import type { Context, JsonValue } from "@earendil-works/chord";
import {
    AssistantEntry,
    type ConversationId,
    type Cursor,
    type EntryId,
    Harness,
    ProviderDoc,
    UserEntry,
    type TaskId,
    type Storage,
    type TaskRecord,
} from "@earendil-works/pi-durable";
import { canonicalInput } from "../core/identity.ts";
import {
    type AgentThreadIdentity,
    hasWorkflowAgentProviderSessionIdPrefix,
    parseWorkflowAgentProviderSessionId,
    workflowAgentThreadKey,
} from "./profile.ts";
import { RUN_DOC } from "../core/index.ts";
import { parseWorkflowAgentPolicyBinding } from "./admission-policy.ts";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    type AgentThreadRecord,
    WorkflowAgentAdmissionError,
} from "./records.ts";
import { workflowAgentRunnerIntentMatches } from "./runner.ts";

function persistedJsonMatches(left: unknown, right: unknown): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }

    try {
        return (
            canonicalInput(left as JsonValue).canonical ===
            canonicalInput(right as JsonValue).canonical
        );
    } catch {
        return false;
    }
}

export type WorkflowAgentRecoveryAuthorityCheck = (
    thread: AgentThreadRecord,
    runnerInput: JsonValue,
) => boolean | Promise<boolean>;

async function canSafelyReplayToolTask(
    harness: Harness,
    task: TaskRecord<JsonValue, JsonValue, unknown>,
    reference: { readonly taskId: TaskId; readonly generationTaskId: TaskId },
    conversationId: ConversationId | undefined,
    thread: AgentThreadRecord,
    turnId: unknown,
    context: Context,
): Promise<boolean> {
    const checkpoint = task.state.checkpoint as unknown as Record<string, unknown>;

    if (
        task.kind !== "pi.tool" ||
        task.id !== reference.taskId ||
        task.owner !== reference.generationTaskId ||
        task.conversationId !== conversationId ||
        task.abortRequested ||
        task.state.status === "terminal" ||
        task.state.status === "completing" ||
        checkpoint.phase !== "execute" ||
        checkpoint.replay !== "safe" ||
        typeof turnId !== "string"
    ) {
        return false;
    }

    const input = task.input as { readonly assistant?: unknown; readonly callId?: unknown };

    if (
        typeof input.assistant !== "number" ||
        !Number.isSafeInteger(input.assistant) ||
        input.assistant <= 0 ||
        typeof input.callId !== "string"
    ) {
        return false;
    }

    const assistant = await harness.commit(
        (tx) => tx.entry(AssistantEntry, input.assistant as EntryId),
        context,
    );
    const message = assistant?.model?.[0];
    const candidate =
        message?.role === "assistant"
            ? message.content.find((item) => item.type === "toolCall" && item.id === input.callId)
            : undefined;

    if (candidate?.type !== "toolCall") {
        return false;
    }

    const call = candidate;

    const conversation = await harness.conversation(conversationId!, context);
    const agent = await conversation?.agent(context);
    const tool = agent?.tools.find((candidate) => candidate.name === call.name);
    const turn = thread.turns?.find((candidate) => candidate.turnId === turnId);

    if (
        tool?.replay !== "safe" ||
        turn === undefined ||
        typeof turn.effectiveAuthority !== "object" ||
        turn.effectiveAuthority === null ||
        Array.isArray(turn.effectiveAuthority)
    ) {
        return false;
    }

    const effectiveAuthority = turn.effectiveAuthority as {
        readonly tools?: unknown;
    };

    return (
        Array.isArray(effectiveAuthority.tools) &&
        effectiveAuthority.tools.some(
            (authorized) =>
                typeof authorized === "object" &&
                authorized !== null &&
                !Array.isArray(authorized) &&
                "name" in authorized &&
                authorized.name === call.name,
        )
    );
}

type PersistedAgentThreadReference = {
    readonly key: string;
    readonly conversationId: number;
};

