import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal, withCancel } from "@earendil-works/chord/context";
import {
    createAssistantMessageEventStream,
    createModels,
    fauxAssistantMessage,
    fauxProvider,
} from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineDocFamily,
    defineExtension,
    defineTask,
    Harness,
    MemoryStorage,
    AgentDoc,
    ProviderDoc,
    type ConversationId,
    type HarnessOptions,
    type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    createWorkflowAgentRuntime,
    type AgentThreadRecord,
    type WorkflowAgentHostSetup,
    type WorkflowAgentRuntime,
} from "../packages/workflow-runtime/index.ts";
import type { WorkflowAgentProfile } from "../packages/workflow-runtime/agents/profile.ts";
import {
    workflowAgentModelFingerprint,
    workflowAgentProfileFingerprint,
    workflowAgentProviderSessionId,
    workflowAgentThreadKey,
} from "../packages/workflow-runtime/agents/profile.ts";
import {
    createWorkflowRuntimeKernel,
    defineWorkflow,
    RUN_DOC,
    type WorkflowDefinition,
    type WorkflowContext,
} from "../packages/workflow-runtime/core/index.ts";
import { canonicalInput } from "../packages/workflow-runtime/core/identity.ts";

async function openAgentHost(
    runtime: WorkflowAgentRuntime,
    storage: Storage = new MemoryStorage(),
) {
    return runtime.openHost(storage, BACKGROUND_CONTEXT, () => undefined);
}

async function createOwnedAgentThread(
    harness: Harness,
    runtime: WorkflowAgentRuntime,
    models: ReturnType<typeof createModels>,
    profile: WorkflowAgentProfile,
    runId: string,
    threadId: string,
    initializeRuntime = true,
): Promise<AgentThreadRecord> {
    const workflow = defineWorkflow({
        id: `host-owner-${runId}`,
        version: 1,
        run: () => null,
    });

    if (initializeRuntime) {
        runtime.register(workflow);
    }

    const workflowTask = runtime.extension.tasks?.find(
        (task) => task.definition.name === "pocket.workflow-runtime.task",
    );

    assert.ok(workflowTask, "runtime exposes its portable workflow Task definition");

    const root = await harness.root(BACKGROUND_CONTEXT);
    const input = canonicalInput(null);
    const ownerTaskId = await root.commit(async (tx) => {
        const run = await tx.doc(RUN_DOC, runId, runId);

        run.workflowId = workflow.id;
        run.workflowVersion = workflow.version;
        run.input = null;
        run.inputCanonical = input.canonical;
        run.inputDigest = input.digest;
        run.conversationId = Number(root.id);
        run.status = "running";

        const taskId = await tx.createTask(
            workflowTask as never,
            {
                runId,
                workflowId: workflow.id,
                workflowVersion: workflow.version,
                input: null,
                inputDigest: input.digest,
            },
            { ownership: { kind: "conversation" } },
        );

        run.taskId = Number(taskId);

        return taskId;
    }, BACKGROUND_CONTEXT);
    const conversation = await root.commit(
        (tx) => tx.createConversation({ ownership: { kind: "task", taskId: ownerTaskId } }),
        BACKGROUND_CONTEXT,
    );

    const identity = { runId, threadId, profileId: profile.id };
    const threadKey = workflowAgentThreadKey(identity);
    const providerSessionId = workflowAgentProviderSessionId(identity);
    const modelFingerprint = workflowAgentModelFingerprint(models, profile).fingerprint;
    const profileFingerprint = workflowAgentProfileFingerprint(profile);

    return root.commit(async (tx) => {
        const provider = await tx.doc(ProviderDoc, conversation.id);
        const thread = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);

        provider.sessionId = providerSessionId;
        thread.status = "ready";
        thread.runId = runId;
        thread.threadId = threadId;
        thread.profileId = profile.id;
        thread.profileVersion = profile.version;
        thread.conversationId = Number(conversation.id);
        thread.providerSessionId = providerSessionId;
        thread.ownerTaskId = Number(ownerTaskId);
        thread.profileFingerprint = profileFingerprint;
        thread.modelFingerprint = modelFingerprint;

        return { ...thread } as AgentThreadRecord;
    }, BACKGROUND_CONTEXT);
}

