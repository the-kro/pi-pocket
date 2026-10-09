/** Validate bounded check evidence and aggregate it into the canonical verification result. */
import { createVerificationBinding } from "./manifest.ts";
import type { CheckResult, VerificationRequest, VerificationResult } from "./types.ts";

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

/** Aggregate an exact ordered set of check outcomes for a validated request. */
export function aggregateVerificationResult(
    request: VerificationRequest,
    checkResults: readonly CheckResult[],
    options: { readonly subjectValid?: boolean } = {},
): VerificationResult {
    const binding = createVerificationBinding(request);

    if (options.subjectValid !== undefined && typeof options.subjectValid !== "boolean") {
        throw new Error("Verification subject validity must be a boolean");
    }

    if (!Array.isArray(checkResults) || checkResults.length !== request.manifest.checks.length) {
        throw new Error("Verification result must contain one outcome for each manifest check");
    }

    const checks: CheckResult[] = [];
    let aggregateEvidenceBytes = 0;
    let hasFailure = false;
    let hasInterruption = false;
    let requiredInterruptionSeen = false;

    for (let index = 0; index < checkResults.length; index++) {
        const checkResult = copyCheckResult(checkResults[index]);
        const expectedCheck = request.manifest.checks[index];

        if (!checkResult || !expectedCheck || checkResult.checkId !== expectedCheck.id) {
            throw new Error("Verification result check order does not match its manifest");
        }

        if (requiredInterruptionSeen) {
            if (checkResult.status !== "not-run" || hasCheckEvidence(checkResult)) {
                throw new Error("Checks after a required interruption must be not-run");
            }

            checks.push(checkResult);
            continue;
        }

        if (checkResult.status === "not-run") {
            if (options.subjectValid !== false) {
                throw new Error("A not-run check requires an earlier required interruption");
            }

            if (hasCheckEvidence(checkResult)) {
                throw new Error("A blocked not-run check cannot contain command evidence");
            }

            checks.push(checkResult);
            continue;
        }

        validateOutputEvidence(checkResult, expectedCheck.maxOutputBytes);

        if (
            checkResult.exitCode !== undefined &&
            (!Number.isSafeInteger(checkResult.exitCode) || checkResult.exitCode < 0)
        ) {
            throw new Error("Verification check requires a safe integer exit code");
        }

        const evidenceBytes = checkResult.evidence
            ? Buffer.byteLength(checkResult.evidence, "utf8")
            : 0;

        aggregateEvidenceBytes += evidenceBytes;

        if (aggregateEvidenceBytes > request.manifest.bounds.aggregateOutputBytes) {
            throw new Error("Verification result exceeds the aggregate evidence ceiling");
        }

        if (checkResult.status === "passed") {
            if (
                checkResult.exitCode !== 0 ||
                checkResult.failureCode !== undefined ||
                (checkResult.termination !== undefined && checkResult.termination !== "none")
            ) {
                throw new Error("A passed check requires a conclusive zero exit");
            }
        } else if (checkResult.status === "failed") {
            const knownFailure =
                checkResult.failureCode === "shell_unavailable" ||
                checkResult.failureCode === "spawn_error";

            if (checkResult.failureCode !== undefined && !knownFailure) {
                throw new Error(
                    "Verification result contains an unsupported verification failure code",
                );
            }

            if (
                (checkResult.exitCode === undefined && !knownFailure) ||
                checkResult.exitCode === 0 ||
                (checkResult.termination !== undefined && checkResult.termination !== "none")
            ) {
                throw new Error("A failed check requires a nonzero exit or known start failure");
            }

            hasFailure = true;
        } else if (checkResult.status === "interrupted") {
            if (
                checkResult.termination !== "timeout" &&
                checkResult.termination !== "cancelled" &&
                checkResult.termination !== "unknown"
            ) {
                throw new Error("An interrupted check requires a termination reason");
            }

            if (checkResult.failureCode !== undefined) {
                throw new Error("An interrupted check cannot claim a known start failure");
            }

            hasInterruption = true;
            requiredInterruptionSeen = expectedCheck.required;
        } else {
            throw new Error("Unsupported verification check status");
        }

        checks.push(checkResult);
    }

    return {
        verificationId: request.verificationId,
        requestDigest: binding.digest,
        workspaceId: request.workspaceId,
        subjectRevision: request.subjectRevision.digest,
        status:
            options.subjectValid === false
                ? "interrupted"
                : requiredInterruptionSeen
                  ? "interrupted"
                  : hasFailure
                    ? "failed"
                    : hasInterruption
                      ? "interrupted"
                      : "passed",
        checks,
    };
}

