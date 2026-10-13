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
    AgentDoc,
    Harness,
    ProviderDoc,
    UserEntry,
    type ConversationId,
    type Storage,
    type StorageWrite,
    section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    createWorkflowAgentRuntime,
    type AgentThreadRecord,
    type WorkflowAgentHostSetup,
} from "../../packages/workflow-runtime/index.ts";
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
        mode !== "terminal-runner" &&
        mode !== "orphan-missing-provider" &&
        mode !== "orphan-missing-thread-and-provider" &&
        mode !== "tamper-result-payload" &&
        mode !== "tamper-result-schema" &&
        mode !== "tamper-result-assistant" &&
        mode !== "tamper-result-submission" &&
        mode !== "tamper-result-task") ||
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

function markCrashTurnNotCompleted(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || !("turns" in value)) {
        return undefined;
    }

    const copy = structuredClone(value) as Record<string, unknown>;

    if (!Array.isArray(copy.turns)) {
        return undefined;
    }

    const turn = copy.turns.find(
        (candidate): candidate is Record<string, unknown> =>
            typeof candidate === "object" &&
            candidate !== null &&
            "turnId" in candidate &&
            candidate.turnId === "crash-turn",
    );

    if (turn?.status !== "reserved") {
        return undefined;
    }

    turn.status = "not-completed";

    return copy;
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
    if (
        boundary === "result-candidate-committed" ||
        boundary === "result-tool-settled" ||
        boundary === "result-native-answer" ||
        boundary === "result-adapter-promoted"
    ) {
        return [
            fauxAssistantMessage(
                [
                    fauxToolCall(
                        "submit_crash_result",
                        { answer: "literal crash result", score: 11 },
                        { id: "crash-result-call" },
                    ),
                ],
                { stopReason: "toolUse" },
            ),
        ];
    }

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

    if (boundary === "tool-dispatched" || boundary === "agent-selection-malformed-safe-tool") {
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
    extensions: [{ name: "crash-fixture-unsafe-effect", version: "unsafe-effect-extension-v1" }],
    ...(boundary === "section-view-submission-committed"
        ? {
              sections: [
                  {
                      key: "crash-section-alpha",
                      extension: "crash-fixture-unsafe-effect",
                      version: "crash-section-alpha-v1",
                  },
                  {
                      key: "crash-section-beta",
                      extension: "crash-fixture-unsafe-effect",
                      version: "crash-section-beta-v1",
                  },
              ],
          }
        : {}),
    tools: [
        {
            name: "unsafe_effect",
            extension: "crash-fixture-unsafe-effect",
            version: "unsafe-effect-tool-v1",
            capabilities: ["fixture.effect"],
        },
    ],
    capabilities: ["fixture.effect"],
    ...(boundary === "result-candidate-committed" ||
    boundary === "result-tool-settled" ||
    boundary === "result-native-answer" ||
    boundary === "result-adapter-promoted"
        ? {
              result: {
                  id: "crash-fixture-result",
                  version: "1",
                  toolName: "submit_crash_result",
                  schema: {
                      type: "object",
                      properties: {
                          answer: { type: "string" },
                          score: { type: "integer" },
                      },
                      required: ["answer", "score"],
                      additionalProperties: false,
                  },
              },
          }
        : {}),
} as const;
const registry = createRegistry();
const unsafeEffect = defineTool({
    name: "unsafe_effect",
    description: "Record one test side effect before returning.",
    parameters: Type.Object({ label: Type.String() }),
    replay: boundary === "agent-selection-malformed-safe-tool" ? "safe" : "unsafe",
    execute: async (args) => {
        durableToolDispatchMarker();

        if (mode === "start" && boundary === "agent-selection-malformed-safe-tool") {
            if (malformedAgentSelectionConversationId === undefined) {
                throw new Error("Safe-tool fixture has no conversation to corrupt");
            }

            await harness.commit(async (tx) => {
                const agent = await tx.doc(
                    AgentDoc,
                    malformedAgentSelectionConversationId as ConversationId,
                );

                agent.extensions = [
                    unsafeEffectExtension.name,
                    "missing-agent-extension",
                    unsafeEffectExtension.name,
                ];
                agent.tools = ["unsafe_effect", "missing-agent-tool", "unsafe_effect"];
            }, context);
            controlledBoundary(boundary);
        }

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
    ...(boundary === "section-view-submission-committed"
        ? {
              sections: [
                  section("crash-section-alpha", () => "CRASH_SECTION_ALPHA"),
                  section("crash-section-beta", () => "CRASH_SECTION_BETA_PRIVATE"),
              ],
          }
        : {}),
});

function malformedAgentSelection(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const copy = structuredClone(value) as Record<string, unknown>;

    copy.extensions = [
        unsafeEffectExtension.name,
        "missing-agent-extension",
        unsafeEffectExtension.name,
    ];
    copy.tools = ["unsafe_effect", "missing-agent-tool", "unsafe_effect"];

    return copy;
}

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
                const runnerWrite = writes.find(
                    (write) => write.type === "task" && write.value.kind === AGENT_RUNNER_TASK_NAME,
                ) as Extract<StorageWrite, { type: "task" }> | undefined;
                const runnerCreated = runnerWrite !== undefined;
                const runnerConversationId =
                    runnerWrite === undefined
                        ? undefined
                        : (runnerWrite.value.input as { readonly conversationId?: unknown })
                              .conversationId;
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

                let classifiedNotCompletedTurn = false;
                const committedWrites = [...writes];

                if (mode === "start" && boundary === "turn-not-completed-classified") {
                    for (let index = 0; index < writes.length; index += 1) {
                        const write = writes[index];

                        if (write?.type === "document.create") {
                            if (write.record.kind !== AGENT_THREAD_DOC.definition.kind) {
                                continue;
                            }

                            const value = markCrashTurnNotCompleted(write.content.value);

                            if (value !== undefined) {
                                committedWrites[index] = {
                                    ...write,
                                    content: {
                                        ...write.content,
                                        value: value as typeof write.content.value,
                                    },
                                };
                                classifiedNotCompletedTurn = true;
                                break;
                            }
                        }

                        if (write?.type === "document.change") {
                            const stored = await target.document(
                                write.id,
                                "current",
                                commitContext,
                            );

                            if (
                                stored?.record.kind !== AGENT_THREAD_DOC.definition.kind ||
                                write.content.kind !== "delta"
                            ) {
                                continue;
                            }

                            const turns =
                                (stored.value as unknown as AgentThreadRecord).turns ?? [];
                            const turnIndex = turns.findIndex(
                                (turn) => turn.turnId === "crash-turn",
                            );

                            if (turnIndex < 0) {
                                continue;
                            }

                            const ops = write.content.ops.map((operation) => {
                                const tuple = operation as unknown as unknown[];
                                const path = tuple[1];

                                if (
                                    tuple[0] === "s" &&
                                    Array.isArray(path) &&
                                    path[0] === "turns" &&
                                    path[1] === turnIndex &&
                                    path[2] === "status" &&
                                    tuple[2] === "reserved"
                                ) {
                                    classifiedNotCompletedTurn = true;

                                    return [tuple[0], path, "not-completed"];
                                }

                                return operation;
                            });

                            if (classifiedNotCompletedTurn) {
                                committedWrites[index] = {
                                    ...write,
                                    content: {
                                        ...write.content,
                                        ops: ops as unknown as typeof write.content.ops,
                                    },
                                };
                                break;
                            }
                        }
                    }
                }

                let malformedAgentSelectionCommitted = false;

                if (
                    mode === "start" &&
                    boundary === "agent-selection-malformed-committed" &&
                    typeof runnerConversationId === "number"
                ) {
                    const extensions = [
                        unsafeEffectExtension.name,
                        "missing-agent-extension",
                        unsafeEffectExtension.name,
                    ];
                    const tools = ["unsafe_effect", "missing-agent-tool", "unsafe_effect"];

                    for (let index = 0; index < writes.length; index += 1) {
                        const write = writes[index];

                        if (write?.type === "document.create") {
                            if (
                                write.record.kind !== AgentDoc.definition.kind ||
                                write.record.scope.kind !== "conversation" ||
                                Number(write.record.scope.conversationId) !==
                                    Number(runnerConversationId) ||
                                write.content.kind !== "base"
                            ) {
                                continue;
                            }

                            const value = malformedAgentSelection(write.content.value);

                            if (value !== undefined) {
                                committedWrites[index] = {
                                    ...write,
                                    content: {
                                        ...write.content,
                                        value: value as typeof write.content.value,
                                    },
                                };
                                malformedAgentSelectionCommitted = true;
                            }

                            continue;
                        }

                        if (write?.type !== "document.change") {
                            continue;
                        }

                        const stored = await target.document(write.id, "current", commitContext);

                        if (
                            stored?.record.kind !== AgentDoc.definition.kind ||
                            stored.record.scope.kind !== "conversation" ||
                            Number(stored.record.scope.conversationId) !==
                                Number(runnerConversationId)
                        ) {
                            continue;
                        }

                        if (write.content.kind === "base") {
                            const value = malformedAgentSelection(write.content.value);

                            if (value !== undefined) {
                                committedWrites[index] = {
                                    ...write,
                                    content: {
                                        ...write.content,
                                        value: value as typeof write.content.value,
                                    },
                                };
                                malformedAgentSelectionCommitted = true;
                            }

                            continue;
                        }

                        const ops = [
                            ...write.content.ops,
                            ["s", ["extensions"], extensions],
                            ["s", ["tools"], tools],
                        ] as typeof write.content.ops;

                        committedWrites[index] = {
                            ...write,
                            content: { ...write.content, ops },
                        };
                        malformedAgentSelectionCommitted = true;
                    }
                }

                const sequence = await target.commit(committedWrites, commitContext);

                if (classifiedNotCompletedTurn) {
                    controlledBoundary("turn-not-completed-classified");
                }

                if (
                    malformedAgentSelectionCommitted &&
                    boundary === "agent-selection-malformed-committed"
                ) {
                    controlledBoundary("agent-selection-malformed-committed");
                }

                if (
                    mode === "start" &&
                    (boundary === "result-candidate-committed" ||
                        boundary === "result-adapter-promoted")
                ) {
                    for (const write of writes) {
                        if (write.type !== "document.change") {
                            continue;
                        }

                        const stored = await target.document(write.id, "current", commitContext);

                        if (stored?.record.kind !== AGENT_THREAD_DOC.definition.kind) {
                            continue;
                        }

                        const turns = (stored.value as unknown as AgentThreadRecord).turns ?? [];
                        const matched = turns.some(
                            (turn) =>
                                turn.turnId === "crash-turn" &&
                                turn.candidate !== undefined &&
                                (boundary !== "result-adapter-promoted" ||
                                    turn.status === "completed"),
                        );

                        if (matched) {
                            controlledBoundary(boundary);
                        }
                    }
                }

                if (
                    mode === "start" &&
                    boundary === "result-tool-settled" &&
                    writes.some(
                        (write) =>
                            write.type === "task" &&
                            write.value.kind === "pi.tool" &&
                            write.value.state.status === "terminal" &&
                            write.value.state.outcome.status === "completed" &&
                            (
                                write.value.state.outcome.result as {
                                    control?: { terminate?: boolean };
                                }
                            ).control?.terminate === true,
                    )
                ) {
                    controlledBoundary(boundary);
                }

                if (
                    mode === "start" &&
                    boundary === "result-native-answer" &&
                    done?.type === "submission" &&
                    done.value.requestId?.startsWith("pocket-workflow-agent-turn-v1:")
                ) {
                    controlledBoundary(boundary);
                }

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
                    (boundary === "submission-committed" ||
                        boundary === "section-view-submission-committed") &&
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
let nativeAgentResolutionAttempted = false;
let malformedAgentConversationId: number | undefined;
let malformedAgentSelectionConversationId: number | undefined;

if (mode === "recover" && boundary === "agent-selection-malformed-safe-tool") {
    const threadKey = workflowAgentThreadKey({
        runId: "agent-crash-run",
        threadId: "crash-thread",
        profileId: profile.id,
    });
    const documents = await originalStorage.scanDocuments(
        {
            scope: { kind: "session" },
            at: "current",
            kind: AGENT_THREAD_DOC.definition.kind,
        },
        100,
        undefined,
        context,
    );
    const threadDocument = documents.items.find((document) => document.key === threadKey);
    const thread =
        threadDocument === undefined
            ? undefined
            : await originalStorage.document(threadDocument.id, "current", context);
    const record = thread?.value as unknown as AgentThreadRecord | undefined;

    if (typeof record?.conversationId !== "number") {
        throw new Error("Safe-tool recovery fixture has no malformed-selection conversation");
    }

    malformedAgentConversationId = record.conversationId;
}

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
    agentConfig: {
        authority: {
            extensions: ["crash-fixture-unsafe-effect"],
            ...(boundary === "section-view-submission-committed"
                ? { sections: ["crash-section-alpha", "crash-section-beta"] }
                : {}),
            tools: ["unsafe_effect"],
            capabilities: ["fixture.effect"],
        },
        profiles: [profile],
    },
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
            boundary === "agent-selection-malformed-safe-tool" ||
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
                boundary === "agent-selection-malformed-safe-tool" ||
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

            if (thread === undefined || conversation === undefined) {
                throw new Error("Cannot configure the crash-fixture agent conversation");
            }

            if (boundary === "agent-selection-malformed-safe-tool") {
                malformedAgentSelectionConversationId = Number(thread.conversationId);
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
            ...(boundary === "section-view-submission-committed"
                ? { sections: ["crash-section-alpha"] }
                : {}),
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
let recoveredRunnerId: number | undefined;
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

    if (
        mode === "recover" &&
        boundary === "agent-selection-malformed-safe-tool" &&
        malformedAgentConversationId !== undefined
    ) {
        const originalHarnessOpen = Harness.open;

        Harness.open = async (storage, options, openContext) => {
            const opened = await originalHarnessOpen(storage, options, openContext);
            const originalConversation = opened.conversation.bind(opened);

            opened.conversation = async (conversationId, conversationContext) => {
                const conversation = await originalConversation(
                    conversationId,
                    conversationContext,
                );

                if (
                    conversation !== undefined &&
                    Number(conversationId) === malformedAgentConversationId
                ) {
                    conversation.agent = async () => {
                        nativeAgentResolutionAttempted = true;

                        throw new Error(
                            "Fixture detected native Agent resolution after selection validation failed",
                        );
                    };
                }

                return conversation;
            };

            return opened;
        };
    }

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
            const runnerPage = await storage.scanTasks(
                { kind: AGENT_RUNNER_TASK_NAME },
                100,
                undefined,
                context,
            );
            const persistedRunner = runnerPage.items.find((candidate) => {
                const input = candidate.input as {
                    runId?: unknown;
                    threadId?: unknown;
                    profileId?: unknown;
                };

                return (
                    input.runId === "agent-crash-run" &&
                    input.threadId === "crash-thread" &&
                    input.profileId === profile.id
                );
            });

            recoveredRunnerId =
                persistedRunner === undefined ? undefined : Number(persistedRunner.id);
            const runnerBeforeRecovery =
                persistedRunner === undefined
                    ? undefined
                    : await setup.getTask(persistedRunner.id as never);
            const ownerTaskId = beforeAttach?.ownerTaskId ?? persistedRunner?.owner;
            const ownerBeforeRecovery =
                ownerTaskId === undefined ? undefined : await setup.getTask(ownerTaskId as never);
            const runBeforeRecovery = await setup.snapshot(RUN_DOC, "agent-crash-run", context);
            const agentConversationId =
                beforeAttach?.conversationId ??
                (typeof (persistedRunner?.input as { conversationId?: unknown } | undefined)
                    ?.conversationId === "number"
                    ? ((persistedRunner?.input as { conversationId: number })
                          .conversationId as ConversationId)
                    : undefined);
            const providerBeforeRecovery =
                agentConversationId === undefined
                    ? undefined
                    : await setup.snapshot(
                          ProviderDoc,
                          agentConversationId as ConversationId,
                          context,
                      );
            const agentBeforeRecovery =
                agentConversationId === undefined
                    ? undefined
                    : await setup.snapshot(
                          AgentDoc,
                          agentConversationId as ConversationId,
                          context,
                      );
            const conversationsBeforeRecovery = await setup.scanConversations({}, 100);
            const nativeConversationBeforeRecovery = conversationsBeforeRecovery.items.find(
                (conversation) => conversation.id === agentConversationId,
            );

            process.stdout.write(
                `PRE-RECOVERY:${JSON.stringify({
                    threadStatus: beforeAttach?.status,
                    turnStatus: beforeAttach?.turns?.[0]?.status,
                    runnerStatus: runnerBeforeRecovery?.state.status,
                    runnerAbortRequested: runnerBeforeRecovery?.abortRequested,
                    ownerStatus: ownerBeforeRecovery?.state.status,
                    ownerAbortRequested: ownerBeforeRecovery?.abortRequested,
                    ownerTaskId: ownerBeforeRecovery?.id,
                    ownerConversationId: ownerBeforeRecovery?.conversationId,
                    ownerRunId: (ownerBeforeRecovery?.input as { runId?: unknown } | undefined)
                        ?.runId,
                    runStatus: runBeforeRecovery?.status,
                    runTaskId: runBeforeRecovery?.taskId,
                    runHasStopCommand: runBeforeRecovery?.stopCommand !== undefined,
                    runHasSelectedOutcome: runBeforeRecovery?.selectedOutcome !== undefined,
                    threadProviderSessionId: beforeAttach?.providerSessionId,
                    providerSessionId: providerBeforeRecovery?.sessionId,
                    agentExtensions: agentBeforeRecovery?.extensions,
                    agentTools: agentBeforeRecovery?.tools,
                    nativeConversationOwner: nativeConversationBeforeRecovery?.owner,
                })}${String.fromCharCode(10)}`,
            );

            if (
                boundary === "tamper-turn-submission-id" ||
                boundary === "tamper-turn-submission-id-string"
            ) {
                await setup.updateDocuments(async (writer) => {
                    const thread = await writer.sessionFamily(AGENT_THREAD_DOC, key, key);
                    const turn = thread.turns?.[0];

                    if (turn === undefined) {
                        throw new Error("Cannot tamper a missing native agent turn");
                    }

                    if (boundary === "tamper-turn-submission-id-string") {
                        if (
                            typeof turn.submissionId !== "number" ||
                            !Number.isSafeInteger(turn.submissionId)
                        ) {
                            throw new Error(
                                "Cannot stringify a missing native submission reference",
                            );
                        }

                        Object.assign(turn, { submissionId: String(turn.submissionId) });
                    } else {
                        turn.submissionId = 0;
                    }
                });
                const updated = await setup.snapshot(AGENT_THREAD_DOC, key, context);
                const boundaryName =
                    boundary === "tamper-turn-submission-id-string"
                        ? "turn-submission-id-string"
                        : "turn-submission-id";

                process.stdout.write(
                    `SETUP:TAMPERED:${boundaryName}:${updated?.turns?.[0]?.submissionId ?? "missing"}\n`,
                );
            }

            nativeTasks = (await setup.inspect()).tasks
                .map((candidate) => candidate.record)
                .filter(
                    (candidate) =>
                        candidate.id !== persistedRunner?.id &&
                        agentConversationId !== undefined &&
                        Number(candidate.conversationId) === Number(agentConversationId),
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
    mode === "tamper-result-payload" ||
    mode === "tamper-result-schema" ||
    mode === "tamper-result-assistant" ||
    mode === "tamper-result-submission" ||
    mode === "tamper-result-task"
) {
    const key = workflowAgentThreadKey({
        runId: "agent-crash-run",
        threadId: "crash-thread",
        profileId: profile.id,
    });
    const thread = await harness.snapshot(AGENT_THREAD_DOC, key, context);

    if (thread?.turns?.[0]?.candidate === undefined) {
        throw new Error("Cannot tamper a missing structured-result candidate");
    }

    await harness.commit(async (tx) => {
        const current = await tx.doc(AGENT_THREAD_DOC, key, key);
        const turn = current.turns?.find((candidate) => candidate.turnId === "crash-turn");

        if (turn?.candidate === undefined) {
            throw new Error("Structured-result candidate disappeared before tampering");
        }

        if (mode === "tamper-result-payload") {
            turn.candidate = {
                ...turn.candidate,
                payload: { answer: "changed candidate payload", score: 11 },
            };
        } else if (mode === "tamper-result-schema") {
            turn.candidate = { ...turn.candidate, schemaFingerprint: "changed-schema" };
        } else if (mode === "tamper-result-assistant") {
            turn.candidate = {
                ...turn.candidate,
                assistantEntryId: turn.candidate.assistantEntryId + 1,
            };
        } else if (mode === "tamper-result-submission") {
            turn.candidate = {
                ...turn.candidate,
                submissionId: turn.candidate.submissionId + 1,
            };
        } else {
            turn.candidate = { ...turn.candidate, toolTaskId: turn.candidate.toolTaskId + 1 };
        }
    }, context);

    await harness.close(context);
    process.stdout.write(`TAMPERED:${mode}\n`);
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
} else if (mode === "orphan-missing-provider" || mode === "orphan-missing-thread-and-provider") {
    const key = workflowAgentThreadKey({
        runId: "agent-crash-run",
        threadId: "crash-thread",
        profileId: profile.id,
    });
    const thread = await harness.snapshot(AGENT_THREAD_DOC, key, context);
    const tasks = (await harness.inspect(context)).tasks.map((candidate) => candidate.record);
    const runnerTaskId = thread?.turns?.[0]?.runnerTaskId;
    const runner = tasks.find(
        (candidate) =>
            candidate.kind === AGENT_RUNNER_TASK_NAME &&
            Number(candidate.id) === Number(runnerTaskId),
    );
    const generation = tasks.find(
        (candidate) =>
            candidate.kind === "pi.generation" &&
            Number(candidate.conversationId) === Number(thread?.conversationId) &&
            candidate.state.status !== "terminal",
    );

    if (thread === undefined || runner === undefined || generation === undefined) {
        throw new Error("Crash fixture has no active agent generation and runner to orphan");
    }

    await harness.commit(async (tx) => {
        const provider = await tx.doc(ProviderDoc, thread.conversationId as ConversationId);

        if (provider.sessionId !== thread.providerSessionId) {
            throw new Error("Crash fixture ProviderDoc does not match its persisted agent thread");
        }

        if (!Reflect.deleteProperty(provider, "sessionId")) {
            throw new Error("Crash fixture could not remove the ProviderDoc session mapping");
        }
    }, context);
    const terminalRunner = {
        ...runner,
        state: { status: "terminal", outcome: { status: "aborted", reason: "fixture" } },
    } as typeof runner;
    const orphanWrites: StorageWrite[] = [{ type: "task", value: terminalRunner }];

    if (mode === "orphan-missing-thread-and-provider") {
        const documents = await originalStorage.scanDocuments(
            {
                scope: { kind: "session" },
                at: "current",
                kind: AGENT_THREAD_DOC.definition.kind,
            },
            100,
            undefined,
            context,
        );
        const threadDocument = documents.items.find((document) => document.key === key);

        if (threadDocument === undefined) {
            throw new Error("Crash fixture cannot retire a missing agent thread record");
        }

        orphanWrites.push({ type: "document.retire", id: threadDocument.id });
    }

    await originalStorage.commit(orphanWrites, context);
    const remainingThreadDocuments = await originalStorage.scanDocuments(
        {
            scope: { kind: "session" },
            at: "current",
            kind: AGENT_THREAD_DOC.definition.kind,
        },
        100,
        undefined,
        context,
    );
    const threadStillCurrent = remainingThreadDocuments.items.some(
        (document) => document.key === key,
    );

    await harness.close(context);
    process.stdout.write(
        `ORPHANED:${JSON.stringify({
            reason:
                mode === "orphan-missing-thread-and-provider"
                    ? "thread-and-provider-mapping-missing-runner-terminal"
                    : "provider-mapping-missing-runner-terminal",
            conversationId: Number(thread.conversationId),
            runnerTaskId: Number(runner.id),
            threadStillCurrent,
        })}${String.fromCharCode(10)}`,
    );
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
        recoveredThread?.turns?.find((turn) => turn.turnId === "crash-turn")?.runnerTaskId ??
        recoveredRunnerId;

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
                id: Number(settled?.id ?? candidate.id),
                conversationId: Number(settled?.conversationId ?? candidate.conversationId),
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
        `FINAL:${JSON.stringify({
            thread,
            runner,
            nativeTasks: settledNativeTasks,
            nativeAgentResolutionAttempted,
        })}\n`,
    );
    unsubscribe();
    await hostDispose?.();
    await runtime.close();
    await harness.close(context);
}