test("agent host owns startup while generic kernels retain direct lifecycle", async () => {
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "host-test",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });

    registry.install(runtime.extension);
    let host: Awaited<ReturnType<typeof runtime.openHost>> | undefined;

    try {
        host = await runtime.openHost(new MemoryStorage(), BACKGROUND_CONTEXT, () => undefined);
        assert.equal((await host.harness.inspect(BACKGROUND_CONTEXT)).scheduling, "running");
        const close = runtime.close();

        assert.equal(runtime.close(), close);
        await close;
        assert.equal((await host.harness.inspect(BACKGROUND_CONTEXT)).scheduling, "running");
    } finally {
        await host?.dispose();
        await runtime.close();
        await host?.harness.close(BACKGROUND_CONTEXT);
    }

    const genericRegistry = createRegistry();
    const kernel = createWorkflowRuntimeKernel();

    genericRegistry.install(kernel.extension);
    const genericHarness = await Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry: genericRegistry },
        BACKGROUND_CONTEXT,
    );
    const genericEngine = kernel.createEngine(genericHarness);

    try {
        await genericEngine.open(BACKGROUND_CONTEXT);
        assert.equal((await genericHarness.inspect(BACKGROUND_CONTEXT)).scheduling, "running");
    } finally {
        await genericEngine.close();
        await genericHarness.close(BACKGROUND_CONTEXT);
    }
});

test("close waits for an in-flight host setup and startup cleanup", async () => {
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "close-race",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });

    registry.install(runtime.extension);
    let signalEntered!: () => void;
    let releaseSetup!: () => void;
    const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        releaseSetup = resolve;
    });
    const opening = runtime.openHost(new MemoryStorage(), BACKGROUND_CONTEXT, async () => {
        signalEntered();
        await blocked;
    });

    try {
        await entered;
        const closing = runtime.close();
        let closeSettled = false;

        void closing.then(() => {
            closeSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(closeSettled, false);

        releaseSetup();
        await assert.rejects(opening, /closed during host preparation/i);
        await closing;
    } finally {
        releaseSetup();
        await runtime.close();
    }
});

test("openHost withholds the raw Harness until setup and runtime startup complete", async () => {
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "open-host",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });

    registry.install(runtime.extension);
    assert.equal("options" in runtime, false);
    assert.equal("attach" in runtime, false);
    assert.equal("open" in runtime, false);
    assert.equal("openHarness" in runtime, false);
    let enteredSetup!: () => void;
    let releaseSetup!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
        enteredSetup = resolve;
    });
    const setupBlocked = new Promise<void>((resolve) => {
        releaseSetup = resolve;
    });
    let host: { harness: Harness; prepared: string; dispose(): Promise<void> } | undefined;
    let savedSetup: WorkflowAgentHostSetup | undefined;
    let afterAdapterRecovery = false;

    try {
        const opening = runtime.openHost(new MemoryStorage(), BACKGROUND_CONTEXT, async (setup) => {
            savedSetup = setup;
            setup.onAfterAdapterRecovery(() => {
                afterAdapterRecovery = true;
            });
            assert.equal("harness" in setup, false);
            assert.equal("waitForTask" in setup, false);
            assert.equal("resume" in setup, false);
            assert.equal("conversation" in setup, false);
            assert.equal("requestConversationAbort" in setup, true);
            assert.throws(() => runtime.engine, /startup|ready/i);
            enteredSetup();
            await setupBlocked;

            return "prepared";
        });

        await setupEntered;
        let settled = false;

        void opening.then(() => {
            settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(settled, false);

        releaseSetup();
        const openedHost = await opening;

        host = openedHost;
        assert.equal(openedHost.prepared, "prepared");
        assert.equal(afterAdapterRecovery, true);
        assert.ok(savedSetup);
        assert.throws(
            () => savedSetup!.requestConversationAbort(999_999 as ConversationId),
            /sealed/i,
        );
        assert.equal((await openedHost.harness.inspect(BACKGROUND_CONTEXT)).scheduling, "running");
        await openedHost.harness.waitForIdle(BACKGROUND_CONTEXT);
    } finally {
        releaseSetup();
        await runtime.close();
        await host?.dispose();
        await host?.harness.close(BACKGROUND_CONTEXT);
    }
});

test("openHost setup exposes only scoped document recovery and disposers", async () => {
    const StartupDoc = defineDocFamily<{ count: number }, string>({
        kind: "test.workflow-agent-startup",
        version: 1,
        scope: "session",
        family: true,
        initial: () => ({ count: 0 }),
    });
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "setup-facade",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });

    registry.install(runtime.extension);
    let host: Awaited<ReturnType<typeof runtime.openHost>> | undefined;
    let commits = 0;
    let cleanups = 0;

    try {
        host = await runtime.openHost(new MemoryStorage(), BACKGROUND_CONTEXT, async (setup) => {
            setup.subscribeCommits(() => {
                commits++;
            });
            setup.onCleanup(() => {
                cleanups++;
            });
            setup.requestConversationAbort(999_999 as ConversationId);
            assert.equal((await setup.inspect()).scheduling, "paused");
            assert.equal((await setup.scanConversations({}, 10)).items.length, 0);
            await setup.updateDocuments(async (writer) => {
                const doc = await writer.sessionFamily(StartupDoc, "startup-key", "startup-key");

                doc.count++;
            });
            assert.equal("commit" in setup, false);
            assert.equal("updateDocuments" in setup, true);

            return "ready";
        });

        assert.equal(host.prepared, "ready");
        assert.equal(
            (await host.harness.snapshot(StartupDoc, "startup-key", BACKGROUND_CONTEXT))?.count,
            1,
        );
        assert.equal(commits, 1);
        await host.dispose();
        assert.equal(cleanups, 1);
    } finally {
        await runtime.close();
        await host?.dispose();
        await host?.harness.close(BACKGROUND_CONTEXT);
    }
});

