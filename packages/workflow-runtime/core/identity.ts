import { createHash } from "node:crypto";
import { copyJson, type JsonValue } from "@earendil-works/chord";

/** Canonical, frozen-at-admission identity; key order does not affect a run ID. */
export function canonicalInput(value: JsonValue): {
    readonly input: JsonValue;
    readonly canonical: string;
    readonly digest: string;
} {
    const snapshot = copyJson(value);
    const canonical = canonicalJson(snapshot);

    return {
        input: JSON.parse(canonical) as JsonValue,
        canonical,
        digest: createHash("sha256").update(canonical).digest("hex"),
    };
}

function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Workflow input must contain only finite JSON numbers");
        }

        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }

    const object = value as Record<string, JsonValue>;

    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
        .join(",")}}`;
}

export function freezeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        for (const item of value) {
            freezeJson(item);
        }
    } else if (value !== null && typeof value === "object") {
        for (const item of Object.values(value)) {
            freezeJson(item);
        }
    }

    return value !== null && typeof value === "object"
        ? (Object.freeze(value) as JsonValue)
        : value;
}

/** JSON tuple encoding is unambiguous even when IDs contain separators. */
export function idempotencyKey(runId: string, operationId: string): string {
    // Durable idempotency keys survive restarts and host changes; keep this namespace stable.
    return `pocket-workflow-v1:${Buffer.from(JSON.stringify([runId, operationId]), "utf8").toString("base64url")}`;
}
