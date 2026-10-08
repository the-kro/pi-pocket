import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    createAssistantMessageEventStream,
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    Type,
} from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    defineTool,
    Harness,
    UserEntry,
    type ConversationId,
    type Storage,
    type StorageWrite,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    createWorkflowAgentRuntime,
    type AgentThreadRecord,
    type WorkflowAgentHostSetup,
} from "../../packages/workflow-runtime/agents/recovery.ts";
import { workflowAgentThreadKey } from "../../packages/workflow-runtime/agents/profile.ts";
import {
    defineWorkflow,
    RUN_DOC,
    type WorkflowContext,
} from "../../packages/workflow-runtime/core/index.ts";

const mode = process.env.PI_AGENT_MODE;
const database = process.env.PI_AGENT_DB;
const markerFile = process.env.PI_AGENT_MARKERS;
const boundary = process.env.PI_AGENT_BOUNDARY;
const context = BACKGROUND_CONTEXT;

if (
    (mode !== "start" &&
        mode !== "recover" &&
        mode !== "tamper" &&
        mode !== "tamper-content" &&
        mode !== "tamper-native-entry" &&
        mode !== "tamper-owner-id" &&
        mode !== "tamper-workflow-task-id" &&
        mode !== "abort-owner" &&
        mode !== "terminal-runner") ||
    database === undefined ||
    markerFile === undefined ||
    boundary === undefined
) {
    throw new Error("Missing workflow agent crash-worker configuration");
}

