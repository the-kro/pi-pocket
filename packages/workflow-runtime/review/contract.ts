import { createHash } from "node:crypto";
import type { CheckResult, VerificationResult, WorkspaceRevision } from "../verification/types.ts";
import type {
    ReviewBinding,
    ReviewDecision,
    ReviewRequest,
    ReviewResult,
    ReviewReviewerIdentity,
} from "./types.ts";

const REQUEST_KEYS = [
    "gateId",
    "reviewerProfile",
    "reviewerIdentity",
    "scope",
    "threadId",
    "turnId",
    "verification",
    "workspaceRevision",
];
const REVISION_KEYS = ["algorithm", "coverage", "digest", "workspaceId"];
const REVIEWER_IDENTITY_KEYS = [
    "authorityFingerprint",
    "fingerprint",
    "instructionsFingerprint",
    "instructionsVersion",
    "modelFingerprint",
    "policyFingerprint",
    "profileFingerprint",
    "profileId",
    "profileVersion",
    "resultPolicy",
    "resultSchemaFingerprint",
    "resultSchemaId",
    "resultSchemaVersion",
] as const;
const VERIFICATION_KEYS = [
    "checks",
    "requestDigest",
    "status",
    "subjectRevision",
    "verificationId",
    "workspaceId",
];
const CHECK_RESULT_KEYS = [
    "checkId",
    "evidence",
    "exitCode",
    "failureCode",
    "observedOutputBytes",
    "status",
    "termination",
    "truncated",
];
const MAX_ID_BYTES = 128;
const MAX_SCOPE_BYTES = 8_192;
const MAX_VERIFICATION_CHECKS = 256;
const MAX_CHECK_EVIDENCE_BYTES = 262_144;
const MAX_VERIFICATION_EVIDENCE_BYTES = 1_048_576;
const MAX_SUMMARY_BYTES = 2_048;
const MAX_REASON_BYTES = 2_048;
const MAX_FINDINGS = 8;
const MAX_FINDING_DESCRIPTION_BYTES = 1_024;
const MAX_FINDING_EVIDENCE_BYTES = 2_048;
const MAX_FINDING_CHANGE_BYTES = 1_024;
const MAX_RESULT_BYTES = 65_536;
const REVIEW_BINDING_KEYS = [
    "gateId",
    "threadId",
    "turnId",
    "operationId",
    "reviewerProfile",
    "reviewerIdentity",
    "workspaceId",
    "subjectRevision",
    "verificationId",
    "verificationRequestDigest",
    "requestDigest",
] as const;

export class ReviewRequestConflict extends Error {
    readonly code = "review_request_conflict";
    readonly retryable = false;

    constructor(operationId: string) {
        super(`Review request ${operationId} conflicts with its frozen identity`);
        this.name = "ReviewRequestConflict";
    }
}

/** Create the canonical identity and collision-safe operation key for one Review pass. */
export function createReviewBinding(input: unknown): ReviewBinding {
    const request = validateReviewRequest(input);
    const operationId = reviewOperationId(request.gateId, request.threadId, request.turnId);
    const identity = {
        bindingVersion: 1,
        gateId: request.gateId,
        threadId: request.threadId,
        turnId: request.turnId,
        reviewerProfile: request.reviewerProfile,
        reviewerIdentity: request.reviewerIdentity,
        workspaceRevision: request.workspaceRevision,
        verification: {
            verificationId: request.verification.verificationId,
            requestDigest: request.verification.requestDigest,
            status: request.verification.status,
            workspaceId: request.verification.workspaceId,
            subjectRevision: request.verification.subjectRevision,
        },
        verificationResultDigest: hash(canonicalJson(request.verification)),
        scope: request.scope,
        resultContract: "workflow-review-v1",
    };

    return deepFreeze({
        gateId: request.gateId,
        threadId: request.threadId,
        turnId: request.turnId,
        operationId,
        reviewerProfile: request.reviewerProfile,
        reviewerIdentity: request.reviewerIdentity,
        workspaceId: request.workspaceRevision.workspaceId,
        subjectRevision: request.workspaceRevision.digest,
        verificationId: request.verification.verificationId,
        verificationRequestDigest: request.verification.requestDigest,
        requestDigest: hash(canonicalJson(identity)),
    });
}

