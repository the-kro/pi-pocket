import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    createReviewReviewerIdentity,
    createWorkflowAgentRuntime,
    defineWorkflow,
    review,
    WORKFLOW_REVIEW_RESULT,
    type ReviewAdapters,
    type ReviewResult,
    type WorkflowAgentReviewProfileDescriptor,
    type WorkflowAgentRuntime,
    type WorkflowAgentHost,
    type WorkflowContext,
} from "../packages/workflow-runtime/index.ts";

test("public standalone host runs and recovers an offline Review consumer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflow-review-host-"));
    const database = join(directory, "review.sqlite");
    const faux = fauxProvider();
    const models = createModels();

    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const reviewExtensionName = "standalone-review-tools";
    let readCount = 0;

    const reviewExtension = defineExtension({
        name: reviewExtensionName,
        tools: [
            defineTool({
                name: "review_read",
                description: "Read the bounded review fixture.",
                parameters: Type.Object({}),
                async execute() {
                    readCount += 1;

                    return { content: [{ type: "text", text: "The fixture is safe to approve." }] };
                },
            }),
        ],
    });
    const reviewerProfile = {
        id: "standalone-reviewer-v1",
        version: 1,
        instructions: "Use the read tool, then submit the structured Review decision.",
        instructionsVersion: "standalone-reviewer-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "standalone-faux-v1",
        },
        extensions: [{ name: reviewExtensionName, version: "standalone-read-extension-v1" }],
        sections: [],
        tools: [
            {
                name: "review_read",
                extension: reviewExtensionName,
                version: "standalone-read-tool-v1",
                capabilities: ["filesystem.read"],
            },
        ],
        capabilities: ["filesystem.read"],
        result: WORKFLOW_REVIEW_RESULT,
    };
    const authority = {
        extensions: [reviewExtensionName],
        sections: [],
        tools: ["review_read"],
        capabilities: ["filesystem.read"],
    };
    const revision = {
        workspaceId: "standalone-review-workspace",
        digest: "a".repeat(64),
        algorithm: "sha256" as const,
        coverage: "git-head-index-worktree-v1" as const,
    };
    const verification = {
        verificationId: "standalone-review-verification",
        requestDigest: "b".repeat(64),
        workspaceId: revision.workspaceId,
        subjectRevision: revision.digest,
        status: "passed" as const,
        checks: [
            {
                checkId: "offline-standalone-check",
                status: "passed" as const,
                exitCode: 0,
                evidence: "The injected offline verification passed.",
            },
        ],
    };
    const adapterPhases: string[] = [];
    const reviewAdapters: ReviewAdapters = {
        workspace: {
            async snapshot() {
                adapterPhases.push("snapshot");

                return { ...revision };
            },
        },
        safety: {
            async assertQuiescent(request) {
                adapterPhases.push(request.phase);

                return {
                    state: "quiescent",
                    assuranceId: `standalone-${request.phase}`,
                };
            },
        },
    };
    const decision = {
        verdict: "APPROVED",
        summary: "The standalone offline review found no blocking issue.",
    };

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("review_read", {}, { id: "standalone-read" })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage(
            [
                fauxToolCall(WORKFLOW_REVIEW_RESULT.toolName, decision, {
                    id: "standalone-review-decision",
                }),
            ],
            { stopReason: "toolUse" },
        ),
    ]);

    const workflow = defineWorkflow({
        id: "standalone-review-consumer",
        version: 1,
        async run(context: WorkflowContext<null>) {
            assert.ok(context.agent);
            const reviewer = (await context.agent.resolveProfile(
                reviewerProfile.id,
            )) as unknown as WorkflowAgentReviewProfileDescriptor;

            const result = await review(
                context,
                {
                    gateId: "standalone-review-gate",
                    threadId: "standalone-review-thread",
                    turnId: "standalone-review-turn-1",
                    reviewerProfile: reviewerProfile.id,
                    reviewerIdentity: createReviewReviewerIdentity(reviewer),
                    workspaceRevision: revision,
                    verification,
                    scope: "Review the bounded standalone fixture for blocking regressions.",
                },
                reviewAdapters,
            );

            return JSON.parse(JSON.stringify(result)) as JsonValue;
        },
    });

    const makeRuntime = () => {
        const registry = createRegistry();

        registry.install(reviewExtension);
        const runtime = createWorkflowAgentRuntime({
            harnessOptions: { models, registry },
            agentConfig: {
                authority,
                profiles: [reviewerProfile],
                review: { profileAllowlist: [reviewerProfile.id], authority },
            },
        });

        registry.install(runtime.extension);
        runtime.register(workflow);

        return runtime;
    };

    const startupOrder: string[] = [];
    let secondOpened = false;
    let firstRuntime: WorkflowAgentRuntime | undefined;
    let firstHost: WorkflowAgentHost<string> | undefined;
    let secondRuntime: WorkflowAgentRuntime | undefined;
    let secondHost: WorkflowAgentHost<string> | undefined;

    try {
        firstRuntime = makeRuntime();
        firstHost = await firstRuntime.openHost(
            await openNodeSqliteStorage(database),
            BACKGROUND_CONTEXT,
            () => "first-open",
        );
        assert.equal(firstHost.prepared, "first-open");

        await firstRuntime.engine.start(
            workflow,
            null,
            { runId: "standalone-review-run" },
            BACKGROUND_CONTEXT,
        );
        const firstValue = await firstRuntime.engine.wait(
            "standalone-review-run",
            BACKGROUND_CONTEXT,
        );
        const firstResult = firstValue as unknown as ReviewResult;

        assert.equal(firstResult.decision.verdict, "APPROVED");
        assert.equal(readCount, 1);
        assert.equal(faux.state.callCount, 2);
        assert.deepEqual(adapterPhases, ["snapshot", "admission", "snapshot", "promotion"]);

        await firstHost.dispose();
        await firstRuntime.close();
        await firstHost.harness.close(BACKGROUND_CONTEXT);
        firstHost = undefined;
        firstRuntime = undefined;

        secondRuntime = makeRuntime();
        secondHost = await secondRuntime.openHost(
            await openNodeSqliteStorage(database),
            BACKGROUND_CONTEXT,
            (setup) => {
                setup.onAfterAdapterRecovery(async (recoverySetup) => {
                    assert.equal((await recoverySetup.inspect()).scheduling, "paused");
                    startupOrder.push("adapter-recovered");
                });
                setup.onCleanup(() => {
                    startupOrder.push("setup-cleanup");
                });

                return "reopened";
            },
        );
        secondOpened = true;
        startupOrder.push("host-opened");

        assert.equal(secondHost.prepared, "reopened");
        assert.deepEqual(startupOrder, ["adapter-recovered", "host-opened"]);
        assert.equal(faux.state.callCount, 2);
        const recoveredValue = await secondRuntime.engine.wait(
            "standalone-review-run",
            BACKGROUND_CONTEXT,
        );
        const recoveredResult = recoveredValue as unknown as ReviewResult;

        assert.deepEqual(recoveredResult, firstResult);
        assert.equal(readCount, 1);
        assert.equal(faux.state.callCount, 2);
    } finally {
        if (secondHost !== undefined) {
            await secondHost.dispose();
            await secondRuntime?.close();
            await secondHost.harness.close(BACKGROUND_CONTEXT);
        } else {
            await secondRuntime?.close();
        }

        if (firstHost !== undefined) {
            await firstHost.dispose();
            await firstRuntime?.close();
            await firstHost.harness.close(BACKGROUND_CONTEXT);
        } else {
            await firstRuntime?.close();
        }

        if (secondOpened) {
            assert.deepEqual(startupOrder, ["adapter-recovered", "host-opened", "setup-cleanup"]);
        }

        await rm(directory, { recursive: true, force: true });
    }
});
