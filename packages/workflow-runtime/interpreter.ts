import { randomUUID } from "node:crypto";
import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import {
	type Conversation,
	type ConversationId,
	defineDocFamily,
	defineEntry,
	defineTask,
	type Harness,
	type NextTaskState,
	type RunningTask,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { InvocationCoordinator } from "./invocation.ts";
import { WorkflowTimerHost, type WorkflowTimerOptions } from "./timer-host.ts";

export type StepExecution = {
	readonly idempotencyKey: string;
	readonly attempt: number;
	readonly signal: AbortSignal;
};
export type StepRecovery<T extends JsonValue> =
	| { readonly status: "completed"; readonly result: T }
	| { readonly status: "retry" };
export type WorkflowDoOptions<T extends JsonValue> = {
	readonly retries?: number;
	readonly recover?: (execution: StepExecution) => StepRecovery<T> | Promise<StepRecovery<T>>;
};
export type WorkflowStep = {
	do<T extends JsonValue>(
		stepId: string,
		callback: (execution: StepExecution) => T | Promise<T>,
		options?: WorkflowDoOptions<T>,
	): Promise<T>;
	sleepUntil(stepId: string, wakeAt: number): Promise<void>;
	sleep(stepId: string, durationMs: number): Promise<void>;
	waitForEvent(stepId: string, name: string): Promise<{ readonly eventId: string; readonly payload: JsonValue }>;
	runChild<I extends JsonValue, O extends JsonValue>(
		stepId: string,
		definition: WorkflowDefinition<I, O>,
		input: I,
	): Promise<O>;
};
export type WorkflowCall<I extends JsonValue, O extends JsonValue> = (scope: {
	readonly input: I;
	readonly step: WorkflowStep;
}) => Promise<O>;
export type WorkflowDefinition<I extends JsonValue, O extends JsonValue> = {
	readonly name: string;
	readonly version: number;
	readonly run: WorkflowCall<I, O>;
};
export type WorkflowHandle<O extends JsonValue = JsonValue> = { readonly id: string; readonly result?: O };
export type WorkflowInspection = Pick<WorkflowState, "status" | "currentStep" | "steps">;

type WorkflowError = { message: string; name: string };
type WorkflowWait =
	| { kind: "sleep"; stepId: string; wakeAt: number }
	| { kind: "event"; stepId: string; name: string }
	| { kind: "child"; stepId: string; workflowId: string; taskId: TaskId };
type WorkflowSignal = { eventId: string; name: string; payload: JsonValue; consumedBy: string | null };
// Locator and mailbox fields are authoritative host state. Status/steps/results
// are observational history and survive Pi terminal checkpoint disposal.
type WorkflowState = {
	workflowId: string;
	conversationId: number;
	taskId: number;
	workflowName: string;
	workflowVersion: number;
	status: "running" | "waiting" | "completed" | "failed" | "aborted";
	currentStep: string | null;
	waitingFor: WorkflowWait | null;
	events: WorkflowSignal[];
	steps: Record<
		string,
		{
			status: "running" | "recovering" | "waiting" | "completed" | "failed";
			attempt: number;
			retryCount: number;
			recoveryCount: number;
			result?: JsonValue;
			error?: WorkflowError;
		}
	>;
	result?: JsonValue;
	error?: WorkflowError;
};
type WorkflowTaskInput = {
	workflowId: string;
	workflowName: string;
	workflowVersion: number;
	input: JsonValue;
};
type DoStep =
	| {
			kind: "do";
			status: "running" | "recovering";
			attempt: number;
			retries: number;
			retryCount: number;
			recoveryCount: number;
			recoverEnabled: boolean;
	  }
	| {
			kind: "do";
			status: "completed";
			attempt: number;
			retries: number;
			retryCount: number;
			recoveryCount: number;
			recoverEnabled: boolean;
			result: JsonValue;
	  }
	| {
			kind: "do";
			status: "failed";
			attempt: number;
			retries: number;
			retryCount: number;
			recoveryCount: number;
			recoverEnabled: boolean;
			retryPending: boolean;
			retryable: boolean;
			error: WorkflowError;
	  };
type SleepStep =
	| { kind: "sleep"; status: "waiting"; wakeAt: number; durationMs?: number }
	| { kind: "sleep"; status: "completed"; wakeAt: number; durationMs?: number };
type EventStep =
	| { kind: "event"; status: "waiting"; name: string }
	| { kind: "event"; status: "completed"; name: string; eventId: string; payload: JsonValue };
type ChildStep = {
	kind: "child";
	status: "waiting" | "completed" | "failed";
	workflowId: string;
	taskId: TaskId;
	workflowName: string;
	workflowVersion: number;
	input: JsonValue;
	result?: JsonValue;
	error?: WorkflowError;
};
type StepRecord = DoStep | SleepStep | EventStep | ChildStep;
type WorkflowCheckpoint = { phase: "run"; steps: Record<string, StepRecord> };
// These are semantic facts chosen by primitives, never inferred from checkpoint diffs.
// Optional fields preserve the original journal envelopes, including sparse completions.
type WorkflowEventFields = {
	"workflow.started": { data: string };
	"workflow.completed": object;
	"workflow.failed": { data: WorkflowError | "aborted" };
	"workflow.timer.waiting": { stepId: string; data: number };
	"workflow.event.received": { data: { eventId: string; name: string; payload: JsonValue } };
	"workflow.event.waiting": { stepId: string; data: string };
	"workflow.event.consumed": { stepId: string; data: { eventId: string; name: string } };
	"workflow.child.started": { stepId: string; data: string };
	"workflow.child.completed": { stepId: string; data: string };
	"workflow.child.failed": { stepId: string; data: WorkflowError };
	"step.started": { stepId: string };
	"step.attempt.started": { stepId: string; attempt: number; data: string };
	"step.attempt.interrupted": { stepId: string; attempt: number };
	"step.attempt.failed": {
		stepId: string;
		attempt: number;
		data: { error: WorkflowError; retryable: boolean; retryPending: boolean; retryCount: number };
	};
	"step.retry.started": { stepId: string; attempt: number; data: number };
	"step.recovery.started": { stepId: string; attempt: number; data: number };
	"step.recovery.failed": { stepId: string; data: WorkflowError };
	"step.recovery.retry": { stepId: string; attempt: number };
	"step.reconciled": { stepId: string; attempt: number; data: number };
	"step.completed": { stepId: string; attempt?: number; data?: number };
};
type WorkflowEvent = {
	[K in keyof WorkflowEventFields]: { type: K; workflowId: string } & WorkflowEventFields[K];
}[keyof WorkflowEventFields];

/** Envelope only: callers explicitly select meaning, payload and append order. */
function workflowEvent<K extends keyof WorkflowEventFields>(
	workflowId: string,
	type: K,
	fields: WorkflowEventFields[K],
): { type: K; workflowId: string } & WorkflowEventFields[K] {
	return { type, workflowId, ...fields };
}

const definitions = new Map<string, WorkflowDefinition<JsonValue, JsonValue>>();
const WorkflowStateDoc = defineDocFamily<WorkflowState, string>({
	kind: "spike.workflow.state",
	version: 1,
	scope: "session",
	family: true,
	initial: (workflowId) => ({
		workflowId,
		conversationId: 0,
		taskId: 0,
		workflowName: "",
		workflowVersion: 1,
		status: "running",
		currentStep: null,
		waitingFor: null,
		events: [],
		steps: {},
	}),
});
const WorkflowJournal = defineEntry<WorkflowEvent>("spike.workflow.event");

class SuspendWorkflow extends Error {
	constructor() {
		super("workflow invocation suspended");
	}
}

export class NonRetryableError extends Error {}

export function workflow<I extends JsonValue, O extends JsonValue = JsonValue>(
	name: string,
	run: WorkflowCall<I, O>,
	options: { readonly version?: number } = {},
): WorkflowDefinition<I, O> {
	if (name.length === 0) throw new TypeError("Workflow name must be non-empty");
	const definition: WorkflowDefinition<I, O> = { name, version: options.version ?? 1, run };
	definitions.set(name, definition as unknown as WorkflowDefinition<JsonValue, JsonValue>);
	return definition;
}

type WorkflowRuntime = TaskRuntime<WorkflowTaskInput, WorkflowCheckpoint, JsonValue, object>;
type WorkflowRunningTask = RunningTask<WorkflowTaskInput, WorkflowCheckpoint, JsonValue>;
type WorkflowTransition = {
	status: WorkflowState["status"];
	currentStep: string | null;
	waitingFor?: WorkflowWait;
	step?: { id: string; record: StepRecord };
	events: WorkflowEvent | readonly WorkflowEvent[];
	next:
		| { status: "running" }
		| Omit<Extract<NextTaskState<WorkflowCheckpoint, JsonValue>, { status: "waiting" }>, "checkpoint">
		| {
				status: "terminal";
				outcome:
					| { status: "completed"; result: JsonValue }
					| { status: "failed"; error: WorkflowError }
					| { status: "aborted"; reason: string };
		  };
};

function projectStep(record: StepRecord): WorkflowState["steps"][string] {
	return {
		status: record.status,
		attempt: record.kind === "do" ? record.attempt : 0,
		retryCount: record.kind === "do" ? record.retryCount : 0,
		recoveryCount: record.kind === "do" ? record.recoveryCount : 0,
		...(record.kind === "do" && record.status === "completed"
			? { result: record.result }
			: record.kind === "event" && record.status === "completed"
				? { result: record.payload }
				: record.kind === "child" && record.status === "completed"
					? { result: record.result }
					: {}),
		...(record.kind === "do" && record.status === "failed"
			? { error: record.error }
			: record.kind === "child" && record.status === "failed"
				? { error: record.error }
				: {}),
	};
}

/** One task-state writer. Custom mailbox/child work runs inside the same commit. */
async function writeTransition(
	workflowId: string,
	runtime: WorkflowRuntime,
	context: Context,
	operation:
		| WorkflowTransition
		| ((tx: Tx, state: WorkflowState, current: WorkflowRunningTask) => Promise<WorkflowTransition>),
): Promise<void> {
	await runtime.commit(async (tx, current) => {
		const state = await tx.doc(WorkflowStateDoc, workflowId, workflowId);
		const transition = typeof operation === "function" ? await operation(tx, state, current) : operation;
		const checkpoint = current.state.checkpoint;
		const nextSteps = { ...checkpoint.steps };
		state.status = transition.status;
		state.currentStep = transition.currentStep;
		state.waitingFor = transition.waitingFor ?? null;
		if (transition.step !== undefined) {
			const { id, record } = transition.step;
			nextSteps[id] = record;
			// This is historical observational state, not a replacement checkpoint.
			// Keep it after terminalization, when Pi discards the checkpoint.
			state.steps = { ...state.steps, [id]: projectStep(record) };
		}
		if (transition.next.status === "terminal") {
			const outcome = transition.next.outcome;
			if (outcome.status === "completed") state.result = outcome.result;
			if (outcome.status === "failed") state.error = outcome.error;
		}
		for (const event of Array.isArray(transition.events) ? transition.events : [transition.events]) {
			await tx.appendEntry(WorkflowJournal, current.conversationId, { data: event });
		}
		if (transition.next.status === "terminal") return transition.next;
		return { ...transition.next, checkpoint: { ...checkpoint, steps: nextSteps } };
	}, context);
}

export const WorkflowTask = defineTask<WorkflowTaskInput, WorkflowCheckpoint, JsonValue>({
	name: "spike.workflow",
	version: 1,
	initial: () => ({ phase: "run", steps: {} }),
	phases: {
		run: async (task, runtime, context) => {
			const definition = definitions.get(task.input.workflowName);
			if (definition === undefined || definition.version !== task.input.workflowVersion) {
				await finishFailure(task, runtime, context, {
					message: `Workflow definition ${task.input.workflowName}@${task.input.workflowVersion} is unavailable`,
					name: "WorkflowDefinitionError",
				});
				return;
			}

			const steps = new Map(Object.entries(task.state.checkpoint.steps));
			const invocation = new InvocationCoordinator();
			const visited = new Set<string>();
			const ensureStep = (stepId: string, kind: StepRecord["kind"]): StepRecord | undefined => {
				invocation.ensureWorkflowOrigin();
				if (stepId.length === 0) throw new TypeError("Workflow step ID must be non-empty");
				if (visited.has(stepId))
					throw new Error(`Workflow step ${stepId} was called more than once in one invocation`);
				visited.add(stepId);
				const found = steps.get(stepId);
				if (found !== undefined && found.kind !== kind) {
					throw new Error(`Workflow step ${stepId} changed kind from ${found.kind} to ${kind}`);
				}
				return found;
			};
			const saveRunningStep = async (
				stepId: string,
				record: StepRecord,
				events: WorkflowEvent | readonly WorkflowEvent[],
			): Promise<void> => {
				await writeTransition(task.input.workflowId, runtime, context, {
					status: "running",
					currentStep: stepId,
					events,
					step: { id: stepId, record },
					next: { status: "running" },
				});
				steps.set(stepId, record);
			};
			const sleepStep = async (stepId: string, wakeAt: number, durationMs?: number): Promise<void> => {
				const prior = ensureStep(stepId, "sleep") as SleepStep | undefined;
				if (prior !== undefined && prior.durationMs !== durationMs) {
					throw new Error(`Workflow sleep ${stepId} changed its sleep mode or duration`);
				}
				if (prior?.status === "completed") {
					if (prior.wakeAt !== wakeAt) throw new Error(`Workflow sleep ${stepId} changed its absolute deadline`);
					return;
				}
				if (prior?.status === "waiting" && prior.wakeAt !== wakeAt) {
					throw new Error(`Workflow sleep ${stepId} changed its absolute deadline`);
				}
				if (prior?.status === "waiting" && runtime.now() >= prior.wakeAt) {
					await saveRunningStep(
						stepId,
						{
							kind: "sleep",
							status: "completed",
							wakeAt: prior.wakeAt,
							...(durationMs === undefined ? {} : { durationMs }),
						},
						workflowEvent(task.input.workflowId, "step.completed", { stepId }),
					);
					return;
				}

				const durableWakeAt = prior?.wakeAt ?? wakeAt;
				if (!Number.isSafeInteger(durableWakeAt))
					throw new TypeError("step.sleepUntil() requires an integer deadline");
				await invocation.preparePark();
				const sleep: SleepStep = {
					kind: "sleep",
					status: "waiting",
					wakeAt: durableWakeAt,
					...(durationMs === undefined ? {} : { durationMs }),
				};
				await writeTransition(task.input.workflowId, runtime, context, {
					status: "waiting",
					currentStep: stepId,
					waitingFor: { kind: "sleep", stepId, wakeAt: durableWakeAt },
					step: { id: stepId, record: sleep },
					events: workflowEvent(task.input.workflowId, "workflow.timer.waiting", { stepId, data: durableWakeAt }),
					next: { status: "waiting", on: [], policy: "allSettled", external: true },
				});
				invocation.commitPark();
				throw new SuspendWorkflow();
			};
			// Effect attempts, explicit recovery and retries; only effect callbacks carry ALS origin.
			const doStep = <T extends JsonValue>(
				stepId: string,
				callback: (execution: StepExecution) => T | Promise<T>,
				options: WorkflowDoOptions<T> = {},
			): Promise<T> => {
				const admissionFailure = invocation.admitEffect();
				if (admissionFailure !== undefined) return Promise.reject(admissionFailure);
				const operation = (async (): Promise<T> => {
					let prior = ensureStep(stepId, "do") as DoStep | undefined;
					const retries = options.retries ?? 0;
					if (!Number.isSafeInteger(retries) || retries < 0)
						throw new TypeError("step.do retries must be a non-negative integer");
					const recoverEnabled = options.recover !== undefined;
					if (prior !== undefined && (prior.retries !== retries || prior.recoverEnabled !== recoverEnabled)) {
						throw new Error(`Workflow step ${stepId} changed its retry or recovery policy`);
					}
					if (prior?.status === "completed") return prior.result as T;
					if (prior?.status === "failed" && !prior.retryPending) throw errorFrom(prior.error);

					if (
						prior !== undefined &&
						(prior.status === "running" || prior.status === "recovering") &&
						options.recover !== undefined
					) {
						const recoveryCount = prior.recoveryCount + 1;
						const execution: StepExecution = {
							idempotencyKey: `${task.input.workflowId}/${stepId}`,
							attempt: prior.attempt,
							signal: runtime.signal,
						};
						const recovering: DoStep = { ...prior, status: "recovering", recoveryCount };
						await saveRunningStep(
							stepId,
							recovering,
							workflowEvent(task.input.workflowId, "step.recovery.started", {
								stepId,
								attempt: prior.attempt,
								data: recoveryCount,
							}),
						);
						let recovered: StepRecovery<T>;
						try {
							recovered = await options.recover(execution);
						} catch (error) {
							const detail = errorRecord(error);
							const failed: DoStep = {
								kind: "do",
								status: "failed",
								attempt: prior.attempt,
								retries,
								retryCount: prior.retryCount,
								recoveryCount,
								recoverEnabled,
								retryPending: false,
								retryable: false,
								error: detail,
							};
							await saveRunningStep(
								stepId,
								failed,
								workflowEvent(task.input.workflowId, "step.recovery.failed", { stepId, data: detail }),
							);
							throw error;
						}
						if (recovered.status === "completed") {
							const result = copyJson(recovered.result);
							const completed: DoStep = { ...recovering, status: "completed", result };
							await saveRunningStep(stepId, completed, [
								workflowEvent(task.input.workflowId, "step.reconciled", {
									stepId,
									attempt: prior.attempt,
									data: recoveryCount,
								}),
								workflowEvent(task.input.workflowId, "step.completed", {
									stepId,
									attempt: prior.attempt,
								}),
							]);
							return result as T;
						}
						prior = { ...recovering, status: "running" };
						await saveRunningStep(
							stepId,
							prior,
							workflowEvent(task.input.workflowId, "step.recovery.retry", { stepId, attempt: prior.attempt }),
						);
					}

					for (;;) {
						const attempt: number = (prior?.attempt ?? 0) + 1;
						const retryCount: number = prior?.retryCount ?? 0;
						const recoveryCount: number = prior?.recoveryCount ?? 0;
						const nextAttempt: DoStep = {
							kind: "do",
							status: "running",
							attempt,
							retries,
							retryCount,
							recoveryCount,
							recoverEnabled,
						};
						const startEvents: WorkflowEvent[] = [
							...(prior === undefined
								? [workflowEvent(task.input.workflowId, "step.started", { stepId })]
								: prior.status === "failed"
									? [
											workflowEvent(task.input.workflowId, "step.retry.started", {
												stepId,
												attempt,
												data: retryCount,
											}),
										]
									: [
											workflowEvent(task.input.workflowId, "step.attempt.interrupted", {
												stepId,
												attempt: prior.attempt,
											}),
										]),
							workflowEvent(task.input.workflowId, "step.attempt.started", {
								stepId,
								attempt,
								data: `${task.input.workflowId}/${stepId}`,
							}),
						];
						await saveRunningStep(stepId, nextAttempt, startEvents);
						try {
							const result = copyJson(
								await invocation.runCallback(stepId, () =>
									callback({
										idempotencyKey: `${task.input.workflowId}/${stepId}`,
										attempt,
										signal: runtime.signal,
									}),
								),
							);
							await saveRunningStep(
								stepId,
								{ ...nextAttempt, status: "completed", result },
								workflowEvent(task.input.workflowId, "step.completed", {
									stepId,
									attempt,
									data: retryCount,
								}),
							);
							return result as T;
						} catch (error) {
							if (error instanceof SuspendWorkflow || steps.get(stepId)?.status === "completed") throw error;
							const detail = errorRecord(error);
							const retryable = !(error instanceof NonRetryableError);
							const retryPending = retryable && retryCount < retries;
							const failed: DoStep = {
								kind: "do",
								status: "failed",
								attempt,
								retries,
								retryCount: retryCount + (retryPending ? 1 : 0),
								recoveryCount,
								recoverEnabled,
								retryPending,
								retryable,
								error: detail,
							};
							await saveRunningStep(
								stepId,
								failed,
								workflowEvent(task.input.workflowId, "step.attempt.failed", {
									stepId,
									attempt,
									data: { error: detail, retryable, retryPending, retryCount: failed.retryCount },
								}),
							);
							if (!retryPending) throw error;
							prior = failed;
						}
					}
				})();
				return invocation.track(operation);
			};

			// Relative sleep validation preserves the saved deadline on replay.
			const relativeSleepStep = async (stepId: string, durationMs: number): Promise<void> => {
				if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
					throw new TypeError("step.sleep() requires a non-negative integer duration");
				}
				const prior = steps.get(stepId);
				if (prior !== undefined && (prior.kind !== "sleep" || prior.durationMs !== durationMs)) {
					throw new Error(`Workflow sleep ${stepId} changed its sleep mode or duration`);
				}
				const wakeAt = prior?.kind === "sleep" ? prior.wakeAt : runtime.now() + durationMs;
				await sleepStep(stepId, wakeAt, durationMs);
			};

			// Mailbox consumption and the alternative external park are one atomic choice.
			const eventStep = async (stepId: string, name: string) => {
				const prior = ensureStep(stepId, "event") as EventStep | undefined;
				if (prior !== undefined && prior.name !== name) {
					throw new Error(`Workflow event wait ${stepId} changed event name`);
				}
				if (prior?.status === "completed") return { eventId: prior.eventId, payload: prior.payload };
				let matched: WorkflowSignal | undefined;
				await invocation.preparePark();
				await writeTransition(task.input.workflowId, runtime, context, async (_tx, state) => {
					const available = state.events.find((event) => event.name === name && event.consumedBy === null);
					matched = available === undefined ? undefined : (copyJson(available) as WorkflowSignal);
					if (matched !== undefined) {
						const eventStep: EventStep = {
							kind: "event",
							status: "completed",
							name,
							eventId: matched.eventId,
							payload: matched.payload,
						};
						state.events = state.events.map((event) =>
							event.eventId === matched!.eventId ? { ...event, consumedBy: stepId } : event,
						);
						return {
							status: "running",
							currentStep: stepId,
							step: { id: stepId, record: eventStep },
							events: [
								workflowEvent(task.input.workflowId, "workflow.event.consumed", {
									stepId,
									data: { eventId: matched.eventId, name },
								}),
								workflowEvent(task.input.workflowId, "step.completed", { stepId }),
							],
							next: { status: "running" },
						};
					}
					return {
						status: "waiting",
						currentStep: stepId,
						waitingFor: { kind: "event", stepId, name },
						step: { id: stepId, record: { kind: "event", status: "waiting", name } },
						events: workflowEvent(task.input.workflowId, "workflow.event.waiting", { stepId, data: name }),
						next: { status: "waiting", on: [], policy: "allSettled", external: true },
					};
				});
				if (matched !== undefined) {
					invocation.clearParkRequest();
					return { eventId: matched.eventId, payload: matched.payload };
				}
				invocation.commitPark();
				throw new SuspendWorkflow();
			};

			// Owned child creation, Task join, and memoized outcome are distinct from external wakes.
			const childStep = async <I extends JsonValue, O extends JsonValue>(
				stepId: string,
				childDefinition: WorkflowDefinition<I, O>,
				input: I,
			): Promise<O> => {
				const prior = ensureStep(stepId, "child") as ChildStep | undefined;
				const inputSnapshot = copyJson(input);
				const childWorkflowId = `${task.input.workflowId}/${encodeURIComponent(stepId)}`;
				if (prior !== undefined) {
					if (
						prior.workflowId !== childWorkflowId ||
						prior.workflowName !== childDefinition.name ||
						prior.workflowVersion !== childDefinition.version ||
						JSON.stringify(prior.input) !== JSON.stringify(inputSnapshot)
					) {
						throw new Error(`Workflow child step ${stepId} changed its definition or input`);
					}
					if (prior.status === "completed") return prior.result as O;
					if (prior.status === "failed")
						throw errorFrom(prior.error ?? { name: "ChildWorkflowError", message: stepId });
				} else {
					await invocation.preparePark();
					await writeTransition(task.input.workflowId, runtime, context, async (tx) => {
						const childState = await tx.doc(WorkflowStateDoc, childWorkflowId, childWorkflowId);
						if (childState.taskId !== 0) throw new Error(`Workflow child ${childWorkflowId} already exists`);
						const childTaskId = await tx.createTask(
							WorkflowTask,
							{
								workflowId: childWorkflowId,
								workflowName: childDefinition.name,
								workflowVersion: childDefinition.version,
								input: inputSnapshot,
							},
							{ ownership: { kind: "task", taskId: task.id } },
						);
						const childStep: ChildStep = {
							kind: "child",
							status: "waiting",
							workflowId: childWorkflowId,
							taskId: childTaskId,
							workflowName: childDefinition.name,
							workflowVersion: childDefinition.version,
							input: inputSnapshot,
						};
						childState.taskId = childTaskId;
						childState.conversationId = task.conversationId;
						childState.workflowName = childDefinition.name;
						childState.workflowVersion = childDefinition.version;
						childState.status = "running";
						return {
							status: "waiting",
							currentStep: stepId,
							waitingFor: { kind: "child", stepId, workflowId: childWorkflowId, taskId: childTaskId },
							step: { id: stepId, record: childStep },
							events: [
								workflowEvent(task.input.workflowId, "workflow.child.started", {
									stepId,
									data: childWorkflowId,
								}),
								workflowEvent(childWorkflowId, "workflow.started", { data: childDefinition.name }),
							],
							next: { status: "waiting", on: [childTaskId], policy: "allSettled" },
						};
					});
					invocation.commitPark();
					throw new SuspendWorkflow();
				}

				const childTask = await runtime.getTask(prior.taskId, context);
				if (childTask === undefined) throw new Error(`Workflow child task ${prior.taskId} is missing`);
				if (childTask.state.status !== "terminal") {
					await invocation.preparePark();
					await writeTransition(task.input.workflowId, runtime, context, {
						status: "waiting",
						currentStep: stepId,
						waitingFor: { kind: "child", stepId, workflowId: prior.workflowId, taskId: prior.taskId },
						events: [],
						next: { status: "waiting", on: [prior.taskId], policy: "allSettled" },
					});
					invocation.commitPark();
					throw new SuspendWorkflow();
				}

				const outcome = childTask.state.outcome;
				if (outcome.status === "completed") {
					const result = copyJson(outcome.result);
					const completed: ChildStep = { ...prior, status: "completed", result };
					await saveRunningStep(
						stepId,
						completed,
						workflowEvent(task.input.workflowId, "workflow.child.completed", {
							stepId,
							data: prior.workflowId,
						}),
					);
					return result as O;
				}
				const detail: WorkflowError = {
					name: outcome.status,
					message:
						outcome.status === "failed" || outcome.status === "faulted"
							? outcome.error.message
							: outcome.status === "aborted"
								? (outcome.reason ?? "Child workflow aborted")
								: outcome.reason,
				};
				const failed: ChildStep = { ...prior, status: "failed", error: detail };
				await saveRunningStep(
					stepId,
					failed,
					workflowEvent(task.input.workflowId, "workflow.child.failed", { stepId, data: detail }),
				);
				throw errorFrom(detail);
			};

			const step: WorkflowStep = {
				do: doStep,
				sleepUntil: (stepId, wakeAt) => sleepStep(stepId, wakeAt),
				sleep: relativeSleepStep,
				waitForEvent: eventStep,
				runChild: childStep,
			};

			try {
				const result = await definition.run({ input: task.input.input, step });
				await invocation.drainEffects();
				if (invocation.parked) return;
				await writeTransition(task.input.workflowId, runtime, context, {
					status: "completed",
					currentStep: null,
					events: workflowEvent(task.input.workflowId, "workflow.completed", {}),
					next: { status: "terminal", outcome: { status: "completed", result } },
				});
			} catch (error) {
				let failure = error;
				try {
					await invocation.drainEffects();
				} catch (drainedError) {
					if (failure instanceof SuspendWorkflow) failure = drainedError;
				}
				if (failure instanceof SuspendWorkflow) return;
				invocation.clearParkRequest();
				if (invocation.parked) {
					runtime.report(failure);
					return;
				}
				await finishFailure(task, runtime, context, errorRecord(failure));
			}
		},
	},
	abort: async (task, runtime, context) => {
		await writeTransition(task.input.workflowId, runtime, context, {
			status: "aborted",
			currentStep: null,
			events: workflowEvent(task.input.workflowId, "workflow.failed", { data: "aborted" }),
			next: { status: "terminal", outcome: { status: "aborted", reason: "Workflow aborted" } },
		});
	},
});