test("openHost preserves setup failure and disposes acquired startup resources", async () => {
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "setup-failure",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });

    registry.install(runtime.extension);
    const startupFailure = new Error("host recovery failed");
    let cleanupCount = 0;

    try {
        await assert.rejects(
            runtime.openHost(new MemoryStorage(), BACKGROUND_CONTEXT, (setup) => {
                setup.onCleanup(() => {
                    cleanupCount++;
                });
                setup.onAfterAdapterRecovery(() => {
                    throw startupFailure;
                });
            }),
            (error) => error === startupFailure,
        );
        assert.equal(cleanupCount, 1);
        assert.throws(() => runtime.engine, /startup|ready/i);
    } finally {
        await runtime.close();
    }
});

test("openHost preserves Harness acquisition cleanup reports with the open failure", async () => {
    const registry = createRegistry();
    const openFailure = new Error("Harness task scan failed");
    const closeFailure = new Error("partial Harness storage close failed");
    const reportFailure = new Error("host report callback failed");
    const reports: unknown[] = [];
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: {
            models: createModels(),
            registry,
            onReport: (error) => {
                reports.push(error);

                throw reportFailure;
            },
        },
        agentConfig: {
            profiles: [
                {
                    id: "harness-acquisition-failure",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });
    let closeCount = 0;
    const storage = new Proxy(new MemoryStorage(), {
        get(target, property, receiver) {
            if (property === "scanTasks") {
                return async () => {
                    throw openFailure;
                };
            }

            if (property === "close") {
                return async () => {
                    closeCount++;

                    throw closeFailure;
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;

    registry.install(runtime.extension);

    try {
        await assert.rejects(
            runtime.openHost(storage, BACKGROUND_CONTEXT, () => undefined),
            (error) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.cause, openFailure);
                assert.equal(error.errors[0], openFailure);
                assert.ok(error.errors.includes(closeFailure));
                assert.ok(error.errors.includes(reportFailure));

                return true;
            },
        );
        assert.deepEqual(reports, [closeFailure]);
        assert.equal(closeCount, 1);
    } finally {
        await runtime.close();
    }
});

test("openHost leaves pre-acquisition storage cleanup to its caller", async () => {
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "pre-acquisition-failure",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });
    let closeCount = 0;
    const storage = new Proxy(new MemoryStorage(), {
        get(target, property, receiver) {
            if (property === "close") {
                return async (context: Parameters<Storage["close"]>[0]) => {
                    closeCount++;

                    return target.close(context);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const controller = new AbortController();
    const cancellation = new Error("cancelled before Harness acquisition");

    registry.install(runtime.extension);
    controller.abort(cancellation);

    try {
        await assert.rejects(
            runtime.openHost(
                storage,
                withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
                () => undefined,
            ),
            (error) => error === cancellation,
        );
        assert.equal(closeCount, 0);
        await storage.close(BACKGROUND_CONTEXT);
        assert.equal(closeCount, 1);
    } finally {
        await runtime.close();
    }
});

test("openHost uses independent cleanup context and aggregates startup failures", async () => {
    const registry = createRegistry();
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models: createModels(), registry },
        agentConfig: {
            profiles: [
                {
                    id: "cleanup-failure",
                    version: 1,
                    instructions: "",
                    instructionsVersion: "1",
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                        api: "faux-api",
                        providerVersion: "1",
                    },
                },
            ],
        },
    });
    const storageCloseFailure = new Error("storage close failed");
    const disposerFailure = new Error("setup disposer failed");
    const startupFailure = new Error("cancelled startup failed");
    let closeCount = 0;
    let disposerCount = 0;
    const storage = new Proxy(new MemoryStorage(), {
        get(target, property, receiver) {
            if (property === "close") {
                return async () => {
                    closeCount++;

                    throw storageCloseFailure;
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);

    registry.install(runtime.extension);

    try {
        await assert.rejects(
            runtime.openHost(storage, context, (setup) => {
                setup.onCleanup(() => {
                    disposerCount++;

                    throw disposerFailure;
                });
                cancel();

                throw startupFailure;
            }),
            (error) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.cause, startupFailure);
                assert.equal(error.errors[0], startupFailure);
                assert.ok(error.errors.includes(disposerFailure));
                assert.ok(error.errors.includes(storageCloseFailure));

                return true;
            },
        );
        assert.equal(disposerCount, 1);
        assert.equal(closeCount, 1);
    } finally {
        await runtime.close();
    }
});

test("agent turns bind only the current workflow invocation and drain before terminality", async () => {
    const registry = createRegistry();
    let turnCompleted = false;
    let invocation: { runId: string; taskId: number; conversationId: number } | undefined;
    const kernel = createWorkflowRuntimeKernel({
        bindAgentTurn: (binding) => async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            await binding.commit(async (tx) => {
                const agent = await tx.doc(AgentDoc, binding.conversationId);

                agent.instructions = "turn committed";
            });
            invocation = {
                runId: binding.runId,
                taskId: Number(binding.taskId),
                conversationId: Number(binding.conversationId),
            };
            turnCompleted = true;

            return { accepted: true };
        },
    });

    registry.install(kernel.extension);
    const harness = await Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry },
        BACKGROUND_CONTEXT,
    );
    const engine = kernel.createEngine(harness);
    const definition: WorkflowDefinition<{ start: boolean }, { terminal: boolean }> = {
        id: "agent-context-binding",
        version: 1,
        run: async ({ agent }: WorkflowContext<{ start: boolean }>) => {
            assert.ok(agent);
            void agent.turn({ intent: "detached turn" });

            return { terminal: true };
        },
    };

    try {
        engine.register(definition);
        await engine.open(BACKGROUND_CONTEXT);
        await engine.start(
            definition,
            { start: true },
            { runId: "agent-context-run" },
            BACKGROUND_CONTEXT,
        );

        assert.deepEqual(await engine.wait("agent-context-run", BACKGROUND_CONTEXT), {
            terminal: true,
        });
        assert.equal(turnCompleted, true);
        assert.deepEqual(invocation, {
            runId: "agent-context-run",
            taskId: invocation?.taskId,
            conversationId: invocation?.conversationId,
        });
        assert.ok(invocation?.taskId);
        assert.ok(invocation?.conversationId);
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("preflight durably classifies uncertain runner work before abort marking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-preflight-"));
    const database = join(directory, "agent.sqlite");
    const registry = createRegistry();
    const faux = fauxProvider();
    const models = createModels();

    models.setProvider(faux.provider);
    const profile = {
        id: "recovery-test",
        version: 1,
        instructions: "",
        instructionsVersion: "1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: models.getModel("faux", "faux-1")!.api,
            providerVersion: "faux-test-v1",
        },
    } as const;
    let abortObservedStatus = "not-run";
    let threadKey = "";
    const runner = defineTask<
        { schemaVersion: 1; runId: string; threadId: string; profileId: string },
        { phase: "dispatching" },
        string
    >({
        name: AGENT_RUNNER_TASK_NAME,
        version: 1,
        initial: () => ({ phase: "dispatching" }),
        phases: {
            dispatching: async () => {
                throw new Error("an abort-marked recovery task must not run its phase");
            },
        },
        abort: async (task, nativeRuntime, context) => {
            const thread = await nativeRuntime.snapshot(AGENT_THREAD_DOC, threadKey, context);

            abortObservedStatus = thread?.status ?? "missing";
            await nativeRuntime.commit(
                () => ({
                    status: "terminal",
                    outcome: { status: "aborted", reason: "preflight" },
                }),
                context,
            );
        },
    });
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: { profiles: [profile] },
    });

    const runtimeTasks = runtime.extension.tasks;

    assert.ok(runtimeTasks);
    registry.install(
        defineExtension({
            name: "agent-recovery-runtime",
            tasks: runtimeTasks.filter((task) => task.definition.name !== AGENT_RUNNER_TASK_NAME),
        }),
    );
    registry.install(defineExtension({ name: "agent-recovery-test", tasks: [runner] }));
    const seedHarness = await Harness.open(
        await openNodeSqliteStorage(database),
        { models, registry },
        BACKGROUND_CONTEXT,
    );
    const identity = {
        runId: "run-recovery",
        threadId: "thread-recovery",
        profileId: profile.id,
    };
    const thread = await createOwnedAgentThread(
        seedHarness,
        runtime,
        models,
        runtime.profiles[0]!,
        "run-recovery",
        "thread-recovery",
        false,
    );

    threadKey = thread.threadKey;
    runtime.register(
        defineWorkflow({
            id: "host-owner-run-recovery",
            version: 1,
            run: () => null,
        }),
    );
    const runnerId = await seedHarness
        .root(BACKGROUND_CONTEXT)
        .then((root) =>
            root.commit(
                (tx) =>
                    tx.createTask(
                        runner,
                        { schemaVersion: 1, ...identity },
                        { ownership: { kind: "conversation" } },
                    ),
                BACKGROUND_CONTEXT,
            ),
        );

    await seedHarness.close(BACKGROUND_CONTEXT);
    let host: Awaited<ReturnType<typeof runtime.openHost>> | undefined;

    try {
        host = await runtime.openHost(
            await openNodeSqliteStorage(database),
            BACKGROUND_CONTEXT,
            () => undefined,
        );
        const harness = host.harness;
        const stored = await harness.snapshot(
            AGENT_THREAD_DOC,
            thread.threadKey,
            BACKGROUND_CONTEXT,
        );
        const native = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
            (candidate) => Number(candidate.record.id) === Number(runnerId),
        );

        assert.equal(stored?.status, "unknown");
        assert.equal(native?.record.abortRequested, true);
        await harness.waitForTask(runnerId, BACKGROUND_CONTEXT);
        assert.equal(abortObservedStatus, "unknown");
    } finally {
        await host?.dispose();
        await runtime.close();
        await host?.harness.close(BACKGROUND_CONTEXT);
        await rm(directory, { recursive: true, force: true });
    }
});

