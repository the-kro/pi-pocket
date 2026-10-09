import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { FileSystem } from "@earendil-works/pi-durable/env";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { NonRetryableError } from "../core/index.ts";
import type {
    VerificationBinding,
    VerificationCeilings,
    VerificationManifest,
    VerificationRequest,
    ValidatedVerificationManifest,
} from "./types.ts";

const RESULT_POLICY = "all-required-checks-pass-v1" as const;
const MANIFEST_KEYS = ["bounds", "checks", "resultPolicy"];
const BOUNDS_KEYS = ["aggregateOutputBytes", "aggregateTimeoutMs", "maxChecks"];
const CEILING_KEYS = [
    "maxAggregateOutputBytes",
    "maxAggregateTimeoutMs",
    "maxCheckOutputBytes",
    "maxCheckTimeoutMs",
    "maxChecks",
    "maxCommandBytes",
    "maxManifestBytes",
];
const CHECK_KEYS = [
    "command",
    "cwd",
    "environmentPolicyId",
    "id",
    "maxOutputBytes",
    "required",
    "timeoutMs",
];

export interface ValidateVerificationManifestOptions {
    workspaceRoot: string;
    ceilings: VerificationCeilings;
    fileSystem: Pick<FileSystem, "canonicalPath">;
    context: Context;
}

export class VerificationRequestConflict extends NonRetryableError {
    readonly code = "verification_request_conflict";
    readonly retryable = false;

    constructor(verificationId: string) {
        super(`Verification request ${verificationId} conflicts with its frozen identity`);
        this.name = "VerificationRequestConflict";
    }
}