export class WorkflowEngine {
	readonly #harness: Harness;
	readonly #timerHost: WorkflowTimerHost<WorkflowCheckpoint>;
	#opened = false;
	#closed = false;

	constructor(harness: Harness, options: WorkflowTimerOptions) {
		this.#harness = harness;
		this.#timerHost = new WorkflowTimerHost<WorkflowCheckpoint>(
			harness,
			WorkflowTask.definition.name,
			(checkpoint) =>
				Object.values(checkpoint.steps).find(
					(step): step is Extract<SleepStep, { status: "waiting" }> =>
						step.kind === "sleep" && step.status === "waiting",
				)?.wakeAt,
			options,
		);
	}

	async open(context: Context): Promise<void> {
		if (this.#opened) return;
		if (this.#closed) throw new Error("WorkflowEngine is closed");
		this.#opened = true;
		await this.#timerHost.open(context);
		this.#harness.resume();
	}

	async start<I extends JsonValue, O extends JsonValue>(
		definition: WorkflowDefinition<I, O>,
		input: I,
		conversation: Conversation,
		context: Context,
	): Promise<WorkflowHandle<O>> {
		if (!this.#opened || this.#closed) throw new Error("WorkflowEngine.open() must precede start()");
		const workflowId = randomUUID();
		await conversation.commit(async (tx) => {
			const state = await tx.doc(WorkflowStateDoc, workflowId, workflowId);
			const taskId = await tx.createTask(
				WorkflowTask,
				{ workflowId, workflowName: definition.name, workflowVersion: definition.version, input },
				{ ownership: { kind: "conversation" } },
			);
			state.taskId = taskId;
			state.conversationId = conversation.id;
			state.workflowName = definition.name;
			state.workflowVersion = definition.version;
			state.status = "running";
			await tx.appendEntry(WorkflowJournal, conversation.id, {
				data: workflowEvent(workflowId, "workflow.started", { data: definition.name }),
			});
		}, context);
		return { id: workflowId };
	}

	async sendEvent(
		handle: WorkflowHandle,
		eventId: string,
		name: string,
		payload: JsonValue,
		context: Context,
	): Promise<boolean> {
		if (eventId.length === 0 || name.length === 0) throw new TypeError("Event ID and name must be non-empty");
		const safePayload = copyJson(payload);
		return this.#harness.commit(async (tx) => {
			const state = await tx.doc(WorkflowStateDoc, handle.id, handle.id);
			if (state.taskId === 0) throw new Error(`Workflow ${handle.id} does not exist`);
			const duplicate = state.events.find((event) => event.eventId === eventId);
			if (duplicate !== undefined) {
				if (duplicate.name !== name || JSON.stringify(duplicate.payload) !== JSON.stringify(safePayload)) {
					throw new Error(`Workflow event ID ${eventId} was reused with different content`);
				}
				return false;
			}
			if (state.status === "completed" || state.status === "failed" || state.status === "aborted") {
				throw new Error(`Workflow ${handle.id} is already ${state.status}`);
			}
			await tx.wakeTask(state.taskId as unknown as TaskId, `event:${eventId}`);
			state.events = [...state.events, { eventId, name, payload: safePayload, consumedBy: null }];
			await tx.appendEntry(WorkflowJournal, state.conversationId as unknown as ConversationId, {
				data: workflowEvent(handle.id, "workflow.event.received", {
					data: { eventId, name, payload: safePayload },
				}),
			});
			return true;
		}, context);
	}

	async inspect(handle: WorkflowHandle, context: Context): Promise<WorkflowInspection> {
		const state = await this.#harness.snapshot(WorkflowStateDoc, handle.id, context);
		if (state === undefined) throw new Error(`Workflow ${handle.id} does not exist`);
		return { status: state.status, currentStep: state.currentStep, steps: state.steps };
	}

	async wait<O extends JsonValue>(handle: WorkflowHandle<O>, context: Context): Promise<O> {
		const state = await this.#harness.snapshot(WorkflowStateDoc, handle.id, context);
		if (state === undefined) throw new Error(`Workflow ${handle.id} does not exist`);
		const receipt = await this.#harness.waitForTask(state.taskId as unknown as TaskId<O>, context);
		const outcome = receipt.state.outcome;
		if (outcome.status === "completed") return outcome.result as O;
		if (outcome.status === "failed" || outcome.status === "faulted") {
			throw errorFrom({ name: "TaskError", message: outcome.error.message });
		}
		throw new Error(`Workflow ${handle.id} ended with ${outcome.status}`);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#timerHost.close();
	}
}

async function finishFailure(
	task: { readonly conversationId: ConversationId; readonly input: WorkflowTaskInput },
	runtime: TaskRuntime<WorkflowTaskInput, WorkflowCheckpoint, JsonValue, object>,
	context: Context,
	error: WorkflowError,
): Promise<void> {
	await writeTransition(task.input.workflowId, runtime, context, {
		status: "failed",
		currentStep: null,
		events: workflowEvent(task.input.workflowId, "workflow.failed", { data: error }),
		next: { status: "terminal", outcome: { status: "failed", error } },
	});
}

function errorRecord(error: unknown): WorkflowError {
	return {
		message: error instanceof Error ? error.message : String(error),
		name: error instanceof Error ? error.name : "Error",
	};
}

function errorFrom(error: WorkflowError): Error {
	return new Error(error.message, { cause: error.name });
}
