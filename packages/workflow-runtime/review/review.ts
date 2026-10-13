/** Run one revision-bound, schema-settled Review pass through the workflow agent adapter. */
import { createHash } from "node:crypto";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import type {
    WorkflowAgentResultBinding,
    WorkflowAgentReviewIdentity,
    WorkflowAgentReviewProfileDescriptor,
} from "../agents/profile.ts";
import { workflowAgentResultSchemaFingerprint } from "../agents/profile.ts";
import {
    ReviewRequestConflict,
    assertReviewBindingUnchanged,
    createReviewBinding,
    createReviewResult,
    validateReviewDecision,
    validateReviewResult,
} from "./contract.ts";
import type { WorkflowContext } from "../core/index.ts";
import type { ReviewRequest, ReviewResult } from "./types.ts";
import type { WorkspaceRevision, WorkspaceSafetyAdapter } from "../verification/types.ts";

const MAX_ASSURANCE_ID_BYTES = 256;
const REVIEW_GATE_BINDING_VERSION = 1;
const REVIEW_THREAD_OWNER_VERSION = 1;
const REVIEW_REQUEST_VERSION = 1;

const REVIEW_FINDING_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        description: { type: "string", minLength: 1, maxLength: 1_024 },
        evidence: { type: "string", minLength: 1, maxLength: 2_048 },
        requiredChange: { type: "string", minLength: 1, maxLength: 1_024 },
    },
    required: ["id", "description", "evidence", "requiredChange"],
    additionalProperties: false,
};
const REVIEW_DECISION_SCHEMA: JsonValue = {
    type: "object",
    properties: {
        verdict: {
            type: "string",
            enum: ["APPROVED", "CHANGES_REQUIRED", "BLOCKED"],
        },
        summary: { type: "string", minLength: 1, maxLength: 2_048 },
        findings: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: REVIEW_FINDING_SCHEMA,
        },
        reason: { type: "string", minLength: 1, maxLength: 2_048 },
    },
    required: ["verdict", "summary"],
    additionalProperties: false,
};

/** Exact schema-bound result tool that must be configured on the reviewer profile. */
export const WORKFLOW_REVIEW_RESULT: WorkflowAgentResultBinding = {
    id: "workflow-review-decision",
    version: "1",
    toolName: "submit_workflow_review_decision",
    schema: REVIEW_DECISION_SCHEMA,
};

/** Build the contract's expected identity from a Target 3 runtime-resolved reviewer descriptor. */
export function createReviewReviewerIdentity(
    descriptor: WorkflowAgentReviewProfileDescriptor,
): ReviewRequest["reviewerIdentity"] {
    const { identity, profile, instructions, model, authority, result } = descriptor;
    const resultSchemaFingerprint = workflowAgentResultSchemaFingerprint(WORKFLOW_REVIEW_RESULT);

    if (
        profile.id !== identity.profileId ||
        !Number.isSafeInteger(profile.version) ||
        profile.version < 1 ||
        authority.delegation !== false ||
        model.fingerprint !== identity.modelFingerprint ||
        !isSha256(identity.profileFingerprint) ||
        !isSha256(identity.modelFingerprint) ||
        !isSha256(identity.authorityFingerprint) ||
        !isSha256(identity.policyFingerprint) ||
        !isSha256(identity.fingerprint) ||
        typeof instructions.text !== "string" ||
        typeof instructions.version !== "string" ||
        instructions.version.length === 0 ||
        result === undefined ||
        result.id !== WORKFLOW_REVIEW_RESULT.id ||
        result.version !== WORKFLOW_REVIEW_RESULT.version ||
        result.toolName !== WORKFLOW_REVIEW_RESULT.toolName ||
        canonicalJson(result.schema) !== canonicalJson(WORKFLOW_REVIEW_RESULT.schema) ||
        result.fingerprint !== resultSchemaFingerprint ||
        identity.resultSchemaFingerprint !== resultSchemaFingerprint
    ) {
        throw new ReviewAdmissionError(
            "Runtime-resolved profile is not the exact read-only, schema-bound Review profile",
        );
    }

    return Object.freeze({
        profileId: identity.profileId,
        profileVersion: profile.version,
        profileFingerprint: identity.profileFingerprint,
        modelFingerprint: identity.modelFingerprint,
        authorityFingerprint: identity.authorityFingerprint,
        policyFingerprint: identity.policyFingerprint,
        instructionsVersion: instructions.version,
        instructionsFingerprint: digest(instructions.text),
        resultSchemaId: result.id,
        resultSchemaVersion: result.version,
        resultSchemaFingerprint: resultSchemaFingerprint,
        fingerprint: identity.fingerprint,
        resultPolicy: "structured-result-required-v1",
    });
}