/** Validate a manifest and resolve its working directories against the explicit workspace root. */
export async function validateVerificationManifest(
    manifest: VerificationManifest,
    options: ValidateVerificationManifestOptions,
): Promise<ValidatedVerificationManifest> {
    assertFields(manifest, MANIFEST_KEYS, "manifest");
    assertFields(manifest.bounds, BOUNDS_KEYS, "manifest bounds");
    assertFields(options.ceilings, CEILING_KEYS, "host ceilings");

    const ceilings = normalizeCeilings(options.ceilings);
    const bounds = { ...manifest.bounds };

    if (!Array.isArray(manifest.checks)) {
        throw new Error("Verification manifest checks must be an array");
    }

    if (manifest.checks.length === 0) {
        throw new Error("A verification manifest must contain at least one check");
    }

    if (
        !Number.isSafeInteger(bounds.maxChecks) ||
        bounds.maxChecks <= 0 ||
        bounds.maxChecks > ceilings.maxChecks ||
        manifest.checks.length > bounds.maxChecks
    ) {
        throw new Error("Manifest exceeds the check-count ceiling");
    }

    for (let index = 0; index < manifest.checks.length; index++) {
        if (!Object.hasOwn(manifest.checks, index)) {
            throw new Error("Verification manifest check array contains a missing entry");
        }
    }

    const checkSnapshots = manifest.checks.map((inputCheck) => {
        assertFields(inputCheck, CHECK_KEYS, "verification check");

        return { ...inputCheck };
    });

    if (manifest.resultPolicy !== RESULT_POLICY) {
        throw new Error("Unsupported verification result policy");
    }

    if (
        !Number.isSafeInteger(bounds.aggregateTimeoutMs) ||
        bounds.aggregateTimeoutMs <= 0 ||
        bounds.aggregateTimeoutMs > ceilings.maxAggregateTimeoutMs
    ) {
        throw new Error("Manifest exceeds the aggregate timeout ceiling");
    }

    if (
        !Number.isSafeInteger(bounds.aggregateOutputBytes) ||
        bounds.aggregateOutputBytes <= 0 ||
        bounds.aggregateOutputBytes > ceilings.maxAggregateOutputBytes
    ) {
        throw new Error("Manifest exceeds the aggregate output ceiling");
    }

    if (
        typeof options.workspaceRoot !== "string" ||
        !isAbsolute(options.workspaceRoot) ||
        options.workspaceRoot.includes("\0")
    ) {
        throw new Error("workspaceRoot must be an explicit absolute path");
    }

    const workspaceRoot = resolve(options.workspaceRoot);
    const fileSystem = options.fileSystem;
    const context = options.context;
    const canonicalRootResult = await fileSystem.canonicalPath(workspaceRoot, context);

    if (!canonicalRootResult.ok) {
        throw new Error("Cannot resolve the verification workspace root");
    }

    const canonicalWorkspaceRoot = canonicalRootResult.value;
    const seenCheckIds = new Set<string>();
    let requestedTimeoutMs = 0;
    let requestedOutputBytes = 0;
    const checks = await Promise.all(
        checkSnapshots.map(async (check) => {
            if (
                typeof check.id !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(check.id)
            ) {
                throw new Error("Verification check id must be a stable identifier");
            }

            if (seenCheckIds.has(check.id)) {
                throw new Error(`Duplicate verification check id: ${check.id}`);
            }

            seenCheckIds.add(check.id);

            if (typeof check.command !== "string" || check.command.trim().length === 0) {
                throw new Error("Verification checks require an explicit non-empty command");
            }

            if (
                check.command.includes("\0") ||
                Buffer.byteLength(check.command, "utf8") > ceilings.maxCommandBytes
            ) {
                throw new Error("Verification command exceeds its byte ceiling");
            }

            if (
                !Number.isSafeInteger(check.timeoutMs) ||
                check.timeoutMs <= 0 ||
                check.timeoutMs > ceilings.maxCheckTimeoutMs
            ) {
                throw new Error("Verification check exceeds its timeout ceiling");
            }

            if (
                !Number.isSafeInteger(check.maxOutputBytes) ||
                check.maxOutputBytes <= 0 ||
                check.maxOutputBytes > ceilings.maxCheckOutputBytes
            ) {
                throw new Error("Verification check exceeds its output ceiling");
            }

            requestedTimeoutMs += check.timeoutMs;
            requestedOutputBytes += check.maxOutputBytes;

            if (
                !Number.isSafeInteger(requestedTimeoutMs) ||
                requestedTimeoutMs > bounds.aggregateTimeoutMs
            ) {
                throw new Error("Checks exceed the aggregate timeout bound");
            }

            if (
                !Number.isSafeInteger(requestedOutputBytes) ||
                requestedOutputBytes > bounds.aggregateOutputBytes
            ) {
                throw new Error("Checks exceed the aggregate output bound");
            }

            if (typeof check.required !== "boolean") {
                throw new Error("Verification check required policy must be a boolean");
            }

            if (
                typeof check.environmentPolicyId !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(check.environmentPolicyId)
            ) {
                throw new Error("Verification checks require a stable environment policy identity");
            }

            const cwd = normalizeCwd(check.cwd);
            const lexicalCwd =
                cwd === "." ? canonicalWorkspaceRoot : resolve(canonicalWorkspaceRoot, cwd);
            const canonicalCwdResult = await fileSystem.canonicalPath(lexicalCwd, context);

            if (!canonicalCwdResult.ok) {
                throw new Error("Cannot resolve verification cwd within the workspace");
            }

            const effectiveCwd = canonicalCwdResult.value;
            const relativeCwd = relative(canonicalWorkspaceRoot, effectiveCwd);

            if (
                relativeCwd === ".." ||
                relativeCwd.startsWith(`..${sep}`) ||
                isAbsolute(relativeCwd)
            ) {
                throw new Error("Verification cwd resolves outside the workspace");
            }

            return {
                ...check,
                cwd,
                effectiveCwd,
            };
        }),
    );
    const normalized = {
        checks,
        bounds,
        resultPolicy: RESULT_POLICY,
        ceilings,
    };

    const canonical = canonicalJson(normalized);
    const serializedBytes = Buffer.byteLength(
        canonicalJson({ checks, bounds, resultPolicy: RESULT_POLICY }),
        "utf8",
    );

    if (serializedBytes > ceilings.maxManifestBytes) {
        throw new Error("Verification manifest exceeds its size ceiling");
    }

    const validated: ValidatedVerificationManifest = {
        ...normalized,
        digest: hash(canonical),
        serializedBytes,
    };

    return deepFreeze(validated);
}

