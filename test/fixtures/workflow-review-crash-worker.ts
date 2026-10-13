import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    createAssistantMessageEventStream,
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    Type,
} from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as workflowRuntime from "../../packages/workflow-runtime/index.ts";
import type { WorkflowAgentReviewProfileDescriptor } from "../../packages/workflow-runtime/index.ts";
import {
    defineWorkflow,
    type WorkflowContext,
} from "../../packages/workflow-runtime/core/index.ts";
import type { ReviewAdapters } from "../../packages/workflow-runtime/review/review.ts";
import type { ReviewRequest, ReviewResult } from "../../packages/workflow-runtime/review/types.ts";
import type { VerificationResult } from "../../packages/workflow-runtime/verification/types.ts";

const mode = requiredEnvironment("PI_REVIEW_RECOVERY_MODE");
const database = requiredEnvironment("PI_REVIEW_RECOVERY_DB");
const markers = requiredEnvironment("PI_REVIEW_RECOVERY_MARKERS");
const scenario = process.env.PI_REVIEW_RECOVERY_SCENARIO ?? "single-review";
const workspacePath = process.env.PI_REVIEW_RECOVERY_WORKSPACE;
const effectsPath = process.env.PI_REVIEW_RECOVERY_EFFECTS;
const context = BACKGROUND_CONTEXT;
const runId = "review-cold-recovery-run";
const gateId = "review-gate-cold-recovery";
const threadId = "review-thread-cold-recovery";
const turnId = "review-turn-cold-recovery";
const profileId = "reviewer-cold-recovery";
const guidanceWaitId = "review-guidance-occurrence-1";
const guidanceEventType = "review-guidance";
const revision = {
    workspaceId: "review-cold-recovery-workspace",
    digest: "a".repeat(64),
    algorithm: "sha256" as const,
    coverage: "git-head-index-worktree-v1" as const,
};
const revisionB = { ...revision, digest: "c".repeat(64) };
const verification: VerificationResult = {
    verificationId: "review-cold-recovery-verification",
    requestDigest: "b".repeat(64),
    workspaceId: revision.workspaceId,
    subjectRevision: revision.digest,
    status: "passed" as const,
    checks: [
        {
            checkId: "review-cold-recovery-check",
            status: "passed" as const,
            exitCode: 0,
            evidence: "The cold-recovery fixture verification passed.",
        },
    ],
};
const decisionA = {
    verdict: "APPROVED" as const,
    summary: "Revision A received an approval that must not cross a revision change.",
};
const decisionB = {
    verdict: "APPROVED" as const,
    summary: "Fresh revision B passed its independent review.",
};
const decisionBlocked = {
    verdict: "BLOCKED" as const,
    summary: "Review cannot safely proceed.",
    reason: "Owner guidance is required before another verification.",
};
const decisionChangesRequired = {
    verdict: "CHANGES_REQUIRED" as const,
    summary: "One bounded repair is required before approval.",
    findings: [
        {
            id: "review-cold-recovery-repair",
            description: "The first fixture revision lacks the required repair.",
            evidence: "The consumer fixture has not applied its bounded repair yet.",
            requiredChange: "Apply the repair and verify the new workspace revision.",
        },
    ],
};

function requiredEnvironment(name: string): string {
    const value = process.env[name];

    if (value === undefined || value.length === 0) {
        throw new Error(`Missing required environment variable ${name}`);
    }

    return value;
}

