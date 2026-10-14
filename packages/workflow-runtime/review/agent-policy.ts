import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { RegistryReader } from "@earendil-works/pi-durable";
import { canonicalInput, freezeJson } from "../core/identity.ts";
import {
    type EffectiveWorkflowAgentAuthority,
    type ResolvedWorkflowAgentConfig,
    type WorkflowAgentAuthorityFloor,
    type WorkflowAgentCallAuthority,
    type WorkflowAgentConfig,
    type WorkflowAgentModelRoute,
    type WorkflowAgentResultBinding,
    resolveWorkflowAgentAuthority,
    resolveWorkflowAgentConfig,
    workflowAgentResultExtensionName,
    workflowAgentResultSchemaFingerprint,
} from "../agents/profile.ts";
import {
    type WorkflowAgentAdmissionPolicy,
    type WorkflowAgentPolicyBinding,
    type WorkflowAgentPolicyProfile,
} from "../agents/admission-policy.ts";
import {
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
    type AgentTurnRecord,
} from "../agents/records.ts";
import {
    createWorkflowAgentResultRegistry,
    createWorkflowAgentStructuredResultExtensions,
} from "../agents/structured-result.ts";
import { createWorkflowAgentSectionRegistry } from "../agents/section-registry.ts";
import {
    type WorkflowAgentProfileSnapshot,
    workflowAgentProfileSnapshot,
} from "../agents/profile-snapshot.ts";

export const WORKFLOW_AGENT_REVIEW_POLICY_ID = "workflow-review";
export const WORKFLOW_AGENT_REVIEW_POLICY_VERSION = "1";

type ResolvedWorkflowAgentReviewConfig = {
    readonly profileAllowlist: readonly string[];
    readonly authority: Required<WorkflowAgentAuthorityFloor>;
};