/** Reject a reused logical turn if any part of its frozen binding changed. */
export function assertReviewBindingUnchanged(previousInput: unknown, currentInput: unknown): void {
    const previous = validateReviewBinding(previousInput);
    const current = validateReviewBinding(currentInput);

    if (
        REVIEW_BINDING_KEYS.some((key) =>
            key === "reviewerIdentity"
                ? canonicalJson(previous.reviewerIdentity) !==
                  canonicalJson(current.reviewerIdentity)
                : previous[key] !== current[key],
        )
    ) {
        throw new ReviewRequestConflict(current.operationId);
    }
}

function validateReviewBinding(input: unknown): ReviewBinding {
    const value = exactObject(input, REVIEW_BINDING_KEYS, "Review binding");
    const gateId = stableId(value.gateId, "gateId");
    const threadId = stableId(value.threadId, "threadId");
    const turnId = stableId(value.turnId, "turnId");

    if (new Set([gateId, threadId, turnId]).size !== 3) {
        throw new Error("Review gateId, threadId, and turnId must be distinct");
    }

    const expectedOperationId = reviewOperationId(gateId, threadId, turnId);
    const operationId = value.operationId;

    if (operationId !== expectedOperationId) {
        throw new Error("Review binding operationId is malformed");
    }

    const reviewerProfile = stableId(value.reviewerProfile, "reviewerProfile");
    const reviewerIdentity = validateReviewReviewerIdentity(
        value.reviewerIdentity,
        reviewerProfile,
    );

    return {
        gateId,
        threadId,
        turnId,
        operationId,
        reviewerProfile,
        reviewerIdentity,
        workspaceId: boundedText(value.workspaceId, "workspaceId", 256),
        subjectRevision: sha256Text(value.subjectRevision, "subjectRevision"),
        verificationId: stableId(value.verificationId, "verificationId"),
        verificationRequestDigest: sha256Text(
            value.verificationRequestDigest,
            "verificationRequestDigest",
        ),
        requestDigest: sha256Text(value.requestDigest, "requestDigest"),
    };
}

function validateReviewReviewerIdentity(
    input: unknown,
    expectedProfileId: string,
): ReviewReviewerIdentity {
    const value = exactObject(input, REVIEWER_IDENTITY_KEYS, "Review reviewer identity");
    const profileId = stableId(value.profileId, "reviewer identity profileId");

    if (profileId !== expectedProfileId) {
        throw new Error("Review reviewer identity profileId does not match reviewerProfile");
    }

    if (!Number.isSafeInteger(value.profileVersion) || (value.profileVersion as number) < 1) {
        throw new Error("Review reviewer profileVersion must be a positive safe integer");
    }

    if (value.resultPolicy !== "structured-result-required-v1") {
        throw new Error(
            "Review reviewer resultPolicy must require a schema-bound structured result",
        );
    }

    return {
        profileId,
        profileVersion: value.profileVersion as number,
        profileFingerprint: sha256Text(value.profileFingerprint, "reviewer profileFingerprint"),
        modelFingerprint: sha256Text(value.modelFingerprint, "reviewer modelFingerprint"),
        authorityFingerprint: sha256Text(
            value.authorityFingerprint,
            "reviewer authorityFingerprint",
        ),
        policyFingerprint: sha256Text(value.policyFingerprint, "reviewer policyFingerprint"),
        instructionsVersion: stableId(value.instructionsVersion, "instructionsVersion"),
        instructionsFingerprint: sha256Text(
            value.instructionsFingerprint,
            "reviewer instructionsFingerprint",
        ),
        resultSchemaId: stableId(value.resultSchemaId, "resultSchemaId"),
        resultSchemaVersion: stableId(value.resultSchemaVersion, "resultSchemaVersion"),
        resultSchemaFingerprint: sha256Text(
            value.resultSchemaFingerprint,
            "resultSchemaFingerprint",
        ),
        fingerprint: sha256Text(value.fingerprint, "reviewer fingerprint"),
        resultPolicy: "structured-result-required-v1",
    };
}

