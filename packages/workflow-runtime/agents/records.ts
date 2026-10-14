import type { JsonValue } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";

export type WorkflowAgentPolicyBinding = {
    readonly policyId: string;
    readonly policyVersion: string;
    readonly input: JsonValue;
};

export type AgentThreadStatus = "uninitialized" | "ready" | "unknown" | "closed";
export type AgentTurnStatus = "reserved" | "submitted" | "completed" | "not-completed" | "unknown";

export type AgentTurnResultSchema = {
    readonly id: string;
    readonly version: string;
    readonly toolName: string;
    readonly fingerprint: string;
};

export type AgentStructuredResultCandidate = {
    readonly runId: string;
    readonly threadKey: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly conversationId: number;
    readonly requestId: string;
    readonly submissionId: number;
    readonly assistantEntryId: number;
    readonly callId: string;
    readonly toolTaskId: number;
    readonly generationTaskId: number;
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schemaFingerprint: string;
    readonly payload: JsonValue;
};

export type AgentTurnRecord = {
    readonly turnId: string;
    readonly intentCanonical: string;
    readonly intentDigest: string;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly profileInput: JsonValue;
    readonly modelInput: JsonValue;
    readonly authorityFingerprint: string;
    readonly authorityInput: JsonValue;
    readonly effectiveAuthority: JsonValue;
    readonly policyBinding?: WorkflowAgentPolicyBinding;
    readonly requestId: string;
    readonly resultSchema?: AgentTurnResultSchema;
    status: AgentTurnStatus;
    runnerTaskId?: number;
    submissionId?: number;
    answerEntryId?: number;
    candidate?: AgentStructuredResultCandidate;
    result?: JsonValue;
};

export type AgentThreadRecord = {
    readonly schemaVersion: 1;
    readonly threadKey: string;
    status: AgentThreadStatus;
    readonly runId: string;
    readonly threadId: string;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly conversationId: number;
    readonly providerSessionId: string;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly authorityFingerprint?: string;
    readonly authorityInput?: JsonValue;
    readonly ownerTaskId?: number;
    readonly profileInput?: JsonValue;
    readonly modelInput?: JsonValue;
    turns?: AgentTurnRecord[];
    unknownReason?: string;
    nativeRunnerTaskId?: number;
};

/** Session-scoped identity and admission state for one workflow-owned native agent thread. */
export class WorkflowAgentAdmissionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowAgentAdmissionError";
    }
}

export const AGENT_RUNNER_TASK_NAME = "pocket.workflow-runtime.agent-runner";

export const AGENT_THREAD_DOC = defineDocFamily<AgentThreadRecord, string>({
    kind: "pocket.workflow-runtime.agent-thread",
    version: 1,
    scope: "session",
    family: true,
    initial: (threadKey) => ({
        schemaVersion: 1,
        threadKey,
        status: "uninitialized",
        runId: "",
        threadId: "",
        profileId: "",
        profileVersion: 0,
        conversationId: 0,
        providerSessionId: "",
        profileFingerprint: "",
        modelFingerprint: "",
        turns: [],
    }),
});
