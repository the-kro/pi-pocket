import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    defineTool,
    MemoryStorage,
} from "@earendil-works/pi-durable";
import {
    AGENT_THREAD_DOC,
    createWorkflowAgentReviewAdmissionPolicy,
    createWorkflowAgentReviewPolicyBinding,
    createWorkflowAgentRuntime,
    WORKFLOW_AGENT_REVIEW_POLICY_ID,
    workflowAgentThreadKey,
    type WorkflowAgentConfig,
    type WorkflowAgentReviewConfig,
    type WorkflowAgentReviewProfileDescriptor,
} from "../packages/workflow-runtime/index.ts";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineWorkflow, type WorkflowContext } from "../packages/workflow-runtime/core/index.ts";

const context = BACKGROUND_CONTEXT;

async function resolvedReviewProfile(
    agent: { resolveProfile(profileId: string): Promise<unknown> },
    profileId: string,
): Promise<WorkflowAgentReviewProfileDescriptor> {
    return (await agent.resolveProfile(
        profileId,
    )) as unknown as WorkflowAgentReviewProfileDescriptor;
}

function createReviewRuntime(
    models: ReturnType<typeof createModels>,
    registry: ReturnType<typeof createRegistry>,
    agentConfig: WorkflowAgentConfig,
    reviewConfig: WorkflowAgentReviewConfig,
) {
    return createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig,
        admissionPolicy: createWorkflowAgentReviewAdmissionPolicy({
            models,
            registry,
            agentConfig,
            reviewConfig,
        }),
    });
}