/** Validate a structured Review decision against the bounded verdict algebra. */
export function validateReviewDecision(input: unknown): ReviewDecision {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Review decision must be a plain object");
    }

    const verdict = (input as Record<string, unknown>).verdict;

    if (verdict !== "APPROVED" && verdict !== "CHANGES_REQUIRED" && verdict !== "BLOCKED") {
        throw new Error("Review decision has an unsupported verdict");
    }

    const keys =
        verdict === "APPROVED"
            ? ["verdict", "summary"]
            : verdict === "CHANGES_REQUIRED"
              ? ["verdict", "summary", "findings"]
              : ["verdict", "summary", "reason"];
    const value = exactObject(input, keys, "Review decision");
    const summary = boundedText(value.summary, "Review summary", MAX_SUMMARY_BYTES);

    if (verdict === "APPROVED") {
        return { verdict, summary };
    }

    if (verdict === "BLOCKED") {
        return {
            verdict,
            summary,
            reason: boundedText(value.reason, "Review blocked reason", MAX_REASON_BYTES),
        };
    }

    const findingInputs = denseArray(value.findings, "Review findings", MAX_FINDINGS);

    if (findingInputs.length === 0) {
        throw new Error("CHANGES_REQUIRED must contain a bounded non-empty findings list");
    }

    const seenFindingIds = new Set<string>();
    const findings = findingInputs.map((findingInput) => {
        const finding = exactObject(
            findingInput,
            ["id", "description", "evidence", "requiredChange"],
            "Review finding",
        );
        const id = stableId(finding.id, "finding id");

        if (seenFindingIds.has(id)) {
            throw new Error(`Review decision has duplicate finding id: ${id}`);
        }

        seenFindingIds.add(id);

        return {
            id,
            description: boundedText(
                finding.description,
                "Finding description",
                MAX_FINDING_DESCRIPTION_BYTES,
            ),
            evidence: boundedText(finding.evidence, "Finding evidence", MAX_FINDING_EVIDENCE_BYTES),
            requiredChange: boundedText(
                finding.requiredChange,
                "Finding required change",
                MAX_FINDING_CHANGE_BYTES,
            ),
        };
    });

    return { verdict, summary, findings };
}

/** Create bounded historical Review evidence for exactly the request's logical turn. */
export function createReviewResult(request: unknown, decision: unknown): ReviewResult {
    const binding = createReviewBinding(request);
    const validatedDecision = validateReviewDecision(decision);
    const result = { ...binding, decision: validatedDecision };

    assertResultSize(result);

    return deepFreeze(result);
}

/** Validate stored result data against the exact request for the pass being resumed. */
export function validateReviewResult(input: unknown, request: unknown): ReviewResult {
    const binding = createReviewBinding(request);
    const value = exactObject(input, [...REVIEW_BINDING_KEYS, "decision"], "Review result");
    const reviewerIdentity = validateReviewReviewerIdentity(
        value.reviewerIdentity,
        binding.reviewerProfile,
    );

    for (const key of REVIEW_BINDING_KEYS) {
        const supplied = key === "reviewerIdentity" ? canonicalJson(reviewerIdentity) : value[key];
        const expected =
            key === "reviewerIdentity"
                ? canonicalJson(binding.reviewerIdentity)
                : binding[key as keyof ReviewBinding];

        if (supplied !== expected) {
            throw new Error(`Review result ${key} does not match the requested pass`);
        }
    }

    const result = {
        ...binding,
        decision: validateReviewDecision(value.decision),
    };

    assertResultSize(result);

    return deepFreeze(result);
}