export interface ReviewAdapters {
    readonly workspace: {
        snapshot(): Promise<WorkspaceRevision>;
    };
    readonly safety: WorkspaceSafetyAdapter;
}

interface ReviewGateBinding {
    readonly schemaVersion: number;
    readonly gateId: string;
    readonly threadId: string;
    readonly reviewerProfile: string;
    readonly reviewerIdentity: ReviewRequest["reviewerIdentity"];
    readonly firstTurnId: string;
    readonly scope: string;
    readonly scopeDigest: string;
}

interface ReviewThreadOwnerBinding {
    readonly schemaVersion: number;
    readonly gateId: string;
    readonly threadId: string;
    readonly reviewerProfile: string;
    readonly reviewerIdentity: ReviewRequest["reviewerIdentity"];
    readonly firstTurnId: string;
}

interface InvocationReviewState {
    readonly gateBindings: Map<string, Promise<JsonValue>>;
    readonly threadOwners: Map<string, Promise<JsonValue>>;
    readonly turnBindings: Map<string, Promise<JsonValue>>;
    readonly results: Map<string, Promise<JsonValue>>;
}

const invocationReviewStates = new WeakMap<object, InvocationReviewState>();

/** Throw an execution error (never a verdict) when Review admission or promotion is unprovable. */
export class ReviewAdmissionError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReviewAdmissionError";
    }
}

/**
 * Persist and execute one exact structured Review pass. The caller owns Verify, repair, waits, and
 * continuation; this helper only admits one reviewer turn and promotes its revision-bound result.
 */
export async function review<I extends JsonValue>(
    context: WorkflowContext<I>,
    request: ReviewRequest,
    adapters: ReviewAdapters,
): Promise<ReviewResult> {
    assertActive(context.signal);

    if (
        context.agent === undefined ||
        typeof context.agent.turn !== "function" ||
        typeof context.agent.resolveProfile !== "function"
    ) {
        throw new ReviewAdmissionError(
            "Review requires Target 3 runtime-owned profile resolution and turn admission",
        );
    }

    const stableRequest = freezeJsonValue(
        copyJson(request as unknown as JsonValue),
    ) as unknown as ReviewRequest;

    assertResultSchema(stableRequest);

    let resolvedProfile: WorkflowAgentReviewProfileDescriptor;

    try {
        resolvedProfile = (await context.agent.resolveProfile(
            stableRequest.reviewerProfile,
        )) as unknown as WorkflowAgentReviewProfileDescriptor;
    } catch (error) {
        throw new ReviewAdmissionError("The configured Review profile could not be resolved", {
            cause: error,
        });
    }

    const resolvedIdentity = createReviewReviewerIdentity(resolvedProfile);

    if (canonicalJson(resolvedIdentity) !== canonicalJson(stableRequest.reviewerIdentity)) {
        throw new ReviewAdmissionError(
            "Caller-supplied reviewerIdentity does not match the runtime-resolved reviewer identity",
        );
    }

    const binding = createReviewBinding(stableRequest);
    const gateBinding = createGateBinding(stableRequest);
    const invocation = invocationReviewState(context.step);
    const frozenGate = await memoizedStep(invocation.gateBindings, stableRequest.gateId, () =>
        context.step.do<JsonValue>(
            gateOperationId(stableRequest.gateId),
            () => gateBinding as unknown as JsonValue,
            { interrupted: "retry" },
        ),
    );

    const stableGate = assertGateBindingUnchanged(frozenGate, gateBinding, binding.operationId);

    assertActive(context.signal);

    const threadOwner = createThreadOwnerBinding(stableGate);
    const threadOwnerId = threadOwnerOperationId(stableGate.threadId, stableGate.reviewerProfile);
    const frozenThreadOwner = await memoizedStep(invocation.threadOwners, threadOwnerId, () =>
        context.step.do<JsonValue>(threadOwnerId, () => threadOwner as unknown as JsonValue, {
            interrupted: "retry",
        }),
    );

    assertThreadOwnerUnchanged(frozenThreadOwner, threadOwner, threadOwnerId);
    assertActive(context.signal);

    const frozenTurn = await memoizedStep(invocation.turnBindings, binding.operationId, () =>
        context.step.do<JsonValue>(
            phaseOperationId("binding", binding.operationId),
            () => binding as unknown as JsonValue,
            { interrupted: "retry" },
        ),
    );

    assertReviewBindingUnchanged(frozenTurn, binding);
    assertActive(context.signal);

    const admissionAssuranceId = await assertCurrentWorkspace(
        context.signal,
        stableRequest,
        adapters,
        "admission",
    );
    const requestContent = makeReviewerInput(stableRequest);
    const saved = await memoizedStep(invocation.results, binding.operationId, () =>
        context.step.do<JsonValue>(
            phaseOperationId("result", binding.operationId),
            async () => {
                assertActive(context.signal);

                const nativeResult = await context.agent!.turn({
                    threadId: stableRequest.threadId,
                    turnId: stableRequest.turnId,
                    profile: stableRequest.reviewerProfile,
                    content: requestContent,
                    purpose: "review",
                    reviewerIdentity: resolvedProfile.identity as WorkflowAgentReviewIdentity,
                    freshThread: stableRequest.turnId === stableGate.firstTurnId,
                });

                assertActive(context.signal);

                const decision = validateReviewDecision(nativeResult);

                return createReviewResult(stableRequest, decision) as unknown as JsonValue;
            },
            { interrupted: "retry" },
        ),
    );

    validateReviewResult(saved, stableRequest);
    await assertCurrentWorkspace(
        context.signal,
        stableRequest,
        adapters,
        "promotion",
        admissionAssuranceId,
    );

    return saved as unknown as ReviewResult;
}

