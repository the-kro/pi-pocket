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
    type TaskId,
    type TaskRecord,
    type ToolRegistration,
    type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
    type WorkflowAgentConfig,
    type WorkflowAgentProfile,
    hasWorkflowAgentProviderSessionIdPrefix,
    parseWorkflowAgentProviderSessionId,
    resolveWorkflowAgentConfig,
    workflowAgentProfileFingerprint,
} from "./profile.ts";
import {
    createWorkflowRuntimeKernel,
    RUN_DOC,
    type WorkflowDefinition,
    type WorkflowEngine,
} from "../core/index.ts";
import type { WorkflowTimerOptions } from "../timer-host.ts";
import {
    AGENT_THREAD_DOC,
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
} from "./records.ts";
import { recoverAgentRunnerTasks } from "./recovery.ts";
import { createWorkflowAgentRunnerTask, createWorkflowAgentTurnBinder } from "./runner.ts";

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
            !hasWorkflowAgentProviderSessionIdPrefix(provider.sessionId)
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
