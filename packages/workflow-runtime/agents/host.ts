import { copyJson, type Context, type Draft, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
    type ConversationDocFamilyToken,
    type ConversationDocToken,
    type ConversationId,
    type ConversationQuery,
    type ConversationRecord,
    type Cursor,
    type Agent,
    type AgentState,
    AgentDoc,
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
    type ToolExecutionApi,
    type ToolRegistration,
    type Extension,
    type RegistryReader,
    type RegistrySnapshot,
    type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
    type WorkflowAgentAdmissionPolicy,
    parseWorkflowAgentPolicyBinding,
    validateWorkflowAgentAdmission,
} from "./admission-policy.ts";
import {
    type WorkflowAgentConfig,
    type WorkflowAgentProfile,
    type WorkflowAgentCallAuthority,
    type EffectiveWorkflowAgentAuthority,
    hasWorkflowAgentProviderSessionIdPrefix,
    parseWorkflowAgentProviderSessionId,
    resolveWorkflowAgentConfig,
    workflowAgentProfileFingerprint,
    workflowAgentProviderSessionId,
} from "./profile.ts";
import {
    createWorkflowRuntimeKernel,
    RUN_DOC,
    type WorkflowDefinition,
    type WorkflowEngine,
} from "../core/index.ts";
import type { WorkflowTimerOptions } from "../timer-host.ts";
import { canonicalInput } from "../core/identity.ts";
import {
    AGENT_THREAD_DOC,
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
} from "./records.ts";
import { recoverAgentRunnerTasks } from "./recovery.ts";
import {
    createWorkflowAgentResultRegistry,
    createWorkflowAgentStructuredResultExtensions,
} from "./structured-result.ts";
import {
    createWorkflowAgentSectionRegistry,
    workflowAgentSectionSourceName,
} from "./section-registry.ts";
import {
    createWorkflowAgentRunnerTask,
    createWorkflowAgentTurnBinder,
    workflowAgentNativeSelectionMatches,
    workflowAgentSectionViewsMatch,
} from "./runner.ts";
import {
    type WorkflowAgentProfileSnapshot,
    workflowAgentProfileSnapshot,
} from "./profile-snapshot.ts";

function exactPersistedSelection(actual: unknown, expected: readonly string[]): boolean {
    if (
        !Array.isArray(actual) ||
        actual.some((name) => typeof name !== "string") ||
        new Set(expected).size !== expected.length ||
        new Set(actual).size !== actual.length ||
        actual.length !== expected.length
    ) {
        return false;
    }

    return actual.every((name, index) => name === expected[index]);
}

function workflowAgentRawSelectionMatches(
    state: AgentState | undefined,
    snapshot: WorkflowAgentProfileSnapshot,
): boolean {
    return (
        state !== undefined &&
        exactPersistedSelection(
            state.extensions,
            snapshot.extensions.map((extension) => extension.name),
        ) &&
        exactPersistedSelection(
            state.tools,
            snapshot.authority.tools.map((tool) => tool.name),
        )
    );
}