test("native Models entrypoints preserve host behavior for adapter and ordinary sessions", async () => {
    const registry = createRegistry();
    const faux = fauxProvider();
    const models = createModels();
    let dispatches = 0;

    models.setProvider(faux.provider);
    faux.setResponses([
        () => {
            dispatches++;

            return fauxAssistantMessage("one");
        },
        () => {
            dispatches++;

            return fauxAssistantMessage("two");
        },
        () => {
            dispatches++;

            return fauxAssistantMessage("ordinary stream");
        },
        () => {
            dispatches++;

            return fauxAssistantMessage("ordinary completion");
        },
    ]);
    const profile = {
        id: "host-test",
        version: 1,
        instructions: "Use only the approved profile.",
        instructionsVersion: "1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: models.getModel("faux", "faux-1")!.api,
            providerVersion: "faux-test-v1",
        },
    } as const;
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: { profiles: [profile] },
    });

    registry.install(runtime.extension);
    const host = await openAgentHost(runtime);
    const harness = host.harness;
    const identity = { runId: "run-A", threadId: "thread-A", profileId: profile.id };
    const sessionId = workflowAgentProviderSessionId(identity);

    const model = models.getModel("faux", "faux-1")!;
    const agentModels = models;

    try {
        assert.equal(agentModels, models);
        const controller = new AbortController();

        controller.abort(new Error("cancelled by caller"));

        const abortedStream = agentModels.streamSimple(
            model,
            { messages: [] },
            { sessionId, signal: controller.signal },
        );
        const abortedEvents: string[] = [];
        const abortedReasons: string[] = [];

        for await (const event of abortedStream) {
            abortedEvents.push(event.type);

            if (event.type === "error") {
                abortedReasons.push(event.reason);
            }
        }

        const abortedResult = await abortedStream.result();

        assert.deepEqual(abortedEvents, ["error"]);
        assert.deepEqual(abortedReasons, ["error"]);
        assert.equal(abortedResult.stopReason, "error");
        assert.match(abortedResult.errorMessage ?? "", /cancelled by caller/i);
        assert.equal(dispatches, 0);

        const agentStream = agentModels.streamSimple(model, { messages: [] }, { sessionId });

        assert.equal((await agentStream.result()).stopReason, "stop");
        assert.equal(dispatches, 1);
        assert.equal(
            (await agentModels.completeSimple(model, { messages: [] }, { sessionId })).stopReason,
            "stop",
        );
        assert.equal(dispatches, 2);

        const ordinaryStream = agentModels.streamSimple(
            model,
            { messages: [] },
            { sessionId: "ordinary-session" },
        );

        assert.equal((await ordinaryStream.result()).stopReason, "stop");
        assert.equal(
            (
                await agentModels.completeSimple(
                    model,
                    { messages: [] },
                    { sessionId: "ordinary-session" },
                )
            ).stopReason,
            "stop",
        );
        assert.equal(dispatches, 4);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("deferred adapter polling and cancellation follow native Models behavior across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-deferred-agent-"));
    const database = join(directory, "agent.sqlite");
    const registry = createRegistry();
    const faux = fauxProvider();
    const models = createModels();
    const handle = {
        provider: "faux",
        modelId: "faux-1",
        api: faux.getModel().api,
        id: "deferred-adapter-1",
    };
    let providerDispatches = 0;
    let deferredFetches = 0;
    const cancelled: unknown[] = [];
    const provider = {
        ...faux.provider,
        streamSimple(model: Parameters<typeof faux.provider.streamSimple>[0]) {
            providerDispatches++;
            const stream = createAssistantMessageEventStream();
            const message = {
                ...fauxAssistantMessage("deferred", { stopReason: "deferred", deferred: handle }),
                api: model.api,
                provider: model.provider,
                model: model.id,
            };

            queueMicrotask(() => stream.push({ type: "done", reason: "deferred", message }));

            return stream;
        },
        fetchDeferred(model: Parameters<typeof faux.provider.streamSimple>[0]) {
            deferredFetches++;
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
        async cancelDeferred(_model: unknown, deferred: unknown) {
            cancelled.push(deferred);
        },
    };

    models.setProvider(provider);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "deferred-test",
        version: 1,
        instructions: "",
        instructionsVersion: "1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-test-v1",
        },
    } as const;
    let runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig: { profiles: [profile] },
    });

    registry.install(runtime.extension);
    let host = await runtime.openHost(
        await openNodeSqliteStorage(database),
        BACKGROUND_CONTEXT,
        () => undefined,
    );
    let harness = host.harness;
    const thread = await createOwnedAgentThread(
        harness,
        runtime,
        models,
        runtime.profiles[0]!,
        "deferred-run",
        "deferred-thread",
    );

    try {
        const deferredMessage = await models
            .streamSimple(model, { messages: [] }, { sessionId: thread.providerSessionId })
            .result();
        const correlatedHandle = deferredMessage.deferred!;

        assert.equal(deferredMessage.stopReason, "deferred");
        assert.equal(correlatedHandle.id, handle.id);
        assert.equal(providerDispatches, 1);
        assert.equal(
            (await harness.snapshot(AGENT_THREAD_DOC, thread.threadKey, BACKGROUND_CONTEXT))
                ?.status,
            "ready",
        );
        assert.equal((await models.fetchDeferred(model, correlatedHandle)).stopReason, "stop");
        assert.equal(deferredFetches, 1);
        const deferredController = new AbortController();

        deferredController.abort(new Error("deferred request cancelled"));

        const cancelledDeferredStream = models.streamDeferred(model, correlatedHandle, {
            signal: deferredController.signal,
        });
        const cancelledDeferredEvents: string[] = [];
        const cancelledDeferredReasons: string[] = [];

        for await (const event of cancelledDeferredStream) {
            cancelledDeferredEvents.push(event.type);

            if (event.type === "error") {
                cancelledDeferredReasons.push(event.reason);
            }
        }

        const cancelledDeferredResult = await cancelledDeferredStream.result();

        assert.deepEqual(cancelledDeferredEvents, ["error"]);
        assert.deepEqual(cancelledDeferredReasons, ["error"]);
        assert.equal(cancelledDeferredResult.stopReason, "error");
        assert.match(cancelledDeferredResult.errorMessage ?? "", /deferred request cancelled/i);

        const acceptedStream = models.streamDeferred(model, correlatedHandle);

        assert.equal((await acceptedStream.result()).stopReason, "stop");
        assert.equal(deferredFetches, 2);

        await host.dispose();
        await runtime.close();
        await harness.close(BACKGROUND_CONTEXT);

        const reopenedRegistry = createRegistry();

        runtime = createWorkflowAgentRuntime({
            harnessOptions: { models, registry: reopenedRegistry },
            agentConfig: { profiles: [profile] },
        });
        reopenedRegistry.install(runtime.extension);
        host = await runtime.openHost(
            await openNodeSqliteStorage(database),
            BACKGROUND_CONTEXT,
            () => undefined,
        );
        harness = host.harness;
        assert.equal((await models.fetchDeferred(model, correlatedHandle)).stopReason, "stop");
        assert.equal(deferredFetches, 3);
        await models.cancelDeferred(model, correlatedHandle);
        assert.deepEqual(cancelled, [handle]);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(BACKGROUND_CONTEXT);
        await rm(directory, { recursive: true, force: true });
    }
});

