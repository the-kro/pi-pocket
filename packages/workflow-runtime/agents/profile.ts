import type { Context, JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { canonicalInput, freezeJson } from "../core/identity.ts";

export type WorkflowAgentModelRoute = {
    readonly provider: string;
    readonly modelId: string;
    readonly api: string;
    /** Bump when provider behavior changes, including secret-bearing route configuration. */
    readonly providerVersion: string;
};

export type WorkflowAgentProfile = {
    readonly id: string;
    readonly version: number;
    readonly instructions: string;
    readonly instructionsVersion: string;
    readonly model: WorkflowAgentModelRoute;
};

export type WorkflowAgentConfig = {
    readonly profiles: readonly WorkflowAgentProfile[];
    readonly buildEnv?: (
        profile: WorkflowAgentProfile,
        target: EnvTarget,
        inherited: ExecutionEnv | undefined,
        context: Context,
    ) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
};

export type AgentThreadIdentity = {
    readonly runId: string;
    readonly threadId: string;
    readonly profileId: string;
};

export type ResolvedWorkflowAgentConfig = {
    readonly profiles: readonly WorkflowAgentProfile[];
    readonly byId: ReadonlyMap<string, WorkflowAgentProfile>;
    readonly buildEnv?: WorkflowAgentConfig["buildEnv"];
};

const PROVIDER_SESSION_PREFIX = "pocket-workflow-agent-v1:";

export function resolveWorkflowAgentConfig(
    config: WorkflowAgentConfig,
): ResolvedWorkflowAgentConfig {
    if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
        throw new TypeError("Agent configuration must contain at least one profile");
    }

    if (config.buildEnv !== undefined && typeof config.buildEnv !== "function") {
        throw new TypeError("Agent buildEnv must be a function");
    }

    const profiles = config.profiles.map((profile) => {
        if (
            profile.id.length === 0 ||
            !Number.isSafeInteger(profile.version) ||
            profile.version < 1 ||
            profile.instructionsVersion.length === 0 ||
            profile.model.provider.length === 0 ||
            profile.model.modelId.length === 0 ||
            profile.model.api.length === 0 ||
            profile.model.providerVersion.length === 0
        ) {
            throw new TypeError(
                "Agent profiles require stable IDs, versions, instructions, and model routes",
            );
        }

        return freezeJson(
            copyJson(profile as unknown as JsonValue),
        ) as unknown as WorkflowAgentProfile;
    });
    const byId = new Map<string, WorkflowAgentProfile>();

    for (const profile of profiles) {
        if (byId.has(profile.id)) {
            throw new TypeError(`Agent profile ${profile.id} is configured more than once`);
        }

        byId.set(profile.id, profile);
    }

    return Object.freeze({
        profiles: Object.freeze(profiles),
        byId,
        ...(config.buildEnv === undefined ? {} : { buildEnv: config.buildEnv }),
    });
}

export function workflowAgentThreadKey(identity: AgentThreadIdentity): string {
    validateIdentity(identity);

    return Buffer.from(
        JSON.stringify([identity.runId, identity.threadId, identity.profileId]),
        "utf8",
    ).toString("base64url");
}

export function workflowAgentProviderSessionId(identity: AgentThreadIdentity): string {
    return `${PROVIDER_SESSION_PREFIX}${workflowAgentThreadKey(identity)}`;
}

export function parseWorkflowAgentProviderSessionId(
    sessionId: string,
): { readonly key: string; readonly identity: AgentThreadIdentity } | undefined {
    if (!sessionId.startsWith(PROVIDER_SESSION_PREFIX)) {
        return undefined;
    }

    const key = sessionId.slice(PROVIDER_SESSION_PREFIX.length);

    try {
        const decoded = Buffer.from(key, "base64url").toString("utf8");
        const values: unknown = JSON.parse(decoded);

        if (
            !Array.isArray(values) ||
            values.length !== 3 ||
            values.some((value) => typeof value !== "string" || value.length === 0) ||
            Buffer.from(decoded, "utf8").toString("base64url") !== key
        ) {
            return undefined;
        }

        const identity = {
            runId: values[0],
            threadId: values[1],
            profileId: values[2],
        };

        return { key, identity };
    } catch {
        return undefined;
    }
}

export function workflowAgentProfileFingerprint(profile: WorkflowAgentProfile): string {
    return canonicalInput(profile as unknown as JsonValue).digest;
}

/**
 * Restrict a configured route to the exact model the host provider publicly lists. This rejects
 * virtual aliases and catalog drift; provider implementation changes require providerVersion bumps.
 */
export function workflowAgentModelFingerprint(
    models: Models,
    profile: WorkflowAgentProfile,
): { readonly model: Model<Api>; readonly fingerprint: string } {
    const model = models.getModel(profile.model.provider, profile.model.modelId);
    const provider = models.getProvider(profile.model.provider);
    const listed = provider
        ?.getModels()
        .find(
            (candidate) =>
                candidate.provider === profile.model.provider &&
                candidate.id === profile.model.modelId &&
                candidate.api === profile.model.api,
        );

    if (
        model === undefined ||
        listed === undefined ||
        model.provider !== profile.model.provider ||
        model.id !== profile.model.modelId ||
        model.api !== profile.model.api ||
        workflowAgentModelIdentityFingerprint(model) !==
            workflowAgentModelIdentityFingerprint(listed)
    ) {
        throw new Error(
            `Agent profile ${profile.id} does not resolve to its declared physical model route`,
        );
    }

    return { model, fingerprint: workflowAgentModelIdentityFingerprint(model) };
}

/**
 * Durable snapshots omit custom header values and URL credentials/path/query; providerVersion tracks meaningful changes
 * to that secret-bearing configuration without storing it in session records.
 */
export function workflowAgentModelIdentityInputs(model: Model<Api>): JsonValue {
    const identity: Record<string, JsonValue> = {};
    const fields = [
        "provider",
        "id",
        "api",
        "name",
        "input",
        "inputLimits",
        "cost",
        "type",
        "reasoning",
        "thinkingLevelMap",
        "promptCache",
        "contextWindow",
        "maxTokens",
        "samplingParams",
        "samplingParamsByThinkingLevel",
        "compat",
    ] as const;

    for (const field of fields) {
        const value = model[field];

        if (value !== undefined) {
            identity[field] = copyJson(value as JsonValue);
        }
    }

    if (model.baseUrl !== undefined) {
        try {
            identity.baseUrlOrigin = new URL(model.baseUrl).origin;
        } catch {
            identity.baseUrlOrigin = "custom";
        }
    }

    return identity;
}

export function workflowAgentModelIdentityFingerprint(model: Model<Api>): string {
    return canonicalInput(workflowAgentModelIdentityInputs(model)).digest;
}

function validateIdentity(identity: AgentThreadIdentity): void {
    if (
        identity.runId.length === 0 ||
        identity.threadId.length === 0 ||
        identity.profileId.length === 0
    ) {
        throw new TypeError("Agent thread identity fields must be non-empty");
    }
}