function freezeJsonValue<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) {
            freezeJsonValue(nested);
        }

        Object.freeze(value);
    }

    return value;
}

function invocationReviewState(step: object): InvocationReviewState {
    const existing = invocationReviewStates.get(step);

    if (existing !== undefined) {
        return existing;
    }

    const created: InvocationReviewState = {
        gateBindings: new Map(),
        threadOwners: new Map(),
        turnBindings: new Map(),
        results: new Map(),
    };

    invocationReviewStates.set(step, created);

    return created;
}

async function memoizedStep(
    records: Map<string, Promise<JsonValue>>,
    key: string,
    run: () => Promise<JsonValue>,
): Promise<JsonValue> {
    let result = records.get(key);

    if (result === undefined) {
        result = run().then((value) => copyJson(value));
        records.set(key, result);
    }

    return copyJson(await result);
}

function assertResultSchema(request: ReviewRequest): void {
    const identity = request.reviewerIdentity;
    const fingerprint = workflowAgentResultSchemaFingerprint(WORKFLOW_REVIEW_RESULT);

    if (
        identity.resultSchemaId !== WORKFLOW_REVIEW_RESULT.id ||
        identity.resultSchemaVersion !== WORKFLOW_REVIEW_RESULT.version ||
        identity.resultSchemaFingerprint !== fingerprint ||
        identity.resultPolicy !== "structured-result-required-v1"
    ) {
        throw new ReviewAdmissionError(
            "Reviewer profile must use the exact schema-bound Workflow Review result contract",
        );
    }
}

function createGateBinding(request: ReviewRequest): ReviewGateBinding {
    return Object.freeze({
        schemaVersion: REVIEW_GATE_BINDING_VERSION,
        gateId: request.gateId,
        threadId: request.threadId,
        reviewerProfile: request.reviewerProfile,
        reviewerIdentity: request.reviewerIdentity,
        firstTurnId: request.turnId,
        scope: request.scope,
        scopeDigest: digest(request.scope),
    });
}

function createThreadOwnerBinding(gate: ReviewGateBinding): ReviewThreadOwnerBinding {
    return Object.freeze({
        schemaVersion: REVIEW_THREAD_OWNER_VERSION,
        gateId: gate.gateId,
        threadId: gate.threadId,
        reviewerProfile: gate.reviewerProfile,
        reviewerIdentity: gate.reviewerIdentity,
        firstTurnId: gate.firstTurnId,
    });
}