/** Compute a stable identity for a verification request without serializing environment secrets. */
export function createVerificationBinding(request: VerificationRequest): VerificationBinding {
    assertFields(
        request,
        ["verificationId", "workspaceId", "subjectRevision", "manifest", "runner"],
        "request",
    );

    if (
        typeof request.verificationId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.verificationId)
    ) {
        throw new Error("verificationId must be a stable non-empty identifier");
    }

    if (
        typeof request.workspaceId !== "string" ||
        request.workspaceId.length === 0 ||
        request.workspaceId.length > 256 ||
        request.workspaceId.includes("\0")
    ) {
        throw new Error("workspaceId must be an explicit stable identity");
    }

    assertFields(
        request.subjectRevision,
        ["workspaceId", "digest", "algorithm", "coverage"],
        "subject revision",
    );

    if (
        request.workspaceId !== request.subjectRevision.workspaceId ||
        !/^[a-f0-9]{64}$/.test(request.subjectRevision.digest) ||
        request.subjectRevision.algorithm !== "sha256" ||
        request.subjectRevision.coverage !== "git-head-index-worktree-v1"
    ) {
        throw new Error("The subject revision does not identify this workspace");
    }

    assertFields(request.runner, ["id", "version"], "runner identity");

    if (
        typeof request.runner.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.runner.id) ||
        typeof request.runner.version !== "string" ||
        request.runner.version.length === 0 ||
        request.runner.version.length > 128 ||
        request.runner.version.includes("\0")
    ) {
        throw new Error("Runner identity and version must be explicit stable strings");
    }

    assertFields(
        request.manifest,
        ["bounds", "checks", "ceilings", "digest", "resultPolicy", "serializedBytes"],
        "validated manifest",
    );
    assertFields(request.manifest.bounds, BOUNDS_KEYS, "manifest bounds");
    assertFields(request.manifest.ceilings, CEILING_KEYS, "host ceilings");

    if (
        request.manifest.resultPolicy !== RESULT_POLICY ||
        !/^[a-f0-9]{64}$/.test(request.manifest.digest) ||
        !Number.isSafeInteger(request.manifest.serializedBytes) ||
        request.manifest.serializedBytes <= 0
    ) {
        throw new Error("The validated manifest identity is malformed");
    }

    const checks = request.manifest.checks.map((check) => {
        assertFields(
            check,
            [
                "command",
                "cwd",
                "effectiveCwd",
                "environmentPolicyId",
                "id",
                "maxOutputBytes",
                "required",
                "timeoutMs",
            ],
            "validated check",
        );

        return {
            id: check.id,
            command: check.command,
            effectiveCwd: check.effectiveCwd,
            environmentPolicyId: check.environmentPolicyId,
            required: check.required,
            timeoutMs: check.timeoutMs,
            maxOutputBytes: check.maxOutputBytes,
        };
    });
    const identity = {
        bindingVersion: 1,
        verificationId: request.verificationId,
        workspaceId: request.workspaceId,
        subjectRevision: {
            workspaceId: request.subjectRevision.workspaceId,
            digest: request.subjectRevision.digest,
            algorithm: request.subjectRevision.algorithm,
            coverage: request.subjectRevision.coverage,
        },
        manifest: {
            checks,
            bounds: request.manifest.bounds,
            ceilings: request.manifest.ceilings,
            resultPolicy: request.manifest.resultPolicy,
        },
        runner: { id: request.runner.id, version: request.runner.version },
    };

    return {
        verificationId: request.verificationId,
        workspaceId: request.workspaceId,
        subjectRevision: request.subjectRevision.digest,
        digest: hash(canonicalJson(identity)),
    };
}

export function assertVerificationBindingUnchanged(
    previous: VerificationBinding,
    current: VerificationBinding,
): void {
    if (
        previous.verificationId !== current.verificationId ||
        previous.workspaceId !== current.workspaceId ||
        previous.subjectRevision !== current.subjectRevision ||
        previous.digest !== current.digest
    ) {
        throw new VerificationRequestConflict(current.verificationId);
    }
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

function normalizeCeilings(value: VerificationCeilings): VerificationCeilings {
    return {
        maxManifestBytes: positiveCeiling(value.maxManifestBytes, "maxManifestBytes"),
        maxChecks: positiveCeiling(value.maxChecks, "maxChecks"),
        maxCommandBytes: positiveCeiling(value.maxCommandBytes, "maxCommandBytes"),
        maxCheckTimeoutMs: positiveCeiling(value.maxCheckTimeoutMs, "maxCheckTimeoutMs"),
        maxAggregateTimeoutMs: positiveCeiling(
            value.maxAggregateTimeoutMs,
            "maxAggregateTimeoutMs",
        ),
        maxCheckOutputBytes: positiveCeiling(value.maxCheckOutputBytes, "maxCheckOutputBytes"),
        maxAggregateOutputBytes: positiveCeiling(
            value.maxAggregateOutputBytes,
            "maxAggregateOutputBytes",
        ),
    };
}

function positiveCeiling(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Host ceilings must be positive safe integers (${name})`);
    }

    return value;
}

function assertFields(
    value: unknown,
    allowedKeys: string[],
    label: string,
): asserts value is Record<string, unknown> {
    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
        throw new Error(`Verification ${label} must be a plain object`);
    }

    const keys = Reflect.ownKeys(value);

    if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
        throw new Error(`Verification ${label} contains unsupported fields`);
    }

    if (allowedKeys.some((key) => !Object.hasOwn(value, key))) {
        throw new Error(`Verification ${label} is missing required fields`);
    }
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

function normalizeCwd(value: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.startsWith("/") ||
        value.includes("\\") ||
        value.includes("\0") ||
        /^[A-Za-z]:/.test(value)
    ) {
        throw new Error("Verification cwd must be a workspace-relative path");
    }

    const parts = value.split("/").filter((part) => part !== "" && part !== ".");

    if (parts.some((part) => part === "..")) {
        throw new Error("Verification cwd must be a workspace-relative path");
    }

    return parts.length === 0 ? "." : parts.join("/");
}

function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
