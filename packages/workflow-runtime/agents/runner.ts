import type { Context, JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import {
    AgentDoc,
    AssistantEntry,
    configure,
    defineTask,
    ProviderDoc,
    UserEntry,
    type ConversationId,
    type EntryId,
    type RunningTask,
    type SubmissionRecord,
    type TaskId,
    type TaskRecord,
    type TaskRuntime,
    type Tx,
    type UserInput,
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
    type WorkflowAgentConfig,
    type WorkflowAgentProfile,
    workflowAgentModelFingerprint,
    workflowAgentModelIdentityInputs,
    workflowAgentProfileFingerprint,
    workflowAgentProviderSessionId,
    workflowAgentThreadKey,
} from "./profile.ts";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    type AgentThreadRecord,
    type AgentTurnRecord,
} from "./records.ts";
import { WorkflowAgentAdmissionError } from "./recovery.ts";

export type WorkflowAgentTurnInput = {
    readonly threadId: string;
    readonly turnId: string;
    readonly profile: string;
    readonly content: UserInput;
};

type AgentRunnerInput = {
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
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly profileInput: JsonValue;
    readonly modelInput: JsonValue;
};
type AgentRunnerCheckpoint = { readonly phase: "run" };
type AgentRunnerRuntime = TaskRuntime<AgentRunnerInput, AgentRunnerCheckpoint, JsonValue, object>;
type AgentRunnerTask = ReturnType<typeof createWorkflowAgentRunnerTask>;

type ProfileSnapshot = {
    readonly profile: WorkflowAgentProfile;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly profileInput: JsonValue;
    readonly modelInput: JsonValue;
};

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
            (key) => !["threadId", "turnId", "profile", "content"].includes(key),
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
    };
}

function requestId(threadKey: string, turnId: string): string {
    return `${TURN_REQUEST_PREFIX}${Buffer.from(JSON.stringify([threadKey, turnId]), "utf8").toString("base64url")}`;
}

function profileSnapshot(models: Models, profile: WorkflowAgentProfile): ProfileSnapshot {
    const profileInput = copyJson(profile as unknown as JsonValue);
    const current = workflowAgentModelFingerprint(models, profile);

    return {
        profile,
        profileFingerprint: workflowAgentProfileFingerprint(profile),
        modelFingerprint: current.fingerprint,
        profileInput,
        modelInput: copyJson(workflowAgentModelIdentityInputs(current.model)),
    };
}

