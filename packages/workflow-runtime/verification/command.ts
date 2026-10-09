/** Bounded command execution over the host-injected public Pi Durable Shell capability. */
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Shell } from "@earendil-works/pi-durable/env";
import type { CheckResult, ValidatedVerificationCheck } from "./types.ts";

export interface VerificationCommandAdapterOptions {
    shell: Pick<Shell, "exec">;
    context: Context;
    signal?: AbortSignal;
    maxCheckTimeoutMs: number;
    maxCheckOutputBytes: number;
}

export interface RunVerificationCheckInput {
    check: ValidatedVerificationCheck;
    /** Resolved by the host from this check's environment-policy identity. */
    environment: Readonly<Record<string, string>>;
    /** Remaining aggregate evidence budget; zero still permits execution without retaining output. */
    remainingAggregateOutputBytes: number;
}

export interface VerificationCommandAdapter {
    run(input: RunVerificationCheckInput): Promise<CheckResult>;
}

/** Execute one trusted check with explicit cwd/environment and a bounded output callback. */
export function createVerificationCommandAdapter(
    options: VerificationCommandAdapterOptions,
): VerificationCommandAdapter {
    assertPositiveSafeInteger(options.maxCheckTimeoutMs, "maxCheckTimeoutMs");
    assertPositiveSafeInteger(options.maxCheckOutputBytes, "maxCheckOutputBytes");

    const context = options.signal
        ? withAbortSignal(options.signal, options.context)
        : options.context;

    let executionTail: Promise<void> = Promise.resolve();
    let requiredInterruptionSeen = false;

    const runOnce = async (input: RunVerificationCheckInput): Promise<CheckResult> => {
        const check = input.check;

        assertPositiveSafeInteger(check.timeoutMs, "check timeout");
        assertPositiveSafeInteger(check.maxOutputBytes, "check output ceiling");

        if (check.timeoutMs > options.maxCheckTimeoutMs) {
            throw new Error("Verification check exceeds the host timeout ceiling");
        }

        if (check.maxOutputBytes > options.maxCheckOutputBytes) {
            throw new Error("Verification check exceeds the host output ceiling");
        }

        if (
            !Number.isSafeInteger(input.remainingAggregateOutputBytes) ||
            input.remainingAggregateOutputBytes < 0
        ) {
            throw new Error(
                "Remaining aggregate output budget must be a finite non-negative integer",
            );
        }

        const outputLimit = Math.min(
            check.maxOutputBytes,
            options.maxCheckOutputBytes,
            input.remainingAggregateOutputBytes,
        );
        const observationLimit = Math.min(outputLimit + 1, Number.MAX_SAFE_INTEGER);
        const outputParts: string[] = [];
        let retainedOutputBytes = 0;
        let observedOutputBytes = 0;
        let truncated = false;

        const onOutput = (text: string) => {
            if (text.length === 0 || truncated) {
                return;
            }

            for (const character of text) {
                const codePoint = character.codePointAt(0) ?? 0;
                const validCharacter =
                    codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
                const characterBytes = Buffer.byteLength(validCharacter, "utf8");

                if (observedOutputBytes < observationLimit) {
                    observedOutputBytes = Math.min(
                        observationLimit,
                        observedOutputBytes + characterBytes,
                    );
                }

                if (retainedOutputBytes + characterBytes > outputLimit) {
                    observedOutputBytes = observationLimit;
                    truncated = true;

                    return;
                }

                outputParts.push(validCharacter);
                retainedOutputBytes += characterBytes;
            }
        };

        if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error("Verification command cancelled");
        }

        const environment = { ...input.environment };
        let shellResult;

        try {
            shellResult = await options.shell.exec(
                check.command,
                {
                    cwd: check.effectiveCwd,
                    env: environment,
                    inheritEnv: false,
                    timeout: check.timeoutMs,
                    onOutput,
                },
                context,
            );
        } catch {
            if (options.signal?.aborted) {
                throw options.signal.reason ?? new Error("Verification command cancelled");
            }

            const output = outputParts.join("");

            return {
                checkId: check.id,
                status: "interrupted",
                ...(output.length > 0 ? { evidence: output } : {}),
                observedOutputBytes,
                truncated,
                termination: "unknown",
            };
        }

        if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error("Verification command cancelled");
        }

        if (
            shellResult.ok &&
            (!Number.isSafeInteger(shellResult.value.exitCode) || shellResult.value.exitCode < 0)
        ) {
            return {
                checkId: check.id,
                status: "interrupted",
                ...(outputParts.length > 0 ? { evidence: outputParts.join("") } : {}),
                observedOutputBytes,
                truncated,
                termination: "unknown",
            };
        }

        if (!shellResult.ok) {
            const output = outputParts.join("");

            if (
                shellResult.error.code === "shell_unavailable" ||
                shellResult.error.code === "spawn_error"
            ) {
                return {
                    checkId: check.id,
                    status: "failed",
                    failureCode: shellResult.error.code,
                    ...(output.length > 0 ? { evidence: output } : {}),
                    observedOutputBytes,
                    truncated,
                    termination: "none",
                };
            }

            if (shellResult.error.code === "timeout") {
                return {
                    checkId: check.id,
                    status: "interrupted",
                    ...(output.length > 0 ? { evidence: output } : {}),
                    observedOutputBytes,
                    truncated,
                    termination: "timeout",
                };
            }

            if (shellResult.error.code === "aborted") {
                return {
                    checkId: check.id,
                    status: "interrupted",
                    ...(output.length > 0 ? { evidence: output } : {}),
                    observedOutputBytes,
                    truncated,
                    termination: "cancelled",
                };
            }

            return {
                checkId: check.id,
                status: "interrupted",
                ...(output.length > 0 ? { evidence: output } : {}),
                observedOutputBytes,
                truncated,
                termination: "unknown",
            };
        }

        const output = outputParts.join("");

        return {
            checkId: check.id,
            status: shellResult.value.exitCode === 0 ? "passed" : "failed",
            exitCode: shellResult.value.exitCode,
            ...(output.length > 0 ? { evidence: output } : {}),
            observedOutputBytes,
            truncated,
            termination: "none",
        };
    };

    return {
        run(input) {
            const result = executionTail.then(async () => {
                if (requiredInterruptionSeen) {
                    return { checkId: input.check.id, status: "not-run" as const };
                }

                const checkResult = await runOnce(input);

                if (checkResult.status === "interrupted" && input.check.required) {
                    requiredInterruptionSeen = true;
                }

                return checkResult;
            });

            executionTail = result.then(
                () => undefined,
                () => undefined,
            );

            return result;
        },
    };
}

function assertPositiveSafeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive finite integer`);
    }
}
