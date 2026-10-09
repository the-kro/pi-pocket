/** A caller-supplied, ordered verification command. Commands are trusted input, not a sandbox policy. */
export interface VerificationCheck {
    id: string;
    command: string;
    /** Workspace-relative POSIX path; `.` means the workspace root. */
    cwd: string;
    /** Stable identity for host-owned environment policy; secret values never belong here. */
    environmentPolicyId: string;
    required: boolean;
    timeoutMs: number;
    maxOutputBytes: number;
}

export interface VerificationBounds {
    maxChecks: number;
    aggregateTimeoutMs: number;
    aggregateOutputBytes: number;
}

export type VerificationResultPolicy = "all-required-checks-pass-v1";

export interface VerificationManifest {
    checks: VerificationCheck[];
    bounds: VerificationBounds;
    resultPolicy: VerificationResultPolicy;
}

export interface VerificationCeilings {
    maxManifestBytes: number;
    maxChecks: number;
    maxCommandBytes: number;
    maxCheckTimeoutMs: number;
    maxAggregateTimeoutMs: number;
    maxCheckOutputBytes: number;
    maxAggregateOutputBytes: number;
}

export interface ValidatedVerificationCheck extends VerificationCheck {
    effectiveCwd: string;
}

export interface ValidatedVerificationManifest {
    checks: ValidatedVerificationCheck[];
    bounds: VerificationBounds;
    resultPolicy: VerificationResultPolicy;
    ceilings: VerificationCeilings;
    digest: string;
    serializedBytes: number;
}

/** Deterministic identity for one workspace content state and its declared coverage. */
export interface WorkspaceRevision {
    workspaceId: string;
    digest: string;
    algorithm: "sha256";
    coverage: "git-head-index-worktree-v1";
}

/** Rejects unsupported or over-bound states instead of returning a partial revision. */
export interface WorkspaceAdapter {
    snapshot(): Promise<WorkspaceRevision>;
}

export interface WorkspaceSafetyRequest {
    phase: "admission" | "promotion";
    verificationId: string;
    workspaceId: string;
    subjectRevision: string;
    priorAssuranceId?: string;
}

export type WorkspaceSafetyAssurance =
    | {
          state: "quiescent";
          /** Durable/external evidence identity, not a process-local lock or timestamp. */
          assuranceId: string;
      }
    | {
          state: "unsafe" | "unknown";
          assuranceId?: string;
          reason?: string;
      };

/**
 * Required host capability for both command admission and passing promotion. A `quiescent` result
 * promises authoritative single-writer/quiescence evidence that remains valid across host restart
 * and all verification IDs. Snapshot equality alone cannot provide that evidence or rule out a
 * change-and-restore race. Hosts must fail closed with `unsafe` or `unknown` when uncertain.
 */
export interface WorkspaceSafetyAdapter {
    assertQuiescent(request: WorkspaceSafetyRequest): Promise<WorkspaceSafetyAssurance>;
}

export type CheckStatus = "passed" | "failed" | "interrupted" | "not-run";

export type VerificationCheckFailureCode = "shell_unavailable" | "spawn_error";

export interface CheckResult {
    checkId: string;
    status: CheckStatus;
    exitCode?: number;
    evidence?: string;
    /** Saturates at the retained byte limit plus one to indicate additional observed output. */
    observedOutputBytes?: number;
    truncated?: boolean;
    failureCode?: VerificationCheckFailureCode;
    termination?: "none" | "timeout" | "cancelled" | "unknown";
}

export type VerificationStatus = "passed" | "failed" | "interrupted";

/** Durable result identity is bound to the workspace revision and canonical request digest. */
export interface VerificationResult {
    verificationId: string;
    requestDigest: string;
    workspaceId: string;
    subjectRevision: string;
    status: VerificationStatus;
    checks: CheckResult[];
}

export interface VerificationRunnerIdentity {
    id: string;
    version: string;
}

export interface VerificationRequest {
    verificationId: string;
    workspaceId: string;
    subjectRevision: WorkspaceRevision;
    manifest: ValidatedVerificationManifest;
    runner: VerificationRunnerIdentity;
}

export interface VerificationBinding {
    verificationId: string;
    workspaceId: string;
    subjectRevision: string;
    digest: string;
}
