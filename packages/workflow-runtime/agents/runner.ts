import type { Context, JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import {
    AgentDoc,
    AssistantEntry,
    type Agent,
    configure,
    defineTask,
    ProviderDoc,
    UserEntry,
    type ConversationId,
    type RunningTask,
    type SubmissionRecord,
    type TaskId,
    type TaskRecord,
    type TaskRuntime,
    type Tx,
    type UserInput,
    type RegistryReader,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { canonicalInput } from "../core/identity.ts";
import {
    RUN_DOC,
    type WorkflowAgentTurnBinder,
    type WorkflowAgentTurnBinding,
} from "../core/index.ts";
import {
    type AgentThreadIdentity,
    type ResolvedWorkflowAgentConfig,
    type EffectiveWorkflowAgentAuthority,
    type WorkflowAgentResultBinding,
    workflowAgentProviderSessionId,
    workflowAgentThreadKey,
} from "./profile.ts";
import {
    type WorkflowAgentAdmissionPolicy,
    type WorkflowAgentPolicyBinding,
    parseWorkflowAgentPolicyBinding,
    validateWorkflowAgentAdmission,
} from "./admission-policy.ts";
import {
    type WorkflowAgentProfileSnapshot,
    workflowAgentProfileSnapshot,
} from "./profile-snapshot.ts";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
    type AgentTurnRecord,
} from "./records.ts";
import {
    settleWorkflowAgentTurnInTransaction,
    workflowAgentTurnResultSchema,
} from "./structured-result.ts";
import { workflowAgentSectionSourceName } from "./section-registry.ts";

export type WorkflowAgentTurnInput = {
    readonly threadId: string;
    readonly turnId: string;
    readonly profile: string;
    readonly content: UserInput;
    readonly extensions?: readonly string[];
    readonly sections?: readonly string[];
    readonly tools?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly policyBinding?: WorkflowAgentPolicyBinding;
};

type AgentRunnerInput = {
    readonly schemaVersion: 1;
    readonly runId: string;
    readonly workflowTaskId: number;
    readonly threadKey: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly profileId: string;
    readonly conversationId: number;
    readonly requestId: string;
    readonly intentCanonical: string;
    readonly intentDigest: string;
    readonly content: UserInput;
    readonly policyBinding?: WorkflowAgentPolicyBinding;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly profileInput: JsonValue;
    readonly modelInput: JsonValue;
    readonly authorityFingerprint: string;
    readonly authorityInput: JsonValue;
    readonly effectiveAuthority: JsonValue;
    readonly resultSchema?: AgentTurnRecord["resultSchema"];
};
type AgentRunnerCheckpoint = { readonly phase: "run" };
type AgentRunnerRuntime = TaskRuntime<AgentRunnerInput, AgentRunnerCheckpoint, JsonValue, object>;
type AgentRunnerTask = ReturnType<typeof createWorkflowAgentRunnerTask>;

export function workflowAgentSectionViewsMatch(
    agent: Agent,
    snapshot: WorkflowAgentProfileSnapshot,
): boolean {
    const sectionViews = snapshot.extensions.filter(
        (extension) => workflowAgentSectionSourceName(extension.name) !== extension.name,
    );

    if (sectionViews.length === 0) {
        return true;
    }

    for (const view of sectionViews) {
        const selected = agent.extensions.find((extension) => extension.name === view.name);

        if (
            selected === undefined ||
            !sameStrings(
                (selected.sections ?? []).map((section) => section.key),
                (view.sections ?? []).map((section) => section.key),
            )
        ) {
            return false;
        }
    }

    const actualSections = agent.sections
        .map((section) => section.key)
        .filter((key) => key !== "instructions");

    return sameStrings(
        actualSections,
        snapshot.authority.sections.map((section) => section.key),
    );
}

export function workflowAgentNativeSelectionMatches(
    agent: Agent,
    snapshot: WorkflowAgentProfileSnapshot,
): boolean {
    const expectedExtensions = snapshot.extensions.map((extension) => extension.name);
    const expectedTools = snapshot.authority.tools.map((entry) => entry.name);
    const expectedSections = snapshot.authority.sections.map((entry) => entry.key);
    const selectionNameBySource = new Map(
        snapshot.authority.extensions.map(
            (entry, index) => [entry.name, snapshot.extensions[index]!.name] as const,
        ),
    );
    const actualExtensions = agent.extensions.map((extension) => extension.name);
    const actualTools = agent.tools.map((tool) => tool.name);
    const actualSections = agent.sections
        .map((section) => section.key)
        .filter((key) => key !== "instructions");
    const actualToolBindings = agent.tools.map((tool) => {
        const owners = agent.extensions.filter((extension) =>
            extension.tools?.some((candidate) => candidate.name === tool.name),
        );

        return owners.length === 1 ? JSON.stringify([owners[0]!.name, tool.name]) : "";
    });
    const expectedToolBindings = snapshot.authority.tools.map((entry) =>
        JSON.stringify([selectionNameBySource.get(entry.extension), entry.name]),
    );

    return (
        sameStrings(actualExtensions, expectedExtensions) &&
        sameStrings(actualTools, expectedTools) &&
        sameStrings(actualToolBindings, expectedToolBindings) &&
        new Set(actualTools).size === actualTools.length &&
        sameStrings(actualSections, expectedSections) &&
        agent.instructions === snapshot.profile.instructions &&
        agent.model?.provider === snapshot.profile.model.provider &&
        agent.model?.modelId === snapshot.profile.model.modelId &&
        agent.thinkingLevel === (snapshot.profile.thinkingLevel ?? "off")
    );
}

type Admission =
    | { readonly status: "completed"; readonly result: JsonValue }
    | { readonly status: "runner"; readonly taskId: TaskId<JsonValue> };

const PROVIDER_SESSION_PREFIX = "pocket-workflow-agent-v1:";
const TURN_REQUEST_PREFIX = "pocket-workflow-agent-turn-v1:";

function parseTurnInput(input: JsonValue): WorkflowAgentTurnInput {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new TypeError("Agent turn input must be an object");
    }

    const record = input as Record<string, JsonValue>;

    if (
        typeof record.threadId !== "string" ||
        record.threadId.length === 0 ||
        typeof record.turnId !== "string" ||
        record.turnId.length === 0 ||
        typeof record.profile !== "string" ||
        record.profile.length === 0 ||
        record.content === undefined ||
        Object.keys(record).some(
            (key) =>
                ![
                    "threadId",
                    "turnId",
                    "profile",
                    "content",
                    "extensions",
                    "sections",
                    "tools",
                    "capabilities",
                    "policyBinding",
                ].includes(key),
        )
    ) {
        throw new TypeError(
            "Agent turn requires non-empty threadId, turnId, profile, and content fields",
        );
    }

    return {
        threadId: record.threadId,
        turnId: record.turnId,
        profile: record.profile,
        content: copyJson(record.content) as UserInput,
        ...(record.extensions === undefined
            ? {}
            : { extensions: parseNameList(record.extensions, "extensions") }),
        ...(record.sections === undefined
            ? {}
            : { sections: parseNameList(record.sections, "sections") }),
        ...(record.tools === undefined ? {} : { tools: parseNameList(record.tools, "tools") }),
        ...(record.capabilities === undefined
            ? {}
            : { capabilities: parseNameList(record.capabilities, "capabilities") }),
        ...(record.policyBinding === undefined
            ? {}
            : { policyBinding: parseWorkflowAgentPolicyBinding(record.policyBinding) }),
    };
}

