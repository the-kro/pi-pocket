import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    createRegistry,
    defineExtension,
    defineTool,
    MemoryStorage,
    section,
} from "@earendil-works/pi-durable";
import { workflowAgentResultSchemaFingerprint } from "../packages/workflow-runtime/agents/profile.ts";
import type { WorkflowAgentReviewProfileDescriptor } from "../packages/workflow-runtime/review/agent-policy.ts";
import { defineWorkflow, type WorkflowContext } from "../packages/workflow-runtime/core/index.ts";

const reviewApi = await import("../packages/workflow-runtime/review/contract.ts").catch(
    () => undefined,
);
const workflowRuntime: Record<string, any> =
    await import("../packages/workflow-runtime/index.ts").catch(() => ({}));

test("the public workflow runtime exports the portable durable Review helper", () => {
    assert.equal(typeof workflowRuntime?.review, "function");
});

const revision = {
    workspaceId: "workspace-review-1",
    digest: "c".repeat(64),
    algorithm: "sha256" as const,
    coverage: "git-head-index-worktree-v1" as const,
};

const verification = {
    verificationId: "verify-review-1",
    requestDigest: "b".repeat(64),
    workspaceId: revision.workspaceId,
    subjectRevision: revision.digest,
    status: "passed" as const,
    checks: [
        {
            checkId: "tests",
            status: "passed" as const,
            exitCode: 0,
            observedOutputBytes: 0,
            truncated: false,
            termination: "none" as const,
        },
    ],
};

const reviewerIdentity = {
    profileId: "reviewer-v1",
    profileVersion: 3,
    profileFingerprint: "d".repeat(64),
    modelFingerprint: "e".repeat(64),
    authorityFingerprint: "f".repeat(64),
    policyFingerprint: "b".repeat(64),
    instructionsVersion: "reviewer-instructions-v2",
    instructionsFingerprint: "a".repeat(64),
    resultSchemaId: "review-decision",
    resultSchemaVersion: "1",
    resultSchemaFingerprint: "1".repeat(64),
    fingerprint: "c".repeat(64),
    resultPolicy: "structured-result-required-v1" as const,
};

const request = {
    gateId: "gate:1",
    threadId: "thread:1",
    turnId: "turn:1",
    reviewerProfile: "reviewer-v1",
    reviewerIdentity,
    workspaceRevision: revision,
    verification,
    scope: "Review the current implementation for correctness and regressions.",
};

test("review binding captures the resolved reviewer authority and structured-result identity", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const binding = reviewApi.createReviewBinding({ ...request, reviewerIdentity });

    assert.equal(binding.reviewerProfile, reviewerIdentity.profileId);
    assert.deepEqual(binding.reviewerIdentity, reviewerIdentity);
    assert.doesNotThrow(() =>
        reviewApi.assertReviewBindingUnchanged(
            binding,
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: { ...reviewerIdentity },
            }),
        ),
    );

    const changedIdentities = [
        { ...reviewerIdentity, profileVersion: 4 },
        { ...reviewerIdentity, profileFingerprint: "2".repeat(64) },
        { ...reviewerIdentity, modelFingerprint: "2".repeat(64) },
        { ...reviewerIdentity, authorityFingerprint: "2".repeat(64) },
        { ...reviewerIdentity, policyFingerprint: "4".repeat(64) },
        { ...reviewerIdentity, fingerprint: "5".repeat(64) },
        { ...reviewerIdentity, instructionsVersion: "reviewer-instructions-v3" },
        { ...reviewerIdentity, instructionsFingerprint: "2".repeat(64) },
        { ...reviewerIdentity, resultSchemaId: "review-decision-v2" },
        { ...reviewerIdentity, resultSchemaVersion: "2" },
        { ...reviewerIdentity, resultSchemaFingerprint: "2".repeat(64) },
    ];

    for (const identity of changedIdentities) {
        const changed = reviewApi.createReviewBinding({ ...request, reviewerIdentity: identity });

        assert.notEqual(binding.requestDigest, changed.requestDigest);
        assert.throws(
            () => reviewApi.assertReviewBindingUnchanged(binding, changed),
            /conflicts with its frozen identity/i,
        );
    }
});

test("review bindings preserve and validate the full Target 3 reviewer identity", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const identity = {
        ...reviewerIdentity,
        policyFingerprint: "b".repeat(64),
        fingerprint: "c".repeat(64),
    };
    const binding = reviewApi.createReviewBinding({ ...request, reviewerIdentity: identity });

    assert.deepEqual(binding.reviewerIdentity, identity);

    const { policyFingerprint: _policyFingerprint, ...missingPolicyFingerprint } = identity;

    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: missingPolicyFingerprint,
            }),
        /missing required fields/i,
    );

    const { fingerprint: _fingerprint, ...missingFingerprint } = identity;

    assert.throws(
        () => reviewApi.createReviewBinding({ ...request, reviewerIdentity: missingFingerprint }),
        /missing required fields/i,
    );

    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: { ...identity, policyFingerprint: "not-a-digest" },
            }),
        /policyFingerprint.*SHA-256/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: { ...identity, fingerprint: "not-a-digest" },
            }),
        /fingerprint.*SHA-256/i,
    );
});