export type CreateWorkflowAgentRuntimeOptions<Tool extends ToolRegistration = ToolRegistration> = {
    readonly harnessOptions: HarnessOptions<Tool>;
    readonly agentConfig: WorkflowAgentConfig;
    readonly admissionPolicy?: WorkflowAgentAdmissionPolicy;
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
    const workflowAgentConversationIds = new Set<number>();

    const registerWorkflowAgentConversation = (conversationId: number): void => {
        if (Number.isSafeInteger(conversationId) && conversationId > 0) {
            workflowAgentConversationIds.add(conversationId);
        }
    };

    const requireHostStorage = (): Storage => {
        if (hostStartStorage === undefined) {
            throw new WorkflowAgentAdmissionError("Agent recovery requires its opened Storage");
        }

        return hostStartStorage;
    };

    const resultExtensions = createWorkflowAgentStructuredResultExtensions(config.profiles);
    const resultRegistry = createWorkflowAgentResultRegistry(
        options.harnessOptions.registry,
        resultExtensions,
    );
    const baseRegistry = createWorkflowAgentSectionRegistry(resultRegistry);
    const guardedRegistry = createGuardedRegistryReader(
        baseRegistry,
        async (tool, extensionName, args, api, context) =>
            assertCurrentAgentToolAuthority(
                config,
                baseModels,
                guardedRegistry,
                tool,
                extensionName,
                args,
                api,
                context,
                options.admissionPolicy,
            ),
        (conversationId) => workflowAgentConversationIds.has(Number(conversationId)),
    );

    const recoveryAuthorityIsCurrent = async (
        thread: AgentThreadRecord,
        rawInput: JsonValue,
    ): Promise<boolean> => {
        registerWorkflowAgentConversation(thread.conversationId);

        try {
            const snapshot = currentRunnerProfileSnapshot(
                config,
                baseModels,
                baseRegistry,
                thread,
                rawInput,
                options.admissionPolicy,
            );

            if (snapshot === undefined) {
                return false;
            }

            if (harness === undefined) {
                return false;
            }

            const persistedAgent = await harness.snapshot(
                AgentDoc,
                thread.conversationId as ConversationId,
                BACKGROUND_CONTEXT,
            );

            if (!workflowAgentRawSelectionMatches(persistedAgent, snapshot)) {
                return false;
            }

            const conversation = await harness.conversation(
                thread.conversationId as ConversationId,
                BACKGROUND_CONTEXT,
            );

            if (conversation === undefined) {
                return false;
            }

            const nativeAgent = await conversation.agent(BACKGROUND_CONTEXT);

            return (
                workflowAgentNativeSelectionMatches(nativeAgent, snapshot) &&
                workflowAgentSectionViewsMatch(nativeAgent, snapshot)
            );
        } catch {
            return false;
        }
    };

    const runnerTask = createWorkflowAgentRunnerTask(
        baseModels,
        config,
        baseRegistry,
        options.admissionPolicy,
    );
    const bindAgentTurn = createWorkflowAgentTurnBinder({
        models: baseModels,
        config,
        registry: baseRegistry,
        admissionPolicy: options.admissionPolicy,
        runnerTask,
        onConversationAdmitted: (conversationId) =>
            registerWorkflowAgentConversation(Number(conversationId)),
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

            await recoverAgentRunnerTasks(
                harness,
                context,
                recoveryAuthorityIsCurrent,
                requireHostStorage(),
                registerWorkflowAgentConversation,
            );
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
        guardedRegistry,
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
        new Set(resultExtensions.map((extension) => extension.name)),
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
            await recoverAgentRunnerTasks(
                attachedHarness,
                context,
                recoveryAuthorityIsCurrent,
                requireHostStorage(),
                registerWorkflowAgentConversation,
            );

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

            await recoverAgentRunnerTasks(
                harness,
                context,
                recoveryAuthorityIsCurrent,
                requireHostStorage(),
                registerWorkflowAgentConversation,
            );

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

function currentRunnerProfileSnapshot(
    config: ReturnType<typeof resolveWorkflowAgentConfig>,
    models: Models,
    registry: RegistryReader,
    thread: AgentThreadRecord,
    rawInput: JsonValue,
    admissionPolicy?: WorkflowAgentAdmissionPolicy,
): ReturnType<typeof workflowAgentProfileSnapshot> | undefined {
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
        return undefined;
    }

    const input = rawInput as Record<string, JsonValue>;
    const profile = config.byId.get(thread.profileId);
    const rawEffective = input.effectiveAuthority;

    if (
        profile === undefined ||
        typeof input.profileId !== "string" ||
        input.profileId !== thread.profileId ||
        typeof input.profileFingerprint !== "string" ||
        typeof input.modelFingerprint !== "string" ||
        typeof input.authorityFingerprint !== "string" ||
        typeof input.turnId !== "string" ||
        typeof rawEffective !== "object" ||
        rawEffective === null ||
        Array.isArray(rawEffective)
    ) {
        return undefined;
    }

    const effective = rawEffective as unknown as EffectiveWorkflowAgentAuthority;

    if (
        !Array.isArray(effective.extensions) ||
        !Array.isArray(effective.sections) ||
        !Array.isArray(effective.tools) ||
        !Array.isArray(effective.capabilities)
    ) {
        return undefined;
    }

    const turn = thread.turns?.find((candidate) => candidate.turnId === input.turnId);

    if (turn === undefined) {
        return undefined;
    }

    let policyBinding: ReturnType<typeof parseWorkflowAgentPolicyBinding> | undefined;

    if (input.policyBinding !== undefined) {
        try {
            policyBinding = parseWorkflowAgentPolicyBinding(input.policyBinding);
        } catch {
            return undefined;
        }
    }

    if (
        !sameJson(
            turn.policyBinding as unknown as JsonValue | undefined,
            policyBinding as unknown as JsonValue | undefined,
        )
    ) {
        return undefined;
    }

    const callAuthority: WorkflowAgentCallAuthority = {
        extensions: effective.extensions.map((entry) => entry.name),
        sections: effective.sections.map((entry) => entry.key),
        tools: effective.tools.map((entry) => entry.name),
        capabilities: effective.capabilities,
    };
    const genericSnapshot = workflowAgentProfileSnapshot(
        models,
        config,
        profile,
        callAuthority,
        registry,
    );
    const policyProfile =
        policyBinding === undefined ? undefined : admissionPolicy?.resolveProfile?.(profile.id);
    const snapshot = policyProfile?.snapshot ?? genericSnapshot;

    try {
        validateWorkflowAgentAdmission(
            admissionPolicy,
            "recovery",
            profile.id,
            thread,
            {
                turnId: turn.turnId,
                intentCanonical: turn.intentCanonical,
                intentDigest: turn.intentDigest,
                ...(policyBinding === undefined ? {} : { policyBinding }),
            },
            snapshot,
        );
    } catch {
        return undefined;
    }

    const isCurrent =
        snapshot.profileFingerprint === input.profileFingerprint &&
        snapshot.modelFingerprint === input.modelFingerprint &&
        snapshot.authorityFingerprint === input.authorityFingerprint &&
        snapshot.profileFingerprint === thread.profileFingerprint &&
        snapshot.modelFingerprint === thread.modelFingerprint &&
        snapshot.authorityFingerprint === thread.authorityFingerprint &&
        sameJson(snapshot.profileInput, input.profileInput) &&
        sameJson(snapshot.modelInput, input.modelInput) &&
        sameJson(snapshot.authorityInput, input.authorityInput) &&
        sameJson(snapshot.authority as unknown as JsonValue, input.effectiveAuthority) &&
        turn.profileFingerprint === snapshot.profileFingerprint &&
        turn.modelFingerprint === snapshot.modelFingerprint &&
        turn.authorityFingerprint === snapshot.authorityFingerprint &&
        sameJson(turn.profileInput, input.profileInput) &&
        sameJson(turn.modelInput, input.modelInput) &&
        sameJson(turn.authorityInput, input.authorityInput) &&
        sameJson(turn.effectiveAuthority, input.effectiveAuthority);

    return isCurrent ? snapshot : undefined;
}

function createGuardedRegistryReader(
    base: RegistryReader,
    authorize: (
        tool: ToolRegistration,
        extensionName: string | undefined,
        args: unknown,
        api: ToolExecutionApi,
        context: Context,
    ) => Promise<ToolExecutionApi>,
    isWorkflowAgentConversation: (conversationId: ConversationId) => boolean,
): RegistryReader {
    return {
        snapshot() {
            const snapshot = base.snapshot();
            const extensions = new Map<Extension, Extension>();
            const toolOwners = new WeakMap<object, string>();

            for (const extension of snapshot.installed()) {
                for (const tool of extension.tools ?? []) {
                    toolOwners.set(tool, extension.name);
                }
            }

            const guardTool = (
                tool: ToolRegistration,
                extensionName = toolOwners.get(tool),
            ): ToolRegistration => {
                const execute = tool.execute;
                const guarded: ToolRegistration = {
                    ...tool,
                    execute: async (args, api, context) => {
                        if (typeof api.commit !== "function") {
                            throw new WorkflowAgentAdmissionError(
                                "Nested tool execution has no public persisted-authority context",
                            );
                        }

                        const providerSessionId = await api.commit(
                            async (tx) => (await tx.doc(ProviderDoc, api.conversationId)).sessionId,
                            context,
                        );

                        if (
                            providerSessionId === undefined ||
                            !hasWorkflowAgentProviderSessionIdPrefix(providerSessionId)
                        ) {
                            if (isWorkflowAgentConversation(api.conversationId)) {
                                throw new WorkflowAgentAdmissionError(
                                    "Agent ProviderDoc correlation is missing or changed",
                                );
                            }

                            return execute(args as never, api, context);
                        }

                        let validated: unknown;

                        try {
                            validated = validateToolArguments(tool, {
                                id: api.callId,
                                name: tool.name,
                                arguments: args,
                            } as ToolCall);
                        } catch (error) {
                            throw new WorkflowAgentAdmissionError(
                                `Agent tool ${tool.name} arguments failed final validation: ${String(error)}`,
                            );
                        }

                        const authorizedApi = await authorize(
                            tool,
                            extensionName,
                            validated,
                            api,
                            context,
                        );

                        return execute(validated as never, authorizedApi, context);
                    },
                };

                if (extensionName !== undefined) {
                    toolOwners.set(guarded, extensionName);
                }

                return guarded;
            };

            const guardExtension = (extension: Extension): Extension => {
                const cached = extensions.get(extension);

                if (cached !== undefined) {
                    return cached;
                }

                const guarded: Extension = {
                    ...extension,
                    ...(extension.tools === undefined
                        ? {}
                        : {
                              tools: extension.tools.map((tool: ToolRegistration) =>
                                  guardTool(tool, extension.name),
                              ),
                          }),
                    ...(extension.wraps === undefined
                        ? {}
                        : {
                              wraps: extension.wraps.map((wrap) =>
                                  "tool" in wrap
                                      ? {
                                            tool: wrap.tool,
                                            wrap: (tool: ToolRegistration) => {
                                                const origin = toolOwners.get(tool);
                                                const wrapped = wrap.wrap(
                                                    tool as ToolRegistration,
                                                ) as ToolRegistration;

                                                return guardTool(wrapped, origin);
                                            },
                                        }
                                      : wrap,
                              ),
                          }),
                };

                extensions.set(extension, guarded);

                return guarded;
            };

            const tools = (): ReturnType<RegistrySnapshot["tools"]> =>
                snapshot.tools().map(({ extension, tool }) => {
                    const guardedExtension = guardExtension(extension);
                    const index = extension.tools?.indexOf(tool) ?? -1;

                    return {
                        extension: guardedExtension,
                        tool:
                            index >= 0
                                ? (guardedExtension.tools?.[index] as ToolRegistration)
                                : guardTool(tool as ToolRegistration, extension.name),
                    };
                });

            return {
                installed: () => snapshot.installed().map(guardExtension),
                extension: (name) => {
                    const extension = snapshot.extension(name);

                    return extension === undefined ? undefined : guardExtension(extension);
                },
                tools,
                sections: () =>
                    snapshot.sections().map(({ extension, section: promptSection }) => ({
                        extension: guardExtension(extension),
                        section: promptSection,
                    })),
                tasks: () => snapshot.tasks(),
                task: (name) => snapshot.task(name),
            };
        },
        subscribe: (listener) => base.subscribe(listener),
    };
}

const blockedWorkflowAgentTransactionOperations = new Set<PropertyKey>([
    "createConversation",
    "forkConversation",
    "createSubmission",
    "createTask",
    "wakeTask",
]);

function restrictWorkflowAgentTransaction(tx: Tx): Tx {
    return new Proxy(tx, {
        get(target, property) {
            if (blockedWorkflowAgentTransactionOperations.has(property)) {
                return async () => {
                    throw new WorkflowAgentAdmissionError("Agent task delegation is disabled");
                };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function createWorkflowAgentExecutionApi(
    api: ToolExecutionApi,
    agent: Agent,
    registry: RegistryReader,
    authority: EffectiveWorkflowAgentAuthority,
): ToolExecutionApi {
    const source = registry.snapshot();
    const toolOwnerByName = new Map(
        authority.tools.map((entry) => [entry.name, entry.extension] as const),
    );
    const selectedExtensionNamesBySource = new Map(
        agent.extensions.map(
            (extension) =>
                [workflowAgentSectionSourceName(extension.name), extension.name] as const,
        ),
    );
    const resolvedTools = new Map<string, ToolRegistration>();

    for (const tool of agent.tools) {
        const owner = toolOwnerByName.get(tool.name);
        const selectedName =
            owner === undefined ? undefined : selectedExtensionNamesBySource.get(owner);

        if (owner === undefined || selectedName === undefined) {
            throw new WorkflowAgentAdmissionError(
                `Agent tool ${tool.name} is outside the current authority manifest`,
            );
        }

        resolvedTools.set(JSON.stringify([selectedName, tool.name]), tool as ToolRegistration);
    }

    const sectionOwnerByKey = new Map(
        authority.sections.map((entry) => [entry.key, entry.extension] as const),
    );
    const resolvedSections = new Map<string, NonNullable<Extension["sections"]>[number]>();

    for (const section of agent.sections) {
        const owner = sectionOwnerByKey.get(section.key);

        if (owner !== undefined) {
            resolvedSections.set(JSON.stringify([owner, section.key]), section);
        }
    }

    const selectedSourceNames = new Set(selectedExtensionNamesBySource.keys());
    const installed = [...source.installed()].filter(
        (extension) => !selectedSourceNames.has(extension.name),
    );
    const installedNames = new Set(installed.map((extension) => extension.name));

    for (const selected of agent.extensions) {
        if (installedNames.has(selected.name)) {
            continue;
        }

        const extension = source.extension(selected.name);

        if (extension === undefined) {
            throw new WorkflowAgentAdmissionError(
                `Agent extension ${selected.name} disappeared before nested execution`,
            );
        }

        installed.push(extension);
        installedNames.add(extension.name);
    }

    const extensions = installed.map((extension): Extension => {
        const sourceName = workflowAgentSectionSourceName(extension.name);

        return {
            ...extension,
            tools: (extension.tools ?? []).map(
                (tool) => resolvedTools.get(JSON.stringify([extension.name, tool.name])) ?? tool,
            ),
            sections: (extension.sections ?? []).flatMap((section) => {
                const resolved = resolvedSections.get(JSON.stringify([sourceName, section.key]));

                return resolved === undefined ? [] : [resolved];
            }),
            wraps: [],
            tasks: [],
        };
    });
    const extensionsByName = new Map(extensions.map((extension) => [extension.name, extension]));
    const selectedExtensions = agent.extensions.map((extension) => {
        const resolved = extensionsByName.get(extension.name);

        if (resolved === undefined) {
            throw new WorkflowAgentAdmissionError(
                `Agent extension ${extension.name} disappeared before nested execution`,
            );
        }

        return resolved;
    });
    const selectedSections = agent.sections.map((section) => {
        const owner = sectionOwnerByKey.get(section.key);

        if (owner === undefined) {
            return section;
        }

        return resolvedSections.get(JSON.stringify([owner, section.key])) ?? section;
    });
    const safeAgent: Agent = {
        ...agent,
        extensions: selectedExtensions,
        tools: agent.tools,
        sections: selectedSections,
    };
    const safeSnapshot: RegistrySnapshot = {
        installed: () => extensions,
        extension: (name) => extensionsByName.get(name),
        tools: () =>
            extensions.flatMap((extension) =>
                (extension.tools ?? []).map((tool) => ({ extension, tool })),
            ),
        sections: () =>
            extensions.flatMap((extension) =>
                (extension.sections ?? []).map((section) => ({ extension, section })),
            ),
        tasks: () => [],
        task: () => undefined,
    };

    return new Proxy(api, {
        get(target, property) {
            if (property === "registry") {
                return safeSnapshot;
            }

            if (property === "commit") {
                return async <T>(
                    change: (tx: Tx) => T | Promise<T>,
                    context: Context,
                ): Promise<T> =>
                    target.commit((tx) => change(restrictWorkflowAgentTransaction(tx)), context);
            }

            if (property === "agent") {
                return async (_context: Context) => safeAgent;
            }

            if (property === "conversation") {
                return async () => {
                    throw new WorkflowAgentAdmissionError("Agent conversation control is disabled");
                };
            }

            if (property === "createTask") {
                return async () => {
                    throw new WorkflowAgentAdmissionError("Agent task delegation is disabled");
                };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

async function assertCurrentAgentToolAuthority(
    config: ReturnType<typeof resolveWorkflowAgentConfig>,
    models: Models,
    registry: RegistryReader,
    tool: ToolRegistration,
    toolExtensionName: string | undefined,
    _args: unknown,
    api: ToolExecutionApi,
    context: Context,
    admissionPolicy?: WorkflowAgentAdmissionPolicy,
): Promise<ToolExecutionApi> {
    const state = await api.commit(async (tx) => {
        const provider = await tx.doc(ProviderDoc, api.conversationId);

        if (provider.sessionId === undefined) {
            throw new WorkflowAgentAdmissionError("Agent ProviderDoc correlation is missing");
        }

        const parsed = parseWorkflowAgentProviderSessionId(provider.sessionId);

        if (parsed === undefined) {
            throw new WorkflowAgentAdmissionError("Agent ProviderDoc correlation is malformed");
        }

        const thread = copyJson(
            (await tx.doc(AGENT_THREAD_DOC, parsed.key, parsed.key)) as unknown as JsonValue,
        ) as unknown as AgentThreadRecord;

        if (thread === undefined || thread.ownerTaskId === undefined) {
            throw new WorkflowAgentAdmissionError("Agent thread authority record is missing");
        }

        const [owner, runDraft, conversation, agentDraft] = await Promise.all([
            tx.task(thread.ownerTaskId as TaskId),
            tx.doc(RUN_DOC, thread.runId, thread.runId),
            tx.conversation(api.conversationId),
            tx.doc(AgentDoc, api.conversationId),
        ]);

        const run = copyJson(runDraft as unknown as JsonValue) as {
            readonly taskId: number;
            readonly stopCommand?: JsonValue;
            readonly selectedOutcome?: JsonValue;
            readonly status: string;
        };
        const agent = copyJson(agentDraft as unknown as JsonValue) as {
            readonly extensions?: readonly string[];
            readonly tools?: readonly string[];
            readonly instructions?: string;
            readonly thinkingLevel?: string;
            readonly model?: { readonly provider?: string; readonly modelId?: string };
        };

        return {
            agent,
            conversation,
            owner,
            parsed,
            providerSessionId: provider.sessionId,
            run,
            thread,
        };
    }, context);
    const {
        agent: storedAgent,
        conversation,
        owner,
        parsed,
        providerSessionId,
        run,
        thread,
    } = state;
    const identity = parsed.identity;

    if (
        providerSessionId !== workflowAgentProviderSessionId(identity) ||
        thread.threadKey !== parsed.key ||
        thread.runId !== identity.runId ||
        thread.threadId !== identity.threadId ||
        thread.schemaVersion !== 1 ||
        thread.profileId !== identity.profileId ||
        thread.conversationId !== Number(api.conversationId) ||
        thread.status !== "ready" ||
        conversation === undefined ||
        conversation.owner === undefined ||
        conversation.owner.taskId !== thread.ownerTaskId ||
        owner === undefined ||
        owner.kind !== "pocket.workflow-runtime.task" ||
        owner.conversationId !== conversation.owner.conversationId ||
        owner.abortRequested ||
        owner.state.status === "terminal" ||
        owner.state.status === "completing" ||
        (owner.input as { readonly runId?: unknown }).runId !== thread.runId ||
        run === undefined ||
        run.taskId !== thread.ownerTaskId ||
        run.stopCommand !== undefined ||
        run.selectedOutcome !== undefined ||
        (run.status !== "running" && run.status !== "waiting")
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent tool owner, current admission, or conversation identity changed",
        );
    }

    const profile = config.byId.get(thread.profileId);

    if (profile === undefined || thread.profileVersion !== profile.version) {
        throw new WorkflowAgentAdmissionError("Agent profile authority changed or is unavailable");
    }

    const activeTurns = (thread.turns ?? []).filter(
        (turn) => turn.status === "reserved" || turn.status === "submitted",
    );
    const turn = activeTurns[0];

    if (activeTurns.length !== 1 || turn?.status !== "submitted") {
        throw new WorkflowAgentAdmissionError(
            "Agent logical-turn admission is stopped or ambiguous",
        );
    }

    const effective = turn.effectiveAuthority as unknown as EffectiveWorkflowAgentAuthority;
    const callAuthority: WorkflowAgentCallAuthority = {
        extensions: effective.extensions.map((entry) => entry.name),
        sections: effective.sections.map((entry) => entry.key),
        tools: effective.tools.map((entry) => entry.name),
        capabilities: effective.capabilities,
    };
    const genericSnapshot = workflowAgentProfileSnapshot(
        models,
        config,
        profile,
        callAuthority,
        registry,
    );
    const policyProfile =
        turn.policyBinding === undefined
            ? undefined
            : admissionPolicy?.resolveProfile?.(profile.id);
    const snapshot = policyProfile?.snapshot ?? genericSnapshot;

    validateWorkflowAgentAdmission(
        admissionPolicy,
        "tool-execution",
        profile.id,
        thread,
        {
            turnId: turn.turnId,
            intentCanonical: turn.intentCanonical,
            intentDigest: turn.intentDigest,
            ...(turn.policyBinding === undefined ? {} : { policyBinding: turn.policyBinding }),
        },
        snapshot,
    );

    if (
        snapshot.profileFingerprint !== thread.profileFingerprint ||
        snapshot.modelFingerprint !== thread.modelFingerprint ||
        snapshot.authorityFingerprint !== thread.authorityFingerprint ||
        turn.authorityFingerprint !== snapshot.authorityFingerprint ||
        !sameJson(thread.authorityInput, snapshot.authorityInput) ||
        !sameJson(turn.authorityInput, snapshot.authorityInput) ||
        !sameJson(snapshot.authority as unknown as JsonValue, turn.effectiveAuthority) ||
        turn.profileFingerprint !== snapshot.profileFingerprint ||
        turn.modelFingerprint !== snapshot.modelFingerprint
    ) {
        throw new WorkflowAgentAdmissionError("Agent current authority manifest drifted");
    }

    const toolSourceName =
        toolExtensionName === undefined
            ? undefined
            : workflowAgentSectionSourceName(toolExtensionName);
    const authorizedTool = snapshot.authority.tools.find(
        (entry) => entry.name === tool.name && entry.extension === toolSourceName,
    );

    if (
        authorizedTool === undefined ||
        !authorizedTool.capabilities.every((capability) =>
            snapshot.authority.capabilities.includes(capability),
        )
    ) {
        throw new WorkflowAgentAdmissionError(
            `Agent tool ${tool.name} is outside the admitted effective authority`,
        );
    }

    const expectedExtensions = snapshot.extensions.map((extension) => extension.name);
    const expectedTools = snapshot.authority.tools.map((entry) => entry.name);
    const actualAgent = await api.agent(context);

    if (
        !workflowAgentNativeSelectionMatches(actualAgent, snapshot) ||
        !Array.isArray(storedAgent.extensions) ||
        !sameStrings(storedAgent.extensions, expectedExtensions) ||
        !Array.isArray(storedAgent.tools) ||
        !sameStrings(storedAgent.tools, expectedTools) ||
        storedAgent.instructions !== profile.instructions ||
        storedAgent.model?.provider !== profile.model.provider ||
        storedAgent.model?.modelId !== profile.model.modelId ||
        storedAgent.thinkingLevel !== (profile.thinkingLevel ?? "off")
    ) {
        throw new WorkflowAgentAdmissionError(
            "Agent persisted tool, section, extension, or model selection drifted",
        );
    }

    return createWorkflowAgentExecutionApi(api, actualAgent, registry, snapshot.authority);
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function excludeWorkflowAgentResultDefaults(
    settings: HarnessOptions["settings"],
    resultExtensionNames: ReadonlySet<string>,
): HarnessOptions["settings"] {
    if (settings === undefined || resultExtensionNames.size === 0) {
        return settings;
    }

    return new Proxy(settings, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);

            if (property !== "extensions" || !Array.isArray(value)) {
                return value;
            }

            return value.filter((extension) => !resultExtensionNames.has(extension.name));
        },
    });
}

function composeHarnessOptions<Tool extends ToolRegistration>(
    base: HarnessOptions<Tool>,
    models: Models,
    registry: RegistryReader,
    buildEnv: (target: EnvTarget, context: Context) => Promise<ExecutionEnv | undefined>,
    captureReportedError: (error: unknown) => void,
    resultExtensionNames: ReadonlySet<string>,
): HarnessOptions {
    const composed = Object.create(Object.getPrototypeOf(base)) as Record<PropertyKey, unknown>;
    const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(base);

    delete descriptors.models;
    delete descriptors.registry;
    delete descriptors.env;
    delete descriptors.settings;
    delete descriptors.conversationCreated;
    delete descriptors.onReport;
    Object.defineProperties(composed, descriptors);
    Object.defineProperties(composed, {
        models: { value: models, enumerable: true, configurable: true },
        registry: { value: registry, enumerable: true, configurable: true },
        env: { value: buildEnv, enumerable: true, configurable: true },
        settings: {
            get: () => excludeWorkflowAgentResultDefaults(base.settings, resultExtensionNames),
            enumerable: true,
            configurable: true,
        },
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
