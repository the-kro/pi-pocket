import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { RegistryReader } from "@earendil-works/pi-durable";
import { canonicalInput, freezeJson } from "../core/identity.ts";
import {
    type ResolvedWorkflowAgentConfig,
    type WorkflowAgentCallAuthority,
    type WorkflowAgentReviewProfileDescriptor,
    resolveWorkflowAgentAuthority,
    workflowAgentResultExtensionName,
    workflowAgentResultSchemaFingerprint,
} from "./profile.ts";
import {
    type AgentThreadRecord,
    type AgentTurnRecord,
    WorkflowAgentAdmissionError,
} from "./records.ts";
import {
    type WorkflowAgentProfileSnapshot,
    workflowAgentProfileSnapshot,
} from "./profile-snapshot.ts";

export type WorkflowAgentReviewProfileResolution = {
    readonly descriptor: WorkflowAgentReviewProfileDescriptor;
    readonly snapshot: WorkflowAgentProfileSnapshot;
};

/** Require a fresh Review first turn or a continuation of that exact admitted Review history. */
export function workflowAgentReviewThreadAdmissionMatches(
    thread: Pick<AgentThreadRecord, "status" | "turns">,
    input: {
        readonly turnId: string;
        readonly intentCanonical: string;
        readonly intentDigest: string;
        readonly freshThread?: boolean;
        readonly reviewerIdentity?: unknown;
    },
): boolean {
    const turns = thread.turns ?? [];
    const firstTurn = turns[0];

    if (input.freshThread === true) {
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
        input.freshThread === false &&
        thread.status !== "uninitialized" &&
        admittedReviewHistoryMatches(turns, input.reviewerIdentity)
    );
}

/** Resolve the configured Review policy and its current effective profile snapshot. */
export function resolveWorkflowAgentReviewProfile(
    models: Models,
    config: ResolvedWorkflowAgentConfig,
    profileId: string,
    registry: RegistryReader,
): WorkflowAgentReviewProfileResolution {
    const review = config.review;
    const profile = config.byId.get(profileId);

    if (review === undefined) {
        throw new WorkflowAgentAdmissionError("Review profile resolution is not configured");
    }

    if (!review.profileAllowlist.includes(profileId) || profile === undefined) {
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
                (name) => name !== resultExtension && review.authority.extensions.includes(name),
            ),
        sections: available.sections
            .map((entry) => entry.key)
            .filter((key) => review.authority.sections.includes(key)),
        tools: available.tools
            .map((entry) => entry.name)
            .filter(
                (name) =>
                    name !== profile.result?.toolName && review.authority.tools.includes(name),
            ),
        capabilities: available.capabilities.filter((capability) =>
            review.authority.capabilities.includes(capability),
        ),
    };
    const snapshot = workflowAgentProfileSnapshot(models, config, profile, call, registry);
    const resultSchemaFingerprint =
        profile.result === undefined ? null : workflowAgentResultSchemaFingerprint(profile.result);
    const policyFingerprint = canonicalInput({
        profileAllowlist: review.profileAllowlist,
        authority: review.authority as unknown as JsonValue,
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

/** Compare the runtime-resolved identity with the value persisted as the caller's expectation. */
export function workflowAgentReviewIdentityMatches(
    resolved: WorkflowAgentReviewProfileResolution,
    expectedIdentity: unknown,
): boolean {
    return sameJsonValue(resolved.descriptor.identity, expectedIdentity);
}

/** Also compare the exact authority snapshot persisted in the native runner input. */
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

function admittedReviewHistoryMatches(
    turns: readonly AgentTurnRecord[],
    expectedIdentity: unknown,
): boolean {
    return (
        turns.length > 0 &&
        turns.every(
            (turn, index) =>
                turn.purpose === "review" &&
                turn.freshThread === (index === 0) &&
                sameJsonValue(turn.reviewerIdentity, expectedIdentity),
        )
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