test("review request binding has a stable collision-safe operation identity", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const binding = reviewApi.createReviewBinding(request);

    assert.deepEqual(
        {
            gateId: binding.gateId,
            threadId: binding.threadId,
            turnId: binding.turnId,
            operationId: binding.operationId,
        },
        {
            gateId: "gate:1",
            threadId: "thread:1",
            turnId: "turn:1",
            operationId: "pocket-review-v1:WyJnYXRlOjEiLCJ0aHJlYWQ6MSIsInR1cm46MSJd",
        },
    );
});

test("review request binding rejects verification that did not pass", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                verification: { ...verification, status: "failed" },
            }),
        /passed verification/i,
    );
});

test("an approved review result is bound to its exact request", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");
    assert.equal(typeof reviewApi.createReviewResult, "function");

    const result = reviewApi.createReviewResult(request, {
        verdict: "APPROVED",
        summary: "No blocking findings.",
    });

    assert.deepEqual(result, {
        gateId: "gate:1",
        threadId: "thread:1",
        turnId: "turn:1",
        operationId: "pocket-review-v1:WyJnYXRlOjEiLCJ0aHJlYWQ6MSIsInR1cm46MSJd",
        reviewerProfile: "reviewer-v1",
        reviewerIdentity,
        workspaceId: "workspace-review-1",
        subjectRevision: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        verificationId: "verify-review-1",
        verificationRequestDigest:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        requestDigest: "1f516c291e9e56501ca7e34eda750828e9139d91204b21708363732ff4868009",
        decision: { verdict: "APPROVED", summary: "No blocking findings." },
    });
    assert.deepEqual(reviewApi.validateReviewResult(result, request), result);
});

test("review decision validation enforces the exact verdict algebra", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");
    assert.equal(typeof reviewApi.validateReviewDecision, "function");

    const actionable = {
        verdict: "CHANGES_REQUIRED",
        summary: "Two concrete changes are required.",
        findings: [
            {
                id: "finding-1",
                description: "The request digest is not checked.",
                evidence: "A result with a changed digest is accepted.",
                requiredChange: "Reject a result bound to a different digest.",
            },
        ],
    };
    const blocked = {
        verdict: "BLOCKED",
        summary: "Review cannot safely proceed.",
        reason: "The verification evidence is incomplete.",
    };

    assert.deepEqual(reviewApi.validateReviewDecision(actionable), actionable);
    assert.deepEqual(reviewApi.validateReviewDecision(blocked), blocked);
    assert.throws(
        () =>
            reviewApi.validateReviewDecision({
                verdict: "APPROVED",
                summary: "Done",
                findings: [],
            }),
        /unsupported fields/i,
    );
    assert.throws(
        () => reviewApi.validateReviewDecision({ verdict: "APPROVED" }),
        /missing required fields/i,
    );
    assert.throws(
        () => reviewApi.validateReviewDecision({ verdict: "APPROVED", summary: "s".repeat(2_049) }),
        /summary.*bounded/i,
    );
    assert.throws(
        () => reviewApi.validateReviewDecision({ ...actionable, findings: [] }),
        /non-empty/i,
    );
    assert.throws(
        () =>
            reviewApi.validateReviewDecision({
                ...actionable,
                findings: [actionable.findings[0], actionable.findings[0]],
            }),
        /duplicate/i,
    );
    assert.throws(
        () =>
            reviewApi.validateReviewDecision({
                ...actionable,
                findings: [{ ...actionable.findings[0], evidence: "e".repeat(2_049) }],
            }),
        /evidence.*bounded/i,
    );
    assert.throws(() => reviewApi.validateReviewDecision({ ...blocked, reason: "  " }), /reason/i);
    assert.throws(
        () => reviewApi.validateReviewDecision({ verdict: "ORACLE_REQUIRED", summary: "unknown" }),
        /unsupported verdict/i,
    );
});

test("same-turn input changes raise a non-retryable review conflict", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");
    assert.equal(typeof reviewApi.assertReviewBindingUnchanged, "function");

    const original = reviewApi.createReviewBinding(request);
    const changed = reviewApi.createReviewBinding({ ...request, scope: "Review only the parser." });

    assert.throws(
        () => reviewApi.assertReviewBindingUnchanged(original, changed),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "review_request_conflict" &&
            "retryable" in error &&
            error.retryable === false,
    );
});

