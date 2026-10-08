import type { JsonValue } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";

export type AgentThreadStatus = "uninitialized" | "ready" | "unknown" | "closed";
export type AgentTurnStatus = "reserved" | "submitted" | "completed" | "not-completed" | "unknown";

export type AgentTurnRecord = {
    readonly turnId: string;
    readonly intentCanonical: string;
    readonly intentDigest: string;
    readonly profileFingerprint: string;
    readonly modelFingerprint: string;
    readonly profileInput: JsonValue;
    readonly modelInput: JsonValue;
    readonly requestId: string;
    status: AgentTurnStatus;
    runnerTaskId?: number;
    submissionId?: number;
    answerEntryId?: number;
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