function assertResultSize(result: ReviewResult): void {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
        throw new Error("Review result exceeds its serialized size bound");
    }
}

function validateReviewRequest(input: unknown): ReviewRequest {
    const value = exactObject(input, REQUEST_KEYS, "Review request");
    const gateId = stableId(value.gateId, "gateId");
    const threadId = stableId(value.threadId, "threadId");
    const turnId = stableId(value.turnId, "turnId");

    if (new Set([gateId, threadId, turnId]).size !== 3) {
        throw new Error("Review gateId, threadId, and turnId must be distinct");
    }

    const reviewerProfile = stableId(value.reviewerProfile, "reviewerProfile");
    const reviewerIdentity = validateReviewReviewerIdentity(
        value.reviewerIdentity,
        reviewerProfile,
    );
    const scope = boundedText(value.scope, "Review scope", MAX_SCOPE_BYTES);
    const workspaceRevision = validateWorkspaceRevision(value.workspaceRevision);
    const verification = validateVerificationResult(value.verification);

    if (
        verification.workspaceId !== workspaceRevision.workspaceId ||
        verification.subjectRevision !== workspaceRevision.digest
    ) {
        throw new Error("Passed verification must match the exact Review workspace revision");
    }

    return {
        gateId,
        threadId,
        turnId,
        reviewerProfile,
        reviewerIdentity,
        workspaceRevision,
        verification,
        scope,
    };
}

function validateWorkspaceRevision(input: unknown): WorkspaceRevision {
    const value = exactObject(input, REVISION_KEYS, "Review workspace revision");
    const workspaceId = boundedText(value.workspaceId, "workspaceId", 256);

    if (
        !isSha256(value.digest) ||
        value.algorithm !== "sha256" ||
        value.coverage !== "git-head-index-worktree-v1"
    ) {
        throw new Error("Review workspace revision must be a supported SHA-256 snapshot");
    }

    return {
        workspaceId,
        digest: value.digest,
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };
}

function validateVerificationResult(input: unknown): VerificationResult {
    const value = exactObject(input, VERIFICATION_KEYS, "Review verification result");
    const verificationId = stableId(value.verificationId, "verificationId");
    const requestDigest = sha256Text(value.requestDigest, "verification requestDigest");
    const workspaceId = boundedText(value.workspaceId, "verification workspaceId", 256);
    const subjectRevision = sha256Text(value.subjectRevision, "verification subjectRevision");

    if (value.status !== "passed") {
        throw new Error("Review requires a passed verification result");
    }

    const checks = denseArray(value.checks, "Verification checks", MAX_VERIFICATION_CHECKS);

    if (checks.length === 0) {
        throw new Error("Passed verification must have a bounded non-empty check list");
    }

    const seenIds = new Set<string>();
    let evidenceBytes = 0;
    const validatedChecks: CheckResult[] = [];

    for (const checkInput of checks) {
        const check = validatePassedCheck(checkInput);

        if (seenIds.has(check.checkId)) {
            throw new Error("Passed verification has duplicate check IDs");
        }

        seenIds.add(check.checkId);
        evidenceBytes +=
            check.evidence === undefined ? 0 : Buffer.byteLength(check.evidence, "utf8");

        if (evidenceBytes > MAX_VERIFICATION_EVIDENCE_BYTES) {
            throw new Error("Passed verification evidence exceeds the Review input bound");
        }

        validatedChecks.push(check);
    }

    return {
        verificationId,
        requestDigest,
        workspaceId,
        subjectRevision,
        status: "passed",
        checks: validatedChecks,
    };
}