function parseNameList(value: JsonValue, key: string): readonly string[] {
    if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string" || entry.length === 0)
    ) {
        throw new TypeError(`Agent turn ${key} must be an array of non-empty names`);
    }

    return value as string[];
}

function requestId(threadKey: string, turnId: string): string {
    return `${TURN_REQUEST_PREFIX}${Buffer.from(JSON.stringify([threadKey, turnId]), "utf8").toString("base64url")}`;
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }

    try {
        return canonicalInput(left).canonical === canonicalInput(right).canonical;
    } catch {
        return false;
    }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function turnIntent(input: WorkflowAgentTurnInput): {
    readonly canonical: string;
    readonly digest: string;
    readonly value: JsonValue;
} {
    const frozen = canonicalInput({
        threadId: input.threadId,
        turnId: input.turnId,
        profile: input.profile,
        content: input.content as unknown as JsonValue,
        ...(input.policyBinding === undefined
            ? {}
            : { policyBinding: input.policyBinding as unknown as JsonValue }),
    });

    return { canonical: frozen.canonical, digest: frozen.digest, value: frozen.input };
}

export function workflowAgentRunnerIntentMatches(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly profileId: string;
    readonly content: JsonValue;
    readonly intentCanonical: string;
    readonly intentDigest: string;
    readonly policyBinding?: WorkflowAgentPolicyBinding;
}): boolean {
    try {
        const intent = turnIntent({
            threadId: input.threadId,
            turnId: input.turnId,
            profile: input.profileId,
            content: input.content as unknown as UserInput,
            ...(input.policyBinding === undefined ? {} : { policyBinding: input.policyBinding }),
        });

        return intent.canonical === input.intentCanonical && intent.digest === input.intentDigest;
    } catch {
        return false;
    }
}

function threadIdentityMatches(
    thread: AgentThreadRecord,
    identity: AgentThreadIdentity,
    binding: WorkflowAgentTurnBinding,
): boolean {
    return (
        thread.schemaVersion === 1 &&
        thread.runId === identity.runId &&
        thread.threadId === identity.threadId &&
        thread.profileId === identity.profileId &&
        thread.ownerTaskId === Number(binding.taskId) &&
        thread.conversationId > 0 &&
        thread.providerSessionId === workflowAgentProviderSessionId(identity)
    );
}

function assertOwnerActive(
    owner: Awaited<ReturnType<Tx["task"]>>,
    run: Awaited<ReturnType<Tx["doc"]>>,
    binding: WorkflowAgentTurnBinding,
): asserts owner is NonNullable<typeof owner> {
    if (
        owner === undefined ||
        owner.kind !== "pocket.workflow-runtime.task" ||
        owner.conversationId !== binding.conversationId ||
        owner.abortRequested ||
        owner.state.status === "terminal" ||
        owner.state.status === "completing" ||
        (owner.input as { readonly runId?: unknown }).runId !== binding.runId ||
        run.taskId !== Number(binding.taskId) ||
        run.stopCommand !== undefined ||
        run.selectedOutcome !== undefined ||
        (run.status !== "running" && run.status !== "waiting")
    ) {
        throw new WorkflowAgentAdmissionError(
            `Workflow ${binding.runId} no longer owns an active agent turn`,
        );
    }
}