function sameJson(left: JsonValue | undefined, right: JsonValue): boolean {
    if (left === undefined) {
        return false;
    }

    try {
        return canonicalInput(left).canonical === canonicalInput(right).canonical;
    } catch {
        return false;
    }
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
}): boolean {
    try {
        const intent = turnIntent({
            threadId: input.threadId,
            turnId: input.turnId,
            profile: input.profileId,
            content: input.content as unknown as UserInput,
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
    snapshot: ProfileSnapshot,
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
        !sameJson(thread.profileInput, snapshot.profileInput) ||
        !sameJson(thread.modelInput, snapshot.modelInput)
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
    snapshot: ProfileSnapshot,
    runnerTask: AgentRunnerTask,
): Promise<Admission> {
    const owner = await tx.task(binding.taskId);
    const run = await tx.doc(RUN_DOC, binding.runId, binding.runId);

    assertOwnerActive(owner, run, binding);

    const key = workflowAgentThreadKey(identity);
    const sessionId = workflowAgentProviderSessionId(identity);
    const intent = turnIntent(input);
    const thread = await tx.doc(AGENT_THREAD_DOC, key, key);

    if (thread.status === "uninitialized") {
        const nativeConversation = await tx.createConversation({
            ownership: { kind: "task", taskId: binding.taskId },
        });

        await configure(tx, nativeConversation.id, {
            model: {
                provider: snapshot.profile.model.provider,
                modelId: snapshot.profile.model.modelId,
            },
            extensions: [],
            tools: [],
            instructions: snapshot.profile.instructions,
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
            !sameJson(existingTurn.profileInput, snapshot.profileInput) ||
            !sameJson(existingTurn.modelInput, snapshot.modelInput)
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

    const record: AgentTurnRecord = {
        turnId: input.turnId,
        intentCanonical: intent.canonical,
        intentDigest: intent.digest,
        profileFingerprint: snapshot.profileFingerprint,
        modelFingerprint: snapshot.modelFingerprint,
        profileInput: copyJson(snapshot.profileInput),
        modelInput: copyJson(snapshot.modelInput),
        requestId: requestId(key, input.turnId),
        status: "reserved",
    };
    const runnerInput: AgentRunnerInput = {
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
        profileFingerprint: record.profileFingerprint,
        modelFingerprint: record.modelFingerprint,
        profileInput: copyJson(record.profileInput),
        modelInput: copyJson(record.modelInput),
    };
    const runnerTaskId = await tx.createTask(runnerTask, runnerInput, {
        ownership: { kind: "task", taskId: binding.taskId },
        conversationId: binding.conversationId,
    });

    record.runnerTaskId = Number(runnerTaskId);
    thread.turns = [...turns, record];

    return { status: "runner", taskId: runnerTaskId };
}

export function createWorkflowAgentTurnBinder(options: {
    readonly models: Models;
    readonly config: WorkflowAgentConfig;
    readonly runnerTask: AgentRunnerTask;
}): WorkflowAgentTurnBinder {
    const profiles = new Map(options.config.profiles.map((profile) => [profile.id, profile]));

    return (binding) => async (value) => {
        if (binding.signal.aborted) {
            throw binding.signal.reason ?? new WorkflowAgentAdmissionError("Workflow is stopped");
        }

        const input = parseTurnInput(value);
        const profile = profiles.get(input.profile);

        if (profile === undefined) {
            throw new WorkflowAgentAdmissionError(`Agent profile ${input.profile} is unavailable`);
        }

        const snapshot = profileSnapshot(options.models, profile);
        const identity: AgentThreadIdentity = {
            runId: binding.runId,
            threadId: input.threadId,
            profileId: profile.id,
        };
        const admission = await binding.commit((tx) =>
            reserveTurn(tx, binding, identity, input, snapshot, options.runnerTask),
        );

        if (admission.status === "completed") {
            return admission.result;
        }

        const receipt = await binding.waitForTask(admission.taskId);

        if (receipt.state.outcome.status !== "completed") {
            const recovered = await binding.commit(async (tx) => {
                const threadKey = workflowAgentThreadKey(identity);
                const thread = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);
                const turn = thread.turns?.find((candidate) => candidate.turnId === input.turnId);

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
        thread === undefined ||
        thread.status !== "ready" ||
        thread.runId !== input.runId ||
        thread.threadId !== input.threadId ||
        thread.profileId !== input.profileId ||
        thread.conversationId !== input.conversationId ||
        thread.ownerTaskId !== input.workflowTaskId ||
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
    submission: SubmissionRecord,
    answerEntryId: EntryId,
    answer: JsonValue,
): Promise<void> {
    await runtime.commit(async (tx) => {
        const thread = await tx.doc(AGENT_THREAD_DOC, input.threadKey, input.threadKey);
        const turn = findTurn(thread, input.turnId, runnerTaskId);

        if (
            turn.requestId !== input.requestId ||
            turn.intentCanonical !== input.intentCanonical ||
            turn.submissionId !== Number(submission.id) ||
            submission.status !== "done" ||
            submission.answer !== answerEntryId
        ) {
            throw new WorkflowAgentAdmissionError(
                "Native answer cannot be correlated to the exact admitted agent turn",
            );
        }

        turn.status = "completed";
        turn.answerEntryId = Number(answerEntryId);
        turn.result = copyJson(answer);

        return { status: "terminal", outcome: { status: "completed", result: copyJson(answer) } };
    }, context);
}

async function runAgentTurn(
    task: RunningTask<AgentRunnerInput, AgentRunnerCheckpoint, JsonValue>,
    runtime: AgentRunnerRuntime,
    context: Context,
    models: Models,
    profiles: ReadonlyMap<string, WorkflowAgentProfile>,
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
        })
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent runner payload conflicts with its immutable admitted intent",
        );
    }

    const currentProfile = profiles.get(input.profileId);

    if (currentProfile === undefined) {
        throw new WorkflowAgentAdmissionError(`Agent profile ${input.profileId} is unavailable`);
    }

    const snapshot = profileSnapshot(models, currentProfile);

    if (
        snapshot.profileFingerprint !== input.profileFingerprint ||
        snapshot.modelFingerprint !== input.modelFingerprint ||
        !sameJson(snapshot.profileInput, input.profileInput) ||
        !sameJson(snapshot.modelInput, input.modelInput)
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

    if (
        nativeThread.profileFingerprint !== snapshot.profileFingerprint ||
        nativeThread.modelFingerprint !== snapshot.modelFingerprint ||
        !sameJson(nativeThread.profileInput, snapshot.profileInput) ||
        !sameJson(nativeThread.modelInput, snapshot.modelInput)
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

    if (existing.record?.status === "done") {
        await setSubmissionMapping(runtime, context, input, task.id, existing.record);
        await completeRunner(
            runtime,
            context,
            input,
            task.id,
            existing.record,
            existing.record.answer!,
            existing.answer!,
        );

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

    await completeRunner(
        runtime,
        context,
        input,
        task.id,
        settled,
        settled.answer,
        copyJson(answer as unknown as JsonValue),
    );
}

async function classifyRunnerFailure(
    runtime: AgentRunnerRuntime,
    input: AgentRunnerInput,
    runnerTaskId: TaskId<JsonValue>,
    context: Context,
): Promise<void> {
    let exactCompleted:
        { readonly submission: SubmissionRecord; readonly answer: JsonValue } | undefined;

    try {
        const located = await lookupSubmission(runtime, context, input);

        if (located.record?.status === "done" && located.answer !== undefined) {
            exactCompleted = { submission: located.record, answer: located.answer };
        }
    } catch {
        // A failed or mismatched lookup cannot prove a safe result; the transaction below fences it.
    }

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
        const exactThreadIdentity =
            thread.schemaVersion === 1 &&
            thread.status === "ready" &&
            thread.runId === input.runId &&
            thread.threadId === input.threadId &&
            thread.profileId === input.profileId &&
            thread.conversationId === input.conversationId &&
            thread.ownerTaskId === input.workflowTaskId &&
            thread.providerSessionId ===
                workflowAgentProviderSessionId({
                    runId: input.runId,
                    threadId: input.threadId,
                    profileId: input.profileId,
                });

        if (
            exactCompleted !== undefined &&
            turn !== undefined &&
            (turn.status === "reserved" || turn.status === "submitted") &&
            exactThreadIdentity &&
            submission?.type === "input" &&
            submission.status === "done" &&
            Number(submission.id) === Number(exactCompleted.submission.id) &&
            Number(submission.answer) === Number(exactCompleted.submission.answer) &&
            submission.conversationId === input.conversationId &&
            submission.requestId === input.requestId &&
            turn.requestId === input.requestId &&
            turn.intentCanonical === input.intentCanonical &&
            turn.intentDigest === input.intentDigest &&
            turn.profileFingerprint === input.profileFingerprint &&
            turn.modelFingerprint === input.modelFingerprint &&
            sameJson(turn.profileInput, input.profileInput) &&
            sameJson(turn.modelInput, input.modelInput) &&
            (turn.submissionId === undefined || turn.submissionId === Number(submission.id))
        ) {
            turn.status = "completed";
            turn.submissionId = Number(submission.id);
            turn.answerEntryId = Number(submission.answer);
            turn.result = copyJson(exactCompleted.answer);

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

export function createWorkflowAgentRunnerTask(models: Models, config: WorkflowAgentConfig) {
    const profiles = new Map(config.profiles.map((profile) => [profile.id, profile]));

    return defineTask<AgentRunnerInput, AgentRunnerCheckpoint, JsonValue>({
        name: AGENT_RUNNER_TASK_NAME,
        version: 1,
        initial: () => ({ phase: "run" }),
        phases: {
            run: async (task, runtime, context) => {
                try {
                    await runAgentTurn(task, runtime, context, models, profiles);
                } catch (error) {
                    try {
                        await classifyRunnerFailure(runtime, task.input, task.id, context);
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