function validatePassedCheck(input: unknown): CheckResult {
    const value = exactObject(input, CHECK_RESULT_KEYS, "Verification check result", [
        "checkId",
        "status",
    ]);
    const checkId = stableId(value.checkId, "verification checkId");

    if (value.status !== "passed") {
        throw new Error("Review requires every verification check to have passed");
    }

    if (value.exitCode !== 0) {
        throw new Error("A passed verification check requires exitCode 0");
    }

    if (value.failureCode !== undefined) {
        throw new Error("A passed verification check cannot have a failure code");
    }

    if (value.termination !== undefined && value.termination !== "none") {
        throw new Error("A passed verification check cannot be interrupted");
    }

    const evidence =
        value.evidence === undefined
            ? undefined
            : boundedText(value.evidence, "verification evidence", MAX_CHECK_EVIDENCE_BYTES, true);
    const evidenceBytes = evidence === undefined ? 0 : Buffer.byteLength(evidence, "utf8");
    const observedOutputBytes = value.observedOutputBytes;
    const truncated = value.truncated;

    if (
        observedOutputBytes !== undefined &&
        (!Number.isSafeInteger(observedOutputBytes) ||
            (observedOutputBytes as number) < evidenceBytes ||
            (observedOutputBytes as number) > MAX_CHECK_EVIDENCE_BYTES + 1)
    ) {
        throw new Error("Verification observed output is malformed or exceeds its bound");
    }

    if (truncated !== undefined && typeof truncated !== "boolean") {
        throw new Error("Verification truncation indicator must be boolean");
    }

    const outputByteCount = observedOutputBytes as number | undefined;

    if (truncated === true && (outputByteCount === undefined || outputByteCount <= evidenceBytes)) {
        throw new Error("Truncated verification evidence requires a bounded larger output count");
    }

    if (truncated === false && outputByteCount !== undefined && outputByteCount !== evidenceBytes) {
        throw new Error("Complete verification evidence must match its output byte count");
    }

    return {
        checkId,
        status: "passed",
        exitCode: 0,
        ...(evidence !== undefined ? { evidence } : {}),
        ...(outputByteCount !== undefined ? { observedOutputBytes: outputByteCount } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
        ...(value.termination !== undefined ? { termination: "none" } : {}),
    };
}

function stableId(value: unknown, label: string): string {
    if (
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > MAX_ID_BYTES ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ) {
        throw new Error(`${label} must be a stable non-empty identifier`);
    }

    return value;
}

function boundedText(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
    if (
        typeof value !== "string" ||
        (!allowEmpty && value.trim().length === 0) ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > maxBytes
    ) {
        throw new Error(`${label} must be non-empty bounded text`);
    }

    return value;
}

function sha256Text(value: unknown, label: string): string {
    if (!isSha256(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest`);
    }

    return value;
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactObject(
    input: unknown,
    keys: readonly string[],
    label: string,
    requiredKeys: readonly string[] = keys,
): Record<string, unknown> {
    if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    ) {
        throw new Error(`${label} must be a plain object`);
    }

    const ownKeys = Reflect.ownKeys(input);

    if (ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
        throw new Error(`${label} contains unsupported fields`);
    }

    if (requiredKeys.some((key) => !Object.hasOwn(input, key))) {
        throw new Error(`${label} is missing required fields`);
    }

    return input as Record<string, unknown>;
}

function denseArray(input: unknown, label: string, maxLength: number): unknown[] {
    if (!Array.isArray(input)) {
        throw new Error(`${label} must be an array`);
    }

    if (input.length > maxLength) {
        throw new Error(`${label} exceeds its size bound`);
    }

    for (let index = 0; index < input.length; index++) {
        if (!Object.hasOwn(input, index)) {
            throw new Error(`${label} cannot contain sparse entries`);
        }
    }

    const allowedKeys = new Set(["length", ...input.map((_value, index) => String(index))]);

    if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
        throw new Error(`${label} contains unsupported array fields`);
    }

    return input;
}

function reviewOperationId(gateId: string, threadId: string, turnId: string): string {
    const tuple = JSON.stringify([gateId, threadId, turnId]);

    return `pocket-review-v1:${Buffer.from(tuple, "utf8").toString("base64url")}`;
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

function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }

        Object.freeze(value);
    }

    return value;
}