async function validateStoredThread(
    tx: Tx,
    thread: AgentThreadRecord,
    identity: AgentThreadIdentity,
    binding: WorkflowAgentTurnBinding,
    snapshot: WorkflowAgentProfileSnapshot,
): Promise<void> {
    if (!threadIdentityMatches(thread, identity, binding)) {
        throw new WorkflowAgentAdmissionError(
            "Agent thread identity is missing or belongs to another workflow owner",
        );
    }

    if (
        thread.status !== "ready" ||
        thread.profileFingerprint !== snapshot.profileFingerprint ||
        thread.modelFingerprint !== snapshot.modelFingerprint ||
        thread.authorityFingerprint !== snapshot.authorityFingerprint ||
        !sameJson(thread.profileInput, snapshot.profileInput) ||
        !sameJson(thread.modelInput, snapshot.modelInput) ||
        !sameJson(thread.authorityInput, snapshot.authorityInput)
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent profile authority or model fingerprint changed",
        );
    }

    const conversationId = thread.conversationId as ConversationId;
    const [nativeConversation, provider, nativeAgent] = await Promise.all([
        tx.conversation(conversationId),
        tx.doc(ProviderDoc, conversationId),
        tx.doc(AgentDoc, conversationId),
    ]);

    if (
        nativeConversation?.owner?.taskId !== binding.taskId ||
        nativeConversation.owner.conversationId !== binding.conversationId ||
        provider.sessionId !== thread.providerSessionId
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent conversation ownership or ProviderDoc correlation changed",
        );
    }

    const profile = snapshot.profile;

    if (
        nativeAgent.model?.provider !== profile.model.provider ||
        nativeAgent.model?.modelId !== profile.model.modelId ||
        nativeAgent.instructions !== profile.instructions
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent profile authority or model fingerprint changed",
        );
    }
}