test("same-turn verification outcome changes conflict even when its request identity is reused", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const original = reviewApi.createReviewBinding(request);
    const changed = reviewApi.createReviewBinding({
        ...request,
        verification: {
            ...verification,
            checks: [
                {
                    checkId: "tests",
                    status: "passed" as const,
                    exitCode: 0,
                    evidence: "a different successful command output",
                },
            ],
        },
    });

    assert.notEqual(original.requestDigest, changed.requestDigest);
    assert.doesNotMatch(JSON.stringify(changed), /different successful command output/);
    assert.throws(
        () => reviewApi.assertReviewBindingUnchanged(original, changed),
        /conflicts with its frozen identity/i,
    );
});

test("a result from an earlier turn cannot satisfy a later review pass", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const firstTurnResult = reviewApi.createReviewResult(request, {
        verdict: "APPROVED",
        summary: "No blocking findings.",
    });

    assert.throws(
        () => reviewApi.validateReviewResult(firstTurnResult, { ...request, turnId: "turn:2" }),
        /turnId/i,
    );
    assert.throws(
        () =>
            reviewApi.validateReviewResult(
                { ...firstTurnResult, subjectRevision: "d".repeat(64) },
                request,
            ),
        /subjectRevision/i,
    );
    assert.throws(
        () =>
            reviewApi.validateReviewResult(
                { ...firstTurnResult, verificationRequestDigest: "a".repeat(64) },
                request,
            ),
        /verificationRequestDigest/i,
    );
    assert.throws(
        () =>
            reviewApi.validateReviewResult(
                { ...firstTurnResult, requestDigest: "a".repeat(64) },
                request,
            ),
        /requestDigest/i,
    );
    assert.throws(
        () => reviewApi.validateReviewResult({ ...firstTurnResult, extra: true }, request),
        /unsupported fields/i,
    );
    assert.throws(
        () =>
            reviewApi.validateReviewResult(
                {
                    ...firstTurnResult,
                    reviewerIdentity: {
                        ...firstTurnResult.reviewerIdentity,
                        authorityFingerprint: "2".repeat(64),
                    },
                },
                request,
            ),
        /reviewerIdentity does not match the requested pass/i,
    );
});

test("review bindings reject malformed or revision-mismatched verification evidence", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                verification: { ...verification, workspaceId: "workspace-other" },
            }),
        /exact Review workspace revision/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                verification: { ...verification, subjectRevision: "d".repeat(64) },
            }),
        /exact Review workspace revision/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                verification: { ...verification, requestDigest: "not-a-digest" },
            }),
        /requestDigest/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                verification: { ...verification, diagnostic: "unbound evidence" },
            }),
        /unsupported fields/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                verification: {
                    ...verification,
                    checks: [{ checkId: "tests", status: "interrupted" }],
                },
            }),
        /passed/i,
    );
});

test("review requests reject extra fields, aliased roles, and over-bound scope", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const { reviewerIdentity: _reviewerIdentity, ...missingReviewerIdentity } = request;

    assert.throws(
        () => reviewApi.createReviewBinding(missingReviewerIdentity),
        /Review request is missing required fields/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: { ...reviewerIdentity, profileId: "another-profile" },
            }),
        /profileId does not match reviewerProfile/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: { ...reviewerIdentity, resultPolicy: "prose-fallback-v1" },
            }),
        /resultPolicy must require a schema-bound structured result/i,
    );
    assert.throws(
        () =>
            reviewApi.createReviewBinding({
                ...request,
                reviewerIdentity: { ...reviewerIdentity, authorityFingerprint: "not-a-digest" },
            }),
        /reviewer authorityFingerprint.*SHA-256/i,
    );
    assert.throws(
        () => reviewApi.createReviewBinding({ ...request, unsafeMode: true }),
        /unsupported fields/i,
    );
    assert.throws(
        () => reviewApi.createReviewBinding({ ...request, threadId: request.gateId }),
        /must be distinct/i,
    );
    assert.throws(
        () => reviewApi.createReviewBinding({ ...request, scope: "s".repeat(8_193) }),
        /scope.*bounded/i,
    );
});

test("operation encoding distinguishes IDs that collide under separator joining", () => {
    assert.ok(reviewApi, "the public review contract seam must be available");

    const first = reviewApi.createReviewBinding({
        ...request,
        gateId: "gate:a",
        threadId: "b",
        turnId: "c",
    });
    const second = reviewApi.createReviewBinding({
        ...request,
        gateId: "gate",
        threadId: "a:b",
        turnId: "c",
    });

    assert.equal(first.operationId, "pocket-review-v1:WyJnYXRlOmEiLCJiIiwiYyJd");
    assert.equal(second.operationId, "pocket-review-v1:WyJnYXRlIiwiYTpiIiwiYyJd");
    assert.notEqual(first.operationId, second.operationId);
});

