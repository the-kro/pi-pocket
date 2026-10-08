import { type Context, type Draft, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
    type ConversationDocFamilyToken,
    type ConversationDocToken,
    type ConversationId,
    type ConversationQuery,
    type ConversationRecord,
    type Cursor,
    type EnvTarget,
    Harness,
    type HarnessOptions,
    type JsonObject,
    type Page,
    type SessionDocFamilyToken,
    type SessionDocToken,
    type Storage,
    ProviderDoc,
    UserEntry,
    type TaskId,
    type TaskRecord,
    type ToolRegistration,
    type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { canonicalInput } from "../core/identity.ts";
import {
    type WorkflowAgentConfig,
    type WorkflowAgentProfile,
    type AgentThreadIdentity,
    parseWorkflowAgentProviderSessionId,
    resolveWorkflowAgentConfig,
    workflowAgentProfileFingerprint,
    workflowAgentThreadKey,
} from "./profile.ts";
import {
    createWorkflowRuntimeKernel,
    RUN_DOC,
    type WorkflowDefinition,
    type WorkflowEngine,
} from "../core/index.ts";
import type { WorkflowTimerOptions } from "../timer-host.ts";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
} from "./records.ts";
import {
    createWorkflowAgentRunnerTask,
    createWorkflowAgentTurnBinder,
    workflowAgentRunnerIntentMatches,
} from "./runner.ts";

export {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
} from "./records.ts";

export type CreateWorkflowAgentRuntimeOptions<Tool extends ToolRegistration = ToolRegistration> = {
    readonly harnessOptions: HarnessOptions<Tool>;
    readonly agentConfig: WorkflowAgentConfig;
    readonly timerOptions?: WorkflowTimerOptions;
};

export type WorkflowAgentDocumentWriter = {
    session<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
    conversation<T extends JsonObject>(
        token: ConversationDocToken<T>,
        conversationId: ConversationId,
    ): Promise<Draft<T>>;
    sessionFamily<T extends JsonObject, I extends JsonValue>(
        token: SessionDocFamilyToken<T, I>,
        key: string,
        seed: I,
    ): Promise<Draft<T>>;
    conversationFamily<T extends JsonObject, I extends JsonValue>(
        token: ConversationDocFamilyToken<T, I>,
        conversationId: ConversationId,
        key: string,
        seed: I,
    ): Promise<Draft<T>>;
};

export type WorkflowAgentHostSetup = Pick<Harness, "snapshot" | "subscribeCommits"> & {
    inspect(): ReturnType<Harness["inspect"]>;
    getTask<T>(taskId: TaskId<T>): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
    scanConversations(
        query: ConversationQuery,
        limit: number,
        cursor?: Cursor,
    ): Promise<Page<ConversationRecord, Cursor>>;
    updateDocuments<T>(update: (writer: WorkflowAgentDocumentWriter) => T | Promise<T>): Promise<T>;
    requestConversationAbort(conversationId: ConversationId): void;
    onAfterAdapterRecovery(recover: (setup: WorkflowAgentHostSetup) => void | Promise<void>): void;
    onCleanup(disposer: () => void | Promise<void>): void;
};

export type WorkflowAgentHost<T> = {
    readonly harness: Harness;
    readonly prepared: T;
    dispose(): Promise<void>;
};

export type WorkflowAgentHostPreparation<T> = (setup: WorkflowAgentHostSetup) => T | Promise<T>;

export type WorkflowAgentRuntime = {
    readonly extension: ReturnType<typeof createWorkflowRuntimeKernel>["extension"];
    readonly profiles: readonly WorkflowAgentProfile[];
    readonly engine: WorkflowEngine;
    register<I extends JsonValue, O extends JsonValue>(definition: WorkflowDefinition<I, O>): void;
    openHost<T>(
        storage: Storage,
        context: Context,
        prepare: WorkflowAgentHostPreparation<T>,
    ): Promise<WorkflowAgentHost<T>>;
    close(): Promise<void>;
};

const AGENT_SESSION_PREFIX = "pocket-workflow-agent-v1:";