async function reserveTurn(
    tx: Tx,
    binding: WorkflowAgentTurnBinding,
    identity: AgentThreadIdentity,
    input: WorkflowAgentTurnInput,
    snapshot: WorkflowAgentProfileSnapshot,
    runnerTask: AgentRunnerTask,
    admissionPolicy?: WorkflowAgentAdmissionPolicy,
    onConversationAdmitted?: (conversationId: ConversationId) => void,
): Promise<Admission> {
    const owner = await tx.task(binding.taskId);
    const run = await tx.doc(RUN_DOC, binding.runId, binding.runId);

    assertOwnerActive(owner, run, binding);

    const key = workflowAgentThreadKey(identity);
    const sessionId = workflowAgentProviderSessionId(identity);
    const intent = turnIntent(input);
    const thread = await tx.doc(AGENT_THREAD_DOC, key, key);

    validateWorkflowAgentAdmission(
        admissionPolicy,
        "reservation",
        input.profile,
        thread,
        {
            turnId: input.turnId,
            intentCanonical: intent.canonical,
            intentDigest: intent.digest,
            ...(input.policyBinding === undefined ? {} : { policyBinding: input.policyBinding }),
        },
        snapshot,
    );

    if (thread.status === "uninitialized") {
        const nativeConversation = await tx.createConversation({
            ownership: { kind: "task", taskId: binding.taskId },
        });

        await configure(tx, nativeConversation.id, {
            model: {
                provider: snapshot.profile.model.provider,
                modelId: snapshot.profile.model.modelId,
            },
            extensions: [...snapshot.extensions],
            tools: [...snapshot.tools],
            instructions: snapshot.profile.instructions,
            thinkingLevel: snapshot.profile.thinkingLevel ?? "off",
            cwd: null,
        });
        const provider = await tx.doc(ProviderDoc, nativeConversation.id);

        if (provider.sessionId.startsWith(PROVIDER_SESSION_PREFIX)) {
            throw new WorkflowAgentAdmissionError(
                "ProviderDoc is already mapped to another agent thread",
            );
        }

        provider.sessionId = sessionId;
        thread.status = "ready";
        thread.runId = identity.runId;
        thread.threadId = identity.threadId;
        thread.profileId = identity.profileId;
        thread.profileVersion = snapshot.profile.version;
        thread.conversationId = Number(nativeConversation.id);
        thread.providerSessionId = sessionId;
        thread.profileFingerprint = snapshot.profileFingerprint;
        thread.modelFingerprint = snapshot.modelFingerprint;
        thread.authorityFingerprint = snapshot.authorityFingerprint;
        thread.authorityInput = copyJson(snapshot.authorityInput);
        thread.ownerTaskId = Number(binding.taskId);
        thread.profileInput = snapshot.profileInput;
        thread.modelInput = snapshot.modelInput;
        thread.turns = [];

        if (
            nativeConversation.owner?.taskId !== binding.taskId ||
            nativeConversation.owner.conversationId !== binding.conversationId
        ) {
            throw new WorkflowAgentAdmissionError(
                "Native agent conversation was not created under its workflow owner",
            );
        }
    } else {
        await validateStoredThread(tx, thread, identity, binding, snapshot);

        await configure(tx, thread.conversationId as ConversationId, {
            model: {
                provider: snapshot.profile.model.provider,
                modelId: snapshot.profile.model.modelId,
            },
            extensions: [...snapshot.extensions],
            tools: [...snapshot.tools],
            instructions: snapshot.profile.instructions,
            thinkingLevel: snapshot.profile.thinkingLevel ?? "off",
            cwd: null,
        });
    }

    const turns = thread.turns ?? [];
    const existingTurn = turns.find((candidate) => candidate.turnId === input.turnId);

    if (existingTurn !== undefined) {
        if (
            existingTurn.intentCanonical !== intent.canonical ||
            existingTurn.intentDigest !== intent.digest
        ) {
            throw new WorkflowAgentAdmissionError(
                "Agent turn identity was reused with different immutable intent",
            );
        }

        if (
            existingTurn.profileFingerprint !== snapshot.profileFingerprint ||
            existingTurn.modelFingerprint !== snapshot.modelFingerprint ||
            existingTurn.authorityFingerprint !== snapshot.authorityFingerprint ||
            !sameJson(existingTurn.profileInput, snapshot.profileInput) ||
            !sameJson(existingTurn.modelInput, snapshot.modelInput) ||
            !sameJson(existingTurn.authorityInput, snapshot.authorityInput) ||
            !sameJson(
                existingTurn.effectiveAuthority,
                snapshot.authority as unknown as JsonValue,
            ) ||
            !sameJson(
                existingTurn.resultSchema as unknown as JsonValue | undefined,
                workflowAgentTurnResultSchema(snapshot.profile) as unknown as JsonValue | undefined,
            )
        ) {
            throw new WorkflowAgentAdmissionError(
                "Agent turn profile authority or model fingerprint changed",
            );
        }

        if (existingTurn.status === "completed") {
            if (existingTurn.result === undefined) {
                throw new WorkflowAgentAdmissionError(
                    "Completed agent turn has no exact saved result",
                );
            }

            return { status: "completed", result: copyJson(existingTurn.result) };
        }

        if (existingTurn.status === "not-completed") {
            throw new WorkflowAgentAdmissionError(
                "Agent turn did not reach native submission; use a new logical turn ID",
            );
        }

        if (existingTurn.status === "unknown" || existingTurn.runnerTaskId === undefined) {
            throw new WorkflowAgentAdmissionError(
                "Agent turn outcome is unknown; a replacement logical turn is not admitted",
            );
        }

        const conversationId = thread.conversationId as ConversationId;

        onConversationAdmitted?.(conversationId);

        return {
            status: "runner",
            taskId: existingTurn.runnerTaskId as TaskId<JsonValue>,
        };
    }

    const activeTurn = turns.find(
        (candidate) => candidate.status !== "completed" && candidate.status !== "not-completed",
    );

    if (activeTurn !== undefined) {
        throw new WorkflowAgentAdmissionError(
            "Another agent turn is active; native answer correlation is not safe",
        );
    }

    const resultSchema = workflowAgentTurnResultSchema(snapshot.profile);
    const record: AgentTurnRecord = {
        turnId: input.turnId,
        intentCanonical: intent.canonical,
        intentDigest: intent.digest,
        profileFingerprint: snapshot.profileFingerprint,
        modelFingerprint: snapshot.modelFingerprint,
        profileInput: copyJson(snapshot.profileInput),
        modelInput: copyJson(snapshot.modelInput),
        authorityFingerprint: snapshot.authorityFingerprint,
        authorityInput: copyJson(snapshot.authorityInput),
        effectiveAuthority: copyJson(snapshot.authority as unknown as JsonValue),
        ...(input.policyBinding === undefined
            ? {}
            : {
                  policyBinding: copyJson(
                      input.policyBinding as unknown as JsonValue,
                  ) as unknown as WorkflowAgentPolicyBinding,
              }),
        requestId: requestId(key, input.turnId),
        ...(resultSchema === undefined ? {} : { resultSchema }),
        status: "reserved",
    };
    const runnerInput: AgentRunnerInput = {
        schemaVersion: 1,
        runId: binding.runId,
        workflowTaskId: Number(binding.taskId),
        threadKey: key,
        threadId: identity.threadId,
        turnId: input.turnId,
        profileId: identity.profileId,
        conversationId: thread.conversationId,
        requestId: record.requestId,
        intentCanonical: record.intentCanonical,
        intentDigest: record.intentDigest,
        content: copyJson(input.content as unknown as JsonValue) as UserInput,
        ...(record.policyBinding === undefined
            ? {}
            : {
                  policyBinding: copyJson(
                      record.policyBinding as unknown as JsonValue,
                  ) as unknown as WorkflowAgentPolicyBinding,
              }),
        profileFingerprint: record.profileFingerprint,
        modelFingerprint: record.modelFingerprint,
        profileInput: copyJson(record.profileInput),
        modelInput: copyJson(record.modelInput),
        authorityFingerprint: record.authorityFingerprint,
        authorityInput: copyJson(record.authorityInput),
        effectiveAuthority: copyJson(record.effectiveAuthority),
        ...(record.resultSchema === undefined
            ? {}
            : {
                  resultSchema: copyJson(
                      record.resultSchema as unknown as JsonValue,
                  ) as AgentRunnerInput["resultSchema"],
              }),
    };

    const runnerTaskId = await tx.createTask(runnerTask, runnerInput, {
        ownership: { kind: "task", taskId: binding.taskId },
        conversationId: binding.conversationId,
    });

    record.runnerTaskId = Number(runnerTaskId);
    thread.turns = [...turns, record];
    const conversationId = thread.conversationId as ConversationId;

    onConversationAdmitted?.(conversationId);

    return { status: "runner", taskId: runnerTaskId };
}