function assertThreadOwnerUnchanged(
    previous: unknown,
    current: ReviewThreadOwnerBinding,
    operationId: string,
): void {
    if (canonicalJson(previous) !== canonicalJson(current)) {
        throw new ReviewAdmissionError(
            "Reviewer thread is already reserved for a different Review gate",
        );
    }

    if (current.schemaVersion !== REVIEW_THREAD_OWNER_VERSION) {
        throw new ReviewAdmissionError(
            `Unsupported reviewer thread owner version at ${operationId}`,
        );
    }
}

function assertGateBindingUnchanged(
    previous: unknown,
    current: ReviewGateBinding,
    operationId: string,
): ReviewGateBinding {
    if (
        previous === null ||
        typeof previous !== "object" ||
        Array.isArray(previous) ||
        typeof (previous as { readonly firstTurnId?: unknown }).firstTurnId !== "string"
    ) {
        throw new ReviewRequestConflict(operationId);
    }

    const previousGate = previous as ReviewGateBinding;
    const candidate = { ...current, firstTurnId: previousGate.firstTurnId };

    if (canonicalJson(previousGate) !== canonicalJson(candidate)) {
        throw new ReviewRequestConflict(operationId);
    }

    return previousGate;
}

async function assertCurrentWorkspace(
    signal: AbortSignal,
    request: ReviewRequest,
    adapters: ReviewAdapters,
    phase: "admission" | "promotion",
    priorAssuranceId?: string,
): Promise<string> {
    assertActive(signal);

    let current: WorkspaceRevision;

    try {
        current = await adapters.workspace.snapshot();
    } catch (error) {
        assertActive(signal);

        throw new ReviewAdmissionError("Review workspace snapshot could not be established", {
            cause: error,
        });
    }

    assertActive(signal);

    if (!sameRevision(current, request.workspaceRevision)) {
        throw new ReviewAdmissionError(
            `Review workspace revision changed before ${phase}; fresh Verify and a new review turn are required`,
        );
    }

    let assurance;

    try {
        assurance = await adapters.safety.assertQuiescent({
            phase,
            verificationId: request.verification.verificationId,
            workspaceId: request.workspaceRevision.workspaceId,
            subjectRevision: request.workspaceRevision.digest,
            ...(priorAssuranceId === undefined ? {} : { priorAssuranceId }),
        });
    } catch (error) {
        assertActive(signal);

        throw new ReviewAdmissionError(`Review workspace safety is unavailable at ${phase}`, {
            cause: error,
        });
    }

    assertActive(signal);

    if (
        assurance === null ||
        typeof assurance !== "object" ||
        assurance.state !== "quiescent" ||
        typeof assurance.assuranceId !== "string" ||
        assurance.assuranceId.trim().length === 0 ||
        Buffer.byteLength(assurance.assuranceId, "utf8") > MAX_ASSURANCE_ID_BYTES
    ) {
        throw new ReviewAdmissionError(
            `Review workspace safety is not authoritatively quiescent at ${phase}`,
        );
    }

    return assurance.assuranceId;
}

function makeReviewerInput(request: ReviewRequest): string {
    return JSON.stringify({
        requestVersion: REVIEW_REQUEST_VERSION,
        scope: request.scope,
        workspaceRevision: request.workspaceRevision,
        verification: request.verification,
    });
}

function sameRevision(left: WorkspaceRevision, right: WorkspaceRevision): boolean {
    return (
        left !== null &&
        typeof left === "object" &&
        left.workspaceId === right.workspaceId &&
        left.digest === right.digest &&
        left.algorithm === right.algorithm &&
        left.coverage === right.coverage
    );
}

function gateOperationId(gateId: string): string {
    return `pocket-review-v1:${encodeTuple(["gate", gateId])}`;
}

function threadOwnerOperationId(threadId: string, reviewerProfile: string): string {
    return `pocket-review-v1:${encodeTuple(["thread-owner", threadId, reviewerProfile])}`;
}

function phaseOperationId(phase: string, operationId: string): string {
    return `pocket-review-v1:${encodeTuple([phase, operationId])}`;
}

function encodeTuple(values: readonly string[]): string {
    return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

function digest(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSha256(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value);
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }

    const object = value as Record<string, unknown>;

    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(",")}}`;
}

function assertActive(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason ?? new ReviewAdmissionError("Review workflow was stopped");
    }
}