export type WorkflowAgentReviewConfig = {
    readonly profileAllowlist: readonly string[];
    readonly authority: WorkflowAgentAuthorityFloor;
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

export type WorkflowAgentReviewProfileResolution = {
    readonly descriptor: WorkflowAgentReviewProfileDescriptor;
    readonly snapshot: WorkflowAgentProfileSnapshot;
};

type WorkflowAgentReviewPolicyInput = {
    readonly reviewerIdentity: WorkflowAgentReviewIdentity;
    readonly firstTurn: boolean;
};

/** Bind one exact Review identity and first-turn status into the generic durable agent intent. */
export function createWorkflowAgentReviewPolicyBinding(
    reviewerIdentity: WorkflowAgentReviewIdentity,
    firstTurn: boolean,
): WorkflowAgentPolicyBinding {
    return freezeJson(
        copyJson({
            policyId: WORKFLOW_AGENT_REVIEW_POLICY_ID,
            policyVersion: WORKFLOW_AGENT_REVIEW_POLICY_VERSION,
            input: { reviewerIdentity, firstTurn },
        } as unknown as JsonValue),
    ) as unknown as WorkflowAgentPolicyBinding;
}

/** Compose Review's profile ceiling and admission rules over the generic agent runtime. */
export function createWorkflowAgentReviewAdmissionPolicy(options: {
    readonly models: Models;
    readonly registry: RegistryReader;
    readonly agentConfig: WorkflowAgentConfig;
    readonly reviewConfig: WorkflowAgentReviewConfig;
}): WorkflowAgentAdmissionPolicy {
    const config = resolveWorkflowAgentConfig(options.agentConfig);
    const reviewConfig = resolveWorkflowAgentReviewConfig(config, options.reviewConfig);
    const resultExtensions = createWorkflowAgentStructuredResultExtensions(config.profiles);
    const resultRegistry = createWorkflowAgentResultRegistry(options.registry, resultExtensions);
    const policyRegistry = createWorkflowAgentSectionRegistry(resultRegistry);
    const resolve = (profileId: string) =>
        resolveWorkflowAgentReviewProfile(
            options.models,
            config,
            reviewConfig,
            profileId,
            policyRegistry,
        );

    return {
        resolveProfile(profileId): WorkflowAgentPolicyProfile {
            const resolved = resolve(profileId);

            return {
                descriptor: resolved.descriptor as unknown as JsonValue,
                snapshot: resolved.snapshot,
            };
        },
        validate({ stage, binding, profileId, thread, turn, snapshot }) {
            if (
                binding.policyId !== WORKFLOW_AGENT_REVIEW_POLICY_ID ||
                binding.policyVersion !== WORKFLOW_AGENT_REVIEW_POLICY_VERSION
            ) {
                throw new WorkflowAgentAdmissionError(
                    `Unsupported agent admission policy ${binding.policyId}@${binding.policyVersion}`,
                );
            }

            const input = parseWorkflowAgentReviewPolicyInput(binding.input);
            const resolved = resolve(profileId);

            if (
                !workflowAgentReviewIdentityMatches(resolved, input.reviewerIdentity) ||
                !workflowAgentReviewSnapshotsMatch(resolved.snapshot, snapshot)
            ) {
                throw new WorkflowAgentAdmissionError(
                    `Resolved Review identity changed before turn ${stage}`,
                );
            }

            if (
                !workflowAgentReviewThreadAdmissionMatches(thread, {
                    turnId: turn.turnId,
                    intentCanonical: turn.intentCanonical,
                    intentDigest: turn.intentDigest,
                    firstTurn: input.firstTurn,
                    reviewerIdentity: input.reviewerIdentity,
                })
            ) {
                throw new WorkflowAgentAdmissionError(
                    input.firstTurn
                        ? "Fresh-thread admission requires an uninitialized thread or exact replay of its first turn"
                        : "Review turns require fresh-thread admission or an admitted Review first turn",
                );
            }
        },
    };
}

/** Require a fresh Review first turn or a continuation of that exact admitted Review history. */
export function workflowAgentReviewThreadAdmissionMatches(
    thread: Pick<AgentThreadRecord, "status" | "turns">,
    input: {
        readonly turnId: string;
        readonly intentCanonical: string;
        readonly intentDigest: string;
        readonly firstTurn: boolean;
        readonly reviewerIdentity: unknown;
    },
): boolean {
    const turns = thread.turns ?? [];
    const firstTurn = turns[0];

    if (input.firstTurn) {
        if (thread.status === "uninitialized") {
            return turns.length === 0;
        }

        return (
            turns.filter((turn) => turn.turnId === input.turnId).length === 1 &&
            firstTurn?.turnId === input.turnId &&
            firstTurn.intentCanonical === input.intentCanonical &&
            firstTurn.intentDigest === input.intentDigest &&
            admittedReviewHistoryMatches(turns, input.reviewerIdentity)
        );
    }

    return (
        thread.status !== "uninitialized" &&
        admittedReviewHistoryMatches(turns, input.reviewerIdentity)
    );
}

/** Resolve the configured Review policy and its current effective profile snapshot. */
export function resolveWorkflowAgentReviewProfile(
    models: Models,
    config: ResolvedWorkflowAgentConfig,
    reviewConfig: ResolvedWorkflowAgentReviewConfig,
    profileId: string,
    registry: RegistryReader,
): WorkflowAgentReviewProfileResolution {
    const profile = config.byId.get(profileId);

    if (!reviewConfig.profileAllowlist.includes(profileId) || profile === undefined) {
        throw new WorkflowAgentAdmissionError(
            `Agent profile ${profileId} is not on the Review profile allowlist`,
        );
    }

    const available = resolveWorkflowAgentAuthority(config, profile);
    const resultExtension =
        profile.result === undefined ? undefined : workflowAgentResultExtensionName(profile.result);
    const call: WorkflowAgentCallAuthority = {
        extensions: available.extensions
            .map((entry) => entry.name)
            .filter(
                (name) =>
                    name !== resultExtension && reviewConfig.authority.extensions.includes(name),
            ),
        sections: available.sections
            .map((entry) => entry.key)
            .filter((key) => reviewConfig.authority.sections.includes(key)),
        tools: available.tools
            .map((entry) => entry.name)
            .filter(
                (name) =>
                    name !== profile.result?.toolName &&
                    reviewConfig.authority.tools.includes(name),
            ),
        capabilities: available.capabilities.filter((capability) =>
            reviewConfig.authority.capabilities.includes(capability),
        ),
    };
    const snapshot = workflowAgentProfileSnapshot(models, config, profile, call, registry);
    const resultSchemaFingerprint =
        profile.result === undefined ? null : workflowAgentResultSchemaFingerprint(profile.result);
    const policyFingerprint = canonicalInput({
        profileAllowlist: reviewConfig.profileAllowlist,
        authority: reviewConfig.authority as unknown as JsonValue,
    } as unknown as JsonValue).digest;
    const identityInput = {
        profileId,
        profileFingerprint: snapshot.profileFingerprint,
        modelFingerprint: snapshot.modelFingerprint,
        authorityFingerprint: snapshot.authorityFingerprint,
        policyFingerprint,
        resultSchemaFingerprint,
    };
    const identity = {
        ...identityInput,
        fingerprint: canonicalInput(identityInput as unknown as JsonValue).digest,
    };
    const descriptor = freezeJson(
        copyJson({
            profile: { id: profile.id, version: profile.version },
            instructions: {
                text: profile.instructions,
                version: profile.instructionsVersion,
            },
            model: { ...profile.model, fingerprint: snapshot.modelFingerprint },
            authority: snapshot.authority,
            ...(profile.result === undefined
                ? {}
                : {
                      result: {
                          ...profile.result,
                          fingerprint: resultSchemaFingerprint!,
                      },
                  }),
            identity,
        } as unknown as JsonValue),
    ) as unknown as WorkflowAgentReviewProfileDescriptor;

    return { descriptor, snapshot };
}

export function workflowAgentReviewIdentityMatches(
    resolved: WorkflowAgentReviewProfileResolution,
    expectedIdentity: unknown,
): boolean {
    return sameJsonValue(resolved.descriptor.identity, expectedIdentity);
}

export function workflowAgentReviewResolutionMatches(
    resolved: WorkflowAgentReviewProfileResolution,
    expectedIdentity: unknown,
    expectedAuthority: unknown,
): boolean {
    return (
        workflowAgentReviewIdentityMatches(resolved, expectedIdentity) &&
        sameJsonValue(resolved.snapshot.authority, expectedAuthority)
    );
}

function resolveWorkflowAgentReviewConfig(
    config: ResolvedWorkflowAgentConfig,
    reviewConfig: WorkflowAgentReviewConfig,
): ResolvedWorkflowAgentReviewConfig {
    const profileAllowlist = [...reviewConfig.profileAllowlist];
    const authority = {
        extensions: [...(reviewConfig.authority.extensions ?? [])],
        sections: [...(reviewConfig.authority.sections ?? [])],
        tools: [...(reviewConfig.authority.tools ?? [])],
        capabilities: [...(reviewConfig.authority.capabilities ?? [])],
    };

    if (
        profileAllowlist.length === 0 ||
        profileAllowlist.some(
            (profileId) => typeof profileId !== "string" || profileId.length === 0,
        ) ||
        new Set(profileAllowlist).size !== profileAllowlist.length
    ) {
        throw new TypeError("Review profile allowlist must contain unique non-empty profile IDs");
    }

    for (const profileId of profileAllowlist) {
        if (!config.byId.has(profileId)) {
            throw new TypeError(`Review profile ${profileId} is not configured`);
        }
    }

    for (const [key, values] of Object.entries(authority)) {
        const available = config.authority[key as keyof typeof config.authority];

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

    return Object.freeze({
        profileAllowlist: Object.freeze(profileAllowlist),
        authority: freezeJson(
            authority as unknown as JsonValue,
        ) as unknown as Required<WorkflowAgentAuthorityFloor>,
    });
}

function admittedReviewHistoryMatches(
    turns: readonly AgentTurnRecord[],
    expectedIdentity: unknown,
): boolean {
    return (
        turns.length > 0 &&
        turns.every((turn, index) => {
            const binding = turn.policyBinding;

            if (
                binding === undefined ||
                binding.policyId !== WORKFLOW_AGENT_REVIEW_POLICY_ID ||
                binding.policyVersion !== WORKFLOW_AGENT_REVIEW_POLICY_VERSION
            ) {
                return false;
            }

            try {
                const input = parseWorkflowAgentReviewPolicyInput(binding.input);

                return (
                    input.firstTurn === (index === 0) &&
                    sameJsonValue(input.reviewerIdentity, expectedIdentity)
                );
            } catch {
                return false;
            }
        })
    );
}

function parseWorkflowAgentReviewPolicyInput(value: JsonValue): WorkflowAgentReviewPolicyInput {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new WorkflowAgentAdmissionError("Review policy binding input is malformed");
    }

    const input = value as Record<string, JsonValue>;
    const identity = input.reviewerIdentity;

    if (!Object.hasOwn(input, "firstTurn") || typeof input.firstTurn !== "boolean") {
        throw new WorkflowAgentAdmissionError(
            "Review turns require fresh-thread admission or an admitted Review first turn",
        );
    }

    if (
        Object.keys(input).length !== 2 ||
        !Object.hasOwn(input, "reviewerIdentity") ||
        typeof identity !== "object" ||
        identity === null ||
        Array.isArray(identity)
    ) {
        throw new WorkflowAgentAdmissionError("Review policy binding input is malformed");
    }

    return {
        reviewerIdentity: copyJson(identity) as unknown as WorkflowAgentReviewIdentity,
        firstTurn: input.firstTurn,
    };
}

function workflowAgentReviewSnapshotsMatch(
    left: WorkflowAgentProfileSnapshot,
    right: WorkflowAgentProfileSnapshot,
): boolean {
    return (
        left.profileFingerprint === right.profileFingerprint &&
        left.modelFingerprint === right.modelFingerprint &&
        left.authorityFingerprint === right.authorityFingerprint &&
        sameJsonValue(left.profileInput, right.profileInput) &&
        sameJsonValue(left.modelInput, right.modelInput) &&
        sameJsonValue(left.authorityInput, right.authorityInput) &&
        sameJsonValue(left.authority, right.authority)
    );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    try {
        return (
            canonicalInput(left as JsonValue).canonical ===
            canonicalInput(right as JsonValue).canonical
        );
    } catch {
        return false;
    }
}
