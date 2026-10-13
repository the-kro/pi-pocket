import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    createRegistry,
    defineExtension,
    defineTool,
    MemoryStorage,
    ToolResultEntry,
    type ConversationId,
    type EntryId,
    type HarnessOptions,
} from "@earendil-works/pi-durable";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    AGENT_THREAD_DOC,
    createWorkflowAgentRuntime,
    workflowAgentResultExtensionName,
    workflowAgentThreadKey,
} from "../packages/workflow-runtime/index.ts";
import { defineWorkflow, type WorkflowContext } from "../packages/workflow-runtime/core/index.ts";

const context = BACKGROUND_CONTEXT;
const resultToolName = "submit_fixture_result";
const fixtureSchema = {
    type: "object",
    properties: {
        answer: { type: "string" },
        score: { type: "integer" },
    },
    required: ["answer", "score"],
    additionalProperties: false,
};
const fixtureResultBinding = {
    id: "fixture-answer",
    version: "1",
    toolName: resultToolName,
    schema: fixtureSchema,
};
const fixturePayload = { answer: "literal accepted", score: 7 };

function resultFixture(settings?: HarnessOptions["settings"], includeResult = true) {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);

    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "structured-fixture",
        version: 1,
        instructions: "Return the requested structured result.",
        instructionsVersion: "structured-fixture-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-result-test-v1",
        },
        ...(includeResult
            ? {
                  result: {
                      ...fixtureResultBinding,
                  },
              }
            : {}),
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry, ...(settings === undefined ? {} : { settings }) },
        agentConfig: { profiles: [profile] },
    });

    registry.install(runtime.extension);

    return { faux, profile, registry, runtime };
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const crashWorkerPath = join(projectRoot, "test/fixtures/workflow-agent-crash-worker.ts");

type CrashWorker = { readonly child: ChildProcess; output: string; errors: string };

type CrashWorkerMode =
    | "start"
    | "recover"
    | "tamper-result-payload"
    | "tamper-result-schema"
    | "tamper-result-assistant"
    | "tamper-result-submission"
    | "tamper-result-task";

function startCrashWorker(
    mode: CrashWorkerMode,
    database: string,
    markers: string,
    boundary: string,
): CrashWorker {
    const child = spawn(process.execPath, ["--experimental-strip-types", crashWorkerPath], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_AGENT_MODE: mode,
            PI_AGENT_DB: database,
            PI_AGENT_MARKERS: markers,
            PI_AGENT_BOUNDARY: boundary,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const worker: CrashWorker = { child, output: "", errors: "" };

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
        worker.output += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
        worker.errors += chunk;
    });

    return worker;
}

async function crashOutputUntil(worker: CrashWorker, marker: string): Promise<string> {
    const deadline = Date.now() + 15_000;

    while (!worker.output.includes(marker)) {
        if (
            Date.now() >= deadline ||
            worker.child.exitCode !== null ||
            worker.child.signalCode !== null
        ) {
            throw new Error(
                `Crash worker missed ${marker}: code=${worker.child.exitCode}; signal=${worker.child.signalCode}; stdout=${worker.output}; stderr=${worker.errors}`,
            );
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return worker.output;
}

async function killCrashWorker(worker: CrashWorker): Promise<void> {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        return;
    }

    const exited = once(worker.child, "exit");

    worker.child.kill("SIGKILL");
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, "SIGKILL");
}

async function successfulCrashWorkerExit(worker: CrashWorker): Promise<void> {
    let code = worker.child.exitCode;
    let signal = worker.child.signalCode;

    if (code === null && signal === null) {
        [code, signal] = (await once(worker.child, "exit")) as [
            number | null,
            NodeJS.Signals | null,
        ];
    }

    assert.equal(signal, null, worker.errors);
    assert.equal(code, 0, worker.errors);
}

async function readDispatchMarkers(path: string): Promise<string[]> {
    try {
        return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw error;
    }
}

async function failedStructuredTurn(
    responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
    runId: string,
) {
    const { faux, profile, runtime } = resultFixture();

    faux.setResponses(responses);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: `structured-result-failure-${runId}`,
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: `thread-${runId}`,
                turnId: `turn-${runId}`,
                profile: profile.id,
                content: "Return a structured result.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId }, context);
        let failure: unknown;

        try {
            await runtime.engine.wait(runId, context);
        } catch (error) {
            failure = error;
        }

        assert.notEqual(
            failure,
            undefined,
            "schema-required turn must not accept prose or invalid output",
        );
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId,
                threadId: `thread-${runId}`,
                profileId: profile.id,
            }),
            context,
        );

        return { callCount: faux.state.callCount, failure, profile, thread };
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
}