test("Review uses a separate schema-bound read-only reviewer and promotes only fresh evidence", async () => {
    assert.equal(typeof workflowRuntime.review, "function");
    assert.ok(reviewApi, "the public Review contract must be importable");

    const directory = await mkdtemp(join(tmpdir(), "workflow-review-direct-"));
    const sentinel = join(directory, "mutated.txt");
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider();
    const reviewExtensionName = "workflow-review-audited-read";
    const mutationExtensionName = "workflow-review-unapproved-mutation";
    let reads = 0;
    let mutationAttempts = 0;
    let mutationDenial = "";
    const readTool = defineTool({
        name: "review_read",
        description: "Read source through the audited read capability.",
        parameters: Type.Object({}),
        async execute(_args, api, toolContext) {
            reads += 1;
            const mutation = api.registry
                .tools()
                .find(
                    ({ extension, tool }) =>
                        extension.name === mutationExtensionName && tool.name === "review_mutate",
                )?.tool;

            assert.ok(mutation, "the test must attempt the unapproved tool at execution time");
            mutationAttempts += 1;

            try {
                await mutation.execute({ path: sentinel }, api, toolContext);
            } catch (error) {
                mutationDenial = String(error);
            }

            return { content: [{ type: "text", text: "audited source read" }] };
        },
    });
    const readExtension = defineExtension({
        name: reviewExtensionName,
        tools: [readTool],
        sections: [section("review-scope", () => "Review only the supplied scope.")],
    });
    const mutationExtension = defineExtension({
        name: mutationExtensionName,
        tools: [
            defineTool({
                name: "review_mutate",
                description: "Attempt to mutate a filesystem sentinel.",
                parameters: Type.Object({ path: Type.String() }),
                async execute(args) {
                    await (await import("node:fs/promises")).writeFile(args.path, "mutated");

                    return { content: [{ type: "text", text: "sentinel mutated" }] };
                },
            }),
        ],
    });

    registry.install(readExtension);
    registry.install(mutationExtension);
    models.setProvider(faux.provider);
    const model = models.getModel("faux", "faux-1")!;
    const reviewerProfile = {
        id: "reviewer-v1",
        version: 1,
        instructions:
            "Inspect only using audited read tools; return the structured Review decision.",
        instructionsVersion: "reviewer-instructions-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "review-faux-v1",
        },
        extensions: [{ name: reviewExtensionName, version: "review-read-extension-v1" }],
        sections: [{ key: "review-scope", extension: reviewExtensionName, version: "scope-v1" }],
        tools: [
            {
                name: "review_read",
                extension: reviewExtensionName,
                version: "review-read-tool-v1",
                capabilities: ["filesystem.read"],
            },
        ],
        capabilities: ["filesystem.read"],
        result: workflowRuntime.WORKFLOW_REVIEW_RESULT,
    };
    const implementerProfile = {
        id: "implementer-v1",
        version: 1,
        instructions: "Implement the requested change.",
        instructionsVersion: "implementer-v1",
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: model.api,
            providerVersion: "review-faux-v1",
        },
    };
    const authority = {
        extensions: [reviewExtensionName],
        sections: ["review-scope"],
        tools: ["review_read"],
        capabilities: ["filesystem.read"],
    };
    const revision = {
        workspaceId: "review-test-workspace",
        digest: "9".repeat(64),
        algorithm: "sha256" as const,
        coverage: "git-head-index-worktree-v1" as const,
    };
    const verification = {
        verificationId: "review-test-verification",
        requestDigest: "8".repeat(64),
        workspaceId: revision.workspaceId,
        subjectRevision: revision.digest,
        status: "passed" as const,
        checks: [
            {
                checkId: "offline-review-fixture",
                status: "passed" as const,
                exitCode: 0,
                evidence: "The offline verification fixture passed.",
            },
        ],
    };
    const reviewRequestBase = {
        gateId: "review-gate-direct",
        threadId: "reviewer-thread-direct",
        turnId: "reviewer-turn-direct",
        reviewerProfile: reviewerProfile.id,
        workspaceRevision: revision,
        verification,
        scope: "Review the implemented diff for correctness and blocking regressions.",
    };
    const phases: string[] = [];
    const safetyRequests: unknown[] = [];
    const adapters = {
        workspace: {
            async snapshot() {
                phases.push("snapshot");

                return { ...revision };
            },
        },
        safety: {
            async assertQuiescent(safetyRequest: { phase: string }) {
                phases.push(safetyRequest.phase);
                safetyRequests.push(safetyRequest);

                return {
                    state: "quiescent" as const,
                    assuranceId: `assurance-${safetyRequest.phase}`,
                };
            },
        },
    };
    const firstDecision = {
        verdict: "CHANGES_REQUIRED",
        summary: "One concrete repair is required.",
        findings: [
            {
                id: "review-finding-1",
                description: "The change does not validate the saved request identity.",
                evidence: "The persisted binding is not compared before replay.",
                requiredChange: "Compare the canonical binding before accepting replay.",
            },
        ],
    };
    const secondDecision = {
        verdict: "APPROVED",
        summary: "The repaired change is correct and has no blocking findings.",
    };
    const reviewResponses = (prefix: string, decision: any) => [
        fauxAssistantMessage([fauxToolCall("review_read", {}, { id: `${prefix}-read-call` })], {
            stopReason: "toolUse",
        }),
        fauxAssistantMessage(
            [
                fauxToolCall(workflowRuntime.WORKFLOW_REVIEW_RESULT.toolName, decision, {
                    id: `${prefix}-decision-call`,
                }),
            ],
            { stopReason: "toolUse" },
        ),
    ];

    faux.setResponses([
        fauxAssistantMessage("This implementer answer must not enter the reviewer conversation."),
        ...reviewResponses("review-first", firstDecision),
        ...reviewResponses("review-second", secondDecision),
    ]);
    const agentConfig = { authority, profiles: [reviewerProfile, implementerProfile] };
    const reviewConfig = { profileAllowlist: [reviewerProfile.id], authority };
    const runtime = workflowRuntime.createWorkflowAgentRuntime({
        harnessOptions: { models, registry },
        agentConfig,
        admissionPolicy: workflowRuntime.createWorkflowAgentReviewAdmissionPolicy({
            models,
            registry,
            agentConfig,
            reviewConfig,
        }),
    });

    registry.install(runtime.extension);
    const host = await runtime.openHost(new MemoryStorage(), BACKGROUND_CONTEXT, () => undefined);
    const workflow = defineWorkflow({
        id: "workflow-review-direct",
        version: 1,
        async run(context: WorkflowContext<null>) {
            assert.ok(context.agent);
            await context.agent.turn({
                threadId: "implementer-thread-direct",
                turnId: "implementer-turn-direct",
                profile: implementerProfile.id,
                content: "Implement the requested fix.",
            });

            const reviewerDescriptor = (await context.agent.resolveProfile(
                reviewerProfile.id,
            )) as unknown as WorkflowAgentReviewProfileDescriptor;
            const reviewRequest = {
                ...reviewRequestBase,
                reviewerIdentity: workflowRuntime.createReviewReviewerIdentity(reviewerDescriptor),
            };
            const first = await workflowRuntime.review(context, reviewRequest, adapters);
            const replay = await workflowRuntime.review(context, reviewRequest, adapters);
            const continuation = await workflowRuntime.review(
                context,
                { ...reviewRequest, turnId: "reviewer-turn-direct-2" },
                adapters,
            );

            return { first, replay, continuation, reviewRequest };
        },
    });

    try {
        runtime.engine.register(workflow);
        await runtime.engine.start(
            workflow,
            null,
            { runId: "workflow-review-direct-run" },
            BACKGROUND_CONTEXT,
        );
        const result = await runtime.engine.wait("workflow-review-direct-run", BACKGROUND_CONTEXT);
        const { reviewRequest } = result;
        const implementerThread = await host.harness.snapshot(
            workflowRuntime.AGENT_THREAD_DOC,
            workflowRuntime.workflowAgentThreadKey({
                runId: "workflow-review-direct-run",
                threadId: "implementer-thread-direct",
                profileId: implementerProfile.id,
            }),
            BACKGROUND_CONTEXT,
        );
        const reviewerThread = await host.harness.snapshot(
            workflowRuntime.AGENT_THREAD_DOC,
            workflowRuntime.workflowAgentThreadKey({
                runId: "workflow-review-direct-run",
                threadId: reviewRequest.threadId,
                profileId: reviewerProfile.id,
            }),
            BACKGROUND_CONTEXT,
        );

        assert.deepEqual(
            { first: result.first, replay: result.replay, continuation: result.continuation },
            {
                first: reviewApi.createReviewResult(reviewRequest, firstDecision),
                replay: reviewApi.createReviewResult(reviewRequest, firstDecision),
                continuation: reviewApi.createReviewResult(
                    { ...reviewRequest, turnId: "reviewer-turn-direct-2" },
                    secondDecision,
                ),
            },
        );
        assert.notEqual(implementerThread?.conversationId, reviewerThread?.conversationId);
        assert.deepEqual(
            reviewerThread?.turns?.map(
                (turn: {
                    turnId: string;
                    status: string;
                    policyBinding?: {
                        readonly policyId?: string;
                        readonly input?: { readonly firstTurn?: boolean };
                    };
                }) => ({
                    turnId: turn.turnId,
                    status: turn.status,
                    policyId: turn.policyBinding?.policyId,
                    firstTurn: turn.policyBinding?.input?.firstTurn,
                }),
            ),
            [
                {
                    turnId: reviewRequest.turnId,
                    status: "completed",
                    policyId: workflowRuntime.WORKFLOW_AGENT_REVIEW_POLICY_ID,
                    firstTurn: true,
                },
                {
                    turnId: "reviewer-turn-direct-2",
                    status: "completed",
                    policyId: workflowRuntime.WORKFLOW_AGENT_REVIEW_POLICY_ID,
                    firstTurn: false,
                },
            ],
        );
        const firstIntent = JSON.parse(reviewerThread!.turns![0]!.intentCanonical) as {
            readonly content: string;
        };

        assert.deepEqual(JSON.parse(firstIntent.content), {
            requestVersion: 1,
            scope: reviewRequest.scope,
            workspaceRevision: revision,
            verification,
        });
        assert.equal(reads, 2);
        assert.equal(mutationAttempts, 2);
        assert.match(mutationDenial, /outside the admitted effective authority/);
        await assert.rejects(access(sentinel));
        assert.deepEqual(phases, [
            "snapshot",
            "admission",
            "snapshot",
            "promotion",
            "snapshot",
            "admission",
            "snapshot",
            "promotion",
            "snapshot",
            "admission",
            "snapshot",
            "promotion",
        ]);
        assert.deepEqual(safetyRequests[1], {
            phase: "promotion",
            verificationId: verification.verificationId,
            workspaceId: revision.workspaceId,
            subjectRevision: revision.digest,
            priorAssuranceId: "assurance-admission",
        });
        const reviewerConversation = await host.harness.conversation(
            reviewerThread!.conversationId as never,
            BACKGROUND_CONTEXT,
        );
        const reviewerTranscript = JSON.stringify(
            await reviewerConversation?.context(BACKGROUND_CONTEXT),
        );

        assert.doesNotMatch(
            reviewerTranscript,
            /This implementer answer must not enter the reviewer conversation/,
        );
        assert.equal(faux.state.callCount, 5);
    } finally {
        await host.dispose();
        await runtime.close();
        await host.harness.close(BACKGROUND_CONTEXT);
        await rm(directory, { recursive: true, force: true });
    }
});