async function registerPersistedAgentConversations(
    storage: Storage,
    context: Context,
    registerConversation: (conversationId: number) => void,
): Promise<Map<number, PersistedAgentThreadReference[]>> {
    const threadsByConversation = new Map<number, PersistedAgentThreadReference[]>();
    let cursor: Cursor | undefined;

    do {
        const page = await storage.scanDocuments(
            {
                scope: { kind: "session" },
                at: "current",
                kind: AGENT_THREAD_DOC.definition.kind,
            },
            100,
            cursor,
            context,
        );

        for (const document of page.items) {
            const stored = await storage.document(document.id, "current", context);

            if (stored?.version !== AGENT_THREAD_DOC.definition.version) {
                throw new WorkflowAgentAdmissionError(
                    `Agent thread document ${document.id} has unsupported durable agent thread document version ${String(stored?.version)}; recovery remains paused`,
                );
            }

            const record = stored.value as unknown as Partial<AgentThreadRecord>;

            if (record.schemaVersion !== 1) {
                throw new WorkflowAgentAdmissionError(
                    `Agent thread document ${document.id} has unsupported agent thread format ${String(record?.schemaVersion)}; recovery remains paused`,
                );
            }

            const conversationId = record.conversationId;

            if (
                typeof conversationId === "number" &&
                Number.isSafeInteger(conversationId) &&
                conversationId > 0
            ) {
                registerConversation(conversationId);

                const key =
                    typeof document.key === "string" && document.key.length > 0
                        ? document.key
                        : typeof record?.threadKey === "string" && record.threadKey.length > 0
                          ? record.threadKey
                          : undefined;

                if (key !== undefined) {
                    const references = threadsByConversation.get(conversationId) ?? [];

                    references.push({ key, conversationId });
                    threadsByConversation.set(conversationId, references);
                }
            }
        }

        cursor = page.next;
    } while (cursor !== undefined);

    return threadsByConversation;
}

async function registerPersistedAgentRunnerConversations(
    storage: Storage,
    context: Context,
    registerConversation: (conversationId: number) => void,
): Promise<Set<number>> {
    const conversationIds = new Set<number>();
    let cursor: Cursor | undefined;

    do {
        const page = await storage.scanTasks(
            { kind: AGENT_RUNNER_TASK_NAME },
            100,
            cursor,
            context,
        );

        for (const task of page.items) {
            if (task.kind !== AGENT_RUNNER_TASK_NAME) {
                continue;
            }

            const input = task.input as Record<string, unknown> | undefined;

            if (task.version !== 1 || input?.schemaVersion !== 1) {
                throw new WorkflowAgentAdmissionError(
                    `Agent runner Task ${task.id} has unsupported agent runner format ${String(task.version)}/${String(input?.schemaVersion)}; recovery remains paused`,
                );
            }

            if (input.policyBinding !== undefined) {
                try {
                    parseWorkflowAgentPolicyBinding(input.policyBinding as JsonValue);
                } catch {
                    throw new WorkflowAgentAdmissionError(
                        `Agent runner Task ${task.id} has an unsupported admission policy binding; recovery remains paused`,
                    );
                }
            }

            const conversationId = input.conversationId;

            if (
                typeof conversationId !== "number" ||
                !Number.isSafeInteger(conversationId) ||
                conversationId <= 0
            ) {
                continue;
            }

            conversationIds.add(conversationId);
            registerConversation(conversationId);
        }

        cursor = page.next;
    } while (cursor !== undefined);

    return conversationIds;
}

async function fencePersistedAgentThreads(
    harness: Harness,
    references: readonly PersistedAgentThreadReference[],
    conversationId: ConversationId,
    reason: string,
    context: Context,
): Promise<void> {
    for (const reference of references) {
        if (reference.conversationId !== Number(conversationId)) {
            continue;
        }

        await harness.commit(async (tx) => {
            const current = await tx.doc(AGENT_THREAD_DOC, reference.key, reference.key);

            if (current.conversationId !== conversationId) {
                return;
            }

            if (current.status !== "closed") {
                current.status = "unknown";
            }

            for (const turn of current.turns ?? []) {
                if (turn.status !== "completed") {
                    turn.status = "unknown";
                }
            }

            current.unknownReason = reason;
        }, context);
    }
}

export function canRecoverDefinitelyNotSubmittedTurn(input: {
    readonly activeWorkflowOwner: boolean;
    readonly exactTurn: boolean;
    readonly submission: unknown;
    readonly turnStatus: string | undefined;
}): boolean {
    return (
        input.activeWorkflowOwner &&
        input.exactTurn &&
        input.submission === undefined &&
        input.turnStatus === "reserved"
    );
}