test("a sole schema-bound native result call promotes its literal payload", async () => {
    const { faux, profile, runtime } = resultFixture();

    faux.setResponses([
        fauxAssistantMessage(
            [fauxToolCall(resultToolName, fixturePayload, { id: "fixture-result-call" })],
            { stopReason: "toolUse" },
        ),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "structured-result-tracer",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "fixture-thread",
                turnId: "fixture-turn",
                profile: profile.id,
                content: "Return the fixed fixture result.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "structured-result-run" }, context);
        const result = await runtime.engine.wait("structured-result-run", context);

        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "structured-result-run",
                threadId: "fixture-thread",
                profileId: profile.id,
            }),
            context,
        );
        const turn = thread?.turns?.[0];

        assert.deepEqual(result, { answer: "literal accepted", score: 7 });
        assert.equal(faux.state.callCount, 1);
        assert.ok(thread);
        assert.ok(turn?.candidate);
        assert.equal(turn.result && JSON.stringify(turn.result), JSON.stringify(fixturePayload));
        assert.equal(turn.candidate.runId, "structured-result-run");
        assert.equal(turn.candidate.threadId, "fixture-thread");
        assert.equal(turn.candidate.turnId, "fixture-turn");
        assert.equal(turn.candidate.requestId, turn.requestId);
        assert.equal(turn.candidate.callId, "fixture-result-call");
        assert.equal(turn.candidate.assistantEntryId, turn.answerEntryId);
        assert.equal(turn.candidate.schemaId, "fixture-answer");
        assert.equal(turn.candidate.schemaVersion, "1");
        assert.deepEqual(turn.candidate.payload, { answer: "literal accepted", score: 7 });

        const submission = await host.harness.commit(
            (tx) => tx.submissionByRequest(thread.conversationId as ConversationId, turn.requestId),
            context,
        );

        assert.equal(submission?.status, "done");
        assert.equal(Number(submission?.id), turn.candidate.submissionId);
        assert.equal(Number(submission?.answer), turn.candidate.assistantEntryId);
        const answer = await host.harness.commit(
            (tx) => tx.entry(AssistantEntry, submission!.answer as EntryId),
            context,
        );
        const assistantMessage = answer?.model?.[0];

        assert.equal(answer?.conversationId, thread.conversationId);
        assert.equal(assistantMessage?.role, "assistant");
        assert.equal(assistantMessage?.role === "assistant" && assistantMessage.content.length, 1);
        assert.equal(
            assistantMessage?.role === "assistant" && assistantMessage.content[0]?.type,
            "toolCall",
        );
        assert.equal(
            assistantMessage?.role === "assistant" &&
                assistantMessage.content[0]?.type === "toolCall" &&
                assistantMessage.content[0].name,
            resultToolName,
        );
        const toolTask = await host.harness.getTask(turn.candidate.toolTaskId as never, context);

        assert.equal(toolTask?.kind, "pi.tool");

        if (
            toolTask === undefined ||
            toolTask.state.status !== "terminal" ||
            toolTask.state.outcome.status !== "completed"
        ) {
            throw new Error("Structured result ToolTask did not complete successfully");
        }

        const taskResult = toolTask.state.outcome.result as { readonly entryId: EntryId };
        const toolResult = await host.harness.commit(
            (tx) => tx.entry(ToolResultEntry, taskResult.entryId),
            context,
        );
        const toolResultMessage = toolResult?.model?.[0];

        assert.equal(toolResult?.conversationId, thread.conversationId);
        assert.equal(toolResultMessage?.role, "toolResult");
        assert.equal(
            toolResultMessage?.role === "toolResult" && toolResultMessage.toolCallId,
            turn.candidate.callId,
        );
        assert.equal(
            toolResultMessage?.role === "toolResult" && toolResultMessage.toolName,
            resultToolName,
        );
        assert.equal(toolResultMessage?.role === "toolResult" && toolResultMessage.isError, false);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("schema-required prose-only native answers are durably rejected", async () => {
    const result = await failedStructuredTurn(
        [fauxAssistantMessage("This prose is not a structured result.")],
        "prose-only",
    );

    assert.equal(result.thread?.status, "unknown");
    assert.equal(result.thread?.turns?.[0]?.status, "unknown");
    assert.equal(result.thread?.turns?.[0]?.candidate, undefined);
    assert.equal(result.thread?.turns?.[0]?.result, undefined);
    assert.equal(result.callCount, 1);
});

test("invalid schema arguments and prose follow-up never promote", async () => {
    const result = await failedStructuredTurn(
        [
            fauxAssistantMessage(
                [
                    fauxToolCall(
                        resultToolName,
                        { answer: "wrong", score: "not-an-integer" },
                        { id: "invalid-result-call" },
                    ),
                ],
                { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Invalid result calls cannot fall back to prose."),
        ],
        "invalid-result",
    );

    assert.equal(result.thread?.status, "unknown");
    assert.equal(result.thread?.turns?.[0]?.candidate, undefined);
    assert.equal(result.thread?.turns?.[0]?.result, undefined);
    assert.equal(result.callCount, 2);
});

test("mixed and multiple result calls are not structured success", async (t) => {
    const cases = [
        {
            runId: "mixed-result-round",
            calls: [
                fauxToolCall(resultToolName, fixturePayload, { id: "mixed-result-call" }),
                fauxToolCall("not-selected", {}, { id: "mixed-other-call" }),
            ],
        },
        {
            runId: "multiple-result-round",
            calls: [
                fauxToolCall(resultToolName, fixturePayload, { id: "multiple-result-call-1" }),
                fauxToolCall(resultToolName, fixturePayload, { id: "multiple-result-call-2" }),
            ],
        },
    ];

    for (const scenario of cases) {
        await t.test(scenario.runId, async () => {
            const result = await failedStructuredTurn(
                [
                    fauxAssistantMessage(scenario.calls, { stopReason: "toolUse" }),
                    fauxAssistantMessage("A mixed or multiple tool round cannot complete."),
                ],
                scenario.runId,
            );

            assert.equal(result.thread?.status, "unknown");
            assert.equal(result.thread?.turns?.[0]?.candidate, undefined);
            assert.equal(result.thread?.turns?.[0]?.result, undefined);
            assert.equal(result.callCount, 2);
        });
    }
});

test("schema result extensions cannot enter ordinary chat default selection", async () => {
    const ordinaryToolName = "ordinary_default_tool";
    const ordinaryExtension = defineExtension({
        name: "ordinary-default-fixture",
        tools: [
            defineTool({
                name: ordinaryToolName,
                description: "Remain selected as a normal host default.",
                parameters: Type.Object({}),
                async execute() {
                    return { content: [{ type: "text", text: "ordinary" }] };
                },
            }),
        ],
    });
    const { registry, runtime } = resultFixture({
        extensions: [
            ordinaryExtension,
            defineExtension({
                name: workflowAgentResultExtensionName(fixtureResultBinding),
                tools: [],
            }),
        ],
    });
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);

    registry.install(ordinaryExtension);

    try {
        const conversation = await host.harness.root(context);
        const agent = await conversation.agent(context);

        assert.deepEqual(
            agent.extensions.map((extension) => extension.name),
            [ordinaryExtension.name],
        );
        assert.deepEqual(
            agent.tools.map((tool) => tool.name),
            [ordinaryToolName],
        );
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("prose-only profiles retain the existing native assistant result", async () => {
    const { faux, profile, runtime } = resultFixture(undefined, false);

    faux.setResponses([fauxAssistantMessage("ordinary native answer")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "ordinary-prose-agent-result",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "ordinary-prose-thread",
                turnId: "ordinary-prose-turn",
                profile: profile.id,
                content: "Answer in prose.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "ordinary-prose-run" }, context);
        const result = await runtime.engine.wait("ordinary-prose-run", context);
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "ordinary-prose-run",
                threadId: "ordinary-prose-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.equal(
            (result as unknown as { readonly content: readonly { readonly text: string }[] })
                .content[0]?.text,
            "ordinary native answer",
        );
        assert.equal(thread?.turns?.[0]?.status, "completed");
        assert.equal(thread?.turns?.[0]?.candidate, undefined);
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("completed structured turn replay returns the exact saved payload", async () => {
    const { faux, profile, runtime } = resultFixture();

    faux.setResponses([
        fauxAssistantMessage(
            [fauxToolCall(resultToolName, fixturePayload, { id: "replay-result-call" })],
            { stopReason: "toolUse" },
        ),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "structured-result-replay",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const request = {
                threadId: "replay-result-thread",
                turnId: "replay-result-turn",
                profile: profile.id,
                content: "Return the same structured result.",
            };

            return [await agent.turn(request), await agent.turn(request)];
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(
            workflow,
            null,
            { runId: "structured-result-replay-run" },
            context,
        );
        const result = await runtime.engine.wait("structured-result-replay-run", context);
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "structured-result-replay-run",
                threadId: "replay-result-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.deepEqual(result, [fixturePayload, fixturePayload]);
        assert.equal(thread?.turns?.length, 1);
        assert.deepEqual(thread?.turns?.[0]?.result, fixturePayload);
        assert.ok(thread?.turns?.[0]?.candidate);
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("nested invocation cannot use the schema result tool to complete a turn", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);

    const model = models.getModel("faux", "faux-1")!;
    const nestedExtensionName = "nested-result-fixture";
    const nestedToolName = "invoke_nested_result";
    const extension = defineExtension({
        name: nestedExtensionName,
        tools: [
            defineTool({
                name: nestedToolName,
                description: "Attempt a nested structured result call.",
                parameters: Type.Object({}),
                async execute(_args, api, toolContext) {
                    const resultTool = (await api.agent(toolContext)).tools.find(
                        (tool) => tool.name === resultToolName,
                    );

                    assert.ok(resultTool);
                    await resultTool.execute(fixturePayload as never, api, toolContext);

                    return { content: [{ type: "text", text: "unexpected nested success" }] };
                },
            }),
        ],
    });

    registry.install(extension);
    const profile = {
        id: "nested-result-profile",
        version: 1,
        instructions: "Use the nested invocation tool.",
        instructionsVersion: "nested-result-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-result-test-v1",
        },
        extensions: [{ name: nestedExtensionName, version: "nested-result-extension-v1" }],
        tools: [
            {
                name: nestedToolName,
                extension: nestedExtensionName,
                version: "nested-result-tool-v1",
                capabilities: [],
            },
        ],
        result: {
            id: "fixture-answer",
            version: "1",
            toolName: resultToolName,
            schema: fixtureSchema,
        },
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: {
            authority: { extensions: [nestedExtensionName], tools: [nestedToolName] },
            profiles: [profile],
        },
    });

    registry.install(runtime.extension);
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall(nestedToolName, {}, { id: "nested-tool-call" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("Nested result calls cannot complete this turn."),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "nested-structured-result",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "nested-result-thread",
                turnId: "nested-result-turn",
                profile: profile.id,
                content: "Call the nested result tool.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "nested-result-run" }, context);
        await assert.rejects(runtime.engine.wait("nested-result-run", context));
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "nested-result-run",
                threadId: "nested-result-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.equal(thread?.status, "unknown");
        assert.equal(thread?.turns?.[0]?.candidate, undefined);
        assert.equal(thread?.turns?.[0]?.result, undefined);
        assert.equal(faux.state.callCount, 2);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("SIGKILL at every structured-result boundary replays the exact payload without redispatch", async () => {
    const boundaries = [
        "result-candidate-committed",
        "result-tool-settled",
        "result-native-answer",
        "result-adapter-promoted",
    ] as const;

    for (const boundary of boundaries) {
        const directory = await mkdtemp(join(tmpdir(), `pi-pocket-${boundary}-`));
        const database = join(directory, "agent.sqlite");
        const markers = join(directory, "provider-dispatches.log");
        const first = startCrashWorker("start", database, markers, boundary);
        let recovery: CrashWorker | undefined;

        try {
            await crashOutputUntil(first, `BOUNDARY:${boundary}`);
            await killCrashWorker(first);
            assert.deepEqual(await readDispatchMarkers(markers), ["faux-provider-dispatch"]);

            recovery = startCrashWorker("recover", database, markers, boundary);
            const output = await crashOutputUntil(recovery, "FINAL:");

            await successfulCrashWorkerExit(recovery);

            const line = output.split("\n").find((entry) => entry.startsWith("FINAL:"));

            assert.ok(line);
            const final = JSON.parse(line.slice("FINAL:".length)) as {
                readonly thread: {
                    readonly status: string;
                    readonly turns: readonly {
                        readonly turnId: string;
                        readonly status: string;
                        readonly result?: unknown;
                        readonly answerEntryId?: number;
                        readonly submissionId?: number;
                        readonly candidate?: {
                            readonly runId: string;
                            readonly threadId: string;
                            readonly turnId: string;
                            readonly requestId: string;
                            readonly submissionId: number;
                            readonly assistantEntryId: number;
                            readonly callId: string;
                            readonly toolTaskId: number;
                            readonly generationTaskId: number;
                            readonly schemaId: string;
                            readonly schemaVersion: string;
                            readonly payload: unknown;
                        };
                    }[];
                };
            };
            const turn = final.thread.turns.find((candidate) => candidate.turnId === "crash-turn");

            assert.equal(final.thread.status, "ready");
            assert.equal(turn?.status, "completed");
            assert.deepEqual(turn?.result, { answer: "literal crash result", score: 11 });
            assert.ok(turn?.candidate);
            assert.equal(turn.candidate.runId, "agent-crash-run");
            assert.equal(turn.candidate.threadId, "crash-thread");
            assert.equal(turn.candidate.turnId, "crash-turn");
            assert.equal(turn.candidate.requestId.length > 0, true);
            assert.equal(turn.candidate.submissionId, turn.submissionId);
            assert.equal(turn.candidate.assistantEntryId, turn.answerEntryId);
            assert.equal(turn.candidate.callId, "crash-result-call");
            assert.equal(turn.candidate.toolTaskId > 0, true);
            assert.equal(turn.candidate.generationTaskId > 0, true);
            assert.equal(turn.candidate.schemaId, "crash-fixture-result");
            assert.equal(turn.candidate.schemaVersion, "1");
            assert.deepEqual(turn.candidate.payload, {
                answer: "literal crash result",
                score: 11,
            });
            assert.deepEqual(await readDispatchMarkers(markers), ["faux-provider-dispatch"]);
        } finally {
            await killCrashWorker(first);

            if (recovery !== undefined) {
                await killCrashWorker(recovery);
            }

            await rm(directory, { recursive: true, force: true });
        }
    }
});

test("changed structured candidate payload and references are fenced on safe replay", async () => {
    const tampering = [
        "tamper-result-payload",
        "tamper-result-schema",
        "tamper-result-assistant",
        "tamper-result-submission",
        "tamper-result-task",
    ] as const;

    for (const mode of tampering) {
        const directory = await mkdtemp(join(tmpdir(), `pi-pocket-${mode}-`));
        const database = join(directory, "agent.sqlite");
        const markers = join(directory, "provider-dispatches.log");
        const first = startCrashWorker("start", database, markers, "result-candidate-committed");
        let tamper: CrashWorker | undefined;
        let recovery: CrashWorker | undefined;

        try {
            await crashOutputUntil(first, "BOUNDARY:result-candidate-committed");
            await killCrashWorker(first);
            assert.deepEqual(await readDispatchMarkers(markers), ["faux-provider-dispatch"]);

            tamper = startCrashWorker(mode, database, markers, "result-candidate-committed");
            await crashOutputUntil(tamper, `TAMPERED:${mode}`);
            await successfulCrashWorkerExit(tamper);

            recovery = startCrashWorker("recover", database, markers, "result-candidate-committed");
            const output = await crashOutputUntil(recovery, "FINAL:");

            await successfulCrashWorkerExit(recovery);

            const line = output.split("\n").find((entry) => entry.startsWith("FINAL:"));

            assert.ok(line);
            const final = JSON.parse(line.slice("FINAL:".length)) as {
                readonly thread: {
                    readonly status: string;
                    readonly turns: readonly {
                        readonly turnId: string;
                        readonly status: string;
                        readonly result?: unknown;
                    }[];
                };
            };
            const turn = final.thread.turns.find((candidate) => candidate.turnId === "crash-turn");

            assert.equal(final.thread.status, "unknown");
            assert.equal(turn?.status, "unknown");
            assert.equal(turn?.result, undefined);
            assert.ok((await readDispatchMarkers(markers)).length >= 1);
        } finally {
            await killCrashWorker(first);

            if (tamper !== undefined) {
                await killCrashWorker(tamper);
            }

            if (recovery !== undefined) {
                await killCrashWorker(recovery);
            }

            await rm(directory, { recursive: true, force: true });
        }
    }
});
