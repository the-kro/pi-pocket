import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    createRegistry,
    MemoryStorage,
    ProviderDoc,
    type ConversationId,
    type EntryId,
    type HarnessOptions,
    type TaskId,
} from "@earendil-works/pi-durable";
import {
    AGENT_RUNNER_TASK_NAME,
    AGENT_THREAD_DOC,
    createWorkflowAgentRuntime,
} from "../packages/workflow-runtime/agents/recovery.ts";
import {
    workflowAgentModelIdentityFingerprint,
    workflowAgentModelIdentityInputs,
    workflowAgentThreadKey,
} from "../packages/workflow-runtime/agents/profile.ts";
import { defineWorkflow, type WorkflowContext } from "../packages/workflow-runtime/core/index.ts";

const context = BACKGROUND_CONTEXT;

function agentFixture(profileIds = ["turn-test"], settings?: HarnessOptions["settings"]) {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);

    const model = models.getModel("faux", "faux-1")!;
    const profiles = profileIds.map((id) => ({
        id,
        version: 1,
        instructions: "Answer directly.",
        instructionsVersion: "1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-test-v1",
        },
    }));
    const profile = profiles[0]!;
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry, ...(settings === undefined ? {} : { settings }) },
        agentConfig: { profiles },
    });

    registry.install(runtime.extension);

    return { registry, models, faux, profile, profiles, runtime };
}

test("durable model identity excludes credentials and retains public route identity", () => {
    const { models } = agentFixture();
    const model = models.getModel("faux", "faux-1")!;
    const first = {
        ...model,
        baseUrl: "https://user-one:pass-one@model.example/v1?api_key=secret-one",
        headers: { Authorization: "Bearer first-secret-value" },
    };
    const rotated = {
        ...model,
        baseUrl: "https://user-two:pass-two@model.example/v1?api_key=secret-two",
        headers: { Authorization: "Bearer second-secret-value" },
    };
    const changedOrigin = {
        ...model,
        baseUrl: "https://other.example/v1?api_key=secret-three",
        headers: { Authorization: "Bearer third-secret-value" },
    };
    const durableIdentity = workflowAgentModelIdentityInputs(first);
    const serializedIdentity = JSON.stringify(durableIdentity);

    for (const secret of ["user-one", "pass-one", "secret-one", "first-secret-value"]) {
        assert.equal(serializedIdentity.includes(secret), false);
    }

    assert.equal(
        workflowAgentModelIdentityFingerprint(first),
        workflowAgentModelIdentityFingerprint(rotated),
    );
    assert.notEqual(
        workflowAgentModelIdentityFingerprint(first),
        workflowAgentModelIdentityFingerprint(changedOrigin),
    );
});