test("reopened hosts start closed and profile drift cannot reach the provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-host-"));
    const database = join(directory, "agent.sqlite");
    const faux = fauxProvider();
    const models = createModels();
    let firstRuntime: ReturnType<typeof createWorkflowAgentRuntime> | undefined;
    let seedHarness: Harness | undefined;
    let secondRuntime: ReturnType<typeof createWorkflowAgentRuntime> | undefined;
    let secondHarness: Harness | undefined;

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("must not dispatch")]);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "static-reopen",
        version: 1,
        instructions: "first profile",
        instructionsVersion: "1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-test-v1",
        },
    } as const;

    try {
        const firstRegistry = createRegistry();

        firstRuntime = createWorkflowAgentRuntime({
            harnessOptions: { models, registry: firstRegistry },
            agentConfig: { profiles: [profile] },
        });
        firstRegistry.install(firstRuntime.extension);
        seedHarness = await Harness.open(
            await openNodeSqliteStorage(database),
            { models, registry: firstRegistry },
            BACKGROUND_CONTEXT,
        );
        const thread = await createOwnedAgentThread(
            seedHarness,
            firstRuntime,
            models,
            firstRuntime.profiles[0]!,
            "reopen-run",
            "reopen-thread",
        );

        await seedHarness.close(BACKGROUND_CONTEXT);
        seedHarness = undefined;
        await firstRuntime.close();
        firstRuntime = undefined;

        const secondRegistry = createRegistry();
        const changedProfile = {
            ...profile,
            version: 2,
            instructions: "changed profile",
            instructionsVersion: "2",
        };

        const reopeningRuntime = createWorkflowAgentRuntime({
            harnessOptions: { models, registry: secondRegistry },
            agentConfig: { profiles: [changedProfile] },
        });

        secondRuntime = reopeningRuntime;
        secondRegistry.install(reopeningRuntime.extension);
        assert.throws(() => reopeningRuntime.engine, /host startup/i);
        reopeningRuntime.register(
            defineWorkflow({
                id: `host-owner-reopen-run`,
                version: 1,
                async run({ agent }) {
                    if (agent === undefined) {
                        throw new Error("Agent binding is unavailable");
                    }

                    return agent.turn({
                        threadId: "reopen-thread",
                        turnId: "second-turn",
                        profile: changedProfile.id,
                        content: "must not dispatch after profile drift",
                    });
                },
            }),
        );
        secondHarness = (
            await reopeningRuntime.openHost(
                await openNodeSqliteStorage(database),
                BACKGROUND_CONTEXT,
                () => undefined,
            )
        ).harness;
        await secondHarness.waitForTask(thread.ownerTaskId as never, BACKGROUND_CONTEXT);
        const storedThread = await secondHarness.snapshot(
            AGENT_THREAD_DOC,
            thread.threadKey,
            BACKGROUND_CONTEXT,
        );

        assert.equal(storedThread?.turns?.length, 0);
        assert.equal(faux.state.callCount, 0);
    } finally {
        await secondRuntime?.close();
        await secondHarness?.close(BACKGROUND_CONTEXT);
        await firstRuntime?.close();
        await seedHarness?.close(BACKGROUND_CONTEXT);
        await rm(directory, { recursive: true, force: true });
    }
});