const structuredRequest = {
    ...request,
    reviewerIdentity: {
        ...reviewerIdentity,
        instructionsFingerprint: "d194b1e2f0c10e5c206cb94db9aaeea07ef0b493197eef415ff4b28edfc61384",
        resultSchemaId: workflowRuntime.WORKFLOW_REVIEW_RESULT.id,
        resultSchemaVersion: workflowRuntime.WORKFLOW_REVIEW_RESULT.version,
        resultSchemaFingerprint: workflowAgentResultSchemaFingerprint(
            workflowRuntime.WORKFLOW_REVIEW_RESULT,
        ),
    },
};

function fakeReviewProfileDescriptor(identity: typeof structuredRequest.reviewerIdentity) {
    const instructions = "Review the supplied evidence.";

    return {
        profile: { id: identity.profileId, version: identity.profileVersion },
        instructions: { text: instructions, version: identity.instructionsVersion },
        model: {
            provider: "faux",
            modelId: "faux-1",
            api: "faux-api",
            providerVersion: "faux-review-v1",
            fingerprint: identity.modelFingerprint,
        },
        authority: {
            delegation: false as const,
            extensions: [],
            sections: [],
            tools: [],
            capabilities: [],
        },
        result: {
            id: identity.resultSchemaId,
            version: identity.resultSchemaVersion,
            toolName: workflowRuntime.WORKFLOW_REVIEW_RESULT.toolName,
            schema: workflowRuntime.WORKFLOW_REVIEW_RESULT.schema,
            fingerprint: identity.resultSchemaFingerprint,
        },
        identity: {
            profileId: identity.profileId,
            profileFingerprint: identity.profileFingerprint,
            modelFingerprint: identity.modelFingerprint,
            authorityFingerprint: identity.authorityFingerprint,
            policyFingerprint: identity.policyFingerprint,
            resultSchemaFingerprint: identity.resultSchemaFingerprint,
            fingerprint: identity.fingerprint,
        },
    };
}