test("runtime resolves the allowlisted Review identity used by fresh-thread admission", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("review answer")]);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "reviewer",
        version: 2,
        instructions: "Review the supplied evidence.",
        instructionsVersion: "review-instructions-v2",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
    };
    const schemaProfile = {
        ...profile,
        id: "schema-reviewer",
        result: {
            id: "review-result",
            version: "schema-v1",
            toolName: "review_result",
            schema: {
                type: "object",
                properties: { verdict: { type: "string" } },
                required: ["verdict"],
            },
        },
    };
    const agentConfig: WorkflowAgentConfig = { profiles: [profile, schemaProfile] };
    const reviewConfig = {
        profileAllowlist: [profile.id, schemaProfile.id],
        authority: { extensions: [], sections: [], tools: [], capabilities: [] },
    };
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig,
        admissionPolicy: createWorkflowAgentReviewAdmissionPolicy({
            models,
            registry,
            agentConfig,
            reviewConfig,
        }),
    });

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "review-profile-resolution",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const resolved = await resolvedReviewProfile(agent, profile.id);

            assert.equal(resolved.profile.id, profile.id);
            assert.equal(resolved.profile.version, profile.version);
            assert.equal(resolved.model.modelId, "faux-1");
            assert.deepEqual(resolved.authority, {
                delegation: false,
                extensions: [],
                sections: [],
                tools: [],
                capabilities: [],
            });
            assert.equal(typeof resolved.identity.fingerprint, "string");
            assert.equal("tools" in resolved, false);
            assert.equal("nativeHandle" in resolved, false);
            const schemaResolved = await resolvedReviewProfile(agent, schemaProfile.id);

            assert.equal(schemaResolved.result?.id, "review-result");
            assert.equal(
                schemaResolved.result?.fingerprint,
                schemaResolved.identity.resultSchemaFingerprint,
            );
            assert.equal(typeof schemaResolved.result?.schema, "object");

            const result = await agent.turn({
                threadId: "review-thread",
                turnId: "review-first-turn",
                profile: profile.id,
                content: "Review this evidence.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(resolved.identity, true),
            });

            return { result, identity: resolved.identity };
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "review-profile-run" }, context);
        const result = await runtime.engine.wait("review-profile-run", context);
        const key = workflowAgentThreadKey({
            runId: "review-profile-run",
            threadId: "review-thread",
            profileId: profile.id,
        });
        const thread = await host.harness.snapshot(AGENT_THREAD_DOC, key, context);

        const workflowResult = result as {
            readonly result: { readonly content: { readonly text: string }[] };
            readonly identity: unknown;
        };

        assert.equal(workflowResult.result.content[0]?.text, "review answer");
        assert.equal(thread?.turns?.[0]?.policyBinding?.policyId, WORKFLOW_AGENT_REVIEW_POLICY_ID);
        assert.equal(
            (thread?.turns?.[0]?.policyBinding?.input as { readonly firstTurn?: unknown })
                .firstTurn,
            true,
        );
        assert.deepEqual(
            (thread?.turns?.[0]?.policyBinding?.input as { readonly reviewerIdentity?: unknown })
                .reviewerIdentity,
            workflowResult.identity,
        );
        assert.equal("purpose" in thread!.turns![0]!, false);
        assert.equal("freshThread" in thread!.turns![0]!, false);
        assert.equal("reviewerIdentity" in thread!.turns![0]!, false);
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("fresh Review admission rejects a pre-used thread atomically", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("existing thread answer")]);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "fresh-thread-reviewer",
        version: 1,
        instructions: "Review only.",
        instructionsVersion: "review-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
    };
    const runtime = createReviewRuntime(
        models,
        registry,
        { profiles: [profile] },
        {
            profileAllowlist: [profile.id],
            authority: { extensions: [], sections: [], tools: [], capabilities: [] },
        },
    );

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "review-pre-used-thread",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            await agent.turn({
                threadId: "pre-used-review-thread",
                turnId: "existing-turn",
                profile: profile.id,
                content: "Use the existing thread.",
            });
            const resolved = await resolvedReviewProfile(agent, profile.id);

            return agent.turn({
                threadId: "pre-used-review-thread",
                turnId: "review-first-turn",
                profile: profile.id,
                content: "Require a fresh reviewer conversation.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(resolved.identity, true),
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "review-pre-used-run" }, context);

        await assert.rejects(
            runtime.engine.wait("review-pre-used-run", context),
            /Fresh-thread admission requires an uninitialized thread or exact replay/,
        );
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "review-pre-used-run",
                threadId: "pre-used-review-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.equal(thread?.turns?.length, 1);
        assert.equal(thread?.turns?.[0]?.turnId, "existing-turn");
        assert.equal(faux.state.callCount, 1);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("Review turns require fresh-thread admission for new and pre-used threads", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);
    faux.setResponses([
        fauxAssistantMessage("existing omitted-flag thread"),
        fauxAssistantMessage("review without omitted flag"),
        fauxAssistantMessage("existing false-flag thread"),
        fauxAssistantMessage("review without false flag"),
        fauxAssistantMessage("existing omitted-flag continuation"),
        fauxAssistantMessage("review on omitted-flag continuation"),
        fauxAssistantMessage("existing false-flag continuation"),
        fauxAssistantMessage("review on false-flag continuation"),
    ]);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "fresh-thread-required-reviewer",
        version: 1,
        instructions: "Review only.",
        instructionsVersion: "review-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
    };
    const runtime = createReviewRuntime(
        models,
        registry,
        { profiles: [profile] },
        {
            profileAllowlist: [profile.id],
            authority: { extensions: [], sections: [], tools: [], capabilities: [] },
        },
    );

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const cases = [
        { threadId: "review-new-omitted", freshThread: undefined, preused: false },
        { threadId: "review-new-false", freshThread: false, preused: false },
        { threadId: "review-used-omitted", freshThread: undefined, preused: true },
        { threadId: "review-used-false", freshThread: false, preused: true },
    ] as const;
    const workflow = defineWorkflow({
        id: "review-fresh-thread-required",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const resolved = await resolvedReviewProfile(agent, profile.id);
            const outcomes: string[] = [];

            for (const [index, scenario] of cases.entries()) {
                if (scenario.preused) {
                    await agent.turn({
                        threadId: scenario.threadId,
                        turnId: `existing-turn-${index}`,
                        profile: profile.id,
                        content: "Use an ordinary thread first.",
                    });
                }

                const request = {
                    threadId: scenario.threadId,
                    turnId: `review-turn-${index}`,
                    profile: profile.id,
                    content: "Start or continue a Review without fresh-thread admission.",
                    policyBinding:
                        scenario.freshThread === undefined
                            ? {
                                  policyId: WORKFLOW_AGENT_REVIEW_POLICY_ID,
                                  policyVersion: "1",
                                  input: { reviewerIdentity: resolved.identity },
                              }
                            : createWorkflowAgentReviewPolicyBinding(
                                  resolved.identity,
                                  scenario.freshThread,
                              ),
                };

                try {
                    await agent.turn(request);
                    outcomes.push("admitted");
                } catch (error) {
                    if (
                        !(error instanceof Error) ||
                        !/Review turns require fresh-thread admission/.test(error.message)
                    ) {
                        throw error;
                    }

                    outcomes.push("rejected");
                }
            }

            return outcomes;
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(
            workflow,
            null,
            { runId: "review-fresh-thread-required-run" },
            context,
        );
        const outcomes = await runtime.engine.wait("review-fresh-thread-required-run", context);

        assert.deepEqual(outcomes, ["rejected", "rejected", "rejected", "rejected"]);
        assert.equal(faux.state.callCount, 2);

        for (const [index, scenario] of cases.entries()) {
            const thread = await host.harness.snapshot(
                AGENT_THREAD_DOC,
                workflowAgentThreadKey({
                    runId: "review-fresh-thread-required-run",
                    threadId: scenario.threadId,
                    profileId: profile.id,
                }),
                context,
            );

            if (scenario.preused) {
                assert.equal(thread?.turns?.length, 1);
                assert.equal(thread?.turns?.[0]?.turnId, `existing-turn-${index}`);
            } else {
                assert.equal(thread, undefined);
            }
        }
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("the exact first Review turn replays and later Review turns continue its thread", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);
    faux.setResponses([
        fauxAssistantMessage("first review"),
        fauxAssistantMessage("second review"),
    ]);
    const model = models.getModel("faux", "faux-1")!;
    const profile = {
        id: "continuing-reviewer",
        version: 1,
        instructions: "Review only.",
        instructionsVersion: "review-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
    };
    const runtime = createReviewRuntime(
        models,
        registry,
        { profiles: [profile] },
        {
            profileAllowlist: [profile.id],
            authority: { extensions: [], sections: [], tools: [], capabilities: [] },
        },
    );

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "review-thread-continuation",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const resolved = await resolvedReviewProfile(agent, profile.id);
            const firstRequest = {
                threadId: "continuing-review-thread",
                turnId: "review-turn-one",
                profile: profile.id,
                content: "First review pass.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(resolved.identity, true),
            } as const;
            const first = await agent.turn(firstRequest);
            const second = await agent.turn({
                ...firstRequest,
                turnId: "review-turn-two",
                content: "Continue the same review conversation.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(resolved.identity, false),
            });
            const replay = await agent.turn(firstRequest);

            return { first, replay, second };
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "review-continuation-run" }, context);
        const result = (await runtime.engine.wait("review-continuation-run", context)) as {
            readonly first: unknown;
            readonly replay: unknown;
            readonly second: { readonly content: { readonly text: string }[] };
        };
        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({
                runId: "review-continuation-run",
                threadId: "continuing-review-thread",
                profileId: profile.id,
            }),
            context,
        );

        assert.deepEqual(result.first, result.replay);
        assert.equal(result.second.content[0]?.text, "second review");
        assert.equal(thread?.turns?.length, 2);
        assert.equal(
            (thread?.turns?.[0]?.policyBinding?.input as { readonly firstTurn?: unknown })
                .firstTurn,
            true,
        );
        assert.equal(
            (thread?.turns?.[1]?.policyBinding?.input as { readonly firstTurn?: unknown })
                .firstTurn,
            false,
        );
        assert.equal(
            thread?.turns?.every(
                (turn) => turn.policyBinding?.policyId === WORKFLOW_AGENT_REVIEW_POLICY_ID,
            ),
            true,
        );
        assert.equal(faux.state.callCount, 2);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("Review authority excludes a mutation-capable profile and guards nested effects", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    const deniedEffects: string[] = [];
    let mutationEffects = 0;

    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const mutationExtension = defineExtension({
        name: "review-mutation-extension",
        tools: [
            defineTool({
                name: "review-write",
                description: "Mutate protected state.",
                parameters: Type.Object({}),
                async execute() {
                    mutationEffects++;

                    return { content: [{ type: "text", text: "mutated" }] };
                },
            }),
        ],
    });
    const readExtension = defineExtension({
        name: "review-read-extension",
        tools: [
            defineTool({
                name: "review-read",
                description: "Read and test guarded nested operations.",
                parameters: Type.Object({}),
                async execute(_args, api, toolContext) {
                    const nestedMutation = api.registry
                        .tools()
                        .find(({ tool }) => tool.name === "review-write")?.tool;

                    assert.ok(nestedMutation);

                    try {
                        await nestedMutation.execute({}, api, toolContext);
                    } catch (error) {
                        deniedEffects.push(String(error));
                    }

                    try {
                        await api.commit(
                            (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
                            toolContext,
                        );
                    } catch (error) {
                        deniedEffects.push(String(error));
                    }

                    return { content: [{ type: "text", text: "read completed" }] };
                },
            }),
        ],
    });

    registry.install(readExtension);
    registry.install(mutationExtension);
    const profile = {
        id: "mixed-capability-reviewer",
        version: 1,
        instructions: "Use only the read tool.",
        instructionsVersion: "review-mixed-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
        extensions: [
            { name: readExtension.name, version: "read-extension-v1" },
            { name: mutationExtension.name, version: "mutation-extension-v1" },
        ],
        tools: [
            {
                name: "review-read",
                extension: readExtension.name,
                version: "read-tool-v1",
                capabilities: ["filesystem.read"],
            },
            {
                name: "review-write",
                extension: mutationExtension.name,
                version: "mutation-tool-v1",
                capabilities: ["filesystem.write"],
            },
        ],
        capabilities: ["filesystem.read", "filesystem.write"],
    };
    const runtime = createReviewRuntime(
        models,
        registry,
        {
            profiles: [profile],
            authority: {
                extensions: [readExtension.name, mutationExtension.name],
                tools: ["review-read", "review-write"],
                capabilities: ["filesystem.read", "filesystem.write"],
            },
        },
        {
            profileAllowlist: [profile.id],
            authority: {
                extensions: [readExtension.name],
                tools: ["review-read"],
                capabilities: ["filesystem.read"],
            },
        },
    );

    registry.install(runtime.extension);
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("review-read", {}, { id: "review-read-once" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage("review answer"),
    ]);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "review-read-only-authority",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const resolved = await resolvedReviewProfile(agent, profile.id);

            assert.deepEqual(
                resolved.authority.tools.map((tool) => tool.name),
                ["review-read"],
            );
            assert.deepEqual(
                resolved.authority.extensions.map((extension) => extension.name),
                [readExtension.name],
            );

            return agent.turn({
                threadId: "review-read-only-thread",
                turnId: "review-read-only-turn",
                profile: profile.id,
                content: "Read only.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(resolved.identity, true),
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "review-read-only-run" }, context);
        const result = await runtime.engine.wait("review-read-only-run", context);

        assert.equal((result as { content: { text: string }[] }).content[0]?.text, "review answer");
        assert.equal(deniedEffects.length, 2);
        assert.match(deniedEffects[0]!, /outside the admitted effective authority/);
        assert.match(deniedEffects[1]!, /delegation is disabled/);
        assert.equal(mutationEffects, 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("registry drift between Review resolution and admission rejects before thread creation", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    const extensionName = "review-drift-extension";

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("must not dispatch")]);
    const model = models.getModel("faux", "faux-1")!;
    const extension = defineExtension({
        name: extensionName,
        tools: [
            defineTool({
                name: "review-drift-read",
                description: "Original read tool.",
                parameters: Type.Object({}),
                async execute() {
                    return { content: [{ type: "text", text: "read" }] };
                },
            }),
        ],
    });

    registry.install(extension);
    const profile = {
        id: "registry-drift-reviewer",
        version: 1,
        instructions: "Read only.",
        instructionsVersion: "review-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
        extensions: [{ name: extensionName, version: "review-extension-v1" }],
        tools: [
            {
                name: "review-drift-read",
                extension: extensionName,
                version: "review-tool-v1",
                capabilities: [],
            },
        ],
        capabilities: [],
    };
    const runtime = createReviewRuntime(
        models,
        registry,
        {
            profiles: [profile],
            authority: { extensions: [extensionName], tools: ["review-drift-read"] },
        },
        {
            profileAllowlist: [profile.id],
            authority: { extensions: [extensionName], tools: ["review-drift-read"] },
        },
    );

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "review-registry-drift",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            const resolved = await resolvedReviewProfile(agent, profile.id);

            registry.install(
                defineExtension({
                    name: extensionName,
                    tools: [
                        defineTool({
                            name: "review-drift-read",
                            description: "Changed read tool.",
                            parameters: Type.Object({ value: Type.String() }),
                            async execute() {
                                return { content: [{ type: "text", text: "changed" }] };
                            },
                        }),
                    ],
                }),
            );

            return agent.turn({
                threadId: "review-drift-thread",
                turnId: "review-drift-turn",
                profile: profile.id,
                content: "Do not admit after registry drift.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(resolved.identity, true),
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "review-drift-run" }, context);

        await assert.rejects(
            runtime.engine.wait("review-drift-run", context),
            /Resolved Review identity changed before turn reservation/,
        );
        assert.equal(
            await host.harness.snapshot(
                AGENT_THREAD_DOC,
                workflowAgentThreadKey({
                    runId: "review-drift-run",
                    threadId: "review-drift-thread",
                    profileId: profile.id,
                }),
                context,
            ),
            undefined,
        );
        assert.equal(faux.state.callCount, 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});

test("forged identities and profiles outside the Review allowlist fail before admission", async () => {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();

    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("must not dispatch")]);
    const model = models.getModel("faux", "faux-1")!;
    const profile = (id: string) => ({
        id,
        version: 1,
        instructions: "Review only.",
        instructionsVersion: "review-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "faux-review-v1",
        },
    });
    const allowedProfile = profile("allowlisted-reviewer");
    const excludedProfile = profile("excluded-reviewer");
    const runtime = createReviewRuntime(
        models,
        registry,
        { profiles: [allowedProfile, excludedProfile] },
        {
            profileAllowlist: [allowedProfile.id],
            authority: { extensions: [], sections: [], tools: [], capabilities: [] },
        },
    );

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), context, () => undefined);
    const workflow = defineWorkflow({
        id: "review-identity-forgery",
        version: 1,
        async run({ agent }: WorkflowContext<null>) {
            assert.ok(agent);
            await assert.rejects(
                resolvedReviewProfile(agent, excludedProfile.id),
                /not on the Review profile allowlist/,
            );
            const resolved = await resolvedReviewProfile(agent, allowedProfile.id);

            return agent.turn({
                threadId: "forged-review-thread",
                turnId: "forged-review-turn",
                profile: allowedProfile.id,
                content: "Do not admit this forged identity.",
                policyBinding: createWorkflowAgentReviewPolicyBinding(
                    { ...resolved.identity, fingerprint: "forged" },
                    true,
                ),
            });
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(workflow, null, { runId: "review-forgery-run" }, context);

        await assert.rejects(
            runtime.engine.wait("review-forgery-run", context),
            /Resolved Review identity changed before turn reservation/,
        );
        assert.equal(
            await host.harness.snapshot(
                AGENT_THREAD_DOC,
                workflowAgentThreadKey({
                    runId: "review-forgery-run",
                    threadId: "forged-review-thread",
                    profileId: allowedProfile.id,
                }),
                context,
            ),
            undefined,
        );
        assert.equal(faux.state.callCount, 0);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
});
