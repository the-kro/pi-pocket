import type { VerificationResult, WorkspaceRevision } from "../verification/types.ts";

/** A bounded, concrete issue that an implementer can address in the required artifact. */
export interface Finding {
    id: string;
    description: string;
    evidence: string;
    requiredChange: string;
}

/** The complete set of decisions available to the Review contract. */
export type ReviewDecision =
    | { verdict: "APPROVED"; summary: string }
    | { verdict: "CHANGES_REQUIRED"; summary: string; findings: Finding[] }
    | { verdict: "BLOCKED"; summary: string; reason: string };

/** Runtime-resolved identity of the configured, schema-bound reviewer profile for one Review pass. */
export interface ReviewReviewerIdentity {
    profileId: string;
    profileVersion: number;
    profileFingerprint: string;
    modelFingerprint: string;
    authorityFingerprint: string;
    policyFingerprint: string;
    instructionsVersion: string;
    instructionsFingerprint: string;
    resultSchemaId: string;
    resultSchemaVersion: string;
    resultSchemaFingerprint: string;
    fingerprint: string;
    resultPolicy: "structured-result-required-v1";
}

/** Caller-owned identity, trusted reviewer snapshot, exact verification, and scope for one pass. */
export interface ReviewRequest {
    gateId: string;
    threadId: string;
    turnId: string;
    reviewerProfile: string;
    reviewerIdentity: ReviewReviewerIdentity;
    workspaceRevision: WorkspaceRevision;
    verification: VerificationResult;
    scope: string;
}

/** Stable operation and request identity derived from one validated Review request. */
export interface ReviewBinding {
    gateId: string;
    threadId: string;
    turnId: string;
    operationId: string;
    reviewerProfile: string;
    reviewerIdentity: ReviewReviewerIdentity;
    workspaceId: string;
    subjectRevision: string;
    verificationId: string;
    verificationRequestDigest: string;
    requestDigest: string;
}

/** Historical decision evidence for exactly one bound Review pass. */
export interface ReviewResult extends ReviewBinding {
    decision: ReviewDecision;
}