export async function recoverAgentRunnerTasks(
    harness: Harness,
    context: Context,
    authorityIsCurrent: WorkflowAgentRecoveryAuthorityCheck,
    storage: Storage,
    registerConversation: (conversationId: number) => void,
): Promise<void> {
    const inspection = await harness.inspect(context);

    if (inspection.scheduling !== "paused") {
        throw new WorkflowAgentAdmissionError(
            "Agent recovery must attach before Harness scheduling resumes",
        );
    }

    const persistedAgentThreads = await registerPersistedAgentConversations(
        storage,
        context,
        registerConversation,
    );
    const persistedAgentRunnerConversationIds = await registerPersistedAgentRunnerConversations(
        storage,
        context,
        registerConversation,
    );

    const allTasks = inspection.tasks.map((task) => task.record);
    const activeTasks = allTasks.filter(
        (task) =>
            task.state.status === "pending" ||
            task.state.status === "running" ||
            task.state.status === "waiting" ||
            task.state.status === "completing",
    );
    const candidates = activeTasks.filter((task) => task.kind === AGENT_RUNNER_TASK_NAME);
    const handledNativeTaskIds = new Set<number>();

    for (const task of candidates) {
        const input = task.input as Partial<AgentThreadIdentity> & {
            readonly schemaVersion?: unknown;
            readonly conversationId?: unknown;
            readonly requestId?: unknown;
            readonly turnId?: unknown;
            readonly threadKey?: unknown;
            readonly intentCanonical?: unknown;
            readonly intentDigest?: unknown;
            readonly content?: unknown;
            readonly workflowTaskId?: unknown;
            readonly policyBinding?: unknown;
        };

        if (
            typeof input.runId !== "string" ||
            input.runId.length === 0 ||
            typeof input.threadId !== "string" ||
            input.threadId.length === 0 ||
            typeof input.profileId !== "string" ||
            input.profileId.length === 0
        ) {
            throw new WorkflowAgentAdmissionError(
                `Agent runner Task ${task.id} has no supported thread identity; recovery remains closed`,
            );
        }

        const identity = {
            runId: input.runId,
            threadId: input.threadId,
            profileId: input.profileId,
        };
        const threadKey = workflowAgentThreadKey(identity);
        const existing = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);

        if (
            existing === undefined ||
            existing.schemaVersion !== 1 ||
            existing.threadKey !== threadKey ||
            existing.runId !== identity.runId ||
            existing.threadId !== identity.threadId ||
            existing.profileId !== identity.profileId
        ) {
            throw new WorkflowAgentAdmissionError(
                `Agent runner Task ${task.id} has no supported durable thread record; recovery remains closed`,
            );
        }

        const runnerTaskId = Number(task.id);
        const turn = existing.turns?.find((candidate) => candidate.runnerTaskId === runnerTaskId);
        const conversationId =
            typeof input.conversationId === "number" &&
            Number.isSafeInteger(input.conversationId) &&
            input.conversationId > 0
                ? (input.conversationId as ConversationId)
                : undefined;
        const requestId =
            typeof input.requestId === "string" && input.requestId.length > 0
                ? input.requestId
                : undefined;
        const parsedPolicyBinding = (() => {
            if (input.policyBinding === undefined) {
                return { valid: true as const, value: undefined };
            }

            try {
                return {
                    valid: true as const,
                    value: parseWorkflowAgentPolicyBinding(input.policyBinding as JsonValue),
                };
            } catch {
                return { valid: false as const, value: undefined };
            }
        })();
        const intentMatches =
            parsedPolicyBinding.valid &&
            typeof input.turnId === "string" &&
            typeof input.intentCanonical === "string" &&
            typeof input.intentDigest === "string" &&
            input.content !== undefined &&
            workflowAgentRunnerIntentMatches({
                threadId: input.threadId,
                turnId: input.turnId,
                profileId: input.profileId,
                content: input.content as JsonValue,
                intentCanonical: input.intentCanonical,
                intentDigest: input.intentDigest,
                ...(parsedPolicyBinding.value === undefined
                    ? {}
                    : { policyBinding: parsedPolicyBinding.value }),
            });
        const exactTurn =
            task.version === 1 &&
            input.schemaVersion === 1 &&
            task.owner === existing.ownerTaskId &&
            input.workflowTaskId === existing.ownerTaskId &&
            intentMatches &&
            conversationId !== undefined &&
            conversationId === existing.conversationId &&
            requestId !== undefined &&
            input.threadKey === threadKey &&
            typeof input.turnId === "string" &&
            typeof input.intentCanonical === "string" &&
            typeof input.intentDigest === "string" &&
            turn !== undefined &&
            turn.turnId === input.turnId &&
            turn.requestId === requestId &&
            turn.intentCanonical === input.intentCanonical &&
            turn.intentDigest === input.intentDigest &&
            persistedJsonMatches(turn.policyBinding, parsedPolicyBinding.value);
        const nativeConversationId =
            typeof existing.conversationId === "number" &&
            Number.isSafeInteger(existing.conversationId) &&
            existing.conversationId > 0
                ? (existing.conversationId as ConversationId)
                : undefined;
        const currentAuthority = await authorityIsCurrent(existing, task.input as JsonValue);

        const nativeTasks =
            nativeConversationId === undefined
                ? []
                : allTasks.filter(
                      (candidate) =>
                          candidate.id !== task.id &&
                          Number(candidate.conversationId) === nativeConversationId,
                  );
        const activeNativeTasks = nativeTasks.filter((candidate) =>
            activeTasks.some((active) => active.id === candidate.id),
        );
        // Inspection lists live tasks only; a waiting Generation's tools phase is the durable
        // reference needed to inspect terminal child outcomes with the public getTask API.
        const toolTaskReferences: { taskId: TaskId; generationTaskId: TaskId }[] = [];
        let malformedToolTaskReference = false;

        for (const nativeTask of nativeTasks) {
            if (nativeTask.kind !== "pi.generation" || nativeTask.state.status === "terminal") {
                continue;
            }

            const checkpoint = (nativeTask.state as { readonly checkpoint?: unknown }).checkpoint;

            if (typeof checkpoint !== "object" || checkpoint === null) {
                continue;
            }

            const generationCheckpoint = checkpoint as {
                readonly phase?: unknown;
                readonly tools?: unknown;
            };

            if (generationCheckpoint.phase !== "tools") {
                continue;
            }

            if (!Array.isArray(generationCheckpoint.tools)) {
                malformedToolTaskReference = true;
                continue;
            }

            for (const toolTaskId of generationCheckpoint.tools) {
                if (
                    typeof toolTaskId !== "number" ||
                    !Number.isSafeInteger(toolTaskId) ||
                    toolTaskId <= 0
                ) {
                    malformedToolTaskReference = true;
                    continue;
                }

                toolTaskReferences.push({
                    taskId: toolTaskId as TaskId,
                    generationTaskId: nativeTask.id as TaskId,
                });
            }
        }

        const observedToolTasks = await Promise.all(
            toolTaskReferences.map(async (reference) => ({
                reference,
                task: await harness.getTask(reference.taskId, context),
            })),
        );
        // A completed tool task is settled. An interrupted execute-phase task is replayable only
        // when both its durable intent and the current implementation prove the replay is safe.
        const safelyReplayableToolTaskIds = new Set<number>();
        let uncertainTerminalToolEffect = malformedToolTaskReference;

        for (const { reference, task: toolTask } of observedToolTasks) {
            if (
                toolTask === undefined ||
                toolTask.kind !== "pi.tool" ||
                toolTask.owner !== reference.generationTaskId ||
                toolTask.conversationId !== nativeConversationId
            ) {
                uncertainTerminalToolEffect = true;
                continue;
            }

            if (toolTask.state.status === "terminal") {
                if (toolTask.state.outcome.status !== "completed") {
                    uncertainTerminalToolEffect = true;
                }

                continue;
            }

            // Resolve the native Agent only after persisted selection validation succeeds.
            if (
                currentAuthority &&
                (await canSafelyReplayToolTask(
                    harness,
                    toolTask,
                    reference,
                    nativeConversationId,
                    existing,
                    input.turnId,
                    context,
                ))
            ) {
                safelyReplayableToolTaskIds.add(Number(toolTask.id));
            } else if (currentAuthority) {
                uncertainTerminalToolEffect = true;
            }
        }

        for (const nativeTask of activeNativeTasks) {
            handledNativeTaskIds.add(Number(nativeTask.id));
        }

        const ownerTaskId =
            typeof existing.ownerTaskId === "number" &&
            Number.isSafeInteger(existing.ownerTaskId) &&
            existing.ownerTaskId > 0
                ? (existing.ownerTaskId as TaskId)
                : undefined;
        const [ownerTask, run, nativeConversation, provider] = await Promise.all([
            ownerTaskId === undefined ? undefined : harness.getTask(ownerTaskId, context),
            harness.snapshot(RUN_DOC, identity.runId, context),
            nativeConversationId === undefined
                ? undefined
                : harness.commit((tx) => tx.conversation(nativeConversationId), context),
            nativeConversationId === undefined
                ? undefined
                : harness.snapshot(ProviderDoc, nativeConversationId, context),
        ]);
        const ownerInput = ownerTask?.input as { readonly runId?: unknown } | undefined;
        const activeWorkflowOwner =
            existing.status === "ready" &&
            ownerTaskId !== undefined &&
            ownerTask?.kind === "pocket.workflow-runtime.task" &&
            !ownerTask.abortRequested &&
            ownerTask.state.status !== "terminal" &&
            ownerTask.state.status !== "completing" &&
            ownerInput?.runId === identity.runId &&
            run !== undefined &&
            run.runId === identity.runId &&
            run.taskId === ownerTaskId &&
            run.stopCommand === undefined &&
            run.selectedOutcome === undefined &&
            (run.status === "running" || run.status === "waiting") &&
            nativeConversation?.owner?.taskId === ownerTaskId &&
            nativeConversation.owner.conversationId === ownerTask.conversationId &&
            provider?.sessionId === existing.providerSessionId;
        const submission =
            exactTurn && conversationId !== undefined && requestId !== undefined
                ? await harness.commit(
                      (tx) => tx.submissionByRequest(conversationId, requestId),
                      context,
                  )
                : undefined;
        const nativeInputEntry =
            submission?.type === "input" && submission.entry !== undefined
                ? await harness.commit((tx) => tx.entry(UserEntry, submission.entry!), context)
                : undefined;
        const nativeUserMessage = nativeInputEntry?.model?.[0];
        let nativeInputMatchesIntent = false;

        if (
            nativeInputEntry?.conversationId === conversationId &&
            nativeUserMessage?.role === "user" &&
            typeof input.intentCanonical === "string"
        ) {
            try {
                nativeInputMatchesIntent =
                    canonicalInput(nativeUserMessage.content as unknown as JsonValue).canonical ===
                    canonicalInput(input.content as JsonValue).canonical;
            } catch {
                nativeInputMatchesIntent = false;
            }
        }

        const exactSubmissionReference =
            turn?.submissionId === undefined ||
            (typeof turn.submissionId === "number" &&
                Number.isSafeInteger(turn.submissionId) &&
                typeof submission?.id === "number" &&
                Number.isSafeInteger(submission.id) &&
                turn.submissionId === submission.id);
        const exactPlacedSubmission =
            submission?.type === "input" &&
            submission.status === "placed" &&
            submission.conversationId === conversationId &&
            submission.requestId === requestId &&
            nativeInputMatchesIntent &&
            exactSubmissionReference;
        const priorTurnsSettled =
            exactTurn &&
            (existing.turns ?? []).every(
                (candidate) =>
                    candidate.turnId === input.turnId ||
                    candidate.status === "completed" ||
                    candidate.status === "not-completed",
            );
        const exactCompletedSubmission =
            exactTurn &&
            submission?.status === "done" &&
            submission.type === "input" &&
            submission.conversationId === conversationId &&
            submission.requestId === requestId &&
            submission.answer !== undefined &&
            nativeInputMatchesIntent &&
            exactSubmissionReference;
        const definitelyNotSubmitted = canRecoverDefinitelyNotSubmittedTurn({
            activeWorkflowOwner,
            exactTurn,
            submission,
            turnStatus: turn?.status,
        });
        const safelyResumableProviderWork =
            currentAuthority &&
            !uncertainTerminalToolEffect &&
            activeWorkflowOwner &&
            !task.abortRequested &&
            exactTurn &&
            exactPlacedSubmission &&
            priorTurnsSettled &&
            (turn?.status === "reserved" || turn?.status === "submitted") &&
            activeNativeTasks.length > 0 &&
            activeNativeTasks.every(
                (candidate) =>
                    !candidate.abortRequested &&
                    (candidate.kind === "pi.generation" ||
                        candidate.kind === "pi.compaction" ||
                        (candidate.kind === "pi.tool" &&
                            safelyReplayableToolTaskIds.has(Number(candidate.id)))),
            );

        if (
            currentAuthority &&
            !uncertainTerminalToolEffect &&
            ((activeWorkflowOwner &&
                !task.abortRequested &&
                priorTurnsSettled &&
                activeNativeTasks.length === 0 &&
                (exactCompletedSubmission || definitelyNotSubmitted)) ||
                safelyResumableProviderWork)
        ) {
            // A missing submission proves no provider request was scheduled; an exact done
            // submission is replayed from its answer reference. Active Generation/Compaction tasks
            // use Pi Durable's retry semantics. An interrupted ToolTask is allowed only when its
            // persisted execute intent and current safe implementation agree; the host guard still
            // revalidates admission, selection, and arguments at actual execution.
            continue;
        }

        await harness.commit(async (tx) => {
            const current = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);
            const currentTurn = current.turns?.find(
                (candidate) => candidate.runnerTaskId === runnerTaskId,
            );

            if (
                current.runId !== identity.runId ||
                current.threadId !== identity.threadId ||
                current.profileId !== identity.profileId ||
                currentTurn?.turnId !== turn?.turnId
            ) {
                throw new WorkflowAgentAdmissionError(
                    `Agent runner Task ${task.id} conflicts with its durable thread record`,
                );
            }

            if (current.status !== "closed") {
                current.status = "unknown";
            }

            if (currentTurn !== undefined) {
                currentTurn.status = "unknown";
            }

            if (!currentAuthority) {
                current.unknownReason =
                    "Agent profile authority or model fingerprint changed before native recovery";
            } else if (uncertainTerminalToolEffect) {
                current.unknownReason =
                    "An interrupted native tool effect is not proven safe to replay";
            } else if (activeWorkflowOwner) {
                current.unknownReason = "Native provider work is unsupported for safe recovery";
            } else {
                current.unknownReason = "Workflow owner stopped or changed before native recovery";
            }

            current.nativeRunnerTaskId = runnerTaskId;
        }, context);

        for (const nativeTask of activeNativeTasks) {
            await harness.abortTask(nativeTask.id as TaskId, context);
        }

        await harness.abortTask(task.id as TaskId, context);
    }

    for (const nativeTask of activeTasks) {
        if (
            nativeTask.kind === AGENT_RUNNER_TASK_NAME ||
            handledNativeTaskIds.has(Number(nativeTask.id)) ||
            !Number.isSafeInteger(nativeTask.conversationId) ||
            Number(nativeTask.conversationId) <= 0
        ) {
            continue;
        }

        const conversationId = Number(nativeTask.conversationId) as ConversationId;
        const persistedThreads = persistedAgentThreads.get(Number(conversationId)) ?? [];
        const provider = await harness.snapshot(ProviderDoc, conversationId, context);
        const sessionId = provider?.sessionId;

        if (sessionId === undefined || !hasWorkflowAgentProviderSessionIdPrefix(sessionId)) {
            if (
                persistedThreads.length === 0 &&
                !persistedAgentRunnerConversationIds.has(Number(conversationId))
            ) {
                continue;
            }

            await fencePersistedAgentThreads(
                harness,
                persistedThreads,
                conversationId,
                "Adapter-owned native task lacks its exact ProviderDoc/thread correlation",
                context,
            );
            await harness.abortTask(nativeTask.id as TaskId, context);
            continue;
        }

        const parsed = parseWorkflowAgentProviderSessionId(sessionId);

        if (parsed === undefined) {
            await fencePersistedAgentThreads(
                harness,
                persistedThreads,
                conversationId,
                "Adapter-owned native task has a malformed ProviderDoc/thread correlation",
                context,
            );
            await harness.abortTask(nativeTask.id as TaskId, context);
            continue;
        }

        const thread = await harness.snapshot(AGENT_THREAD_DOC, parsed.key, context);
        const exactThreadMatch =
            thread !== undefined &&
            thread.schemaVersion === 1 &&
            thread.threadKey === parsed.key &&
            thread.runId === parsed.identity.runId &&
            thread.threadId === parsed.identity.threadId &&
            thread.profileId === parsed.identity.profileId &&
            thread.conversationId === conversationId &&
            thread.providerSessionId === sessionId;

        if (exactThreadMatch) {
            await harness.commit(async (tx) => {
                const current = await tx.doc(AGENT_THREAD_DOC, parsed.key, parsed.key);

                if (
                    current.runId !== parsed.identity.runId ||
                    current.threadId !== parsed.identity.threadId ||
                    current.profileId !== parsed.identity.profileId ||
                    current.providerSessionId !== sessionId ||
                    current.conversationId !== conversationId
                ) {
                    return;
                }

                if (current.status !== "closed") {
                    current.status = "unknown";
                }

                for (const turn of current.turns ?? []) {
                    if (turn.status !== "completed") {
                        turn.status = "unknown";
                    }
                }

                current.unknownReason =
                    "Adapter-owned native task has no matching active workflow runner";
            }, context);
        } else if (persistedThreads.length > 0) {
            await fencePersistedAgentThreads(
                harness,
                persistedThreads,
                conversationId,
                "Adapter-owned native task has no exact ProviderDoc/thread correlation",
                context,
            );
        }

        await harness.abortTask(nativeTask.id as TaskId, context);
    }
}