function appendMarker(path: string, marker: string): void {
    const descriptor = openSync(path, "a");

    try {
        writeSync(descriptor, `${marker}\n`);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function appendEffect(marker: string): void {
    if (effectsPath === undefined) {
        throw new Error("The recovery scenario requires an effect-marker file");
    }

    appendMarker(effectsPath, marker);
}

function persistWorkspaceRevision(next: typeof revision): void {
    if (workspacePath === undefined) {
        throw new Error("The recovery scenario requires a workspace-revision file");
    }

    const descriptor = openSync(workspacePath, "w");

    try {
        writeSync(descriptor, JSON.stringify(next));
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function writeOutput(marker: string, value: unknown): void {
    writeSync(1, `${marker}${JSON.stringify(value)}\n`);
}

function parkProcess(): never {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

    throw new Error("Unreachable process park returned");
}

const models = createModels();
const faux = fauxProvider();
const baseProvider = faux.provider;
const providerApi = "faux-workflow-review-recovery-v1";
let providerDispatchCount = 0;
let resolveProviderDispatch!: () => void;
const providerDispatchReady = new Promise<void>((resolve) => {
    resolveProviderDispatch = resolve;
});
const provider = {
    ...baseProvider,
    api: providerApi,
    getModels: (...args: Parameters<typeof baseProvider.getModels>) =>
        baseProvider.getModels(...args).map((model) => ({ ...model, api: providerApi })),
    streamSimple: (...args: Parameters<typeof baseProvider.streamSimple>) => {
        providerDispatchCount += 1;
        appendMarker(markers, "provider-dispatch");

        if (mode === "pause-after-provider-dispatch" && providerDispatchCount === 1) {
            writeOutput("UNKNOWN-PROVIDER-DISPATCH:", { attempt: providerDispatchCount });
            parkProcess();
        }

        if (mode === "stop-during-review") {
            const [model, , options] = args;
            const signal = options?.signal;

            if (signal === undefined) {
                throw new Error("The native Review provider did not receive its abort signal");
            }

            const stream = createAssistantMessageEventStream();
            const message = {
                ...fauxAssistantMessage("The owner selected stop during the scripted native turn."),
                api: model.api,
                provider: model.provider,
                model: model.id,
            };

            const finishAfterStop = () => {
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
            };

            if (signal.aborted) {
                finishAfterStop();
            } else {
                signal.addEventListener("abort", finishAfterStop, { once: true });
            }

            writeOutput("PROVIDER-DISPATCHED:", { attempt: providerDispatchCount });
            resolveProviderDispatch();

            return stream;
        }

        return baseProvider.streamSimple(...args);
    },
};

models.setProvider(provider);

if (scenario === "read-tool-recovery") {
    const readToolResponse = fauxAssistantMessage(
        [fauxToolCall("read", {}, { id: "review-read-recovery-read" })],
        { stopReason: "toolUse" },
    );
    const forbiddenToolResponse = fauxAssistantMessage(
        [
            fauxToolCall(
                "mutate",
                { label: "must-not-mutate" },
                { id: "review-read-recovery-mutate" },
            ),
            fauxToolCall(
                "delegate",
                { label: "must-not-delegate" },
                { id: "review-read-recovery-delegate" },
            ),
        ],
        { stopReason: "toolUse" },
    );
    const finalReviewResponse = fauxAssistantMessage(
        [
            fauxToolCall(workflowRuntime.WORKFLOW_REVIEW_RESULT.toolName, decisionA, {
                id: "review-read-recovery-result",
            }),
        ],
        { stopReason: "toolUse" },
    );

    faux.setResponses(
        mode === "recover"
            ? [forbiddenToolResponse, finalReviewResponse]
            : [readToolResponse, forbiddenToolResponse, finalReviewResponse],
    );
} else {
    const responses =
        scenario === "blocked-wait"
            ? mode === "recover"
                ? [decisionB]
                : [decisionBlocked]
            : scenario === "repair-continuation"
              ? mode === "pause-after-second-native-result"
                  ? [decisionChangesRequired, decisionB]
                  : [decisionB]
              : scenario === "stale-revision" && mode === "recover"
                ? [decisionB]
                : [decisionA];

    faux.setResponses(
        responses.map((response, index) =>
            fauxAssistantMessage(
                [
                    fauxToolCall(workflowRuntime.WORKFLOW_REVIEW_RESULT.toolName, response, {
                        id: `review-result-cold-recovery-${index + 1}`,
                    }),
                ],
                { stopReason: "toolUse" },
            ),
        ),
    );
}

const model = models.getModel("faux", "faux-1");

if (model === undefined) {
    throw new Error("The faux Review model is unavailable");
}

const registry = createRegistry();
const reviewToolsExtensionName = "review-cold-recovery-tools";
const readTool = defineTool({
    name: "read",
    description: "Read the audited cold-recovery fixture value.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
        appendEffect("read-execute");

        if (mode === "pause-before-read-tool") {
            writeOutput("SAFE-READ-EXECUTING:", { tool: "read" });
            parkProcess();
        }

        return { content: [{ type: "text", text: "audited cold-recovery value" }] };
    },
});
const mutationTool = defineTool({
    name: "mutate",
    description: "Mutation sentinel that must remain unavailable to Review.",
    parameters: Type.Object({ label: Type.String() }),
    replay: "unsafe",
    async execute() {
        appendEffect("mutation-execute");

        return { content: [{ type: "text", text: "unexpected mutation" }] };
    },
});
const delegationTool = defineTool({
    name: "delegate",
    description: "Delegation sentinel that must remain unavailable to Review.",
    parameters: Type.Object({ label: Type.String() }),
    replay: "unsafe",
    async execute() {
        appendEffect("delegation-execute");

        return { content: [{ type: "text", text: "unexpected delegation" }] };
    },
});
const reviewToolsExtension = defineExtension({
    name: reviewToolsExtensionName,
    tools: [readTool, mutationTool, delegationTool],
});

registry.install(reviewToolsExtension);

const authority =
    scenario === "read-tool-recovery"
        ? {
              extensions: [reviewToolsExtensionName],
              sections: [],
              tools: ["read"],
              capabilities: ["filesystem.read"],
          }
        : { extensions: [], sections: [], tools: [], capabilities: [] };
const hostAuthority =
    scenario === "read-tool-recovery"
        ? {
              extensions: [reviewToolsExtensionName],
              sections: [],
              tools: ["read", "mutate", "delegate"],
              capabilities: ["filesystem.read", "filesystem.write", "agent.delegate"],
          }
        : undefined;
const profile = {
    id: profileId,
    version: 1,
    instructions: "Assess only the exact supplied verification evidence.",
    instructionsVersion: "review-cold-recovery-instructions-v1",
    model: {
        provider: "faux",
        modelId: "faux-1",
        api: model.api,
        providerVersion: "review-cold-recovery-provider-v1",
    },
    ...(scenario === "read-tool-recovery"
        ? {
              extensions: [{ name: reviewToolsExtensionName, version: "review-read-tools-v1" }],
              tools: [
                  {
                      name: "read",
                      extension: reviewToolsExtensionName,
                      version: "review-read-tool-v1",
                      capabilities: ["filesystem.read"],
                  },
              ],
              capabilities: ["filesystem.read"],
          }
        : {}),
    result: workflowRuntime.WORKFLOW_REVIEW_RESULT,
};
const runtime = workflowRuntime.createWorkflowAgentRuntime({
    harnessOptions: { models, registry },
    agentConfig: {
        profiles: [profile],
        ...(hostAuthority === undefined ? {} : { authority: hostAuthority }),
        review: { profileAllowlist: [profileId], authority },
    },
});

registry.install(runtime.extension);

const adapters: ReviewAdapters = {
    workspace: {
        async snapshot() {
            if (workspacePath === undefined) {
                return { ...revision };
            }

            return JSON.parse(await readFile(workspacePath, "utf8")) as typeof revision;
        },
    },
    safety: {
        async assertQuiescent(request: { readonly phase: string }) {
            return {
                state: "quiescent" as const,
                assuranceId: `review-cold-recovery-${request.phase}`,
            };
        },
    },
};

async function durableReview(
    workflowContext: WorkflowContext<null>,
    operationId: string,
    request: ReviewRequest,
): Promise<ReviewResult> {
    const saved = await workflowContext.step.do<JsonValue>(
        operationId,
        async () =>
            (await workflowRuntime.review(
                workflowContext,
                request,
                adapters,
            )) as unknown as JsonValue,
        { interrupted: "retry" },
    );

    return saved as unknown as ReviewResult;
}

async function durableVerification(
    workflowContext: WorkflowContext<null>,
    operationId: string,
    effect: string,
    result: VerificationResult,
): Promise<VerificationResult> {
    const saved = await workflowContext.step.do<JsonValue>(
        operationId,
        () => {
            appendEffect(effect);

            return result as unknown as JsonValue;
        },
        { interrupted: "retry" },
    );

    return saved as unknown as VerificationResult;
}

const workflow = defineWorkflow({
    id: "workflow-review-cold-recovery",
    version: 1,
    async run(workflowContext: WorkflowContext<null>): Promise<JsonValue> {
        if (workflowContext.agent === undefined) {
            throw new Error("Target 3 did not bind an agent context");
        }

        const originalAgent = workflowContext.agent;
        const resolvedProfile = (await originalAgent.resolveProfile(
            profileId,
        )) as unknown as WorkflowAgentReviewProfileDescriptor;
        const verificationA: VerificationResult =
            scenario !== "single-review"
                ? await durableVerification(
                      workflowContext,
                      "review-verification-a",
                      "verification-a",
                      verification,
                  )
                : verification;
        const requestA: ReviewRequest = {
            gateId,
            threadId,
            turnId,
            reviewerProfile: profileId,
            reviewerIdentity: workflowRuntime.createReviewReviewerIdentity(resolvedProfile),
            workspaceRevision: revision,
            verification: verificationA,
            scope: "Review only the cold-recovery fixture evidence.",
        };

        if (mode === "pause-before-review-binding") {
            writeOutput("BEFORE-REVIEW-BINDING:", requestA);
            parkProcess();
        }

        let reviewContext = workflowContext;

        if (
            mode === "pause-before-native-dispatch" ||
            mode === "stop-during-review" ||
            mode === "pause-after-native-result" ||
            mode === "pause-after-second-native-result" ||
            (mode === "recover" && scenario === "stale-revision")
        ) {
            const interceptedAgent = {
                ...originalAgent,
                async turn(input: Parameters<typeof originalAgent.turn>[0]) {
                    if (mode === "pause-before-native-dispatch") {
                        writeOutput("BEFORE-NATIVE-DISPATCH:", input);
                        parkProcess();
                    }

                    if (mode === "stop-during-review") {
                        const nativeResult = originalAgent.turn(input);

                        await providerDispatchReady;
                        writeOutput("REVIEW-TURN-PENDING:", input);

                        return await nativeResult;
                    }

                    const nativeResult = await originalAgent.turn(input);

                    if (mode === "pause-after-native-result") {
                        writeOutput("NATIVE-TURN-RESULT:", nativeResult);
                        parkProcess();
                    }

                    const requestedTurnId =
                        input !== null && typeof input === "object" && !Array.isArray(input)
                            ? (input as Record<string, unknown>).turnId
                            : undefined;

                    if (
                        mode === "pause-after-second-native-result" &&
                        requestedTurnId === "review-turn-cold-recovery-2"
                    ) {
                        writeOutput("SECOND-NATIVE-TURN-RESULT:", nativeResult);
                        parkProcess();
                    }

                    if (
                        mode === "recover" &&
                        scenario === "stale-revision" &&
                        requestedTurnId === turnId
                    ) {
                        persistWorkspaceRevision(revisionB);
                        writeOutput("NATIVE-TURN-REPLAYED:", nativeResult);
                    }

                    return nativeResult;
                },
            };

            reviewContext = { ...workflowContext, agent: interceptedAgent };
        }

        if (scenario === "blocked-wait") {
            const blocked = await durableReview(reviewContext, "consumer-review-blocked", requestA);

            if (blocked.decision.verdict !== "BLOCKED") {
                throw new Error(`Expected a BLOCKED Review, received ${blocked.decision.verdict}`);
            }

            writeOutput("BLOCKED-VERDICT:", blocked);
            const received = await workflowContext.step.waitForEvent(
                guidanceWaitId,
                guidanceEventType,
            );
            const guidance = await workflowContext.step.do("consumer-guidance-receipt", () => {
                appendEffect("guidance-consumed");

                return received;
            });
            const repair = await workflowContext.step.do("consumer-guidance-repair", () => {
                persistWorkspaceRevision(revisionB);
                appendEffect("repair-after-guidance");

                return { repaired: true };
            });
            const freshRevision = await adapters.workspace.snapshot();
            const verificationB = await durableVerification(
                workflowContext,
                "consumer-verify-after-guidance",
                "verification-b",
                {
                    ...verification,
                    verificationId: "review-cold-recovery-verification-b",
                    requestDigest: "d".repeat(64),
                    workspaceId: freshRevision.workspaceId,
                    subjectRevision: freshRevision.digest,
                },
            );
            const requestB: ReviewRequest = {
                ...requestA,
                turnId: "review-turn-cold-recovery-2",
                workspaceRevision: freshRevision,
                verification: verificationB,
            };
            const second = await durableReview(
                reviewContext,
                "consumer-review-after-guidance",
                requestB,
            );

            return {
                blocked,
                guidance,
                repair,
                revisionB: freshRevision,
                verificationB,
                second,
            } as unknown as JsonValue;
        }

        if (scenario === "repair-continuation") {
            const first = await durableReview(reviewContext, "consumer-review-pass-a", requestA);

            if (first.decision.verdict !== "CHANGES_REQUIRED") {
                throw new Error(
                    `Expected a bounded repair finding, received ${first.decision.verdict}`,
                );
            }

            const repair = await workflowContext.step.do("consumer-implementer-repair", () => {
                persistWorkspaceRevision(revisionB);
                appendEffect("repair");

                return { repaired: true };
            });
            const freshRevision = await adapters.workspace.snapshot();
            const verificationB = await durableVerification(
                workflowContext,
                "consumer-verify-revision-b",
                "verification-b",
                {
                    ...verification,
                    verificationId: "review-cold-recovery-verification-b",
                    requestDigest: "d".repeat(64),
                    workspaceId: freshRevision.workspaceId,
                    subjectRevision: freshRevision.digest,
                },
            );
            const requestB: ReviewRequest = {
                ...requestA,
                turnId: "review-turn-cold-recovery-2",
                workspaceRevision: freshRevision,
                verification: verificationB,
            };
            const second = await durableReview(reviewContext, "consumer-review-pass-b", requestB);

            return {
                first,
                second,
                freshRevision,
                verificationA,
                verificationB,
                repair,
            } as unknown as JsonValue;
        }

        if (scenario === "cross-gate-owner") {
            const first = await durableReview(
                reviewContext,
                "consumer-owner-first-review",
                requestA,
            );
            const otherGateRequest: ReviewRequest = {
                ...requestA,
                gateId: "review-gate-cold-recovery-other",
                turnId: "review-turn-cold-recovery-other",
            };
            let rejection = "";

            try {
                await durableReview(
                    reviewContext,
                    "consumer-owner-second-review",
                    otherGateRequest,
                );
            } catch (error) {
                rejection = String(error);
            }

            if (
                !/Reviewer thread is already reserved for a different Review gate/i.test(rejection)
            ) {
                throw new Error(`Cross-gate thread reuse was not rejected: ${rejection}`);
            }

            writeOutput("CROSS-GATE-REJECTED:", { message: rejection, first });

            return { message: rejection, first } as unknown as JsonValue;
        }

        if (scenario === "stale-revision") {
            let staleFailure = "";

            try {
                await workflowRuntime.review(reviewContext, requestA, adapters);
            } catch (error) {
                staleFailure = String(error);
            }

            if (!/revision changed before promotion/i.test(staleFailure)) {
                throw new Error(`Revision A was not fenced at promotion: ${staleFailure}`);
            }

            const freshRevision = await adapters.workspace.snapshot();
            const verificationB = await durableVerification(
                workflowContext,
                "review-verification-b",
                "verification-b",
                {
                    ...verification,
                    verificationId: "review-cold-recovery-verification-b",
                    requestDigest: "d".repeat(64),
                    workspaceId: freshRevision.workspaceId,
                    subjectRevision: freshRevision.digest,
                },
            );
            const requestB: ReviewRequest = {
                ...requestA,
                turnId: "review-turn-cold-recovery-2",
                workspaceRevision: freshRevision,
                verification: verificationB,
            };
            const second = await workflowRuntime.review(reviewContext, requestB, adapters);

            return {
                staleFailure,
                verificationA,
                revisionB: freshRevision,
                verificationB,
                second,
            } as unknown as JsonValue;
        }

        const result = await workflowRuntime.review(reviewContext, requestA, adapters);

        if (mode === "pause-after-review-receipt") {
            writeOutput("REVIEW-RECEIPT:", result);
            parkProcess();
        }

        return result as unknown as JsonValue;
    },
});

runtime.register(workflow);
const storage = await openNodeSqliteStorage(database);
const host = await runtime.openHost(storage, context, () => undefined);

async function announceBlockedWait(): Promise<void> {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
        const inspection = await runtime.engine.inspect(runId, context);

        if (inspection.status === "waiting" && inspection.current?.waitId === guidanceWaitId) {
            writeOutput("BLOCKED-WAIT-READY:", inspection);

            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Workflow did not park on ${guidanceWaitId}`);
}

if (scenario === "blocked-wait" || mode === "stop-during-review") {
    process.stdin.setEncoding("utf8");
    let input = "";

    process.stdin.on("data", (chunk: string) => {
        input += chunk;

        while (input.includes("\n")) {
            const end = input.indexOf("\n");
            const line = input.slice(0, end);

            input = input.slice(end + 1);

            if (line.length === 0) {
                continue;
            }

            try {
                const control = JSON.parse(line) as {
                    readonly command?: string;
                    readonly reason?: string;
                    readonly id?: string;
                    readonly type?: string;
                    readonly payload?: unknown;
                };

                if (mode === "stop-during-review" && control.command === "stop") {
                    void runtime.engine
                        .stop(runId, control.reason ?? "Stopped by recovery fixture", context)
                        .then(() => writeOutput("STOP-SELECTED:", { runId }))
                        .catch((error: unknown) =>
                            writeOutput("STOP-ERROR:", { message: String(error) }),
                        );
                } else if (
                    scenario === "blocked-wait" &&
                    typeof control.id === "string" &&
                    typeof control.type === "string" &&
                    control.payload !== undefined
                ) {
                    const event = {
                        id: control.id,
                        type: control.type,
                        payload: control.payload as JsonValue,
                    };

                    void runtime.engine
                        .sendEvent(runId, event, context)
                        .then((accepted) =>
                            writeOutput("EVENT-SENT:", { accepted, eventId: event.id }),
                        )
                        .catch((error: unknown) =>
                            writeOutput("EVENT-ERROR:", { message: String(error) }),
                        );
                } else {
                    writeOutput("CONTROL-ERROR:", { message: "Unsupported worker control" });
                }
            } catch (error) {
                writeOutput("EVENT-ERROR:", { message: String(error) });
            }
        }
    });
}

if (mode === "stop-during-review") {
    await runtime.engine.start(workflow, null, { runId }, context);

    try {
        const result = await runtime.engine.wait(runId, context);

        writeOutput("RESURRECTED-RESULT:", result);
    } catch (error) {
        if (!(error instanceof Error) || error.name !== "WorkflowStoppedError") {
            throw error;
        }

        writeOutput("STOPPED:", { name: error.name, message: error.message });
    }

    await host.dispose();
    await runtime.close();
    await host.harness.close(context);
} else if (mode === "recover-stopped") {
    try {
        const result = await runtime.engine.wait(runId, context);

        writeOutput("RESURRECTED-RESULT:", result);

        throw new Error("A selected Review stop returned a result after cold reopen");
    } catch (error) {
        if (!(error instanceof Error) || error.name !== "WorkflowStoppedError") {
            throw error;
        }

        writeOutput("REOPENED-STOPPED:", { name: error.name, message: error.message });
    }

    await host.dispose();
    await runtime.close();
    await host.harness.close(context);
} else if (
    mode === "blocked-wait" ||
    mode === "pause-after-review-receipt" ||
    mode === "pause-after-provider-dispatch" ||
    mode === "pause-before-review-binding" ||
    mode === "pause-before-native-dispatch" ||
    mode === "pause-after-native-result" ||
    mode === "pause-after-second-native-result" ||
    mode === "pause-before-read-tool"
) {
    await runtime.engine.start(workflow, null, { runId }, context);

    if (scenario === "blocked-wait") {
        await announceBlockedWait();
    }

    await new Promise(() => undefined);
} else if (mode === "recover") {
    const resultPromise = runtime.engine.wait(runId, context);

    if (scenario === "blocked-wait") {
        await announceBlockedWait();
    }

    const result = await resultPromise;
    const output =
        scenario !== "single-review"
            ? {
                  result,
                  thread: await host.harness.snapshot(
                      workflowRuntime.AGENT_THREAD_DOC,
                      workflowRuntime.workflowAgentThreadKey({ runId, threadId, profileId }),
                      context,
                  ),
              }
            : result;

    writeOutput("FINAL:", output);
    await host.dispose();
    await runtime.close();
    await host.harness.close(context);
} else {
    throw new Error(`Unsupported recovery mode ${mode}`);
}