export function createWorkflowAgentTurnBinder(options: {
    readonly models: Models;
    readonly config: ResolvedWorkflowAgentConfig;
    readonly registry: RegistryReader;
    readonly admissionPolicy?: WorkflowAgentAdmissionPolicy;
    readonly runnerTask: AgentRunnerTask;
    readonly onConversationAdmitted?: (conversationId: ConversationId) => void;
}): WorkflowAgentTurnBinder {
    const profiles = options.config.byId;

    return (binding) => {
        const handler = async (value: JsonValue) => {
            if (binding.signal.aborted) {
                throw (
                    binding.signal.reason ?? new WorkflowAgentAdmissionError("Workflow is stopped")
                );
            }

            const input = parseTurnInput(value);
            const profile = profiles.get(input.profile);

            if (profile === undefined) {
                throw new WorkflowAgentAdmissionError(
                    `Agent profile ${input.profile} is unavailable`,
                );
            }

            const policyProfile =
                input.policyBinding === undefined
                    ? undefined
                    : options.admissionPolicy?.resolveProfile?.(profile.id);
            const snapshot =
                policyProfile?.snapshot ??
                workflowAgentProfileSnapshot(
                    options.models,
                    options.config,
                    profile,
                    input,
                    options.registry,
                );
            const identity: AgentThreadIdentity = {
                runId: binding.runId,
                threadId: input.threadId,
                profileId: profile.id,
            };

            const admission = await binding.commit((tx) => {
                const currentSnapshot =
                    input.policyBinding === undefined
                        ? snapshot
                        : (options.admissionPolicy?.resolveProfile?.(profile.id)?.snapshot ??
                          snapshot);

                if (currentSnapshot === undefined) {
                    throw new WorkflowAgentAdmissionError("Agent profile snapshot is unavailable");
                }

                return reserveTurn(
                    tx,
                    binding,
                    identity,
                    input,
                    currentSnapshot,
                    options.runnerTask,
                    options.admissionPolicy,
                    options.onConversationAdmitted,
                );
            });

            if (admission.status === "completed") {
                return admission.result;
            }

            const receipt = await binding.waitForTask(admission.taskId);

            if (receipt.state.outcome.status !== "completed") {
                const recovered = await binding.commit(async (tx) => {
                    const threadKey = workflowAgentThreadKey(identity);
                    const thread = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);
                    const turn = thread.turns?.find(
                        (candidate) => candidate.turnId === input.turnId,
                    );

                    if (
                        turn?.status === "completed" &&
                        turn.runnerTaskId === Number(admission.taskId) &&
                        turn.result !== undefined
                    ) {
                        return copyJson(turn.result);
                    }

                    return undefined;
                });

                if (recovered !== undefined) {
                    return recovered;
                }

                throw new WorkflowAgentAdmissionError(
                    `Native agent runner ended as ${receipt.state.outcome.status}`,
                );
            }

            const saved = await binding.commit(async (tx) => {
                const thread = await tx.doc(
                    AGENT_THREAD_DOC,
                    workflowAgentThreadKey(identity),
                    workflowAgentThreadKey(identity),
                );
                const turn = thread.turns?.find((candidate) => candidate.turnId === input.turnId);

                if (
                    turn?.status !== "completed" ||
                    turn.runnerTaskId !== Number(admission.taskId) ||
                    turn.result === undefined
                ) {
                    throw new WorkflowAgentAdmissionError(
                        "Native runner completed without its exact durable agent result",
                    );
                }

                return copyJson(turn.result);
            });

            return saved;
        };

        return Object.assign(handler, {
            resolveProfile: (profileId: string): JsonValue => {
                const policyProfile = options.admissionPolicy?.resolveProfile?.(profileId);

                if (policyProfile !== undefined) {
                    return copyJson(policyProfile.descriptor);
                }

                throw new WorkflowAgentAdmissionError("Agent profile resolution is not configured");
            },
        });
    };
}

function findTurn(
    thread: AgentThreadRecord,
    turnId: string,
    runnerTaskId: TaskId<JsonValue>,
): AgentTurnRecord {
    const turn = thread.turns?.find((candidate) => candidate.turnId === turnId);

    if (turn === undefined || turn.runnerTaskId !== Number(runnerTaskId)) {
        throw new WorkflowAgentAdmissionError("Native runner no longer owns its reserved turn");
    }

    return turn;
}

function validateRunnerThread(
    thread: AgentThreadRecord | undefined,
    input: AgentRunnerInput,
    ownerTaskId: TaskId,
): asserts thread is AgentThreadRecord {
    if (
        input.schemaVersion !== 1 ||
        thread === undefined ||
        thread.schemaVersion !== 1 ||
        thread.status !== "ready" ||
        thread.runId !== input.runId ||
        thread.threadId !== input.threadId ||
        thread.profileId !== input.profileId ||
        thread.conversationId !== input.conversationId ||
        thread.ownerTaskId !== input.workflowTaskId ||
        thread.authorityFingerprint !== input.authorityFingerprint ||
        !sameJson(thread.authorityInput, input.authorityInput) ||
        thread.providerSessionId !==
            workflowAgentProviderSessionId({
                runId: input.runId,
                threadId: input.threadId,
                profileId: input.profileId,
            }) ||
        thread.turns?.some(
            (turn) =>
                turn.turnId === input.turnId &&
                turn.runnerTaskId === Number(ownerTaskId) &&
                turn.intentCanonical === input.intentCanonical &&
                turn.intentDigest === input.intentDigest &&
                turn.authorityFingerprint === input.authorityFingerprint &&
                sameJson(
                    turn.policyBinding as unknown as JsonValue | undefined,
                    input.policyBinding as unknown as JsonValue | undefined,
                ) &&
                sameJson(turn.authorityInput, input.authorityInput) &&
                sameJson(turn.effectiveAuthority, input.effectiveAuthority) &&
                sameJson(
                    turn.resultSchema as unknown as JsonValue | undefined,
                    input.resultSchema as unknown as JsonValue | undefined,
                ) &&
                turn.requestId === input.requestId,
        ) !== true
    ) {
        throw new WorkflowAgentAdmissionError(
            "Native runner identity or durable turn reservation changed",
        );
    }
}

