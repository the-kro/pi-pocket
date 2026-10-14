import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { WorkflowAgentProfileSnapshot } from "./profile-snapshot.ts";
import {
    WorkflowAgentAdmissionError,
    type AgentThreadRecord,
    type AgentTurnRecord,
    type WorkflowAgentPolicyBinding,
} from "./records.ts";

export type { WorkflowAgentPolicyBinding } from "./records.ts";

export type WorkflowAgentAdmissionStage =
    "reservation" | "dispatch" | "tool-execution" | "recovery";

export type WorkflowAgentPolicyTurn = Pick<
    AgentTurnRecord,
    "turnId" | "intentCanonical" | "intentDigest" | "policyBinding"
>;

export type WorkflowAgentPolicyProfile = {
    readonly descriptor: JsonValue;
    readonly snapshot: WorkflowAgentProfileSnapshot;
};

export type WorkflowAgentAdmissionCheck = {
    readonly stage: WorkflowAgentAdmissionStage;
    readonly binding: WorkflowAgentPolicyBinding;
    readonly profileId: string;
    readonly thread: AgentThreadRecord;
    readonly turn: WorkflowAgentPolicyTurn;
    readonly snapshot: WorkflowAgentProfileSnapshot;
};

/** One statically composed policy adapter for protocol-specific profile and turn admission. */
export type WorkflowAgentAdmissionPolicy = {
    readonly resolveProfile?: (profileId: string) => WorkflowAgentPolicyProfile;
    readonly validate: (input: WorkflowAgentAdmissionCheck) => void;
};

export function validateWorkflowAgentAdmission(
    policy: WorkflowAgentAdmissionPolicy | undefined,
    stage: WorkflowAgentAdmissionStage,
    profileId: string,
    thread: AgentThreadRecord,
    turn: WorkflowAgentPolicyTurn,
    snapshot: WorkflowAgentProfileSnapshot,
): void {
    const binding = turn.policyBinding;

    if (binding === undefined) {
        return;
    }

    if (policy === undefined) {
        throw new WorkflowAgentAdmissionError(
            `Agent admission policy ${binding.policyId}@${binding.policyVersion} is not configured`,
        );
    }

    policy.validate({ stage, binding, profileId, thread, turn, snapshot });
}

export function parseWorkflowAgentPolicyBinding(value: JsonValue): WorkflowAgentPolicyBinding {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Agent policy binding must be an object");
    }

    const binding = value as Record<string, JsonValue>;

    if (
        Object.keys(binding).length !== 3 ||
        !Object.hasOwn(binding, "policyId") ||
        !Object.hasOwn(binding, "policyVersion") ||
        !Object.hasOwn(binding, "input") ||
        typeof binding.policyId !== "string" ||
        binding.policyId.length === 0 ||
        typeof binding.policyVersion !== "string" ||
        binding.policyVersion.length === 0
    ) {
        throw new TypeError("Agent policy binding requires policyId, policyVersion, and input");
    }

    return copyJson(binding as unknown as JsonValue) as unknown as WorkflowAgentPolicyBinding;
}