function fakeReviewContext(
    turn: (input: unknown) => Promise<unknown>,
    resolveProfile: (profileId: string) => Promise<unknown> = async () =>
        fakeReviewProfileDescriptor(structuredRequest.reviewerIdentity),
) {
    const completed = new Map<string, unknown>();
    const controller = new AbortController();
    const context = {
        input: null,
        signal: controller.signal,
        agent: { turn, resolveProfile },
        step: {
            async do(operationId: string, callback: () => Promise<unknown> | unknown) {
                if (completed.has(operationId)) {
                    return structuredClone(completed.get(operationId));
                }

                const result = await callback();

                completed.set(operationId, structuredClone(result));

                return result;
            },
        },
    };

    return { context: context as never, completed };
}

function reviewTestAdapters(options: {
    readonly snapshot: () => Promise<typeof revision>;
    readonly safety?: (phase: string) => Promise<unknown>;
}) {
    return {
        workspace: { snapshot: options.snapshot },
        safety: {
            async assertQuiescent(input: { phase: string }) {
                return options.safety === undefined
                    ? { state: "quiescent" as const, assuranceId: `assurance-${input.phase}` }
                    : options.safety(input.phase);
            },
        },
    };
}

test("Review rejects a caller identity that differs from the runtime resolver before dispatch", async () => {
    let resolutions = 0;
    let dispatches = 0;
    const { context } = fakeReviewContext(
        async () => {
            dispatches += 1;

            return { verdict: "APPROVED", summary: "No blocking findings." };
        },
        async (profileId) => {
            resolutions += 1;
            assert.equal(profileId, structuredRequest.reviewerProfile);

            return fakeReviewProfileDescriptor(structuredRequest.reviewerIdentity);
        },
    );
    const forged = {
        ...structuredRequest,
        reviewerIdentity: {
            ...structuredRequest.reviewerIdentity,
            policyFingerprint: "4".repeat(64),
        },
    };

    await assert.rejects(
        workflowRuntime.review(
            context,
            forged,
            reviewTestAdapters({
                async snapshot() {
                    return revision;
                },
            }),
        ),
        /runtime-resolved reviewer identity/i,
    );
    assert.equal(resolutions, 1);
    assert.equal(dispatches, 0);
});

