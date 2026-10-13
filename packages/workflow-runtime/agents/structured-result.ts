import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import {
    AssistantEntry,
    defineExtension,
    defineTool,
    ProviderDoc,
    ToolResultEntry,
    ToolTask,
    UserEntry,
    type ConversationId,
    type EntryId,
    type Extension,
    type RegistryReader,
    type RegistrySnapshot,
    type SubmissionRecord,
    type TaskId,
    type ToolExecutionApi,
    type ToolRegistration,
    type Tx,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, TSchema, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { canonicalInput } from "../core/identity.ts";
import { RUN_DOC } from "../core/index.ts";
import {
    parseWorkflowAgentProviderSessionId,
    workflowAgentProfileFingerprint,
    workflowAgentResultExtensionName,
    workflowAgentResultSchemaFingerprint,
    type WorkflowAgentProfile,
    type WorkflowAgentResultBinding,
} from "./profile.ts";
import {
    AGENT_THREAD_DOC,
    type AgentStructuredResultCandidate,
    type AgentThreadRecord,
    type AgentTurnRecord,
    type AgentTurnResultSchema,
    WorkflowAgentAdmissionError,
} from "./records.ts";

const RESULT_PROMPT = "Return the final structured payload using this schema-bound tool.";

export function workflowAgentTurnResultSchema(
    profile: WorkflowAgentProfile,
): AgentTurnResultSchema | undefined {
    if (profile.result === undefined) {
        return undefined;
    }

    return {
        id: profile.result.id,
        version: profile.result.version,
        toolName: profile.result.toolName,
        fingerprint: workflowAgentResultSchemaFingerprint(profile.result),
    };
}

export function createWorkflowAgentStructuredResultExtensions(
    profiles: readonly WorkflowAgentProfile[],
): readonly Extension[] {
    return profiles.flatMap((profile) => {
        if (profile.result === undefined) {
            return [];
        }

        const binding = profile.result;
        const extensionName = workflowAgentResultExtensionName(binding);
        const tool = defineTool({
            name: binding.toolName,
            description: RESULT_PROMPT,
            parameters: binding.schema as TSchema,
            replay: "safe",
            async execute(args, api, context) {
                return executeWorkflowAgentStructuredResult(
                    profile,
                    binding,
                    args as unknown as JsonValue,
                    api,
                    context,
                );
            },
        });

        return [defineExtension({ name: extensionName, tools: [tool] })];
    });
}

/** Keep schema result tools addressable to selected agent profiles, but out of default chat selection. */
export function createWorkflowAgentResultRegistry(
    base: RegistryReader,
    extensions: readonly Extension[],
): RegistryReader {
    const byName = new Map(extensions.map((extension) => [extension.name, extension] as const));

    if (byName.size !== extensions.length) {
        throw new WorkflowAgentAdmissionError("Structured result extension identity is ambiguous");
    }

    return {
        snapshot(): RegistrySnapshot {
            const snapshot = base.snapshot();
            const names = new Set(byName.keys());
            const installed = () =>
                snapshot.installed().filter((extension) => !names.has(extension.name));

            return {
                installed,
                extension: (name) => {
                    if (names.has(name)) {
                        return snapshot.extension(name) === undefined
                            ? byName.get(name)
                            : undefined;
                    }

                    return snapshot.extension(name);
                },
                tools: () => snapshot.tools().filter(({ extension }) => !names.has(extension.name)),
                sections: () =>
                    snapshot.sections().filter(({ extension }) => !names.has(extension.name)),
                tasks: () => snapshot.tasks(),
                task: (name) => snapshot.task(name),
            };
        },
        subscribe: (listener) => base.subscribe(listener),
    };
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

function validatePayload(
    binding: WorkflowAgentResultBinding,
    callId: string,
    args: JsonValue,
): JsonValue {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new WorkflowAgentAdmissionError("Structured result payload must be an object");
    }

    try {
        const input = copyJson(args);
        const value = validateToolArguments(
            { name: binding.toolName, parameters: binding.schema as TSchema } as ToolRegistration,
            {
                id: callId,
                type: "toolCall",
                name: binding.toolName,
                arguments: input as ToolCall["arguments"],
            },
        ) as JsonValue;

        if (!sameJson(value, input)) {
            throw new WorkflowAgentAdmissionError(
                "Structured result arguments changed during schema validation",
            );
        }

        return copyJson(value);
    } catch (error) {
        if (error instanceof WorkflowAgentAdmissionError) {
            throw error;
        }

        throw new WorkflowAgentAdmissionError(
            `Structured result failed its current schema: ${String(error)}`,
        );
    }
}

function sameResultSchema(
    left: AgentTurnResultSchema | undefined,
    right: AgentTurnResultSchema | undefined,
): boolean {
    return (
        left?.id === right?.id &&
        left?.version === right?.version &&
        left?.toolName === right?.toolName &&
        left?.fingerprint === right?.fingerprint
    );
}

function candidateMatches(
    left: AgentStructuredResultCandidate | undefined,
    right: AgentStructuredResultCandidate,
): boolean {
    if (left === undefined) {
        return false;
    }

    return (
        left.runId === right.runId &&
        left.threadKey === right.threadKey &&
        left.threadId === right.threadId &&
        left.turnId === right.turnId &&
        left.conversationId === right.conversationId &&
        left.requestId === right.requestId &&
        left.submissionId === right.submissionId &&
        left.assistantEntryId === right.assistantEntryId &&
        left.callId === right.callId &&
        left.toolTaskId === right.toolTaskId &&
        left.generationTaskId === right.generationTaskId &&
        left.schemaId === right.schemaId &&
        left.schemaVersion === right.schemaVersion &&
        left.schemaFingerprint === right.schemaFingerprint &&
        sameJson(left.payload, right.payload)
    );
}

function fenceResultConflict(
    thread: AgentThreadRecord,
    turn: AgentTurnRecord,
    reason: string,
): void {
    turn.status = "unknown";

    if (thread.status !== "closed") {
        thread.status = "unknown";
    }

    thread.unknownReason = reason;
}

function turnIntentContent(
    thread: AgentThreadRecord,
    turn: AgentTurnRecord,
): JsonValue | undefined {
    try {
        const intent: unknown = JSON.parse(turn.intentCanonical);

        if (
            typeof intent !== "object" ||
            intent === null ||
            Array.isArray(intent) ||
            !("content" in intent) ||
            !("threadId" in intent) ||
            !("turnId" in intent) ||
            !("profile" in intent) ||
            intent.threadId !== thread.threadId ||
            intent.turnId !== turn.turnId ||
            intent.profile !== thread.profileId ||
            canonicalInput(intent as JsonValue).canonical !== turn.intentCanonical ||
            canonicalInput(intent as JsonValue).digest !== turn.intentDigest
        ) {
            return undefined;
        }

        return intent.content as JsonValue;
    } catch {
        return undefined;
    }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

type CandidateCommit =
    | { readonly status: "saved"; readonly candidate: AgentStructuredResultCandidate }
    | { readonly status: "rejected"; readonly reason: string }
    | { readonly status: "conflict"; readonly reason: string };

async function executeWorkflowAgentStructuredResult(
    profile: WorkflowAgentProfile,
    binding: WorkflowAgentResultBinding,
    args: JsonValue,
    api: ToolExecutionApi,
    context: Context,
) {
    const payload = validatePayload(binding, api.callId, args);
    const agent = await api.agent(context);
    const selected = agent.tools.filter((tool) => tool.name === binding.toolName);

    if (
        selected.length !== 1 ||
        !sameJson(selected[0]!.parameters as unknown as JsonValue, binding.schema) ||
        !agent.extensions.some(
            (extension) =>
                extension.name === workflowAgentResultExtensionName(binding) &&
                extension.tools?.some((tool) => tool.name === binding.toolName),
        )
    ) {
        throw new WorkflowAgentAdmissionError(
            "Structured result tool is not the current selected profile definition",
        );
    }

    const commitResult = await api.commit(async (tx): Promise<CandidateCommit> => {
        const provider = await tx.doc(ProviderDoc, api.conversationId);
        const parsed =
            provider.sessionId === undefined
                ? undefined
                : parseWorkflowAgentProviderSessionId(provider.sessionId);

        if (
            parsed === undefined ||
            parsed.identity.profileId !== profile.id ||
            parsed.key.length === 0
        ) {
            return {
                status: "rejected",
                reason: "Structured result has no current thread identity",
            };
        }

        const thread = await tx.doc(AGENT_THREAD_DOC, parsed.key, parsed.key);
        const turns = thread.turns ?? [];
        const activeTurns = turns.filter(
            (turn) => turn.status === "reserved" || turn.status === "submitted",
        );
        const turn = activeTurns.length === 1 ? activeTurns[0] : undefined;

        if (turn === undefined) {
            return { status: "rejected", reason: "Structured result turn admission is ambiguous" };
        }

        const bindingIdentity = workflowAgentTurnResultSchema(profile);
        const currentProfileFingerprint = workflowAgentProfileFingerprint(profile);
        const task = await tx.task(api.taskId);
        const taskInput = objectRecord(task?.input);
        const assistantEntryId = taskInput?.assistant;
        const taskCallId = taskInput?.callId;
        const assistant =
            typeof assistantEntryId === "number" && Number.isSafeInteger(assistantEntryId)
                ? await tx.entry(AssistantEntry, assistantEntryId as EntryId)
                : undefined;
        const message = assistant?.model?.[0];
        const calls =
            message?.role === "assistant"
                ? message.content.filter((item) => item.type === "toolCall")
                : [];
        const call = calls[0];
        const generation =
            task?.owner === undefined ? undefined : await tx.task(task.owner as TaskId);
        const generationCheckpoint = objectRecord(generation?.state.checkpoint);
        const generationTools = generationCheckpoint?.tools;
        const directToolTask =
            task !== undefined &&
            task.kind === ToolTask.definition.name &&
            task.id === api.taskId &&
            task.state.status === "running" &&
            Number(task.conversationId) === Number(api.conversationId) &&
            task.owner !== undefined &&
            taskInput?.assistant === assistantEntryId &&
            taskInput?.callId === api.callId &&
            taskCallId === api.callId &&
            assistant !== undefined &&
            Number(assistant.conversationId) === Number(api.conversationId) &&
            message?.role === "assistant" &&
            message.stopReason === "toolUse" &&
            message.content.length === 1 &&
            calls.length === 1 &&
            call?.type === "toolCall" &&
            call.id === api.callId &&
            call.name === binding.toolName &&
            sameJson(call.arguments as unknown as JsonValue, payload) &&
            generation?.kind === "pi.generation" &&
            generation.state.status === "waiting" &&
            Number(generation.conversationId) === Number(api.conversationId) &&
            generationCheckpoint?.phase === "tools" &&
            Number(generationCheckpoint.assistant) === Number(assistantEntryId) &&
            Array.isArray(generationTools) &&
            generationTools.some((taskId) => Number(taskId) === Number(api.taskId));

        const submission = await tx.submissionByRequest(api.conversationId, turn.requestId);
        const expectedContent = turnIntentContent(thread, turn);
        const userEntry =
            submission?.type === "input" && submission.entry !== undefined
                ? await tx.entry(UserEntry, submission.entry)
                : undefined;
        const userMessage = userEntry?.model?.[0];
        const exactSubmission =
            submission?.type === "input" &&
            submission.status === "placed" &&
            Number(submission.conversationId) === Number(api.conversationId) &&
            submission.requestId === turn.requestId &&
            turn.submissionId === Number(submission.id) &&
            userEntry !== undefined &&
            Number(userEntry.conversationId) === Number(api.conversationId) &&
            userMessage?.role === "user" &&
            expectedContent !== undefined &&
            sameJson(userMessage.content as unknown as JsonValue, expectedContent);
        const exactTurn =
            thread.schemaVersion === 1 &&
            thread.threadKey === parsed.key &&
            thread.runId === parsed.identity.runId &&
            thread.threadId === parsed.identity.threadId &&
            thread.profileId === profile.id &&
            thread.status === "ready" &&
            Number(thread.conversationId) === Number(api.conversationId) &&
            thread.providerSessionId === provider.sessionId &&
            turn.status === "submitted" &&
            turn.requestId.length > 0 &&
            turn.profileFingerprint === currentProfileFingerprint &&
            turn.authorityFingerprint === thread.authorityFingerprint &&
            sameResultSchema(turn.resultSchema, bindingIdentity) &&
            directToolTask &&
            exactSubmission;

        if (!exactTurn) {
            return {
                status: "rejected",
                reason: "Structured result does not match the current native ToolTask and turn",
            };
        }

        const run = await tx.doc(RUN_DOC, thread.runId, thread.runId);
        const [owner, nativeConversation] = await Promise.all([
            thread.ownerTaskId === undefined ? undefined : tx.task(thread.ownerTaskId as TaskId),
            tx.conversation(api.conversationId),
        ]);
        const ownerInput = objectRecord(owner?.input);

        if (
            run.taskId !== thread.ownerTaskId ||
            run.stopCommand !== undefined ||
            run.selectedOutcome !== undefined ||
            (run.status !== "running" && run.status !== "waiting") ||
            owner === undefined ||
            owner.kind !== "pocket.workflow-runtime.task" ||
            owner.abortRequested ||
            owner.state.status === "terminal" ||
            owner.state.status === "completing" ||
            ownerInput?.runId !== thread.runId ||
            nativeConversation?.owner?.taskId !== thread.ownerTaskId ||
            nativeConversation.owner.conversationId !== owner.conversationId
        ) {
            return { status: "rejected", reason: "Structured result workflow admission is closed" };
        }

        const candidate: AgentStructuredResultCandidate = {
            runId: thread.runId,
            threadKey: thread.threadKey,
            threadId: thread.threadId,
            turnId: turn.turnId,
            conversationId: Number(api.conversationId),
            requestId: turn.requestId,
            submissionId: Number(submission.id),
            assistantEntryId: Number(assistantEntryId),
            callId: api.callId,
            toolTaskId: Number(api.taskId),
            generationTaskId: Number(task!.owner),
            schemaId: binding.id,
            schemaVersion: binding.version,
            schemaFingerprint: workflowAgentResultSchemaFingerprint(binding),
            payload: copyJson(payload),
        };

        if (turn.candidate !== undefined && !candidateMatches(turn.candidate, candidate)) {
            fenceResultConflict(
                thread,
                turn,
                "Structured result candidate references or payload conflicted with its first durable call",
            );

            return {
                status: "conflict",
                reason: "Structured result candidate conflicts with its first durable call",
            };
        }

        if (turn.candidate === undefined) {
            turn.candidate = candidate;
        }

        return { status: "saved", candidate: turn.candidate };
    }, context);

    if (commitResult.status !== "saved") {
        throw new WorkflowAgentAdmissionError(commitResult.reason);
    }

    return {
        content: [{ type: "text" as const, text: "Structured result accepted." }],
        control: { terminate: true as const },
    };
}

export type WorkflowAgentSettlement =
    | { readonly status: "completed"; readonly result: JsonValue }
    | { readonly status: "not-settled" }
    | { readonly status: "conflict"; readonly reason: string };

function sameCandidateIdentity(
    candidate: AgentStructuredResultCandidate,
    thread: AgentThreadRecord,
    turn: AgentTurnRecord,
    submission: SubmissionRecord,
    answerEntryId: number,
    binding: WorkflowAgentResultBinding,
): boolean {
    return (
        candidate.runId === thread.runId &&
        candidate.threadKey === thread.threadKey &&
        candidate.threadId === thread.threadId &&
        candidate.turnId === turn.turnId &&
        candidate.conversationId === Number(thread.conversationId) &&
        candidate.requestId === turn.requestId &&
        candidate.submissionId === Number(submission.id) &&
        candidate.assistantEntryId === answerEntryId &&
        candidate.schemaId === binding.id &&
        candidate.schemaVersion === binding.version &&
        candidate.schemaFingerprint === workflowAgentResultSchemaFingerprint(binding)
    );
}

async function proveStructuredToolSettlement(
    tx: Tx,
    thread: AgentThreadRecord,
    turn: AgentTurnRecord,
    submission: SubmissionRecord & { readonly status: "done"; readonly type: "input" },
    answerEntryId: number,
    answerMessage: AssistantMessage,
    binding: WorkflowAgentResultBinding,
): Promise<{ readonly payload?: JsonValue; readonly reason?: string }> {
    const candidate = turn.candidate;

    if (
        candidate === undefined ||
        !sameCandidateIdentity(candidate, thread, turn, submission, answerEntryId, binding)
    ) {
        return { reason: "Schema-required turn has no candidate for this exact native answer" };
    }

    const content = answerMessage.content;
    const call = content.length === 1 && content[0]?.type === "toolCall" ? content[0] : undefined;

    if (
        answerMessage.stopReason !== "toolUse" ||
        call === undefined ||
        call.id !== candidate.callId ||
        call.name !== binding.toolName ||
        !sameJson(call.arguments as unknown as JsonValue, candidate.payload)
    ) {
        return { reason: "Native answer is not the candidate's sole direct result call" };
    }

    let payload: JsonValue;

    try {
        payload = validatePayload(binding, candidate.callId, candidate.payload);
    } catch (error) {
        return { reason: `Persisted structured result no longer validates: ${String(error)}` };
    }

    const toolTask = await tx.task(candidate.toolTaskId as TaskId);
    const taskInput = objectRecord(toolTask?.input);
    const taskOutcome =
        toolTask?.state.status === "terminal" && toolTask.state.outcome.status === "completed"
            ? objectRecord(toolTask.state.outcome.result)
            : undefined;
    const resultEntryId = taskOutcome?.entryId;
    const resultEntry =
        typeof resultEntryId === "number" && Number.isSafeInteger(resultEntryId)
            ? await tx.entry(ToolResultEntry, resultEntryId as EntryId)
            : undefined;
    const toolResult = resultEntry?.model?.[0];
    const generation =
        toolTask?.owner === undefined ? undefined : await tx.task(toolTask.owner as TaskId);
    const generationOutcome =
        generation?.state.status === "terminal" && generation.state.outcome.status === "completed"
            ? objectRecord(generation.state.outcome.result)
            : undefined;

    if (
        toolTask === undefined ||
        toolTask.kind !== ToolTask.definition.name ||
        Number(toolTask.id) !== candidate.toolTaskId ||
        Number(toolTask.owner) !== candidate.generationTaskId ||
        Number(toolTask.conversationId) !== candidate.conversationId ||
        taskInput?.assistant !== candidate.assistantEntryId ||
        taskInput?.callId !== candidate.callId ||
        toolTask.state.status !== "terminal" ||
        toolTask.state.outcome.status !== "completed" ||
        taskOutcome === undefined ||
        Number(resultEntryId) !== Number(taskOutcome.entryId) ||
        Number(resultEntry?.id) !== Number(resultEntryId) ||
        Number(resultEntry?.conversationId) !== candidate.conversationId ||
        Number(resultEntry?.byTaskId) !== candidate.toolTaskId ||
        toolResult?.role !== "toolResult" ||
        toolResult.toolCallId !== candidate.callId ||
        toolResult.toolName !== binding.toolName ||
        toolResult.isError !== false ||
        taskOutcome.control === undefined ||
        objectRecord(taskOutcome.control)?.terminate !== true ||
        generation === undefined ||
        generation.kind !== "pi.generation" ||
        Number(generation.id) !== candidate.generationTaskId ||
        Number(generation.conversationId) !== candidate.conversationId ||
        generation.state.status !== "terminal" ||
        generation.state.outcome.status !== "completed" ||
        Number(generationOutcome?.entryId) !== candidate.assistantEntryId
    ) {
        return {
            reason: "Structured result ToolTask did not complete with exact non-error evidence",
        };
    }

    return { payload };
}

/** Prove and atomically promote the exact native answer; conflicts are persisted before returning. */
export async function settleWorkflowAgentTurnInTransaction(
    tx: Tx,
    identity: {
        readonly threadKey: string;
        readonly runId: string;
        readonly threadId: string;
        readonly profileId: string;
        readonly turnId: string;
        readonly runnerTaskId: number;
        readonly requestId: string;
        readonly profileFingerprint: string;
        readonly binding?: WorkflowAgentResultBinding;
    },
): Promise<WorkflowAgentSettlement> {
    const thread = await tx.doc(AGENT_THREAD_DOC, identity.threadKey, identity.threadKey);
    const turn = thread.turns?.find(
        (candidate) =>
            candidate.turnId === identity.turnId &&
            candidate.runnerTaskId === identity.runnerTaskId,
    );
    const submission = await tx.submissionByRequest(
        thread.conversationId as ConversationId,
        identity.requestId,
    );

    if (submission?.status !== "done" || submission.type !== "input") {
        return { status: "not-settled" };
    }

    const conflict = (reason: string): WorkflowAgentSettlement => {
        if (turn !== undefined) {
            fenceResultConflict(thread, turn, reason);
        } else {
            if (thread.status !== "closed") {
                thread.status = "unknown";
            }

            thread.unknownReason = reason;
        }

        return { status: "conflict", reason };
    };

    if (
        turn === undefined ||
        thread.schemaVersion !== 1 ||
        thread.threadKey !== identity.threadKey ||
        thread.runId !== identity.runId ||
        thread.threadId !== identity.threadId ||
        thread.profileId !== identity.profileId ||
        Number(submission.conversationId) !== Number(thread.conversationId) ||
        submission.requestId !== identity.requestId ||
        turn.requestId !== identity.requestId ||
        turn.profileFingerprint !== identity.profileFingerprint ||
        (turn.status !== "reserved" &&
            turn.status !== "submitted" &&
            turn.status !== "completed") ||
        (turn.submissionId !== undefined && turn.submissionId !== Number(submission.id))
    ) {
        return conflict("Completed native submission does not match its exact agent turn identity");
    }

    const expectedContent = turnIntentContent(thread, turn);
    const userEntry = await tx.entry(UserEntry, submission.entry);
    const userMessage = userEntry?.model?.[0];
    const answerEntry = await tx.entry(AssistantEntry, submission.answer);
    const answerMessage = answerEntry?.model?.[0];

    if (
        expectedContent === undefined ||
        userEntry === undefined ||
        Number(userEntry.conversationId) !== Number(thread.conversationId) ||
        userMessage?.role !== "user" ||
        !sameJson(userMessage.content as unknown as JsonValue, expectedContent) ||
        answerEntry === undefined ||
        Number(answerEntry.conversationId) !== Number(thread.conversationId) ||
        answerMessage?.role !== "assistant"
    ) {
        return conflict(
            "Completed native submission has no exact immutable user and answer entries",
        );
    }

    const expectedSchema =
        identity.binding === undefined
            ? undefined
            : workflowAgentTurnResultSchema({ result: identity.binding } as WorkflowAgentProfile);

    if (!sameResultSchema(turn.resultSchema, expectedSchema)) {
        return conflict("Structured result schema identity changed for the admitted turn");
    }

    let result: JsonValue;

    if (identity.binding === undefined) {
        result = copyJson(answerMessage as unknown as JsonValue);
    } else {
        const proof = await proveStructuredToolSettlement(
            tx,
            thread,
            turn,
            submission,
            Number(submission.answer),
            answerMessage,
            identity.binding,
        );

        if (proof.payload === undefined) {
            return conflict(proof.reason ?? "Structured result settlement proof failed");
        }

        result = proof.payload;
    }

    if (turn.status === "completed" && !sameJson(turn.result, result)) {
        return conflict("Completed agent result conflicts with its exact native settlement");
    }

    turn.status = "completed";
    turn.submissionId = Number(submission.id);
    turn.answerEntryId = Number(submission.answer);
    turn.result = copyJson(result);

    return { status: "completed", result: copyJson(result) };
}
