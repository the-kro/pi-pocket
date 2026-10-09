/** Persist exact verification checks and results through the host-independent workflow step API. */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Shell } from "@earendil-works/pi-durable/env";
import { assertVerificationBindingUnchanged, createVerificationBinding } from "./manifest.ts";
import { createVerificationCommandAdapter } from "./command.ts";
import { aggregateVerificationResult } from "./result.ts";
import type {
    CheckResult,
    VerificationBinding,
    VerificationRequest,
    VerificationResult,
    ValidatedVerificationCheck,
    WorkspaceRevision,
    WorkspaceSafetyAssurance,
} from "./types.ts";
import type { StepExecution, WorkflowContext } from "../core/index.ts";

const MAX_ASSURANCE_ID_LENGTH = 256;
const CHECK_RECEIPT_KEYS = ["assuranceId", "result", "subjectValid"];

export interface VerificationAdapters {
    workspace: {
        snapshot(): Promise<WorkspaceRevision>;
    };
    safety: {
        assertQuiescent(request: {
            readonly phase: "admission" | "promotion";
            readonly verificationId: string;
            readonly workspaceId: string;
            readonly subjectRevision: string;
            readonly priorAssuranceId?: string;
        }): Promise<WorkspaceSafetyAssurance>;
    };
    shell: Pick<Shell, "exec">;
    context: Context;
    /** Resolve only the host-owned policy named by the manifest; returned values are never persisted. */
    environmentForPolicy(
        policyId: string,
        check: ValidatedVerificationCheck,
        context: Context,
    ): Promise<Readonly<Record<string, string>>>;
}

interface VerificationCheckReceipt {
    assuranceId?: string;
    result: CheckResult;
    subjectValid: boolean;
}

interface CheckAdmission {
    subjectValid: boolean;
    assuranceId?: string;
}

/** Run one immutable request using stable workflow operation IDs and fail-closed host adapters. */
export async function verify<I extends JsonValue>(
    context: WorkflowContext<I>,
    request: VerificationRequest,
    adapters: VerificationAdapters,
): Promise<VerificationResult> {
    throwIfStopped(context.signal);

    const binding = createVerificationBinding(request);
    const frozenBinding = await context.step.do<JsonValue>(
        bindingOperationId(request.verificationId),
        () => binding as unknown as JsonValue,
        { interrupted: "retry" },
    );

    assertVerificationBindingUnchanged(frozenBinding as unknown as VerificationBinding, binding);
    throwIfStopped(context.signal);

    const commandAdapter = createVerificationCommandAdapter({
        shell: adapters.shell,
        context: adapters.context,
        signal: context.signal,
        maxCheckTimeoutMs: request.manifest.ceilings.maxCheckTimeoutMs,
        maxCheckOutputBytes: request.manifest.ceilings.maxCheckOutputBytes,
    });
    const checkResults: CheckResult[] = [];
    let subjectValid = true;
    let requiredInterruptionSeen = false;
    let priorAssuranceId: string | undefined;
    let aggregateEvidenceBytes = 0;

    for (const check of request.manifest.checks) {
        throwIfStopped(context.signal);

        const admission =
            subjectValid && !requiredInterruptionSeen
                ? await admitCheck(context, request, adapters, priorAssuranceId)
                : { subjectValid };
        const operationId = checkOperationId(request.verificationId, check.id);
        const receipt = await context.step.do<JsonValue>(
            operationId,
            async () => {
                if (requiredInterruptionSeen || !subjectValid || !admission.subjectValid) {
                    return asJsonValue({
                        result: { checkId: check.id, status: "not-run" },
                        subjectValid: subjectValid && admission.subjectValid,
                    });
                }

                if (admission.assuranceId === undefined) {
                    return asJsonValue({
                        result: { checkId: check.id, status: "not-run" },
                        subjectValid: false,
                    });
                }

                let environment: Readonly<Record<string, string>>;

                try {
                    environment = await adapters.environmentForPolicy(
                        check.environmentPolicyId,
                        check,
                        adapters.context,
                    );
                } catch (error) {
                    throwIfStopped(context.signal);

                    return asJsonValue({
                        result: {
                            checkId: check.id,
                            status: "interrupted",
                            termination: "unknown",
                        },
                        subjectValid: true,
                        assuranceId: admission.assuranceId,
                    });
                }

                throwIfStopped(context.signal);

                const result = await commandAdapter.run({
                    check,
                    environment,
                    remainingAggregateOutputBytes: Math.max(
                        0,
                        request.manifest.bounds.aggregateOutputBytes - aggregateEvidenceBytes,
                    ),
                });

                return asJsonValue({
                    result,
                    subjectValid: true,
                    assuranceId: admission.assuranceId,
                });
            },
            {
                interrupted: "reconcile",
                reconcile: (execution) =>
                    reconcileInterruptedCheck(context.signal, check, execution),
            },
        );
        const checkedReceipt = copyCheckReceipt(receipt, check.id);

        checkResults.push(checkedReceipt.result);
        subjectValid = subjectValid && checkedReceipt.subjectValid;
        priorAssuranceId = checkedReceipt.assuranceId ?? priorAssuranceId;
        aggregateEvidenceBytes += checkedReceipt.result.evidence
            ? Buffer.byteLength(checkedReceipt.result.evidence, "utf8")
            : 0;
        requiredInterruptionSeen =
            requiredInterruptionSeen ||
            (check.required && checkedReceipt.result.status === "interrupted");
    }

    const result = await context.step.do<JsonValue>(
        aggregateOperationId(request.verificationId),
        async () => {
            throwIfStopped(context.signal);

            let finalSubjectValid = subjectValid;

            try {
                const finalRevision = await adapters.workspace.snapshot();

                finalSubjectValid =
                    finalSubjectValid && sameRevision(request.subjectRevision, finalRevision);
            } catch (error) {
                throwIfStopped(context.signal);
                finalSubjectValid = false;
            }

            let promotion: WorkspaceSafetyAssurance;

            try {
                promotion = await adapters.safety.assertQuiescent({
                    phase: "promotion",
                    verificationId: request.verificationId,
                    workspaceId: request.workspaceId,
                    subjectRevision: request.subjectRevision.digest,
                    ...(priorAssuranceId === undefined ? {} : { priorAssuranceId }),
                });
            } catch (error) {
                throwIfStopped(context.signal);
                finalSubjectValid = false;
                promotion = { state: "unknown" };
            }

            throwIfStopped(context.signal);

            if (!validAssurance(promotion)) {
                finalSubjectValid = false;
            }

            return asJsonValue(
                aggregateVerificationResult(request, checkResults, {
                    subjectValid: finalSubjectValid,
                }),
            );
        },
        { interrupted: "retry" },
    );

    return result as unknown as VerificationResult;
}