test("Review binds runtime identity and fresh-thread admission to gate turns", async () => {
    const turnInputs: unknown[] = [];
    const { context } = fakeReviewContext(async (input) => {
        turnInputs.push(input);

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
    });

    await workflowRuntime.review(context, structuredRequest, adapters);
    await workflowRuntime.review(
        context,
        { ...structuredRequest, turnId: "review-turn-next" },
        adapters,
    );

    const resolvedIdentity = fakeReviewProfileDescriptor(
        structuredRequest.reviewerIdentity,
    ).identity;

    assert.deepEqual(
        turnInputs.map((input) => {
            const turn = input as {
                readonly policyBinding?: {
                    readonly policyId?: string;
                    readonly policyVersion?: string;
                    readonly input?: {
                        readonly reviewerIdentity?: unknown;
                        readonly firstTurn?: boolean;
                    };
                };
            };

            return {
                policyId: turn.policyBinding?.policyId,
                policyVersion: turn.policyBinding?.policyVersion,
                reviewerIdentity: turn.policyBinding?.input?.reviewerIdentity,
                firstTurn: turn.policyBinding?.input?.firstTurn,
            };
        }),
        [
            {
                policyId: workflowRuntime.WORKFLOW_AGENT_REVIEW_POLICY_ID,
                policyVersion: "1",
                reviewerIdentity: resolvedIdentity,
                firstTurn: true,
            },
            {
                policyId: workflowRuntime.WORKFLOW_AGENT_REVIEW_POLICY_ID,
                policyVersion: "1",
                reviewerIdentity: resolvedIdentity,
                firstTurn: false,
            },
        ],
    );
});

test("Review prevents another gate from reusing the same reviewer thread", async () => {
    let dispatches = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
    });

    await workflowRuntime.review(context, structuredRequest, adapters);
    await assert.rejects(
        workflowRuntime.review(
            context,
            {
                ...structuredRequest,
                gateId: "another-review-gate",
                turnId: "another-review-turn",
            },
            adapters,
        ),
        /reviewer thread.*already reserved|reserved.*reviewer thread/i,
    );
    assert.equal(dispatches, 1);
});

test("concurrent Review gates can admit only one owner for a reviewer thread", async () => {
    let dispatches = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
    });
    const outcomes = await Promise.allSettled([
        workflowRuntime.review(context, structuredRequest, adapters),
        workflowRuntime.review(
            context,
            {
                ...structuredRequest,
                gateId: "concurrent-review-gate",
                turnId: "concurrent-review-turn",
            },
            adapters,
        ),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.equal(dispatches, 1);
});