function assertRunnerOwner(
    owner: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
    input: AgentRunnerInput,
): void {
    if (
        owner === undefined ||
        owner.kind !== "pocket.workflow-runtime.task" ||
        owner.abortRequested ||
        owner.state.status === "terminal" ||
        owner.state.status === "completing" ||
        (owner.input as { readonly runId?: unknown }).runId !== input.runId
    ) {
        throw new WorkflowAgentAdmissionError(
            "Workflow owner is missing, stopped, or terminal before native dispatch",
        );
    }
}

async function setSubmissionMapping(
    runtime: AgentRunnerRuntime,
    context: Context,
    input: AgentRunnerInput,
    runnerTaskId: TaskId<JsonValue>,
    submission: SubmissionRecord,
): Promise<void> {
    if (
        submission.conversationId !== input.conversationId ||
        submission.requestId !== input.requestId ||
        submission.type !== "input"
    ) {
        throw new WorkflowAgentAdmissionError(
            "Native submission does not match its persisted request identity",
        );
    }

    await runtime.commit(async (tx, current) => {
        const thread = await tx.doc(AGENT_THREAD_DOC, input.threadKey, input.threadKey);
        const turn = findTurn(thread, input.turnId, runnerTaskId);

        if (turn.submissionId !== undefined && turn.submissionId !== Number(submission.id)) {
            throw new WorkflowAgentAdmissionError(
                "Native submission mapping changed for an admitted agent turn",
            );
        }

        turn.submissionId = Number(submission.id);
        turn.status = "submitted";

        return { status: "running", checkpoint: current.state.checkpoint };
    }, context);
}

async function lookupSubmission(
    runtime: AgentRunnerRuntime,
    context: Context,
    input: AgentRunnerInput,
): Promise<{ readonly record?: SubmissionRecord; readonly answer?: JsonValue }> {
    let record: SubmissionRecord | undefined;
    let answer: JsonValue | undefined;

    await runtime.commit(async (tx, current) => {
        record = await tx.submissionByRequest(
            input.conversationId as ConversationId,
            input.requestId,
        );

        if (record !== undefined && record.status !== "queued") {
            if (record.entry === undefined) {
                throw new WorkflowAgentAdmissionError(
                    "Native request lookup returned no exact input entry",
                );
            }

            const userEntry = await tx.entry(UserEntry, record.entry);
            const userMessage = userEntry?.model?.[0];

            if (
                userMessage?.role !== "user" ||
                canonicalInput(userMessage.content as unknown as JsonValue).canonical !==
                    canonicalInput(input.content as unknown as JsonValue).canonical
            ) {
                throw new WorkflowAgentAdmissionError(
                    "Native request lookup found a conflicting input payload",
                );
            }

            if (record.status === "done") {
                if (record.answer === undefined) {
                    throw new WorkflowAgentAdmissionError(
                        "Completed native request has no exact answer entry",
                    );
                }

                const answerEntry = await tx.entry(AssistantEntry, record.answer);
                const message = answerEntry?.model?.[0];

                if (
                    answerEntry === undefined ||
                    message?.role !== "assistant" ||
                    answerEntry.conversationId !== input.conversationId
                ) {
                    throw new WorkflowAgentAdmissionError(
                        "Native request answer is not the exact assistant entry",
                    );
                }

                answer = copyJson(message as unknown as JsonValue);
            }
        }

        return { status: "running", checkpoint: current.state.checkpoint };
    }, context);

    return { record, ...(answer === undefined ? {} : { answer }) };
}

async function completeRunner(
    runtime: AgentRunnerRuntime,
    context: Context,
    input: AgentRunnerInput,
    runnerTaskId: TaskId<JsonValue>,
    binding?: WorkflowAgentResultBinding,
): Promise<void> {
    let settlement: Awaited<ReturnType<typeof settleWorkflowAgentTurnInTransaction>> | undefined;

    await runtime.commit(async (tx, current) => {
        settlement = await settleWorkflowAgentTurnInTransaction(tx, {
            threadKey: input.threadKey,
            runId: input.runId,
            threadId: input.threadId,
            profileId: input.profileId,
            turnId: input.turnId,
            runnerTaskId: Number(runnerTaskId),
            requestId: input.requestId,
            profileFingerprint: input.profileFingerprint,
            ...(binding === undefined ? {} : { binding }),
        });

        if (settlement.status !== "completed") {
            return { status: "running", checkpoint: current.state.checkpoint };
        }

        return {
            status: "terminal",
            outcome: { status: "completed", result: copyJson(settlement.result) },
        };
    }, context);

    if (settlement?.status !== "completed") {
        throw new WorkflowAgentAdmissionError(
            settlement?.status === "conflict"
                ? settlement.reason
                : "Native agent submission is not settled with its exact result",
        );
    }
}