function controlledBoundary(name: string, detail = ""): never {
    writeSync(1, `BOUNDARY:${name}${detail}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);

    throw new Error("Unreachable crash boundary");
}

function durableDispatchMarker(): void {
    const descriptor = openSync(markerFile!, "a");
    const content = "faux-provider-dispatch\n";

    try {
        writeSync(descriptor, content);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function durableDeferredPollMarker(): void {
    const descriptor = openSync(`${markerFile}.polls`, "a");
    const content = "faux-deferred-poll\n";

    try {
        writeSync(descriptor, content);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function durableToolDispatchMarker(): void {
    const descriptor = openSync(`${markerFile}.tools`, "a");
    const content = "faux-tool-dispatch\n";

    try {
        writeSync(descriptor, content);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function hasTurnStatus(value: unknown, status: string): boolean {
    if (typeof value !== "object" || value === null || !("turns" in value)) {
        return false;
    }

    return (
        Array.isArray(value.turns) &&
        value.turns.some(
            (turn) =>
                typeof turn === "object" &&
                turn !== null &&
                "status" in turn &&
                turn.status === status,
        )
    );
}

const faux = fauxProvider();
const models = createModels();
const baseProvider = faux.provider;
let providerDispatchCount = 0;
const provider = {
    ...baseProvider,
    api: "faux-process-crash-v1",
    getModels: (...args: Parameters<typeof baseProvider.getModels>) =>
        baseProvider.getModels(...args).map((candidate) => ({
            ...candidate,
            api: "faux-process-crash-v1",
            ...(boundary === "compaction-dispatched" ? { contextWindow: 32 } : {}),
        })),
    streamSimple: (...args: Parameters<typeof baseProvider.streamSimple>) => {
        durableDispatchMarker();
        providerDispatchCount += 1;

        if (
            mode === "start" &&
            (boundary === "provider-dispatched" || boundary === "timer-open-race") &&
            providerDispatchCount === 1
        ) {
            controlledBoundary(boundary);
        }

        if (
            mode === "start" &&
            boundary === "later-provider-dispatched" &&
            providerDispatchCount === 2
        ) {
            controlledBoundary("later-provider-dispatched");
        }

        if (
            mode === "start" &&
            boundary === "compaction-dispatched" &&
            providerDispatchCount === 2
        ) {
            controlledBoundary("compaction-dispatched");
        }

        if (
            mode === "start" &&
            boundary === "later-provider-after-tool" &&
            providerDispatchCount === 3
        ) {
            controlledBoundary("later-provider-after-tool");
        }

        const stream = baseProvider.streamSimple(...args);

        if (
            mode === "start" &&
            boundary === "response-before-classify" &&
            providerDispatchCount === 1
        ) {
            const result = stream.result.bind(stream);

            stream.result = async () => {
                const message = await result();

                controlledBoundary("response-before-classify");

                return message;
            };
        }

        return stream;
    },
    fetchDeferred(model: Parameters<typeof baseProvider.streamSimple>[0]) {
        durableDeferredPollMarker();

        if (mode === "start" && boundary === "deferred-poll-dispatched") {
            controlledBoundary("deferred-poll-dispatched");
        }

        const stream = createAssistantMessageEventStream();
        const message = {
            ...fauxAssistantMessage("deferred result"),
            api: model.api,
            provider: model.provider,
            model: model.id,
        };

        queueMicrotask(() => {
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
        });

        return stream;
    },
};

models.setProvider(provider);
const deferredHandle = {
    provider: "faux",
    modelId: "faux-1",
    api: "faux-process-crash-v1",
    id: "process-crash-deferred",
    pollAfterMs: 5,
};

const unsafeToolResponse = fauxAssistantMessage(
    [fauxToolCall("unsafe_effect", { label: "side effect" }, { id: "unsafe-call-1" })],
    { stopReason: "toolUse" },
);

function fixtureResponses() {
    if (boundary === "later-provider-dispatched") {
        return mode === "recover"
            ? [fauxAssistantMessage("saved after the later dispatch")]
            : [
                  fauxAssistantMessage("first settled native turn"),
                  fauxAssistantMessage("saved after the later dispatch"),
              ];
    }

    if (boundary === "generation-poll" || boundary === "deferred-poll-dispatched") {
        return [
            fauxAssistantMessage("deferred", {
                stopReason: "deferred",
                deferred: deferredHandle,
            }),
        ];
    }

    if (boundary === "tool-dispatched") {
        return [fauxAssistantMessage("first settled native turn"), unsafeToolResponse];
    }

    if (boundary === "tool-effect-then-fail") {
        return mode === "recover"
            ? [fauxAssistantMessage("answer after failed tool execution")]
            : [fauxAssistantMessage("first settled native turn"), unsafeToolResponse];
    }

    if (boundary === "later-provider-after-tool") {
        return mode === "recover"
            ? [fauxAssistantMessage("saved after the tool round")]
            : [
                  fauxAssistantMessage("first settled native turn"),
                  unsafeToolResponse,
                  fauxAssistantMessage("saved after the tool round"),
              ];
    }

    if (boundary === "tool-round-prepare") {
        return mode === "recover"
            ? [fauxAssistantMessage("recovered after the tool effect")]
            : [fauxAssistantMessage("first settled native turn"), unsafeToolResponse];
    }

    if (boundary === "compaction-dispatched") {
        return mode === "recover"
            ? [
                  fauxAssistantMessage("summary after recovery"),
                  fauxAssistantMessage("recovered after compaction"),
              ]
            : [
                  fauxAssistantMessage("first settled native turn"),
                  fauxAssistantMessage("summary after recovery"),
              ];
    }

    return [fauxAssistantMessage("saved before runner receipt")];
}

faux.setResponses(fixtureResponses());
const model = models.getModel("faux", "faux-1")!;
const profile = {
    id: "process-crash",
    version: 1,
    instructions: "Return a short answer.",
    instructionsVersion: "1",
    model: {
        provider: "faux",
        modelId: "faux-1",
        api: model.api,
        providerVersion: "faux-process-test-v1",
    },
} as const;
const registry = createRegistry();
const unsafeEffect = defineTool({
    name: "unsafe_effect",
    description: "Record one test side effect before returning.",
    parameters: Type.Object({ label: Type.String() }),
    replay: "unsafe",
    execute: async (args) => {
        durableToolDispatchMarker();

        if (mode === "start" && boundary === "tool-dispatched") {
            controlledBoundary("tool-dispatched");
        }

        if (mode === "start" && boundary === "tool-effect-then-fail") {
            throw new Error(`fixture failed after effect:${args.label}`);
        }

        return { content: [{ type: "text", text: `effect:${args.label}` }] };
    },
});
const unsafeEffectExtension = defineExtension({
    name: "crash-fixture-unsafe-effect",
    tools: [unsafeEffect],
});

registry.install(unsafeEffectExtension);
const originalStorage = await openNodeSqliteStorage(database);
const storage = new Proxy(originalStorage, {
    get(target, property, receiver) {
        if (property === "commit") {
            return async (
                writes: readonly StorageWrite[],
                commitContext: Parameters<Storage["commit"]>[1],
            ) => {
                const done = writes.find(
                    (write) => write.type === "submission" && write.value.status === "done",
                );
                const nativeSubmission = writes.find(
                    (write) =>
                        write.type === "submission" &&
                        typeof write.value.requestId === "string" &&
                        write.value.requestId.startsWith("pocket-workflow-agent-turn-v1:"),
                );
                const runnerCreated = writes.some(
                    (write) => write.type === "task" && write.value.kind === AGENT_RUNNER_TASK_NAME,
                );
                const threadCreated = writes.some(
                    (write) =>
                        write.type === "document.create" &&
                        write.record.kind === AGENT_THREAD_DOC.definition.kind,
                );
                const failedTool = writes.some(
                    (write) =>
                        write.type === "task" &&
                        write.value.kind === "pi.tool" &&
                        write.value.state.status === "terminal" &&
                        write.value.state.outcome.status === "failed",
                );

                if (
                    mode === "start" &&
                    boundary === "before-intent-commit" &&
                    runnerCreated &&
                    threadCreated
                ) {
                    controlledBoundary("before-intent-commit");
                }

                const sequence = await target.commit(writes, commitContext);

                if (mode === "start" && boundary === "tool-effect-then-fail" && failedTool) {
                    controlledBoundary("tool-effect-then-fail");
                }

                if (
                    mode === "start" &&
                    boundary === "generation-poll" &&
                    writes.some(
                        (write) =>
                            write.type === "task" &&
                            write.value.kind === "pi.generation" &&
                            JSON.stringify(write.value.state).includes('"phase":"poll"'),
                    )
                ) {
                    controlledBoundary("generation-poll");
                }

                if (
                    mode === "start" &&
                    boundary === "tool-round-prepare" &&
                    providerDispatchCount >= 2 &&
                    writes.some(
                        (write) =>
                            write.type === "task" &&
                            write.value.kind === "pi.generation" &&
                            JSON.stringify(write.value.state).includes('"phase":"prepare"'),
                    )
                ) {
                    controlledBoundary("tool-round-prepare");
                }

                if (
                    mode === "recover" &&
                    boundary === "unknown-fence-committed" &&
                    JSON.stringify(writes).includes('"unknown"')
                ) {
                    controlledBoundary("unknown-fence-committed");
                }

                if (
                    mode === "start" &&
                    boundary === "submission-committed" &&
                    nativeSubmission?.type === "submission"
                ) {
                    controlledBoundary(
                        "submission-committed:",
                        JSON.stringify({
                            submissionId: Number(nativeSubmission.value.id),
                            status: nativeSubmission.value.status,
                        }),
                    );
                }

                if (
                    mode === "start" &&
                    boundary === "answer-committed" &&
                    done?.type === "submission"
                ) {
                    controlledBoundary(
                        "answer-committed:",
                        JSON.stringify({
                            submissionId: Number(done.value.id),
                            answerEntryId: Number(done.value.answer),
                        }),
                    );
                }

                return sequence;
            };
        }

        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
    },
}) as Storage;
let startupSetup: WorkflowAgentHostSetup | undefined;
let stopDuringTimerScan: Promise<void> | undefined;
const runtime = createWorkflowAgentRuntime({
    harnessOptions: {
        models,
        registry,
        ...(boundary === "compaction-dispatched"
            ? {
                  settings: {
                      compaction: {
                          enabled: true,
                          reserveTokens: 8,
                          keepRecentTokens: 0,
                          backgroundTokens: 0,
                      },
                  },
              }
            : {}),
    },
    agentConfig: { profiles: [profile] },
    ...(mode === "recover" && boundary === "timer-open-race"
        ? {
              timerOptions: {
                  scheduleAt: () => {
                      if (stopDuringTimerScan === undefined) {
                          if (startupSetup === undefined) {
                              throw new Error(
                                  "Timer scan ran before restricted startup setup was assigned",
                              );
                          }

                          const threadKey = workflowAgentThreadKey({
                              runId: "agent-crash-run",
                              threadId: "crash-thread",
                              profileId: profile.id,
                          });

                          stopDuringTimerScan = startupSetup
                              .updateDocuments(async (writer) => {
                                  const run = await writer.sessionFamily(
                                      RUN_DOC,
                                      "agent-crash-run",
                                      "agent-crash-run",
                                  );
                                  const thread = await writer.sessionFamily(
                                      AGENT_THREAD_DOC,
                                      threadKey,
                                      threadKey,
                                  );

                                  run.stopCommand = { reason: "timer-scan stop", request: 1 };
                                  run.selectedOutcome = {
                                      status: "stopped",
                                      reason: "timer-scan stop",
                                  };
                                  run.status = "stopped";
                                  thread.status = "closed";
                              })
                              .then(() => {
                                  process.stdout.write("STOP-SELECTED-DURING-TIMER-SCAN\n");
                              });
                      }

                      return () => {};
                  },
              },
          }
        : {}),
});

registry.install(runtime.extension);
let harness!: Harness;
const workflow = defineWorkflow({
    id: "agent-process-crash",
    version: 1,
    async run({ agent }: WorkflowContext<null>) {
        if (agent === undefined) {
            throw new Error("Agent binding is unavailable");
        }

        if (
            boundary === "later-provider-dispatched" ||
            boundary === "compaction-dispatched" ||
            boundary === "tool-dispatched" ||
            boundary === "tool-effect-then-fail" ||
            boundary === "later-provider-after-tool" ||
            boundary === "tool-round-prepare"
        ) {
            await agent.turn({
                threadId: "crash-thread",
                turnId: "prior-turn",
                profile: profile.id,
                content: "Produce the first settled result.",
            });
        }

        if (
            mode === "start" &&
            (boundary === "tool-dispatched" ||
                boundary === "tool-effect-then-fail" ||
                boundary === "later-provider-after-tool" ||
                boundary === "tool-round-prepare")
        ) {
            const threadKey = workflowAgentThreadKey({
                runId: "agent-crash-run",
                threadId: "crash-thread",
                profileId: profile.id,
            });
            const thread = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);
            const conversation =
                thread === undefined
                    ? undefined
                    : await harness.conversation(thread.conversationId as never, context);

            if (conversation === undefined) {
                throw new Error("Cannot configure the crash-fixture agent conversation");
            }

            await conversation.configure(
                { extensions: [unsafeEffectExtension], tools: [unsafeEffect] },
                context,
            );
        }

        return agent.turn({
            threadId: "crash-thread",
            turnId: "crash-turn",
            profile: profile.id,
            content:
                boundary === "compaction-dispatched"
                    ? "x ".repeat(2_000)
                    : "Produce the saved result.",
        });
    },
});
const timerScanWorkflow = defineWorkflow({
    id: "agent-timer-open-scan",
    version: 1,
    async run({ step }: WorkflowContext<null>) {
        await step.sleepUntil("wait-for-timer-scan", Date.now() + 60_000);

        return null;
    },
});

let hostDispose: (() => Promise<void>) | undefined;

let unsubscribe = () => {};

let preopen: AgentThreadRecord | undefined;
let nativeTasks: {
    id: number;
    owner?: number;
    conversationId: number;
    kind: string;
    version: number;
    status: string;
    outcome?: unknown;
    checkpoint?: unknown;
    input: unknown;
}[] = [];

if (mode === "start" || mode === "recover") {
    runtime.register(workflow);

    if (boundary === "timer-open-race") {
        runtime.register(timerScanWorkflow);
    }

    const host = await runtime.openHost(storage, context, async (setup) => {
        startupSetup = setup;

        if (mode === "start") {
            unsubscribe = setup.subscribeCommits((publication) => {
                if (boundary !== "intent-committed" && boundary !== "mapping-committed") {
                    return;
                }

                for (const change of publication.changes) {
                    if (
                        change.type !== "document" ||
                        change.record.kind !== AGENT_THREAD_DOC.definition.kind
                    ) {
                        continue;
                    }

                    if (
                        boundary === "intent-committed" &&
                        hasTurnStatus(change.value, "reserved")
                    ) {
                        controlledBoundary("intent-committed");
                    }

                    if (
                        boundary === "mapping-committed" &&
                        hasTurnStatus(change.value, "submitted")
                    ) {
                        controlledBoundary("mapping-committed");
                    }
                }
            });
        } else {
            const key = workflowAgentThreadKey({
                runId: "agent-crash-run",
                threadId: "crash-thread",
                profileId: profile.id,
            });
            const beforeAttach = await setup.snapshot(AGENT_THREAD_DOC, key, context);

            if (boundary === "tamper-turn-submission-id") {
                await setup.updateDocuments(async (writer) => {
                    const thread = await writer.sessionFamily(AGENT_THREAD_DOC, key, key);
                    const turn = thread.turns?.[0];

                    if (turn === undefined) {
                        throw new Error("Cannot tamper a missing native agent turn");
                    }

                    turn.submissionId = 0;
                });
                const updated = await setup.snapshot(AGENT_THREAD_DOC, key, context);

                process.stdout.write(
                    `SETUP:TAMPERED:turn-submission-id:${updated?.turns?.[0]?.submissionId ?? "missing"}\n`,
                );
            }

            nativeTasks = (await setup.inspect()).tasks
                .map((candidate) => candidate.record)
                .filter(
                    (candidate) =>
                        candidate.id !== beforeAttach?.turns?.[0]?.runnerTaskId &&
                        Number(candidate.conversationId) === Number(beforeAttach?.conversationId),
                )
                .map((candidate) => ({
                    id: Number(candidate.id),
                    owner: candidate.owner === undefined ? undefined : Number(candidate.owner),
                    conversationId: Number(candidate.conversationId),
                    kind: candidate.kind,
                    version: candidate.version,
                    status: candidate.state.status,
                    outcome:
                        candidate.state.status === "terminal" ? candidate.state.outcome : undefined,
                    checkpoint: candidate.state.checkpoint,
                    input: candidate.input,
                }));
            const referencedToolTaskIds = new Set<number>();

            for (const candidate of nativeTasks) {
                if (candidate.kind !== "pi.generation") {
                    continue;
                }

                const checkpoint = candidate.checkpoint;

                if (typeof checkpoint !== "object" || checkpoint === null) {
                    continue;
                }

                const toolIds = (checkpoint as { readonly tools?: unknown }).tools;

                if (!Array.isArray(toolIds)) {
                    continue;
                }

                for (const taskId of toolIds) {
                    if (typeof taskId === "number" && Number.isSafeInteger(taskId) && taskId > 0) {
                        referencedToolTaskIds.add(taskId);
                    }
                }
            }

            for (const taskId of referencedToolTaskIds) {
                const toolTask = await setup.getTask(taskId as never);

                if (
                    toolTask === undefined ||
                    nativeTasks.some((candidate) => candidate.id === taskId)
                ) {
                    continue;
                }

                nativeTasks.push({
                    id: Number(toolTask.id),
                    owner: toolTask.owner === undefined ? undefined : Number(toolTask.owner),
                    conversationId: Number(toolTask.conversationId),
                    kind: toolTask.kind,
                    version: toolTask.version,
                    status: toolTask.state.status,
                    outcome:
                        toolTask.state.status === "terminal" ? toolTask.state.outcome : undefined,
                    checkpoint: toolTask.state.checkpoint,
                    input: toolTask.input,
                });
            }

            process.stdout.write(`NATIVE-PREATTACH:${JSON.stringify(nativeTasks)}\n`);
            unsubscribe = setup.subscribeCommits((publication) => {
                for (const change of publication.changes) {
                    if (
                        change.type === "document" &&
                        change.record.kind === AGENT_THREAD_DOC.definition.kind &&
                        change.value?.status === "unknown"
                    ) {
                        process.stdout.write("RECOVERY:unknown-fence-committed\n");
                    }

                    if (change.type === "task" && change.value.abortRequested) {
                        process.stdout.write(
                            change.value.kind === AGENT_RUNNER_TASK_NAME
                                ? "RECOVERY:runner-abort-requested\n"
                                : `RECOVERY:native-abort-requested:${Number(change.value.id)}\n`,
                        );
                    }
                }
            });
            setup.onAfterAdapterRecovery(async (recoverySetup) => {
                if (boundary === "stop-before-open") {
                    await recoverySetup.updateDocuments(async (writer) => {
                        const run = await writer.sessionFamily(
                            RUN_DOC,
                            "agent-crash-run",
                            "agent-crash-run",
                        );
                        const thread = await writer.sessionFamily(AGENT_THREAD_DOC, key, key);

                        run.stopCommand = { reason: "fixture stop", request: 1 };
                        run.selectedOutcome = { status: "stopped", reason: "fixture stop" };
                        run.status = "stopped";
                        thread.status = "closed";
                    });
                    const stoppedThread = await recoverySetup.snapshot(
                        AGENT_THREAD_DOC,
                        key,
                        context,
                    );

                    process.stdout.write(
                        `STOP-SELECTED-BETWEEN-ATTACH-OPEN:${JSON.stringify(stoppedThread)}\n`,
                    );
                }

                preopen = await recoverySetup.snapshot(AGENT_THREAD_DOC, key, context);
                process.stdout.write(`PREOPEN:${JSON.stringify(preopen ?? null)}\n`);

                if (boundary === "recovery-preopen") {
                    controlledBoundary("recovery-preopen");
                }
            });
        }

        return undefined;
    });

    harness = host.harness;
    hostDispose = host.dispose;
} else {
    harness = await Harness.open(storage, { models, registry }, context);
}

if (mode === "tamper-native-entry") {
    const key = workflowAgentThreadKey({
        runId: "agent-crash-run",
        threadId: "crash-thread",
        profileId: profile.id,
    });
    const thread = await harness.snapshot(AGENT_THREAD_DOC, key, context);
    const turn = thread?.turns?.[0];
    const submission =
        thread === undefined || turn === undefined
            ? undefined
            : await harness.commit(
                  (tx) =>
                      tx.submissionByRequest(
                          thread.conversationId as ConversationId,
                          turn.requestId,
                      ),
                  context,
              );

    if (
        thread === undefined ||
        turn === undefined ||
        submission?.type !== "input" ||
        submission.entry === undefined
    ) {
        throw new Error("Cannot tamper a missing native agent input entry");
    }

    const entry = await harness.commit((tx) => tx.entry(UserEntry, submission.entry!), context);
    const firstMessage = entry?.model?.[0];

    if (entry === undefined || firstMessage?.role !== "user") {
        throw new Error("Cannot tamper a malformed native agent input entry");
    }

    const tamperedEntry = await harness.commit(
        (tx) =>
            tx.appendEntry(UserEntry, thread.conversationId as ConversationId, {
                model: [{ ...firstMessage, content: "tampered native agent input" }],
            }),
        context,
    );
    const tamperedSubmission = { ...submission, entry: tamperedEntry.id };

    await originalStorage.commit([{ type: "submission", value: tamperedSubmission }], context);
    await harness.close(context);
    process.stdout.write("TAMPERED:native-entry\n");
} else if (
    mode === "tamper" ||
    mode === "tamper-content" ||
    mode === "tamper-owner-id" ||
    mode === "tamper-workflow-task-id"
) {
    const runner = (await harness.inspect(context)).tasks.find(
        (candidate) => candidate.record.kind === AGENT_RUNNER_TASK_NAME,
    )?.record;

    if (runner === undefined) {
        throw new Error("Cannot tamper a missing agent runner task");
    }

    const value =
        mode === "tamper"
            ? { ...runner, version: 2 }
            : mode === "tamper-content"
              ? {
                    ...runner,
                    input: {
                        ...(runner.input as Record<string, unknown>),
                        content: "mutated after agent intent admission",
                    },
                }
              : mode === "tamper-owner-id"
                ? { ...runner, owner: Number(runner.owner ?? 0) + 1_000 }
                : {
                      ...runner,
                      input: {
                          ...(runner.input as Record<string, unknown>),
                          workflowTaskId:
                              Number(
                                  (runner.input as Record<string, unknown>).workflowTaskId ?? 0,
                              ) + 1_000,
                      },
                  };

    await originalStorage.commit([{ type: "task", value: value as typeof runner }], context);
    await harness.close(context);
    process.stdout.write(
        mode === "tamper"
            ? "TAMPERED:runner-version-2\n"
            : mode === "tamper-content"
              ? "TAMPERED:runner-content\n"
              : mode === "tamper-owner-id"
                ? "TAMPERED:runner-owner\n"
                : "TAMPERED:workflow-task-id\n",
    );
} else if (mode === "terminal-runner") {
    const runner = (await harness.inspect(context)).tasks.find(
        (candidate) => candidate.record.kind === AGENT_RUNNER_TASK_NAME,
    )?.record;

    if (runner === undefined) {
        throw new Error("Crash fixture has no runner Task to terminalize");
    }

    const value = {
        ...runner,
        state: { status: "terminal", outcome: { status: "aborted", reason: "fixture" } },
    } as typeof runner;

    await originalStorage.commit([{ type: "task", value }], context);
    await harness.close(context);
    process.stdout.write("TERMINAL:runner\n");
} else if (mode === "abort-owner") {
    const key = workflowAgentThreadKey({
        runId: "agent-crash-run",
        threadId: "crash-thread",
        profileId: profile.id,
    });
    const thread = await harness.snapshot(AGENT_THREAD_DOC, key, context);

    if (thread?.ownerTaskId === undefined) {
        throw new Error("Crash fixture has no workflow owner to abort");
    }

    await harness.abortTask(thread.ownerTaskId as never, context);
    process.stdout.write(`OWNER-ABORTED:${thread.ownerTaskId}\n`);
    await harness.close(context);
} else if (mode === "start") {
    if (boundary === "timer-open-race") {
        await runtime.engine.start(
            timerScanWorkflow,
            null,
            { runId: "agent-timer-open-race" },
            context,
        );
        const timerDeadline = Date.now() + 5_000;
        let timerWaiting = false;

        while (!timerWaiting && Date.now() < timerDeadline) {
            timerWaiting = (await harness.inspect(context)).tasks.some(
                (candidate) =>
                    candidate.record.kind === "pocket.workflow-runtime.task" &&
                    (candidate.record.input as { readonly runId?: unknown }).runId ===
                        "agent-timer-open-race" &&
                    candidate.record.state.status === "waiting",
            );

            if (!timerWaiting) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }

        if (!timerWaiting) {
            throw new Error("Timer race fixture did not reach a durable sleeping Task");
        }
    }

    await runtime.engine.start(workflow, null, { runId: "agent-crash-run" }, context);
    process.stdout.write("STARTED\n");
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
} else {
    const key = workflowAgentThreadKey({
        runId: "agent-crash-run",
        threadId: "crash-thread",
        profileId: profile.id,
    });

    if (stopDuringTimerScan !== undefined) {
        await stopDuringTimerScan;
    }

    let recoveredThread = preopen;
    const deadline = Date.now() + 5_000;
    const targetRunnerId = () =>
        recoveredThread?.turns?.find((turn) => turn.turnId === "crash-turn")?.runnerTaskId;

    while (targetRunnerId() === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        recoveredThread = await harness.snapshot(AGENT_THREAD_DOC, key, context);
    }

    const runnerId = targetRunnerId();

    if (runnerId === undefined) {
        throw new Error("Crash fixture has no exact runner identity after recovery");
    }

    try {
        await Promise.race([
            harness.waitForTask(runnerId as never, context),
            new Promise<never>((_resolve, reject) =>
                setTimeout(() => reject(new Error("Runner did not settle after recovery")), 5_000),
            ),
        ]);
    } catch (error) {
        if (!(error instanceof Error) || error.message !== "Runner did not settle after recovery") {
            throw error;
        }
    }

    for (const nativeTask of nativeTasks) {
        const current = await harness.getTask(nativeTask.id as never, context);

        if (current?.state.status === "terminal") {
            continue;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            await Promise.race([
                harness.waitForTask(nativeTask.id as never, context),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Native task ${nativeTask.id} did not settle after recovery`,
                                ),
                            ),
                        5_000,
                    );
                }),
            ]);
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    const thread = await harness.snapshot(AGENT_THREAD_DOC, key, context);
    const runner = await harness.getTask(runnerId as never, context);
    const settledNativeTasks = await Promise.all(
        nativeTasks.map(async (candidate) => {
            const settled = await harness.getTask(candidate.id as never, context);

            return {
                kind: settled?.kind ?? candidate.kind,
                status: settled?.state.status ?? "missing",
                outcome: settled?.state.status === "terminal" ? settled.state.outcome.status : null,
                error:
                    settled?.state.status === "terminal" &&
                    settled.state.outcome.status === "failed"
                        ? settled.state.outcome.error
                        : undefined,
            };
        }),
    );

    process.stdout.write(
        `FINAL:${JSON.stringify({ thread, runner, nativeTasks: settledNativeTasks })}\n`,
    );
    unsubscribe();
    await hostDispose?.();
    await runtime.close();
    await harness.close(context);
}