/** Create a portable, per-Harness agent adapter over the existing workflow kernel. */
export function createWorkflowAgentRuntime<Tool extends ToolRegistration = ToolRegistration>(
    options: CreateWorkflowAgentRuntimeOptions<Tool>,
): WorkflowAgentRuntime {
    const config = resolveWorkflowAgentConfig(options.agentConfig);
    const baseModels = options.harnessOptions.models;
    let harness: Harness | undefined;
    let engine: WorkflowEngine | undefined;
    let publicEngine: WorkflowEngine | undefined;
    let attached = false;
    let closed = false;
    let attachPromise: Promise<void> | undefined;
    let openPromise: Promise<void> | undefined;
    let closePromise: Promise<void> | undefined;
    let hostStartPromise: Promise<WorkflowAgentHost<unknown>> | undefined;
    let hostStartStorage: Storage | undefined;
    let hostStartContext: Context | undefined;
    let hostStartPrepare: WorkflowAgentHostPreparation<unknown> | undefined;
    let hostSetupSeal: (() => void) | undefined;
    let lifecycle: "configuring" | "opening" | "ready" | "closed" = "configuring";
    const workflowDefinitions = new Map<string, WorkflowDefinition<JsonValue, JsonValue>>();
    const startupAbortConversations = new Set<ConversationId>();
    const runnerTask = createWorkflowAgentRunnerTask(baseModels, config);
    const bindAgentTurn = createWorkflowAgentTurnBinder({
        models: baseModels,
        config,
        runnerTask,
    });
    const kernel = createWorkflowRuntimeKernel({
        beforeOpen: () => {
            if (closed || !attached) {
                throw new WorkflowAgentAdmissionError(
                    "Agent runtime recovery must complete before workflow runtime open",
                );
            }
        },
        beforeResume: async (context) => {
            if (!attached || harness === undefined) {
                throw new WorkflowAgentAdmissionError(
                    "Agent runtime recovery must complete before Harness scheduling resumes",
                );
            }

            await recoverAgentRunnerTasks(harness, context);
        },
        beforeProgress: async (context) => {
            hostSetupSeal?.();

            if (harness === undefined) {
                throw new WorkflowAgentAdmissionError(
                    "Agent runtime has no Harness at the controlled progress transition",
                );
            }

            for (const conversationId of startupAbortConversations) {
                const conversation = await harness.conversation(conversationId, context);

                if (conversation !== undefined) {
                    await conversation.abort(context);
                }

                startupAbortConversations.delete(conversationId);
            }
        },
        bindAgentTurn,
        additionalTasks: [runnerTask],
    });

    const loadThread = async (
        sessionId: string,
        targetConversationId: ConversationId,
    ): Promise<AgentThreadRecord | undefined> => {
        const parsed = parseWorkflowAgentProviderSessionId(sessionId);

        if (parsed === undefined) {
            throw new WorkflowAgentAdmissionError("Agent provider session identity is malformed");
        }

        if (closed || !attached || harness === undefined) {
            throw new WorkflowAgentAdmissionError(
                "Agent runtime recovery is not ready for model dispatch",
            );
        }

        const thread = await harness.snapshot(AGENT_THREAD_DOC, parsed.key, BACKGROUND_CONTEXT);

        if (thread !== undefined && thread.conversationId !== targetConversationId) {
            return undefined;
        }

        if (
            thread === undefined ||
            thread.schemaVersion !== 1 ||
            thread.threadKey !== parsed.key ||
            thread.runId !== parsed.identity.runId ||
            thread.threadId !== parsed.identity.threadId ||
            thread.profileId !== parsed.identity.profileId ||
            thread.providerSessionId !== sessionId ||
            thread.status !== "ready"
        ) {
            throw new WorkflowAgentAdmissionError(
                "Agent thread identity is missing, stale, or not admitted",
            );
        }

        const profile = config.byId.get(thread.profileId);

        if (
            profile === undefined ||
            thread.profileVersion !== profile.version ||
            thread.profileFingerprint !== workflowAgentProfileFingerprint(profile)
        ) {
            throw new WorkflowAgentAdmissionError(
                "Agent profile authority changed or is unavailable",
            );
        }

        const ownerTaskId = thread.ownerTaskId;

        if (!Number.isSafeInteger(ownerTaskId) || ownerTaskId! <= 0) {
            throw new WorkflowAgentAdmissionError("Agent thread has no workflow Task owner");
        }

        const [nativeConversation, owner, run, provider] = await Promise.all([
            harness.commit(
                (tx) => tx.conversation(thread.conversationId as ConversationId),
                BACKGROUND_CONTEXT,
            ),
            harness.getTask(ownerTaskId as TaskId, BACKGROUND_CONTEXT),
            harness.snapshot(RUN_DOC, thread.runId, BACKGROUND_CONTEXT),
            harness.snapshot(
                ProviderDoc,
                thread.conversationId as ConversationId,
                BACKGROUND_CONTEXT,
            ),
        ]);

        if (
            nativeConversation === undefined ||
            nativeConversation.owner === undefined ||
            nativeConversation.owner.taskId !== ownerTaskId ||
            owner === undefined ||
            owner.kind !== "pocket.workflow-runtime.task" ||
            owner.conversationId !== nativeConversation.owner.conversationId ||
            owner.abortRequested ||
            owner.state.status === "terminal" ||
            owner.state.status === "completing" ||
            (owner.input as { readonly runId?: unknown }).runId !== thread.runId ||
            run === undefined ||
            run.taskId !== ownerTaskId ||
            run.stopCommand !== undefined ||
            run.selectedOutcome !== undefined ||
            (run.status !== "running" && run.status !== "waiting")
        ) {
            throw new WorkflowAgentAdmissionError(
                "Agent thread has no active matching workflow owner",
            );
        }

        if (provider?.sessionId !== sessionId) {
            throw new WorkflowAgentAdmissionError(
                "Agent ProviderDoc correlation is missing or ambiguous",
            );
        }

        return thread as AgentThreadRecord;
    };

    let captureHarnessOpenReport: ((error: unknown) => void) | undefined;
    const composedOptions = composeHarnessOptions(
        options.harnessOptions,
        baseModels,
        async (target, context) => {
            const inherited = await options.harnessOptions.env?.(target, context);
            const thread = await findThreadForConversation(target, context);

            if (thread === undefined || config.buildEnv === undefined) {
                return inherited;
            }

            const profile = config.byId.get(thread.profileId);

            if (profile === undefined) {
                throw new WorkflowAgentAdmissionError("Agent environment profile is unavailable");
            }

            return config.buildEnv(profile, target, inherited, context);
        },
        (error) => captureHarnessOpenReport?.(error),
    );

    async function findThreadForConversation(
        target: EnvTarget,
        context: Context,
    ): Promise<AgentThreadRecord | undefined> {
        const provider = await target.read.snapshot(ProviderDoc, target.conversationId, context);

        if (
            provider?.sessionId === undefined ||
            !provider.sessionId.startsWith(AGENT_SESSION_PREFIX)
        ) {
            return undefined;
        }

        return loadThread(provider.sessionId, target.conversationId);
    }

    const registerWorkflow = <I extends JsonValue, O extends JsonValue>(
        definition: WorkflowDefinition<I, O>,
    ): void => {
        if (lifecycle === "closed" || lifecycle === "opening") {
            throw new WorkflowAgentAdmissionError(
                "Workflow definitions may only change before startup or after it completes",
            );
        }

        const key = JSON.stringify([definition.id, definition.version]);
        const existing = workflowDefinitions.get(key);

        if (existing === definition) {
            return;
        }

        if (existing !== undefined) {
            throw new Error(
                `Workflow ${definition.id}@${definition.version} is already registered`,
            );
        }

        if (lifecycle === "ready") {
            engine?.register(definition);
        }

        workflowDefinitions.set(
            key,
            definition as unknown as WorkflowDefinition<JsonValue, JsonValue>,
        );
    };

    const attachRuntime = (attachedHarness: Harness, context: Context): Promise<void> => {
        if (closed || lifecycle !== "opening") {
            return Promise.reject(
                new WorkflowAgentAdmissionError(
                    "Harness attachment is owned by runtime.openHost()",
                ),
            );
        }

        if (harness !== undefined && harness !== attachedHarness) {
            return Promise.reject(
                new WorkflowAgentAdmissionError("Agent runtime is bound to another Harness"),
            );
        }

        if (attached) {
            return Promise.resolve();
        }

        if (attachPromise !== undefined) {
            return attachPromise;
        }

        harness = attachedHarness;
        engine ??= kernel.createEngine(attachedHarness, options.timerOptions);

        for (const definition of workflowDefinitions.values()) {
            engine.register(definition);
        }

        publicEngine ??= exposeWorkflowEngine(engine);
        attachPromise = (async () => {
            await recoverAgentRunnerTasks(attachedHarness, context);

            if (closed) {
                throw new WorkflowAgentAdmissionError("Agent runtime closed during recovery");
            }

            attached = true;
        })();

        return attachPromise;
    };

    const openRuntime = (context: Context): Promise<void> => {
        if (closed || lifecycle !== "opening" || !attached || engine === undefined) {
            return Promise.reject(
                new WorkflowAgentAdmissionError(
                    "Only openHost() may complete workflow runtime startup",
                ),
            );
        }

        if (openPromise !== undefined) {
            return openPromise;
        }

        const opening = (async () => {
            if (closed || harness === undefined) {
                throw new WorkflowAgentAdmissionError(
                    "Agent runtime closed before workflow progress could start",
                );
            }

            await recoverAgentRunnerTasks(harness, context);

            if (closed) {
                throw new WorkflowAgentAdmissionError(
                    "Agent runtime closed during final recovery preflight",
                );
            }

            await engine.open(context);
        })();

        openPromise = opening;
        void opening.catch(() => {
            if (openPromise === opening) {
                openPromise = undefined;
            }
        });

        return opening;
    };

    const closeRuntimeResources = async (): Promise<void> => {
        if (attachPromise !== undefined) {
            await attachPromise.catch(() => {});
        }

        if (openPromise !== undefined) {
            await openPromise.catch(() => {});
        }

        await engine?.close();
        attached = false;
        harness = undefined;
        engine = undefined;
        publicEngine = undefined;
    };

    const runtime: WorkflowAgentRuntime = {
        extension: kernel.extension,
        profiles: config.profiles,
        get engine() {
            if (lifecycle !== "ready" || publicEngine === undefined) {
                throw new WorkflowAgentAdmissionError(
                    "Workflow engine is unavailable until host startup completes",
                );
            }

            return publicEngine;
        },
        register: registerWorkflow,
        openHost: <T>(
            storage: Storage,
            context: Context,
            prepare: WorkflowAgentHostPreparation<T>,
        ): Promise<WorkflowAgentHost<T>> => {
            if (closed || lifecycle === "closed") {
                return Promise.reject(
                    new WorkflowAgentAdmissionError("Agent runtime cannot start after close"),
                );
            }

            if (hostStartPromise !== undefined) {
                if (
                    storage !== hostStartStorage ||
                    context !== hostStartContext ||
                    prepare !== hostStartPrepare
                ) {
                    return Promise.reject(
                        new WorkflowAgentAdmissionError(
                            "Agent runtime is already starting a different host",
                        ),
                    );
                }

                return hostStartPromise as Promise<WorkflowAgentHost<T>>;
            }

            if (lifecycle !== "configuring") {
                return Promise.reject(
                    new WorkflowAgentAdmissionError("Agent runtime can start only once"),
                );
            }

            lifecycle = "opening";
            hostStartStorage = storage;
            hostStartContext = context;
            hostStartPrepare = prepare as WorkflowAgentHostPreparation<unknown>;
            const opening = (async (): Promise<WorkflowAgentHost<T>> => {
                let openedHarness: Harness | undefined;
                let setupActive = false;
                let afterRecoveryRegistrationOpen = true;
                let disposed = false;
                const cleanupHandlers: (() => void | Promise<void>)[] = [];
                const afterRecoveryHandlers: ((
                    setup: WorkflowAgentHostSetup,
                ) => void | Promise<void>)[] = [];

                const assertSetupActive = () => {
                    if (!setupActive || closed) {
                        throw new WorkflowAgentAdmissionError(
                            "Agent startup setup capabilities are sealed",
                        );
                    }
                };

                const runCleanupHandlers = async (): Promise<unknown[]> => {
                    if (disposed) {
                        return [];
                    }

                    disposed = true;
                    const failures: unknown[] = [];

                    for (const cleanup of cleanupHandlers.reverse()) {
                        try {
                            await cleanup();
                        } catch (error) {
                            failures.push(error);
                        }
                    }

                    return failures;
                };

                const dispose = async () => {
                    const failures = await runCleanupHandlers();

                    if (failures.length === 1) {
                        throw failures[0];
                    }

                    if (failures.length > 1) {
                        throw new AggregateError(failures, "Workflow host setup cleanup failed", {
                            cause: failures[0],
                        });
                    }
                };

                const acquisitionReports: unknown[] = [];

                try {
                    const capture = (report: unknown) => acquisitionReports.push(report);

                    captureHarnessOpenReport = capture;

                    try {
                        openedHarness = await Harness.open(storage, composedOptions, context);
                    } finally {
                        if (captureHarnessOpenReport === capture) {
                            captureHarnessOpenReport = undefined;
                        }
                    }

                    if (closed) {
                        throw new WorkflowAgentAdmissionError(
                            "Agent runtime closed while opening its Harness",
                        );
                    }

                    setupActive = true;

                    hostSetupSeal = () => {
                        setupActive = false;
                    };

                    const snapshot = ((...args: unknown[]) => {
                        assertSetupActive();

                        return Reflect.apply(
                            openedHarness!.snapshot.bind(openedHarness),
                            openedHarness,
                            args,
                        );
                    }) as unknown as WorkflowAgentHostSetup["snapshot"];
                    const setup: WorkflowAgentHostSetup = Object.freeze({
                        snapshot,
                        inspect: () => {
                            assertSetupActive();

                            return openedHarness!.inspect(context);
                        },
                        getTask: (taskId) => {
                            assertSetupActive();

                            return openedHarness!.getTask(taskId, context);
                        },
                        scanConversations: (query, limit, cursor) => {
                            assertSetupActive();

                            return openedHarness!.commit(
                                (tx) => tx.scanConversations(query, limit, cursor),
                                context,
                            );
                        },
                        updateDocuments: (update) => {
                            assertSetupActive();

                            return openedHarness!.commit(async (tx) => {
                                let writerActive = true;

                                const assertWriterActive = () => {
                                    if (!writerActive) {
                                        throw new WorkflowAgentAdmissionError(
                                            "Startup document writer is no longer active",
                                        );
                                    }
                                };

                                const writer: WorkflowAgentDocumentWriter = {
                                    session: (token) => {
                                        assertWriterActive();

                                        return tx.doc(token);
                                    },
                                    conversation: (token, conversationId) => {
                                        assertWriterActive();

                                        return tx.doc(token, conversationId);
                                    },
                                    sessionFamily: (token, key, seed) => {
                                        assertWriterActive();

                                        return tx.doc(token, key, seed);
                                    },
                                    conversationFamily: (token, conversationId, key, seed) => {
                                        assertWriterActive();

                                        return tx.doc(token, conversationId, key, seed);
                                    },
                                };

                                try {
                                    return await update(writer);
                                } finally {
                                    writerActive = false;
                                }
                            }, context);
                        },
                        subscribeCommits: (listener) => {
                            assertSetupActive();
                            const unsubscribe = openedHarness!.subscribeCommits(listener);
                            let active = true;

                            const disposeSubscription = () => {
                                if (!active) {
                                    return;
                                }

                                active = false;
                                unsubscribe();
                            };

                            cleanupHandlers.push(disposeSubscription);

                            return disposeSubscription;
                        },
                        requestConversationAbort: (conversationId) => {
                            assertSetupActive();

                            if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
                                throw new TypeError(
                                    "Conversation ID must be a positive safe integer",
                                );
                            }

                            startupAbortConversations.add(conversationId);
                        },
                        onAfterAdapterRecovery: (recover) => {
                            assertSetupActive();

                            if (!afterRecoveryRegistrationOpen) {
                                throw new WorkflowAgentAdmissionError(
                                    "Post-recovery host setup registration is sealed",
                                );
                            }

                            afterRecoveryHandlers.push(recover);
                        },
                        onCleanup: (cleanup) => {
                            assertSetupActive();
                            cleanupHandlers.push(cleanup);
                        },
                    });
                    const prepared = await prepare(setup);

                    afterRecoveryRegistrationOpen = false;

                    if (closed) {
                        throw new WorkflowAgentAdmissionError(
                            "Agent runtime closed during host preparation",
                        );
                    }

                    await attachRuntime(openedHarness, context);

                    if (closed) {
                        throw new WorkflowAgentAdmissionError(
                            "Agent runtime closed during adapter recovery",
                        );
                    }

                    for (const recover of afterRecoveryHandlers) {
                        await recover(setup);

                        if (closed) {
                            throw new WorkflowAgentAdmissionError(
                                "Agent runtime closed during post-recovery host setup",
                            );
                        }
                    }

                    await openRuntime(context);

                    if (closed) {
                        throw new WorkflowAgentAdmissionError(
                            "Agent runtime closed during host startup",
                        );
                    }

                    setupActive = false;
                    lifecycle = "ready";

                    return { harness: openedHarness, prepared, dispose };
                } catch (error) {
                    setupActive = false;
                    hostSetupSeal?.();
                    closed = true;
                    lifecycle = "closed";
                    const failures: unknown[] = [
                        error,
                        ...acquisitionReports,
                        ...(await runCleanupHandlers()),
                    ];

                    try {
                        await closeRuntimeResources();
                    } catch (cleanupError) {
                        failures.push(cleanupError);
                    }

                    if (openedHarness !== undefined) {
                        try {
                            await openedHarness.close(BACKGROUND_CONTEXT);
                        } catch (cleanupError) {
                            failures.push(cleanupError);
                        }
                    }

                    if (failures.length > 1) {
                        throw new AggregateError(
                            failures,
                            "Agent host startup and cleanup failed",
                            { cause: error },
                        );
                    }

                    throw error;
                }
            })();

            hostStartPromise = opening as Promise<WorkflowAgentHost<unknown>>;

            return opening;
        },
        close: () => {
            if (closePromise !== undefined) {
                return closePromise;
            }

            closed = true;
            lifecycle = "closed";
            closePromise = (async () => {
                if (hostStartPromise !== undefined) {
                    await hostStartPromise.catch(() => {});
                }

                await closeRuntimeResources();
            })();

            return closePromise;
        },
    };

    return runtime;
}