test("host options, callbacks, and non-adapter environments remain composed", async () => {
    const registry = createRegistry();
    const faux = fauxProvider();
    const models = createModels();
    const firstSettings = { stream: { timeoutMs: 10 } };
    const secondSettings = { stream: { timeoutMs: 20 } };
    const inheritedEnvironment = { label: "host-env" } as never;
    const agentEnvironment = { label: "agent-env" } as never;
    let currentSettings = firstSettings;
    let settingsReads = 0;
    let baseEnvCalls = 0;
    let callbackCalls = 0;
    let reportCalls = 0;
    const envResults: unknown[] = [];
    const settingsResults: unknown[] = [];
    const clockResults: number[] = [];
    let agentEnvTarget: { conversationId: number; cwd?: string; read?: unknown } | undefined;

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("agent environment resolved")]);
    const profile = {
        id: "environment-test",
        version: 1,
        instructions: "",
        instructionsVersion: "1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: models.getModel("faux", "faux-1")!.api,
            providerVersion: "faux-test-v1",
        },
    } as const;
    const now = () => 123;

    const onReport = () => {
        reportCalls++;
    };

    const baseOptions = {
        models,
        registry,
        now,
        onReport,
        env: async () => {
            baseEnvCalls++;

            return inheritedEnvironment;
        },
        conversationCreated: async (
            tx: Parameters<NonNullable<HarnessOptions["conversationCreated"]>>[0],
            conversation: Parameters<NonNullable<HarnessOptions["conversationCreated"]>>[1],
        ) => {
            callbackCalls++;
            const agent = await tx.doc(AgentDoc, conversation.id);

            agent.instructions = "created by the host callback";
        },
    } as HarnessOptions;

    Object.defineProperty(baseOptions, "settings", {
        enumerable: true,
        get() {
            settingsReads++;

            return currentSettings;
        },
    });
    const envTask = defineTask<null, { phase: "resolve" }, string>({
        name: "test.workflow-agent-host-env",
        version: 1,
        initial: () => ({ phase: "resolve" }),
        phases: {
            resolve: async (_task, taskRuntime, taskContext) => {
                envResults.push(await taskRuntime.env(taskContext));
                settingsResults.push(taskRuntime.settings);
                clockResults.push(taskRuntime.now());
                taskRuntime.report(new Error("host option forwarding probe"));
                await taskRuntime.commit(
                    () => ({
                        status: "terminal",
                        outcome: { status: "completed", result: "resolved" },
                    }),
                    taskContext,
                );
            },
        },
        abort: async (_task, taskRuntime, taskContext) => {
            await taskRuntime.commit(
                () => ({
                    status: "terminal",
                    outcome: { status: "aborted", reason: "test abort" },
                }),
                taskContext,
            );
        },
    });
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: baseOptions,
        agentConfig: {
            profiles: [profile],
            buildEnv: (_profile, target, inherited) => {
                agentEnvTarget = {
                    conversationId: Number(target.conversationId),
                    cwd: target.cwd,
                    read: target.read,
                };

                assert.equal(inherited, inheritedEnvironment);

                return agentEnvironment;
            },
        },
    });

    registry.install(runtime.extension);
    registry.install(defineExtension({ name: "host-env-test", tasks: [envTask] }));
    const host = await openAgentHost(runtime);
    const harness = host.harness;
    const ordinary = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
    );

    try {
        const ordinaryTaskId = await ordinary.commit(
            (tx) => tx.createTask(envTask, null, { ownership: { kind: "conversation" } }),
            BACKGROUND_CONTEXT,
        );

        await harness.waitForTask(ordinaryTaskId, BACKGROUND_CONTEXT);
        currentSettings = secondSettings;
        const secondOrdinaryTaskId = await ordinary.commit(
            (tx) => tx.createTask(envTask, null, { ownership: { kind: "conversation" } }),
            BACKGROUND_CONTEXT,
        );

        await harness.waitForTask(secondOrdinaryTaskId, BACKGROUND_CONTEXT);
        let resolveTurnCompleted!: () => void;
        let releaseWorkflow!: () => void;
        const turnCompleted = new Promise<void>((resolve) => {
            resolveTurnCompleted = resolve;
        });
        const workflowGate = new Promise<void>((resolve) => {
            releaseWorkflow = resolve;
        });
        const agentWorkflow = defineWorkflow({
            id: "host-env-workflow",
            version: 1,
            async run({ agent }) {
                if (agent === undefined) {
                    throw new Error("Agent binding is unavailable");
                }

                const answer = await agent.turn({
                    threadId: "env-thread",
                    turnId: "env-turn",
                    profile: profile.id,
                    content: "resolve the agent environment",
                });

                resolveTurnCompleted();
                await workflowGate;

                return answer;
            },
        });

        runtime.register(agentWorkflow);
        const run = await runtime.engine.start(
            agentWorkflow,
            null,
            { runId: "host-env-run" },
            BACKGROUND_CONTEXT,
        );

        try {
            await turnCompleted;
            const threadKey = workflowAgentThreadKey({
                runId: run.runId,
                threadId: "env-thread",
                profileId: profile.id,
            });
            const thread = await harness.snapshot(AGENT_THREAD_DOC, threadKey, BACKGROUND_CONTEXT);

            assert.ok(thread);
            const spoofedConversation = await harness.createConversation(
                { ownership: { kind: "ownerless" } },
                BACKGROUND_CONTEXT,
            );

            await spoofedConversation.commit(async (tx) => {
                const provider = await tx.doc(ProviderDoc, spoofedConversation.id);

                provider.sessionId = thread.providerSessionId;
            }, BACKGROUND_CONTEXT);
            const spoofedTaskId = await spoofedConversation.commit(
                (tx) => tx.createTask(envTask, null, { ownership: { kind: "conversation" } }),
                BACKGROUND_CONTEXT,
            );

            await harness.waitForTask(spoofedTaskId, BACKGROUND_CONTEXT);
            assert.equal(agentEnvTarget?.conversationId, thread.conversationId);
        } finally {
            releaseWorkflow();
        }

        await runtime.engine.wait(run.runId, BACKGROUND_CONTEXT);
        assert.deepEqual(envResults, [
            inheritedEnvironment,
            inheritedEnvironment,
            inheritedEnvironment,
        ]);
        assert.deepEqual(
            settingsResults.map(
                (settings) => (settings as { stream: { timeoutMs: number } }).stream.timeoutMs,
            ),
            [10, 20, 20],
        );
        assert.deepEqual(clockResults, [123, 123, 123]);
        assert.ok((agentEnvTarget?.conversationId ?? 0) > 0);
        assert.ok(agentEnvTarget?.read);
        assert.equal(reportCalls, 3);
        assert.equal(baseEnvCalls, 4);
        assert.ok(callbackCalls >= 3);
        assert.ok(settingsReads >= 2);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});
