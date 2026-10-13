import type { Context, JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { Api, Model, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
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

export type WorkflowAgentResultBinding = {
    readonly id: string;
    readonly version: string;
    readonly toolName: string;
    readonly schema: JsonValue;
};

export type WorkflowAgentProfile = {
    readonly id: string;
    readonly version: number;
    readonly instructions: string;
    readonly instructionsVersion: string;
    readonly model: WorkflowAgentModelRoute;
    readonly thinkingLevel?: ModelThinkingLevel;
    readonly extensions?: readonly WorkflowAgentExtensionAuthority[];
    readonly sections?: readonly WorkflowAgentSectionAuthority[];
    readonly tools?: readonly WorkflowAgentToolAuthority[];
    readonly capabilities?: readonly string[];
    /** When present, only this schema-bound native result tool can complete a turn. */
    readonly result?: WorkflowAgentResultBinding;
};

export const WORKFLOW_AGENT_RESULT_EXTENSION_VERSION = "1";

export function workflowAgentResultSchemaFingerprint(binding: WorkflowAgentResultBinding): string {
    return canonicalInput({
        id: binding.id,
        version: binding.version,
        toolName: binding.toolName,
        schema: binding.schema,
    } as unknown as JsonValue).digest;
}

export function workflowAgentResultExtensionName(binding: WorkflowAgentResultBinding): string {
    const schemaFingerprint = workflowAgentResultSchemaFingerprint(binding);

    return `pocket.workflow-runtime.agent-result:${Buffer.from(
        JSON.stringify([binding.id, binding.version, binding.toolName, schemaFingerprint]),
        "utf8",
    ).toString("base64url")}`;
}

export type WorkflowAgentExtensionAuthority = {
    readonly name: string;
    readonly version: string;
};

export type WorkflowAgentSectionAuthority = {
    readonly key: string;
    readonly extension: string;
    readonly version: string;
};

export type WorkflowAgentToolAuthority = {
    readonly name: string;
    readonly extension: string;
    readonly version: string;
    readonly capabilities: readonly string[];
};

export type WorkflowAgentAuthorityFloor = {
    readonly extensions?: readonly string[];
    readonly sections?: readonly string[];
    readonly tools?: readonly string[];
    readonly capabilities?: readonly string[];
};

export type WorkflowAgentCallAuthority = {
    readonly extensions?: readonly string[];
    readonly sections?: readonly string[];
    readonly tools?: readonly string[];
    readonly capabilities?: readonly string[];
};

export type EffectiveWorkflowAgentAuthority = {
    readonly delegation: false;
    readonly extensions: readonly WorkflowAgentExtensionAuthority[];
    readonly sections: readonly WorkflowAgentSectionAuthority[];
    readonly tools: readonly WorkflowAgentToolAuthority[];
    readonly capabilities: readonly string[];
};

export type WorkflowAgentReviewIdentity = {
    readonly profileId: string;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly authorityFingerprint: string;
    readonly policyFingerprint: string;
    readonly resultSchemaFingerprint: string | null;
    readonly fingerprint: string;
};

export type WorkflowAgentReviewProfileDescriptor = {
    readonly profile: { readonly id: string; readonly version: number };
    readonly instructions: { readonly text: string; readonly version: string };
    readonly model: WorkflowAgentModelRoute & { readonly fingerprint: string };
    readonly authority: EffectiveWorkflowAgentAuthority;
    readonly result?: WorkflowAgentResultBinding & { readonly fingerprint: string };
    readonly identity: WorkflowAgentReviewIdentity;
};

export type WorkflowAgentReviewConfig = {
    readonly profileAllowlist: readonly string[];
    readonly authority: WorkflowAgentAuthorityFloor;
};

export type WorkflowAgentConfig = {
    readonly profiles: readonly WorkflowAgentProfile[];
    readonly authority?: WorkflowAgentAuthorityFloor;
    readonly review?: WorkflowAgentReviewConfig;
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
    readonly authority: Required<WorkflowAgentAuthorityFloor>;
    readonly review?: {
        readonly profileAllowlist: readonly string[];
        readonly authority: Required<WorkflowAgentAuthorityFloor>;
    };
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

    const authority = {
        extensions: [...(config.authority?.extensions ?? [])],
        sections: [...(config.authority?.sections ?? [])],
        tools: [...(config.authority?.tools ?? [])],
        capabilities: [...(config.authority?.capabilities ?? [])],
    };

    for (const [key, values] of Object.entries(authority)) {
        if (new Set(values).size !== values.length || values.some((value) => value.length === 0)) {
            throw new TypeError(`Agent authority floor ${key} must contain unique non-empty names`);
        }
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

        validateProfileAuthority(profile);

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

    let review: ResolvedWorkflowAgentConfig["review"];

    if (config.review !== undefined) {
        const profileAllowlist = [...config.review.profileAllowlist];
        const reviewAuthority = {
            extensions: [...(config.review.authority.extensions ?? [])],
            sections: [...(config.review.authority.sections ?? [])],
            tools: [...(config.review.authority.tools ?? [])],
            capabilities: [...(config.review.authority.capabilities ?? [])],
        };

        if (
            profileAllowlist.length === 0 ||
            profileAllowlist.some(
                (profileId) => typeof profileId !== "string" || profileId.length === 0,
            ) ||
            new Set(profileAllowlist).size !== profileAllowlist.length
        ) {
            throw new TypeError(
                "Review profile allowlist must contain unique non-empty profile IDs",
            );
        }

        for (const profileId of profileAllowlist) {
            if (!byId.has(profileId)) {
                throw new TypeError(`Review profile ${profileId} is not configured`);
            }
        }

        for (const [key, values] of Object.entries(reviewAuthority)) {
            const available = authority[key as keyof typeof authority];

            if (
                values.some((value) => typeof value !== "string" || value.length === 0) ||
                new Set(values).size !== values.length ||
                values.some((value) => !available.includes(value))
            ) {
                throw new TypeError(
                    `Review authority ceiling ${key} must be a unique subset of the host authority`,
                );
            }
        }

        review = Object.freeze({
            profileAllowlist: Object.freeze(profileAllowlist),
            authority: freezeJson(
                reviewAuthority as unknown as JsonValue,
            ) as unknown as Required<WorkflowAgentAuthorityFloor>,
        });
    }

    return Object.freeze({
        profiles: Object.freeze(profiles),
        byId,
        authority: freezeJson(
            authority as unknown as JsonValue,
        ) as unknown as Required<WorkflowAgentAuthorityFloor>,
        ...(review === undefined ? {} : { review }),
        ...(config.buildEnv === undefined ? {} : { buildEnv: config.buildEnv }),
    });
}

export function resolveWorkflowAgentAuthority(
    config: ResolvedWorkflowAgentConfig,
    profile: WorkflowAgentProfile,
    call: WorkflowAgentCallAuthority = {},
): EffectiveWorkflowAgentAuthority {
    const profileExtensions = profile.extensions ?? [];
    const profileSections = profile.sections ?? [];
    const profileTools = profile.tools ?? [];
    const profileCapabilities = profile.capabilities ?? [];
    const floor = config.authority;
    const resultExtensionName =
        profile.result === undefined ? undefined : workflowAgentResultExtensionName(profile.result);
    const extensions = profileExtensions.filter((entry) => floor.extensions.includes(entry.name));
    const capabilities = profileCapabilities.filter((entry) => floor.capabilities.includes(entry));
    const callExtensions = narrowNames(
        call.extensions?.filter((name) => name !== resultExtensionName),
        extensions.map((entry) => entry.name),
        "extension",
    );
    const callCapabilities = narrowNames(call.capabilities, capabilities, "capability");
    const selectedExtensionNames = new Set(callExtensions);
    const selectedCapabilities = new Set(callCapabilities);
    const sections = profileSections.filter(
        (entry) =>
            floor.sections.includes(entry.key) && selectedExtensionNames.has(entry.extension),
    );
    const tools = profileTools.filter(
        (entry) =>
            floor.tools.includes(entry.name) &&
            selectedExtensionNames.has(entry.extension) &&
            entry.capabilities.every((capability) => selectedCapabilities.has(capability)),
    );
    const availableToolNames = tools.map((entry) => entry.name);
    const requestedTools = call.tools?.filter((name) => name !== profile.result?.toolName);
    const callSections = narrowNames(
        call.sections,
        sections.map((entry) => entry.key),
        "section",
    );
    const callTools = narrowNames(requestedTools, availableToolNames, "tool");
    const selectedSections = new Set(callSections);
    const selectedTools = new Set(callTools);
    const selectedExtensions = extensions.filter((entry) => selectedExtensionNames.has(entry.name));
    const selectedToolsWithResult = tools.filter((entry) => selectedTools.has(entry.name));

    if (profile.result !== undefined) {
        selectedExtensions.push({
            name: resultExtensionName!,
            version: WORKFLOW_AGENT_RESULT_EXTENSION_VERSION,
        });
        selectedToolsWithResult.push({
            name: profile.result.toolName,
            extension: resultExtensionName!,
            version: profile.result.version,
            capabilities: [],
        });
    }

    return freezeJson({
        delegation: false,
        extensions: selectedExtensions,
        sections: sections.filter((entry) => selectedSections.has(entry.key)),
        tools: selectedToolsWithResult,
        capabilities: callCapabilities,
    } as unknown as JsonValue) as unknown as EffectiveWorkflowAgentAuthority;
}

function narrowNames(
    requested: readonly string[] | undefined,
    available: readonly string[],
    kind: string,
): string[] {
    if (requested === undefined) {
        return [...available];
    }

    if (
        requested.some((name) => typeof name !== "string" || name.length === 0) ||
        new Set(requested).size !== requested.length ||
        requested.some((name) => !available.includes(name))
    ) {
        throw new TypeError(`Agent call cannot widen or duplicate its ${kind} authority`);
    }

    return [...requested];
}

function validateProfileAuthority(profile: WorkflowAgentProfile): void {
    const extensions = profile.extensions ?? [];
    const sections = profile.sections ?? [];
    const tools = profile.tools ?? [];
    const capabilities = profile.capabilities ?? [];

    if (profile.result !== undefined) {
        const result = profile.result as WorkflowAgentResultBinding;
        const schema = result.schema;

        if (
            typeof result.id !== "string" ||
            result.id.length === 0 ||
            typeof result.version !== "string" ||
            result.version.length === 0 ||
            typeof result.toolName !== "string" ||
            result.toolName.length === 0 ||
            typeof schema !== "object" ||
            schema === null ||
            Array.isArray(schema) ||
            schema.type !== "object" ||
            typeof schema.properties !== "object" ||
            schema.properties === null ||
            Array.isArray(schema.properties) ||
            tools.some((entry) => entry.name === result.toolName) ||
            extensions.some((entry) => entry.name === workflowAgentResultExtensionName(result))
        ) {
            throw new TypeError(
                `Agent profile ${profile.id} has an invalid structured result binding`,
            );
        }
    }

    const validateUnique = (items: readonly string[], kind: string) => {
        if (
            items.some((item) => typeof item !== "string" || item.length === 0) ||
            new Set(items).size !== items.length
        ) {
            throw new TypeError(`Agent profile ${profile.id} has duplicate or empty ${kind}`);
        }
    };

    validateUnique(
        extensions.map((entry) => entry.name),
        "extensions",
    );
    validateUnique(
        sections.map((entry) => entry.key),
        "sections",
    );
    validateUnique(
        tools.map((entry) => entry.name),
        "tools",
    );
    validateUnique(capabilities, "capabilities");

    for (const extension of extensions) {
        if (extension.version.length === 0) {
            throw new TypeError(`Agent profile ${profile.id} has an unversioned extension`);
        }
    }

    for (const section of sections) {
        if (
            section.extension.length === 0 ||
            section.version.length === 0 ||
            !extensions.some((entry) => entry.name === section.extension)
        ) {
            throw new TypeError(`Agent profile ${profile.id} has an unaudited section`);
        }
    }

    for (const tool of tools) {
        if (
            tool.extension.length === 0 ||
            tool.version.length === 0 ||
            !extensions.some((entry) => entry.name === tool.extension) ||
            tool.capabilities.some((capability) => !capabilities.includes(capability)) ||
            new Set(tool.capabilities).size !== tool.capabilities.length
        ) {
            throw new TypeError(`Agent profile ${profile.id} has an unaudited tool`);
        }
    }
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

export function hasWorkflowAgentProviderSessionIdPrefix(sessionId: string): boolean {
    return sessionId.startsWith(PROVIDER_SESSION_PREFIX);
}

export function parseWorkflowAgentProviderSessionId(
    sessionId: string,
): { readonly key: string; readonly identity: AgentThreadIdentity } | undefined {
    if (!hasWorkflowAgentProviderSessionIdPrefix(sessionId)) {
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