function validateOutputEvidence(checkResult: CheckResult, perCheckLimit: number): void {
    if (checkResult.evidence !== undefined && typeof checkResult.evidence !== "string") {
        throw new Error("Verification check evidence must be text");
    }

    if (
        checkResult.observedOutputBytes !== undefined &&
        (!Number.isSafeInteger(checkResult.observedOutputBytes) ||
            checkResult.observedOutputBytes < 0 ||
            checkResult.observedOutputBytes > Math.min(perCheckLimit + 1, Number.MAX_SAFE_INTEGER))
    ) {
        throw new Error("Verification observed-output indicator exceeds its bound");
    }

    if (checkResult.truncated !== undefined && typeof checkResult.truncated !== "boolean") {
        throw new Error("Verification truncation evidence must be boolean");
    }

    const evidenceBytes = checkResult.evidence
        ? Buffer.byteLength(checkResult.evidence, "utf8")
        : 0;

    if (evidenceBytes > perCheckLimit) {
        throw new Error("Verification check evidence exceeds its per-check evidence ceiling");
    }

    if (
        checkResult.observedOutputBytes !== undefined &&
        checkResult.observedOutputBytes < evidenceBytes
    ) {
        throw new Error("Observed output cannot be smaller than retained evidence");
    }

    if (checkResult.truncated === true && checkResult.observedOutputBytes === undefined) {
        throw new Error("Truncated evidence requires a bounded observed-output indicator");
    }

    if (
        checkResult.truncated === false &&
        checkResult.observedOutputBytes !== undefined &&
        checkResult.observedOutputBytes !== evidenceBytes
    ) {
        throw new Error("Complete evidence must match its observed-output indicator");
    }

    if (
        checkResult.truncated === true &&
        checkResult.observedOutputBytes !== undefined &&
        checkResult.observedOutputBytes <= evidenceBytes
    ) {
        throw new Error("Truncated evidence must indicate additional observed output");
    }
}

function copyCheckResult(input: unknown): CheckResult {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Verification check result must be an object");
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Verification check result must be a plain object");
    }

    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !CHECK_RESULT_KEYS.includes(key)) {
            throw new Error(
                `Verification check result has unknown verification check field: ${String(key)}`,
            );
        }
    }

    const {
        checkId,
        status,
        exitCode,
        evidence,
        observedOutputBytes,
        truncated,
        failureCode,
        termination,
    } = input as Record<string, unknown>;

    return {
        checkId: checkId as string,
        status: status as CheckResult["status"],
        ...(exitCode !== undefined ? { exitCode: exitCode as number } : {}),
        ...(evidence !== undefined ? { evidence: evidence as string } : {}),
        ...(observedOutputBytes !== undefined
            ? { observedOutputBytes: observedOutputBytes as number }
            : {}),
        ...(truncated !== undefined ? { truncated: truncated as boolean } : {}),
        ...(failureCode !== undefined
            ? { failureCode: failureCode as CheckResult["failureCode"] }
            : {}),
        ...(termination !== undefined
            ? { termination: termination as CheckResult["termination"] }
            : {}),
    };
}

function hasCheckEvidence(checkResult: CheckResult): boolean {
    return (
        checkResult.exitCode !== undefined ||
        checkResult.evidence !== undefined ||
        checkResult.observedOutputBytes !== undefined ||
        checkResult.truncated !== undefined ||
        checkResult.failureCode !== undefined ||
        checkResult.termination !== undefined
    );
}