test("matching concurrent admissions share one owned native thread and runner", async () => {
    const { faux, profile, runtime } = agentFixture();

    faux.setResponses([fauxAssistantMessage("one native answer")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "matching-agent-turns",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const request = {
                threadId: "shared-thread",
                turnId: "shared-turn",
                profile: profile.id,
                content: "Say hello.",
            };
            const results = await Promise.all([agent.turn(request), agent.turn(request)]);
            const liveWorkflow = (await harness.inspect(context)).tasks.find(
                ({ record }) =>
                    record.kind === "pocket.workflow-runtime.task" &&
                    (record.input as { runId?: string }).runId === "matching-agent-run",
            )?.record;

            assert.ok(liveWorkflow);
            const graph = await harness.taskGraph(context);
            const owned = graph.value.tasks[String(liveWorkflow.id)];
            const key = workflowAgentThreadKey({
                runId: "matching-agent-run",
                threadId: request.threadId,
                profileId: profile.id,
            });
            const thread = await harness.snapshot(AGENT_THREAD_DOC, key, context);

            assert.ok(thread);
            assert.equal(thread.turns?.length, 1);
            assert.equal(
                owned?.conversations.includes(thread.conversationId as ConversationId),
                true,
            );
            assert.deepEqual(results[0], results[1]);
            assert.equal(faux.state.callCount, 1);

            const runner = await harness.getTask(
                thread.turns![0]!.runnerTaskId! as TaskId,
                context,
            );

            assert.equal(runner?.kind, AGENT_RUNNER_TASK_NAME);
            assert.equal(runner?.owner, liveWorkflow.id);
            assert.equal(runner?.conversationId, liveWorkflow.conversationId);

            const nativeConversation = await harness.conversation(
                thread.conversationId as ConversationId,
                context,
            );
            const nativeAgent = await nativeConversation?.agent(context);

            assert.deepEqual(nativeAgent?.extensions, []);
            assert.deepEqual(nativeAgent?.tools, []);
            assert.equal(nativeAgent?.cwd, undefined);
            assert.equal(
                (
                    await harness.snapshot(
                        ProviderDoc,
                        thread.conversationId as ConversationId,
                        context,
                    )
                )?.sessionId,
                thread.providerSessionId,
            );

            return "done";
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "matching-agent-run" }, context);
        await runtime.engine.wait("matching-agent-run", context);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("reusing a turn ID with conflicting intent rejects before another dispatch", async () => {
    const { faux, profile, runtime } = agentFixture();

    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("wrong replay")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "conflicting-agent-turn",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const request = {
                threadId: "conflict-thread",
                turnId: "fixed-turn",
                profile: profile.id,
                content: "original intent",
            };

            await agent.turn(request);

            return agent.turn({ ...request, content: "changed intent" });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "conflict-run" }, context);

        await assert.rejects(
            runtime.engine.wait("conflict-run", context),
            /different immutable intent/,
        );
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("concurrent different turns reject unsafe native correlation", async () => {
    const { faux, profile, runtime } = agentFixture();

    faux.setResponses([fauxAssistantMessage("one correlated answer")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "different-agent-turns",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const base = {
                threadId: "busy-thread",
                profile: profile.id,
            };

            return Promise.all([
                agent.turn({ ...base, turnId: "turn-a", content: "first" }),
                agent.turn({ ...base, turnId: "turn-b", content: "second" }),
            ]);
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "different-turn-run" }, context);

        await assert.rejects(
            runtime.engine.wait("different-turn-run", context),
            /Another agent turn is active/,
        );
        const thread = await harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "different-turn-run",
                threadId: "busy-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.equal(thread?.turns?.length, 1);
        assert.equal(thread?.turns?.[0]?.status, "completed");
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("completed turns continue one conversation while profiles stay isolated", async () => {
    const { faux, profile, profiles, runtime } = agentFixture(["turn-test", "second-profile"]);

    faux.setResponses([
        fauxAssistantMessage("first turn"),
        fauxAssistantMessage("second turn"),
        fauxAssistantMessage("separate profile"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "agent-continuation",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            const first = await agent.turn({
                threadId: "continued-thread",
                turnId: "turn-1",
                profile: profile.id,
                content: "first prompt",
            });
            const second = await agent.turn({
                threadId: "continued-thread",
                turnId: "turn-2",
                profile: profile.id,
                content: "second prompt",
            });
            const isolated = await agent.turn({
                threadId: "continued-thread",
                turnId: "turn-1",
                profile: profiles[1]!.id,
                content: "other profile prompt",
            });

            return [first, second, isolated];
        },
    });

    try {
        runtime.engine.register(workflow);
        const result = await runtime.engine.start(
            workflow,
            null,
            { runId: "continuation-run" },
            context,
        );
        const values = await runtime.engine.wait(result.runId, context);
        const firstThread = await harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: result.runId,
                threadId: "continued-thread",
                profileId: profile.id,
            }),
            context,
        );
        const isolatedThread = await harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: result.runId,
                threadId: "continued-thread",
                profileId: profiles[1]!.id,
            }),
            context,
        );

        if (!Array.isArray(values)) {
            throw new Error("Workflow result must contain the three native turn results");
        }

        const turnResults = values as unknown[];

        assert.equal(
            (turnResults[0] as { content: { text: string }[] }).content[0]!.text,
            "first turn",
        );
        assert.equal(
            (turnResults[1] as { content: { text: string }[] }).content[0]!.text,
            "second turn",
        );
        assert.equal(
            (turnResults[2] as { content: { text: string }[] }).content[0]!.text,
            "separate profile",
        );
        assert.equal(firstThread?.turns?.length, 2);
        assert.equal(isolatedThread?.turns?.length, 1);
        assert.notEqual(firstThread?.conversationId, isolatedThread?.conversationId);
        assert.equal(faux.state.callCount, 3);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("completed adapter replay returns its exact saved result without redispatch", async () => {
    const { faux, profile, runtime } = agentFixture();

    faux.setResponses([fauxAssistantMessage("saved native result"), fauxAssistantMessage("wrong")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "agent-turn-replay",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const request = {
                threadId: "replay-thread",
                turnId: "replay-turn",
                profile: profile.id,
                content: "persist this result",
            };
            const first = await agent.turn(request);
            const replay = await agent.turn(request);

            return [first, replay];
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "replay-run" }, context);
        const result = await runtime.engine.wait("replay-run", context);

        if (!Array.isArray(result)) {
            throw new Error("Replay result must contain two native turn results");
        }

        const replayResults = result as unknown[];

        assert.deepEqual(replayResults[0], replayResults[1]);
        assert.equal(
            (replayResults[0] as { content: { text: string }[] }).content[0]!.text,
            "saved native result",
        );
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("tuple and prototype-like logical IDs remain collision-safe", async () => {
    const { faux, runtime } = agentFixture(["c", "b|c", "__proto__"]);

    faux.setResponses([
        fauxAssistantMessage("one"),
        fauxAssistantMessage("two"),
        fauxAssistantMessage("three"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const identities = [
        { threadId: "a|b", turnId: "__proto__", profile: "c" },
        { threadId: "a", turnId: "constructor", profile: "b|c" },
        { threadId: "__proto__", turnId: "toString", profile: "__proto__" },
    ] as const;
    const workflow = defineWorkflow({
        id: "agent-logical-id-collisions",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            for (const [index, identity] of identities.entries()) {
                await agent.turn({ ...identity, content: `content-${index}` });
            }

            return "done";
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "collision-run" }, context);
        await runtime.engine.wait("collision-run", context);

        const keys = identities.map((identity) =>
            workflowAgentThreadKey({
                runId: "collision-run",
                threadId: identity.threadId,
                profileId: identity.profile,
            }),
        );
        const threads = await Promise.all(
            keys.map((key) => harness.snapshot(AGENT_THREAD_DOC, key, context)),
        );

        assert.equal(new Set(keys).size, identities.length);
        assert.equal(
            new Set(threads.map((thread) => thread?.conversationId)).size,
            identities.length,
        );
        assert.deepEqual(
            threads.map((thread) => thread?.turns?.[0]?.turnId),
            identities.map((identity) => identity.turnId),
        );
        assert.equal(faux.state.callCount, identities.length);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("model fingerprint drift rejects continuation before provider dispatch", async () => {
    const { faux, models, profile, runtime } = agentFixture();

    faux.setResponses([fauxAssistantMessage("first result"), fauxAssistantMessage("must not run")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "agent-fingerprint-drift",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            await agent.turn({
                threadId: "drift-thread",
                turnId: "before-drift",
                profile: profile.id,
                content: "first turn",
            });
            const originalProvider = faux.provider;

            models.setProvider({
                ...originalProvider,
                getModels: () =>
                    originalProvider.getModels().map((model) => ({
                        ...model,
                        contextWindow: model.contextWindow + 1,
                    })),
            });

            return agent.turn({
                threadId: "drift-thread",
                turnId: "after-drift",
                profile: profile.id,
                content: "second turn",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "fingerprint-run" }, context);

        await assert.rejects(
            runtime.engine.wait("fingerprint-run", context),
            /model fingerprint changed/,
        );
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("native model configuration drift rejects continuation before provider dispatch", async () => {
    const { faux, profile, runtime } = agentFixture();
    let resolveFirstTurn!: () => void;
    let releaseWorkflow!: () => void;
    const firstTurnCompleted = new Promise<void>((resolve) => {
        resolveFirstTurn = resolve;
    });
    const workflowGate = new Promise<void>((resolve) => {
        releaseWorkflow = resolve;
    });

    faux.setResponses([fauxAssistantMessage("first result"), fauxAssistantMessage("must not run")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "agent-native-configuration-drift",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            await agent.turn({
                threadId: "native-config-thread",
                turnId: "first-turn",
                profile: profile.id,
                content: "first prompt",
            });

            resolveFirstTurn();
            await workflowGate;

            return agent.turn({
                threadId: "native-config-thread",
                turnId: "second-turn",
                profile: profile.id,
                content: "second prompt",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        const run = await runtime.engine.start(
            workflow,
            null,
            { runId: "native-config-drift-run" },
            context,
        );

        await firstTurnCompleted;
        const thread = await harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: run.runId,
                threadId: "native-config-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.ok(thread);
        const conversation = await harness.conversation(
            thread.conversationId as ConversationId,
            context,
        );

        assert.ok(conversation);
        await conversation.configure(
            { model: { provider: "faux", modelId: "changed-model" } },
            context,
        );
        releaseWorkflow();

        await assert.rejects(
            runtime.engine.wait(run.runId, context),
            /profile authority or model fingerprint changed/,
        );
        assert.equal(faux.state.callCount, 1);
    } finally {
        releaseWorkflow();
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("a failed pre-submit runner is marked not-completed and allows a new turn ID", async () => {
    const { faux, models, profile, runtime } = agentFixture(["turn-test"]);
    const originalGetModel = models.getModel.bind(models);
    let modelLookups = 0;

    models.getModel = (provider, modelId) => {
        modelLookups += 1;

        return modelLookups === 2 ? undefined : originalGetModel(provider, modelId);
    };

    faux.setResponses([fauxAssistantMessage("new logical turn succeeded")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "agent-pre-submit-runner-failure",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            let firstFailure: unknown;

            try {
                await agent.turn({
                    threadId: "pre-submit-failure-thread",
                    turnId: "not-submitted",
                    profile: profile.id,
                    content: "the runner cannot resolve this model before submitting",
                });
            } catch (error) {
                firstFailure = error;
            }

            let sameIdFailure: unknown;

            try {
                await agent.turn({
                    threadId: "pre-submit-failure-thread",
                    turnId: "not-submitted",
                    profile: profile.id,
                    content: "the runner cannot resolve this model before submitting",
                });
            } catch (error) {
                sameIdFailure = error;
            }

            const result = await agent.turn({
                threadId: "pre-submit-failure-thread",
                turnId: "new-logical-id",
                profile: profile.id,
                content: "retry under a new logical turn ID",
            });

            return {
                firstFailure: String(firstFailure),
                sameIdFailure: String(sameIdFailure),
                result,
            };
        },
    });

    try {
        runtime.engine.register(workflow);
        const run = await runtime.engine.start(
            workflow,
            null,
            { runId: "pre-submit-runner-failure" },
            context,
        );
        const result = await runtime.engine.wait(run.runId, context);
        const thread = await harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: run.runId,
                threadId: "pre-submit-failure-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.ok(thread);
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns?.[0]?.status, "not-completed");
        assert.equal(thread.turns?.[1]?.status, "completed");
        const firstSubmission = await harness.commit(
            (tx) =>
                tx.submissionByRequest(
                    thread.conversationId as ConversationId,
                    thread.turns![0]!.requestId,
                ),
            context,
        );

        assert.equal(firstSubmission, undefined);
        assert.notEqual((result as { firstFailure: string }).firstFailure, "undefined");
        assert.match(
            (result as { sameIdFailure: string }).sameIdFailure,
            /use a new logical turn ID/,
        );
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("an exact native answer repairs a missing adapter submission receipt", async () => {
    const { faux, profile, runtime } = agentFixture(["turn-test"]);
    let removeMappingBeforeAnswer: (() => Promise<void>) | undefined;
    let removedSubmissionMapping = false;

    faux.setResponses([
        async () => {
            await removeMappingBeforeAnswer?.();

            return fauxAssistantMessage("exact native answer recovered");
        },
    ]);
    const storage = new MemoryStorage();
    const host = await runtime.openHost(storage, context, () => undefined);
    const harness = host.harness;
    const runId = "exact-answer-receipt-repair";
    const threadId = "exact-answer-receipt-thread";
    const turnId = "exact-answer-receipt-turn";
    const threadKey = workflowAgentThreadKey({ runId, threadId, profileId: profile.id });

    removeMappingBeforeAnswer = async () => {
        const deadline = Date.now() + 2_000;
        let thread = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);

        while (thread?.turns?.[0]?.status !== "submitted" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            thread = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);
        }

        assert.equal(thread?.turns?.[0]?.status, "submitted");
        await harness.commit(async (tx) => {
            const current = await tx.doc(AGENT_THREAD_DOC, threadKey, threadKey);
            const turn = current.turns?.find((candidate) => candidate.turnId === turnId);

            assert.ok(turn);
            delete turn.submissionId;
        }, context);
        const updated = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);

        removedSubmissionMapping = updated?.turns?.[0]?.submissionId === undefined;
    };

    const workflow = defineWorkflow({
        id: "agent-exact-answer-receipt-repair",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            let firstFailure: unknown;

            try {
                await agent.turn({
                    threadId,
                    turnId,
                    profile: profile.id,
                    content: "return an answer whose adapter receipt is missing",
                });
            } catch (error) {
                firstFailure = error;
            }

            const replay = await agent.turn({
                threadId,
                turnId,
                profile: profile.id,
                content: "return an answer whose adapter receipt is missing",
            });

            return { firstFailure: String(firstFailure), replay };
        },
    });

    try {
        runtime.engine.register(workflow);
        const run = await runtime.engine.start(workflow, null, { runId }, context);
        const result = (await runtime.engine.wait(run.runId, context)) as {
            firstFailure: string;
            replay: { content: { text: string }[] };
        };
        const thread = await harness.snapshot(AGENT_THREAD_DOC, threadKey, context);

        assert.ok(thread);
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns?.[0]?.status, "completed");
        const completedTurn = thread.turns?.[0];

        assert.ok(completedTurn);
        const submission = await harness.commit(
            (tx) =>
                tx.submissionByRequest(
                    thread.conversationId as ConversationId,
                    completedTurn.requestId,
                ),
            context,
        );

        assert.ok(submission);
        assert.equal(completedTurn.submissionId, Number(submission.id));
        assert.equal(completedTurn.answerEntryId, Number(submission.answer));
        const answerEntry = await harness.commit(
            (tx) => tx.entry(AssistantEntry, completedTurn.answerEntryId as EntryId),
            context,
        );
        const runner = await storage.task(completedTurn.runnerTaskId as TaskId, context);

        assert.ok(answerEntry);
        assert.ok(runner);
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome.status, "faulted");
        assert.deepEqual(result.replay, completedTurn.result);
        assert.deepEqual(completedTurn.result, answerEntry.model?.[0]);
        assert.equal(result.replay.content[0]?.text, "exact native answer recovered");
        assert.equal(removedSubmissionMapping, true);
        assert.equal(result.firstFailure, "undefined");
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("a post-submit provider failure durably fences the agent thread", async () => {
    const { faux, profile, runtime } = agentFixture(["turn-test"], {
        retry: { enabled: false },
    });

    faux.setResponses([
        async () => {
            throw new Error("injected provider failure after native submission");
        },
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "agent-post-submit-runner-failure",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const failures: string[] = [];

            try {
                await agent.turn({
                    threadId: "post-submit-failure-thread",
                    turnId: "provider-failed",
                    profile: profile.id,
                    content: "dispatch exactly once and fence its uncertain result",
                });
            } catch (error) {
                failures.push(String(error));
            }

            try {
                await agent.turn({
                    threadId: "post-submit-failure-thread",
                    turnId: "must-not-dispatch",
                    profile: profile.id,
                    content: "do not dispatch after an uncertain provider outcome",
                });
            } catch (error) {
                failures.push(String(error));
            }

            return failures;
        },
    });

    try {
        runtime.engine.register(workflow);
        const run = await runtime.engine.start(
            workflow,
            null,
            { runId: "post-submit-runner-failure" },
            context,
        );
        const failures = (await runtime.engine.wait(run.runId, context)) as string[];
        const thread = await harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: run.runId,
                threadId: "post-submit-failure-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.ok(thread);
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns?.length, 1);
        assert.equal(thread.turns?.[0]?.status, "unknown");
        assert.equal(failures.length, 2);
        assert.equal(faux.state.callCount, 1);
        const submission = await harness.commit(
            (tx) =>
                tx.submissionByRequest(
                    thread.conversationId as ConversationId,
                    thread.turns![0]!.requestId,
                ),
            context,
        );

        assert.ok(submission);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("workflow terminality drains awaited and detached native turns", async () => {
    const { faux, profile, runtime } = agentFixture();
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;

    try {
        for (const mode of ["awaited", "detached"] as const) {
            let release!: () => void;
            let announceDispatch!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const dispatched = new Promise<void>((resolve) => {
                announceDispatch = resolve;
            });

            faux.appendResponses([
                async () => {
                    announceDispatch();
                    await gate;

                    return fauxAssistantMessage(`${mode} answer`);
                },
            ]);
            const workflow = defineWorkflow({
                id: `agent-drain-${mode}`,
                version: 1,
                async run({ agent }: WorkflowContext<null>) {
                    assert.ok(agent);
                    const turn = agent.turn({
                        threadId: `${mode}-thread`,
                        turnId: `${mode}-turn`,
                        profile: profile.id,
                        content: `wait for ${mode}`,
                    });

                    if (mode === "detached") {
                        void turn;

                        return mode;
                    }

                    await turn;

                    return mode;
                },
            });

            runtime.engine.register(workflow);
            await runtime.engine.start(workflow, null, { runId: `drain-${mode}` }, context);
            const result = runtime.engine.wait(`drain-${mode}`, context);

            await dispatched;
            const inspection = await runtime.engine.inspect(`drain-${mode}`, context);

            assert.equal(inspection.status, "running");
            release();
            assert.equal(await result, mode);
        }
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("completed and stopped workflow owners reject new turns on idle threads", async () => {
    const { faux, profile, runtime } = agentFixture();
    let completedAgent: WorkflowContext<null>["agent"] = undefined;
    let stoppedAgent: WorkflowContext<null>["agent"] = undefined;
    let entered!: () => void;
    const stoppedBodyEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const completed = defineWorkflow({
        id: "retired-agent-owner",
        version: 1,
        run({ agent }: WorkflowContext<null>) {
            completedAgent = agent;

            return "completed";
        },
    });
    const stopped = defineWorkflow({
        id: "stopped-agent-owner",
        version: 1,
        async run({ agent, signal }: WorkflowContext<null>) {
            stoppedAgent = agent;
            entered();
            await new Promise<void>((resolve) => {
                if (signal.aborted) {
                    resolve();

                    return;
                }

                signal.addEventListener("abort", () => resolve(), { once: true });
            });

            return "stopped";
        },
    });

    try {
        runtime.engine.register(completed);
        runtime.engine.register(stopped);
        await runtime.engine.start(completed, null, { runId: "completed-owner-run" }, context);
        await runtime.engine.wait("completed-owner-run", context);
        await runtime.engine.start(stopped, null, { runId: "stopped-owner-run" }, context);
        await stoppedBodyEntered;
        await runtime.engine.stop("stopped-owner-run", "test stop", context);
        await assert.rejects(runtime.engine.wait("stopped-owner-run", context));

        const idleRequest = {
            threadId: "idle-thread",
            turnId: "late-turn",
            profile: profile.id,
            content: "must not be admitted",
        };

        await assert.rejects(completedAgent!.turn(idleRequest), /admission is closed/);
        await assert.rejects(stoppedAgent!.turn(idleRequest), /admission is closed/);
        assert.equal(faux.state.callCount, 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});

test("workflow agent turn returns a scripted native answer", async () => {
    const { faux, profile, runtime } = agentFixture();

    faux.setResponses([fauxAssistantMessage("native answer")]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const harness = host.harness;
    const workflow = defineWorkflow({
        id: "native-agent-turn",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);

            return agent.turn({
                threadId: "thread-one",
                turnId: "turn-one",
                profile: profile.id,
                content: "Say hello.",
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "native-agent-run" }, context);

        const result = await runtime.engine.wait("native-agent-run", context);
        const message = result as { model?: string; content?: { text?: string }[] };

        assert.equal(message.model, "faux-1");
        assert.deepEqual(message.content, [{ type: "text", text: "native answer" }]);
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await harness.close(context);
    }
});