async function runAgentTurn(
    task: RunningTask<AgentRunnerInput, AgentRunnerCheckpoint, JsonValue>,
    runtime: AgentRunnerRuntime,
    context: Context,
    models: Models,
    config: ResolvedWorkflowAgentConfig,
    registry: RegistryReader,
    admissionPolicy?: WorkflowAgentAdmissionPolicy,
): Promise<void> {
    const input = task.input;

    if (
        !workflowAgentRunnerIntentMatches({
            threadId: input.threadId,
            turnId: input.turnId,
            profileId: input.profileId,
            content: input.content as unknown as JsonValue,
            intentCanonical: input.intentCanonical,
            intentDigest: input.intentDigest,
            ...(input.policyBinding === undefined ? {} : { policyBinding: input.policyBinding }),
        })
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent runner payload conflicts with its immutable admitted intent",
        );
    }

    const currentProfile = config.byId.get(input.profileId);

    if (currentProfile === undefined) {
        throw new WorkflowAgentAdmissionError(`Agent profile ${input.profileId} is unavailable`);
    }

    const effective = input.effectiveAuthority as unknown as EffectiveWorkflowAgentAuthority;
    const resolvedPolicyProfile =
        input.policyBinding === undefined
            ? undefined
            : admissionPolicy?.resolveProfile?.(input.profileId);
    const genericSnapshot = workflowAgentProfileSnapshot(
        models,
        config,
        currentProfile,
        {
            extensions: effective.extensions.map((entry) => entry.name),
            sections: effective.sections.map((entry) => entry.key),
            tools: effective.tools.map((entry) => entry.name),
            capabilities: effective.capabilities,
        },
        registry,
    );
    const snapshot = resolvedPolicyProfile?.snapshot ?? genericSnapshot;

    if (
        snapshot.profileFingerprint !== input.profileFingerprint ||
        snapshot.modelFingerprint !== input.modelFingerprint ||
        snapshot.authorityFingerprint !== input.authorityFingerprint ||
        !sameJson(snapshot.profileInput, input.profileInput) ||
        !sameJson(snapshot.modelInput, input.modelInput) ||
        !sameJson(snapshot.authorityInput, input.authorityInput) ||
        !sameJson(snapshot.authority as unknown as JsonValue, input.effectiveAuthority)
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent profile authority or model fingerprint drifted before dispatch",
        );
    }

    const owner = await runtime.getTask(input.workflowTaskId as TaskId<JsonValue>, context);

    assertRunnerOwner(owner, input);

    const run = await runtime.snapshot(RUN_DOC, input.runId, context);

    if (
        run === undefined ||
        run.taskId !== input.workflowTaskId ||
        run.stopCommand !== undefined ||
        run.selectedOutcome !== undefined ||
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "stopped"
    ) {
        throw new WorkflowAgentAdmissionError(
            "Workflow owner is stopped or terminal before native dispatch",
        );
    }

    const nativeThread = await runtime.snapshot(AGENT_THREAD_DOC, input.threadKey, context);

    validateRunnerThread(nativeThread, input, task.id);
    validateWorkflowAgentAdmission(
        admissionPolicy,
        "dispatch",
        input.profileId,
        nativeThread,
        {
            turnId: input.turnId,
            intentCanonical: input.intentCanonical,
            intentDigest: input.intentDigest,
            ...(input.policyBinding === undefined ? {} : { policyBinding: input.policyBinding }),
        },
        snapshot,
    );

    if (
        nativeThread.profileFingerprint !== snapshot.profileFingerprint ||
        nativeThread.modelFingerprint !== snapshot.modelFingerprint ||
        nativeThread.authorityFingerprint !== snapshot.authorityFingerprint ||
        !sameJson(nativeThread.profileInput, snapshot.profileInput) ||
        !sameJson(nativeThread.modelInput, snapshot.modelInput) ||
        !sameJson(nativeThread.authorityInput, snapshot.authorityInput)
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent thread authority fingerprint drifted before native dispatch",
        );
    }

    const provider = await runtime.snapshot(
        ProviderDoc,
        input.conversationId as ConversationId,
        context,
    );

    if (provider?.sessionId !== nativeThread.providerSessionId) {
        throw new WorkflowAgentAdmissionError(
            "ProviderDoc mapping is missing before native agent dispatch",
        );
    }

    const conversation = await runtime.conversation(
        input.conversationId as ConversationId,
        context,
    );

    if (conversation === undefined) {
        throw new WorkflowAgentAdmissionError("Native agent conversation is unavailable");
    }

    const existing = await lookupSubmission(runtime, context, input);

    if (existing.record === undefined) {
        const nativeAgent = await runtime.snapshot(
            AgentDoc,
            input.conversationId as ConversationId,
            context,
        );

        if (
            nativeAgent === undefined ||
            !Array.isArray(nativeAgent.extensions) ||
            !sameStrings(
                nativeAgent.extensions,
                snapshot.extensions.map((extension) => extension.name),
            ) ||
            !Array.isArray(nativeAgent.tools) ||
            !sameStrings(
                nativeAgent.tools,
                snapshot.tools.map((tool) => tool.name),
            ) ||
            nativeAgent.instructions !== snapshot.profile.instructions ||
            nativeAgent.model?.provider !== snapshot.profile.model.provider ||
            nativeAgent.model?.modelId !== snapshot.profile.model.modelId ||
            nativeAgent.thinkingLevel !== (snapshot.profile.thinkingLevel ?? "off")
        ) {
            throw new WorkflowAgentAdmissionError(
                "Native agent extension, tool, section, or model selection drifted before dispatch",
            );
        }
    }

    if (existing.record?.status === "done") {
        await setSubmissionMapping(runtime, context, input, task.id, existing.record);
        await completeRunner(runtime, context, input, task.id, currentProfile.result);

        return;
    }

    if (existing.record?.status === "unanswered" || existing.record?.status === "queued") {
        throw new WorkflowAgentAdmissionError(
            "Native submission is queued or unanswered; a replacement submission is not created",
        );
    }

    let submission;

    if (existing.record !== undefined) {
        await setSubmissionMapping(runtime, context, input, task.id, existing.record);
        submission = await conversation.submit(
            {
                type: "input",
                requestId: input.requestId,
                content: input.content,
                whenBusy: "reject",
            },
            context,
        );
    } else {
        submission = await conversation.submit(
            {
                type: "input",
                requestId: input.requestId,
                content: input.content,
                whenBusy: "reject",
            },
            context,
        );
    }

    const admittedRecord = await submission.status(context);

    if (admittedRecord.status !== "placed" && admittedRecord.status !== "done") {
        throw new WorkflowAgentAdmissionError(
            "Native agent input did not reach an exact placed payload; dispatch is fenced",
        );
    }

    const activeTranscript = await runtime.context(input.conversationId as ConversationId, context);
    const userEntry = activeTranscript.entries.find((entry) => entry.id === admittedRecord.entry);
    const userMessage = userEntry?.model?.[0];

    if (
        !UserEntry.is(userEntry) ||
        userMessage?.role !== "user" ||
        canonicalInput(userMessage.content as unknown as JsonValue).canonical !==
            canonicalInput(input.content as unknown as JsonValue).canonical
    ) {
        throw new WorkflowAgentAdmissionError(
            "Submitted native input does not match its immutable agent intent",
        );
    }

    await setSubmissionMapping(runtime, context, input, task.id, admittedRecord);

    const settled = await submission.wait(context);

    if (settled.status !== "done" || settled.answer === undefined) {
        throw new WorkflowAgentAdmissionError(
            "Native agent submission did not produce a completed answer",
        );
    }

    const completedTranscript = await runtime.context(
        input.conversationId as ConversationId,
        context,
    );
    const answerEntry = completedTranscript.entries.find((entry) => entry.id === settled.answer);
    const answer = answerEntry?.model?.[0];

    if (
        !AssistantEntry.is(answerEntry) ||
        answer?.role !== "assistant" ||
        answerEntry.conversationId !== input.conversationId
    ) {
        throw new WorkflowAgentAdmissionError(
            "Native submission did not settle with its exact assistant answer entry",
        );
    }

    await completeRunner(runtime, context, input, task.id, currentProfile.result);
}