function exposeWorkflowEngine(engine: WorkflowEngine): WorkflowEngine {
    return new Proxy(engine, {
        get(target, property) {
            if (property === "open") {
                return () =>
                    Promise.reject(
                        new WorkflowAgentAdmissionError(
                            "Use runtime.openHost() so workflow activation follows startup recovery",
                        ),
                    );
            }

            if (property === "close") {
                return () =>
                    Promise.reject(
                        new WorkflowAgentAdmissionError(
                            "Use runtime.close() to release runtime resources",
                        ),
                    );
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function composeHarnessOptions<Tool extends ToolRegistration>(
    base: HarnessOptions<Tool>,
    models: Models,
    buildEnv: (target: EnvTarget, context: Context) => Promise<ExecutionEnv | undefined>,
    captureReportedError: (error: unknown) => void,
): HarnessOptions {
    const composed = Object.create(Object.getPrototypeOf(base)) as Record<PropertyKey, unknown>;
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(base);

    delete descriptors.models;
    delete descriptors.env;
    delete descriptors.conversationCreated;
    delete descriptors.onReport;
    Object.defineProperties(composed, descriptors);
    Object.defineProperties(composed, {
        models: { value: models, enumerable: true, configurable: true },
        env: { value: buildEnv, enumerable: true, configurable: true },
        conversationCreated: {
            value: async (
                tx: Tx,
                conversation: Parameters<
                    NonNullable<HarnessOptions<Tool>["conversationCreated"]>
                >[1],
            ) => {
                await base.conversationCreated?.(tx, conversation);
            },
            enumerable: true,
            configurable: true,
        },
        onReport: {
            value: (error: unknown) => {
                captureReportedError(error);

                try {
                    base.onReport?.(error);
                } catch (callbackError) {
                    captureReportedError(callbackError);
                }
            },
            enumerable: true,
            configurable: true,
        },
    });

    return composed as HarnessOptions;
}

async function recoverAgentRunnerTasks(harness: Harness, context: Context): Promise<void> {
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

        if (sessionId === undefined || !sessionId.startsWith(AGENT_SESSION_PREFIX)) {
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