test("Review rejects a stale admission before dispatch", async () => {
    let dispatches = 0;
    let safetyChecks = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return { ...revision, digest: "d".repeat(64) };
        },
    });

    adapters.safety.assertQuiescent = async () => {
        safetyChecks += 1;

        return { state: "quiescent", assuranceId: "unexpected" };
    };

    await assert.rejects(
        workflowRuntime.review(context, structuredRequest, adapters),
        /revision changed before admission/i,
    );
    assert.equal(dispatches, 0);
    assert.equal(safetyChecks, 0);
});

test("Review fails closed when admission safety is unknown", async () => {
    let dispatches = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
        async safety() {
            return { state: "unknown", reason: "writer status is unavailable" };
        },
    });

    await assert.rejects(
        workflowRuntime.review(context, structuredRequest, adapters),
        /not authoritatively quiescent at admission/i,
    );
    assert.equal(dispatches, 0);
});

test("Review does not return a decision when promotion safety is unknown", async () => {
    let dispatches = 0;
    const safetyPhases: string[] = [];
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
        async safety(phase) {
            safetyPhases.push(phase);

            return phase === "admission"
                ? { state: "quiescent", assuranceId: "admission-assurance" }
                : { state: "unknown", reason: "promotion could not be established" };
        },
    });

    await assert.rejects(
        workflowRuntime.review(context, structuredRequest, adapters),
        /not authoritatively quiescent at promotion/i,
    );
    assert.equal(dispatches, 1);
    assert.deepEqual(safetyPhases, ["admission", "promotion"]);
});

test("Review does not return a decision when the revision changes before promotion", async () => {
    let dispatches = 0;
    let snapshots = 0;
    const { context, completed } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            snapshots += 1;

            return snapshots === 1 ? revision : { ...revision, digest: "d".repeat(64) };
        },
    });

    await assert.rejects(
        workflowRuntime.review(context, structuredRequest, adapters),
        /revision changed before promotion/i,
    );
    assert.equal(dispatches, 1);
    assert.equal(snapshots, 2);
    assert.equal(completed.size, 4);
});

test("Review rejects changed same-turn evidence before a second dispatch", async () => {
    let dispatches = 0;
    let snapshots = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            snapshots += 1;

            return revision;
        },
    });

    await workflowRuntime.review(context, structuredRequest, adapters);

    const changedRequest = {
        ...structuredRequest,
        verification: {
            ...structuredRequest.verification,
            checks: [
                {
                    checkId: "tests",
                    status: "passed" as const,
                    exitCode: 0,
                    evidence: "different passed verification evidence",
                },
            ],
        },
    };

    await assert.rejects(
        workflowRuntime.review(context, changedRequest, adapters),
        /conflicts with its frozen identity/i,
    );
    assert.equal(dispatches, 1);
    assert.equal(snapshots, 2);
});

test("Review snapshots its request before awaiting adapters", async () => {
    assert.ok(reviewApi, "the public Review contract must be importable");

    const original = structuredClone(structuredRequest);
    const mutable = structuredClone(structuredRequest) as any;
    let delivered = "";
    const { context } = fakeReviewContext(async (input) => {
        delivered = String((input as { readonly content: unknown }).content);

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            mutable.scope = "A caller mutation after admission must not alter this pass.";
            mutable.verification.checks[0] = {
                checkId: "tests",
                status: "passed",
                exitCode: 0,
                evidence: "changed after binding",
                observedOutputBytes: Buffer.byteLength("changed after binding"),
                truncated: false,
                termination: "none",
            };

            return revision;
        },
    });

    const result = await workflowRuntime.review(context, mutable, adapters);

    assert.deepEqual(JSON.parse(delivered), {
        requestVersion: 1,
        scope: original.scope,
        workspaceRevision: original.workspaceRevision,
        verification: original.verification,
    });
    assert.equal(result.requestDigest, reviewApi.createReviewBinding(original).requestDigest);
});

test("Review keeps one reviewer thread for a gate", async () => {
    let dispatches = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return { verdict: "APPROVED", summary: "No blocking findings." };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
    });

    await workflowRuntime.review(context, structuredRequest, adapters);

    await assert.rejects(
        workflowRuntime.review(
            context,
            { ...structuredRequest, threadId: "different-reviewer-thread", turnId: "turn:2" },
            adapters,
        ),
        /conflicts with its frozen identity/i,
    );
    assert.equal(dispatches, 1);
});

test("invalid structured reviewer output is an error, never a BLOCKED verdict", async () => {
    let dispatches = 0;
    const { context } = fakeReviewContext(async () => {
        dispatches += 1;

        return {
            verdict: "APPROVED",
            summary: "No blocking findings.",
            findings: [],
        };
    });
    const adapters = reviewTestAdapters({
        async snapshot() {
            return revision;
        },
    });

    await assert.rejects(
        workflowRuntime.review(context, structuredRequest, adapters),
        /unsupported fields/i,
    );
    assert.equal(dispatches, 1);
});
