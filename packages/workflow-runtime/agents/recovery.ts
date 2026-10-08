import type { Context, JsonValue } from "@earendil-works/chord";
import {
    type ConversationId,
    Harness,
    ProviderDoc,
    UserEntry,
    type TaskId,
} from "@earendil-works/pi-durable";
import { canonicalInput } from "../core/identity.ts";
import {
    type AgentThreadIdentity,
    hasWorkflowAgentProviderSessionIdPrefix,
    parseWorkflowAgentProviderSessionId,
    workflowAgentThreadKey,
} from "./profile.ts";
import { RUN_DOC } from "../core/index.ts";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    WorkflowAgentAdmissionError,
} from "./records.ts";
import { workflowAgentRunnerIntentMatches } from "./runner.ts";

export async function recoverAgentRunnerTasks(harness: Harness, context: Context): Promise<void> {
    const inspection = await harness.inspect(context);

    if (inspection.scheduling !== "paused") {
        throw new WorkflowAgentAdmissionError(
            "Agent recovery must attach before Harness scheduling resumes",
        );
    }

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
            readonly conversationId?: unknown;
            readonly requestId?: unknown;
            readonly turnId?: unknown;
            readonly threadKey?: unknown;
            readonly intentCanonical?: unknown;
            readonly intentDigest?: unknown;
            readonly content?: unknown;
            readonly workflowTaskId?: unknown;
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
        const intentMatches =
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
            });
        const exactTurn =
            task.version === 1 &&
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
            turn.intentDigest === input.intentDigest;
        const nativeConversationId =
            typeof existing.conversationId === "number" &&
            Number.isSafeInteger(existing.conversationId) &&
            existing.conversationId > 0
                ? (existing.conversationId as ConversationId)
                : undefined;
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
        // A missing, mismatched, failed, or aborted tool Task cannot prove its external effect did not occur.
        const uncertainTerminalToolEffect =
            malformedToolTaskReference ||
            observedToolTasks.some(
                ({ reference, task: toolTask }) =>
                    toolTask === undefined ||
                    toolTask.kind !== "pi.tool" ||
                    toolTask.owner !== reference.generationTaskId ||
                    toolTask.conversationId !== nativeConversationId ||
                    toolTask.state.status !== "terminal" ||
                    toolTask.state.outcome.status !== "completed",
            );

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
            (submission !== undefined && Number(turn.submissionId) === Number(submission.id));
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
        const definitelyNotSubmitted =
            activeWorkflowOwner &&
            exactTurn &&
            submission === undefined &&
            (turn?.status === "reserved" || turn?.status === "not-completed");
        const safelyResumableProviderWork =
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
                    (candidate.kind === "pi.generation" || candidate.kind === "pi.compaction"),
            );

        if (
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
            // are resumed by Pi Durable under its standard retry semantics. Any live tool or unknown
            // task kind remains fenced below.
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

            current.unknownReason = activeWorkflowOwner
                ? "An interrupted native tool or unsupported task cannot be safely resumed"
                : "Workflow owner stopped or changed before native recovery";
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
        const provider = await harness.snapshot(ProviderDoc, conversationId, context);
        const sessionId = provider?.sessionId;

        if (sessionId === undefined || !hasWorkflowAgentProviderSessionIdPrefix(sessionId)) {
            continue;
        }

        const parsed = parseWorkflowAgentProviderSessionId(sessionId);

        if (parsed !== undefined) {
            const thread = await harness.snapshot(AGENT_THREAD_DOC, parsed.key, context);

            if (
                thread !== undefined &&
                thread.schemaVersion === 1 &&
                thread.threadKey === parsed.key &&
                thread.runId === parsed.identity.runId &&
                thread.threadId === parsed.identity.threadId &&
                thread.profileId === parsed.identity.profileId &&
                thread.conversationId === conversationId &&
                thread.providerSessionId === sessionId
            ) {
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
            }
        }

        await harness.abortTask(nativeTask.id as TaskId, context);
    }
}