async function admitCheck<I extends JsonValue>(
    context: WorkflowContext<I>,
    request: VerificationRequest,
    adapters: VerificationAdapters,
    priorAssuranceId?: string,
): Promise<CheckAdmission> {
    let currentRevision: WorkspaceRevision;

    try {
        currentRevision = await adapters.workspace.snapshot();
    } catch (error) {
        throwIfStopped(context.signal);

        return { subjectValid: false };
    }

    throwIfStopped(context.signal);

    if (!sameRevision(request.subjectRevision, currentRevision)) {
        return { subjectValid: false };
    }

    let assurance: WorkspaceSafetyAssurance;

    try {
        assurance = await adapters.safety.assertQuiescent({
            phase: "admission",
            verificationId: request.verificationId,
            workspaceId: request.workspaceId,
            subjectRevision: request.subjectRevision.digest,
            ...(priorAssuranceId === undefined ? {} : { priorAssuranceId }),
        });
    } catch (error) {
        throwIfStopped(context.signal);

        return { subjectValid: false };
    }

    throwIfStopped(context.signal);

    return validAssurance(assurance)
        ? { subjectValid: true, assuranceId: assurance.assuranceId }
        : { subjectValid: false };
}

function reconcileInterruptedCheck(
    signal: AbortSignal,
    check: ValidatedVerificationCheck,
    _execution: StepExecution,
): { status: "completed"; result: JsonValue } {
    throwIfStopped(signal);

    return {
        status: "completed",
        result: {
            result: {
                checkId: check.id,
                status: "interrupted",
                termination: "unknown",
            },
            subjectValid: false,
        } as unknown as JsonValue,
    };
}

function copyCheckReceipt(input: unknown, checkId: string): VerificationCheckReceipt {
    if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    ) {
        throw new Error("Persisted verification check receipt must be a plain object");
    }

    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !CHECK_RECEIPT_KEYS.includes(key)) {
            throw new Error("Persisted verification check receipt has an unknown field");
        }
    }

    const receipt = input as Record<string, unknown>;

    if (receipt.subjectValid !== true && receipt.subjectValid !== false) {
        throw new Error("Persisted verification check receipt has invalid subject evidence");
    }

    if (receipt.assuranceId !== undefined && !validAssuranceId(receipt.assuranceId)) {
        throw new Error("Persisted verification check receipt has invalid safety evidence");
    }

    if (
        receipt.result === null ||
        typeof receipt.result !== "object" ||
        Array.isArray(receipt.result) ||
        (receipt.result as { readonly checkId?: unknown }).checkId !== checkId
    ) {
        throw new Error("Persisted verification check receipt does not match its check");
    }

    return {
        result: receipt.result as CheckResult,
        subjectValid: receipt.subjectValid,
        ...(receipt.assuranceId === undefined ? {} : { assuranceId: receipt.assuranceId }),
    };
}

function sameRevision(expected: WorkspaceRevision, current: WorkspaceRevision): boolean {
    return (
        current !== null &&
        typeof current === "object" &&
        current.workspaceId === expected.workspaceId &&
        current.digest === expected.digest &&
        current.algorithm === expected.algorithm &&
        current.coverage === expected.coverage
    );
}

function validAssurance(
    value: WorkspaceSafetyAssurance,
): value is Extract<WorkspaceSafetyAssurance, { readonly state: "quiescent" }> {
    return (
        value !== null &&
        typeof value === "object" &&
        value.state === "quiescent" &&
        validAssuranceId(value.assuranceId)
    );
}

function validAssuranceId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_ASSURANCE_ID_LENGTH &&
        !/[\u0000-\u001f\u007f]/.test(value)
    );
}

function asJsonValue(value: unknown): JsonValue {
    return value as JsonValue;
}

function throwIfStopped(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason ?? new Error("Verification workflow stopped");
    }
}

function bindingOperationId(verificationId: string): string {
    return `verification:${verificationId.length}:${verificationId}:binding`;
}

function checkOperationId(verificationId: string, checkId: string): string {
    return `verification:${verificationId.length}:${verificationId}:check:${checkId.length}:${checkId}`;
}

function aggregateOperationId(verificationId: string): string {
    return `verification:${verificationId.length}:${verificationId}:aggregate`;
}