async function classifyRunnerFailure(
    runtime: AgentRunnerRuntime,
    input: AgentRunnerInput,
    runnerTaskId: TaskId<JsonValue>,
    context: Context,
    config: ResolvedWorkflowAgentConfig,
): Promise<void> {
    await runtime.commit(async (tx, current) => {
        const submission = await tx.submissionByRequest(
            input.conversationId as ConversationId,
            input.requestId,
        );
        const thread = await tx.doc(AGENT_THREAD_DOC, input.threadKey, input.threadKey);
        const turn = thread.turns?.find(
            (candidate) =>
                candidate.turnId === input.turnId &&
                candidate.runnerTaskId === Number(runnerTaskId),
        );

        if (submission?.status === "done") {
            const binding = config.byId.get(input.profileId)?.result;
            const settlement = await settleWorkflowAgentTurnInTransaction(tx, {
                threadKey: input.threadKey,
                runId: input.runId,
                threadId: input.threadId,
                profileId: input.profileId,
                turnId: input.turnId,
                runnerTaskId: Number(runnerTaskId),
                requestId: input.requestId,
                profileFingerprint: input.profileFingerprint,
                ...(binding === undefined ? {} : { binding }),
            });

            if (settlement.status === "conflict") {
                thread.nativeRunnerTaskId = Number(runnerTaskId);
            }

            return { status: "running", checkpoint: current.state.checkpoint };
        }

        if (turn !== undefined && turn.status !== "completed") {
            if (
                submission === undefined &&
                (turn.status === "reserved" || turn.status === "not-completed") &&
                thread.status === "ready"
            ) {
                turn.status = "not-completed";
            } else {
                turn.status = "unknown";

                if (thread.status !== "closed") {
                    thread.status = "unknown";
                }

                thread.unknownReason =
                    "The native runner failed after submission or uncertain provider work may have started";
                thread.nativeRunnerTaskId = Number(runnerTaskId);
            }
        }

        return { status: "running", checkpoint: current.state.checkpoint };
    }, context);
}

export function createWorkflowAgentRunnerTask(
    models: Models,
    config: ResolvedWorkflowAgentConfig,
    registry: RegistryReader,
    admissionPolicy?: WorkflowAgentAdmissionPolicy,
) {
    return defineTask<AgentRunnerInput, AgentRunnerCheckpoint, JsonValue>({
        name: AGENT_RUNNER_TASK_NAME,
        version: 1,
        initial: () => ({ phase: "run" }),
        phases: {
            run: async (task, runtime, context) => {
                try {
                    await runAgentTurn(
                        task,
                        runtime,
                        context,
                        models,
                        config,
                        registry,
                        admissionPolicy,
                    );
                } catch (error) {
                    try {
                        await classifyRunnerFailure(runtime, task.input, task.id, context, config);
                    } catch (classificationError) {
                        throw new AggregateError(
                            [error, classificationError],
                            "Agent runner failed and its durable turn state could not be classified",
                            { cause: error },
                        );
                    }

                    throw error;
                }
            },
        },
        abort: async (task, runtime, context) => {
            await runtime.commit(async (tx) => {
                const thread = await tx.doc(
                    AGENT_THREAD_DOC,
                    task.input.threadKey,
                    task.input.threadKey,
                );
                const turn = thread.turns?.find(
                    (candidate) => candidate.turnId === task.input.turnId,
                );

                if (
                    turn !== undefined &&
                    turn.runnerTaskId === Number(task.id) &&
                    turn.status !== "completed"
                ) {
                    turn.status = "unknown";

                    if (thread.status !== "closed") {
                        thread.status = "unknown";
                    }

                    thread.unknownReason =
                        "The native runner was stopped before its exact result was committed";
                    thread.nativeRunnerTaskId = Number(task.id);
                }

                return {
                    status: "terminal",
                    outcome: { status: "aborted", reason: "Workflow agent runner stopped" },
                };
            }, context);
        },
    });
}
