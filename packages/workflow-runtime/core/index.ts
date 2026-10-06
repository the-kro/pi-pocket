import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import {
	defineDocFamily,
	defineEntry,
	defineExtension,
	defineTask,
	type Harness,
	type NextTaskState,
	type RunningTask,
	type TaskId,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { canonicalInput, freezeJson, idempotencyKey } from "./identity.ts";
import { observeStopCall, RunControl, StopFailures } from "./run-control.ts";

export type WorkflowErrorRecord = {
	readonly name: string;
	readonly message: string;
	readonly operationId?: string;
	readonly attemptId?: string;
};
export type StepExecution = {
	readonly idempotencyKey: string;
	readonly attempt: number;
	readonly attemptId: string;
	readonly signal: AbortSignal;
};
export type RecoveryResult<T extends JsonValue> =
	| { readonly status: "completed"; readonly result: T }
	| { readonly status: "retry" }
	| { readonly status: "unknown" };
export type InterruptedPolicy = "fail" | "reconcile" | "retry";
export type StepDoOptions<T extends JsonValue> = {
	readonly retries?: number;
	readonly interrupted?: InterruptedPolicy;
	readonly reconcile?: (
		execution: StepExecution,
	) => RecoveryResult<T> | Promise<RecoveryResult<T>>;
};
export type WorkflowStep = {
	do<T extends JsonValue>(
		operationId: string,
		callback: (execution: StepExecution) => T | Promise<T>,
		options?: StepDoOptions<T>,
	): Promise<T>;
};
export type WorkflowContext<I extends JsonValue> = {
	readonly input: I;
	readonly step: WorkflowStep;
	readonly signal: AbortSignal;
};
export type WorkflowDefinition<
	I extends JsonValue = JsonValue,
	O extends JsonValue = JsonValue,
> = {
	readonly id: string;
	readonly version: number;
	run(context: WorkflowContext<I>): O | Promise<O>;
};
export type WorkflowHandle<O extends JsonValue = JsonValue> = {
	readonly runId: string;
	readonly result?: O;
};
export type WorkflowInspection = {
	readonly runId: string;
	readonly workflowId: string;
	readonly workflowVersion: number;
	readonly status:
		| "running"
		| "completed"
		| "failed"
		| "stopped"
		| "incompatible";
	readonly operations: Readonly<
		Record<
			string,
			{
				readonly status: "running" | "unknown" | "completed" | "failed";
				readonly latestAttempt: number;
				readonly error?: string;
			}
		>
	>;
	readonly operationsTruncated: number;
	/** Native Task selection may precede descendant cleanup. Inspect native descendants for failures. */
	readonly cleanup?: {
		readonly status: "pending" | "native-settled";
		readonly nativeTaskId: number;
	};
};

export type WorkflowOutcome =
	| { readonly status: "completed" }
	| { readonly status: "failed"; readonly error: WorkflowErrorRecord }
	| { readonly status: "stopped"; readonly reason: string };
type OperationProjection = {
	status: "running" | "unknown" | "completed" | "failed";
	latestAttempt: number;
	error?: string;
};
export type WorkflowRunRecord = {
	runId: string;
	workflowId: string;
	workflowVersion: number;
	input: JsonValue;
	inputCanonical: string;
	inputDigest: string;
	conversationId: number;
	taskId: number;
	status: WorkflowInspection["status"];
	operations: Record<string, OperationProjection>;
	operationOrder: string[];
	operationsTruncated?: number;
	selectedOutcome?: WorkflowOutcome;
	stopCommand?: { readonly reason: string; readonly request: number };
	cleanup?: { readonly status: "pending" };
};
type WorkflowTaskInput = {
	runId: string;
	workflowId: string;
	workflowVersion: number;
	input: JsonValue;
	inputDigest: string;
};
type AttemptRecord = {
	attempt: number;
	attemptId: string;
	status: "running" | "unknown" | "completed" | "failed";
	error?: WorkflowErrorRecord;
};
type OperationCheckpoint = {
	status: "running" | "unknown" | "completed" | "failed";
	latestAttempt: number;
	attempts: AttemptRecord[];
	retries: number;
	interrupted: InterruptedPolicy;
	reconcileEnabled: boolean;
	knownFailures: number;
	retryable?: boolean;
	reconciliationPending?: boolean;
	result?: JsonValue;
	error?: WorkflowErrorRecord;
};
export type WorkflowCheckpoint = {
	phase: "run";
	operations: Record<string, OperationCheckpoint>;
	control?: {
		/** The exact revision already reserved for a native selection attempt. */
		request: number;
		reason: string;
		receipt: "reserved" | "rejected";
	};
};
export type WorkflowRuntime = TaskRuntime<
	WorkflowTaskInput,
	WorkflowCheckpoint,
	JsonValue,
	object
>;
export type WorkflowRunningTask = RunningTask<
	WorkflowTaskInput,
	WorkflowCheckpoint,
	JsonValue
>;
type WorkflowEvent =
	| {
			readonly type: "workflow.started";
			readonly runId: string;
			readonly workflowId: string;
			readonly workflowVersion: number;
			readonly inputDigest: string;
	  }
	| { readonly type: "workflow.completed"; readonly runId: string }
	| {
			readonly type: "workflow.failed";
			readonly runId: string;
			readonly error: WorkflowErrorRecord;
	  }
	| {
			readonly type: "workflow.stopped";
			readonly runId: string;
			readonly reason: string;
	  }
	| {
			readonly type:
				| "operation.started"
				| "operation.completed"
				| "operation.failed"
				| "operation.interrupted"
				| "operation.reconciled"
				| "operation.retry_started";
			readonly runId: string;
			readonly operationId: string;
			readonly attempt: number;
			readonly attemptId: string;
			readonly idempotencyKey: string;
			readonly error?: WorkflowErrorRecord;
			readonly resolution?: "completed" | "retry" | "unknown";
	  };

export const RUN_DOC = defineDocFamily<WorkflowRunRecord, string>({
	kind: "pocket.workflow-runtime.run",
	version: 1,
	scope: "session",
	family: true,
	initial: (runId) => ({
		runId,
		workflowId: "",
		workflowVersion: 0,
		input: null,
		inputCanonical: "",
		inputDigest: "",
		conversationId: 0,
		taskId: 0,
		status: "running",
		operations: {},
		operationOrder: [],
	}),
});
const JOURNAL = defineEntry<WorkflowEvent>("pocket.workflow-runtime.event");
type DefinitionRegistry = Map<string, WorkflowDefinition<JsonValue, JsonValue>>;
const definitions: DefinitionRegistry = new Map();
const MAX_ERROR_LENGTH = 1_000;

export class NonRetryableError extends Error {}

export class UnknownOperationError extends Error {
	readonly operationId: string;
	readonly attemptId: string;

	constructor(
		operationId: string,
		attemptId: string,
		detail = "The durable operation outcome cannot be proven",
	) {
		super(`${detail}: ${operationId} (${attemptId})`);
		this.name = "UnknownOperationError";
		this.operationId = operationId;
		this.attemptId = attemptId;
	}
}

export class WorkflowStoppedError extends Error {
	constructor(runId: string, reason: string) {
		super(`Workflow ${runId} stopped: ${reason}`);
		this.name = "WorkflowStoppedError";
	}
}

export class WorkflowRunError extends Error {
	readonly workflowName: string;

	constructor(runId: string, error: WorkflowErrorRecord) {
		super(`Workflow ${runId} failed (${error.name}): ${error.message}`);
		this.name = "WorkflowRunError";
		this.workflowName = error.name;
	}
}

export function defineWorkflow<I extends JsonValue, O extends JsonValue>(
	definition: WorkflowDefinition<I, O>,
): WorkflowDefinition<I, O> {
	if (definition.id.length === 0)
		throw new TypeError("Workflow ID must be non-empty");
	if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
		throw new TypeError("Workflow version must be a positive safe integer");
	}
	if (typeof definition.run !== "function")
		throw new TypeError("Workflow run must be a function");
	return Object.freeze({
		id: definition.id,
		version: definition.version,
		run: definition.run,
	});
}

export const recovery = {
	completed<T extends JsonValue>(result: T): RecoveryResult<T> {
		return { status: "completed", result };
	},
	retry<T extends JsonValue = JsonValue>(): RecoveryResult<T> {
		return { status: "retry" };
	},
	unknown<T extends JsonValue = JsonValue>(): RecoveryResult<T> {
		return { status: "unknown" };
	},
} as const;

function definitionKey(id: string, version: number): string {
	return JSON.stringify([id, version]);
}

function errorRecord(error: unknown): WorkflowErrorRecord {
	const message = error instanceof Error ? error.message : String(error);
	return {
		name: error instanceof Error ? error.name : "Error",
		message: message.slice(0, MAX_ERROR_LENGTH),
		...(error instanceof UnknownOperationError
			? { operationId: error.operationId, attemptId: error.attemptId }
			: {}),
	};
}

function errorFrom(record: WorkflowErrorRecord): Error {
	const error = new Error(record.message);
	error.name = record.name;
	return error;
}

async function writeEvent(
	tx: Tx,
	conversationId: number,
	event: WorkflowEvent,
): Promise<void> {
	await tx.appendEntry(JOURNAL, conversationId as never, { data: event });
}

const MAX_OPERATION_SUMMARIES = 64;

const defaultStopFailures = new StopFailures();

class ObservedEffect<T> extends Promise<T> {
	#observe: () => void;
	#trackDerived: (promise: Promise<unknown>) => () => void;
	#insideFinally = false;
	constructor(
		source: Promise<T> | ConstructorParameters<typeof Promise<T>>[0],
		observe?: () => void,
		trackDerived?: (promise: Promise<unknown>) => () => void,
	) {
		super(
			typeof source === "function"
				? source
				: (resolve, reject) => {
						void source.then(resolve, reject);
					},
		);
		this.#observe = observe ?? (() => {});
		this.#trackDerived = trackDerived ?? (() => () => {});
		if (observe !== undefined) {
			// Suppress Node's process-level unhandled event without marking the
			// author's operation as observed by the workflow body.
			void Promise.prototype.then.call(this, undefined, () => {});
		}
	}
	// biome-ignore lint/suspicious/noThenProperty: Override native Promise observation for terminal drain semantics.
	override then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): ObservedEffect<TResult1 | TResult2> {
		if (!this.#insideFinally && onrejected != null) this.#observe();
		const child = super.then(onfulfilled, onrejected) as ObservedEffect<
			TResult1 | TResult2
		>;
		const parentObserve = this.#observe;
		child.#trackDerived = this.#trackDerived;
		const observeBranch = this.#trackDerived(child);
		child.#observe = () => {
			observeBranch();
			parentObserve();
		};
		return child;
	}
	override finally(onfinally?: (() => void) | null): ObservedEffect<T> {
		// Native finally installs a rejection handler that only rethrows; it is
		// not an author's catch. Its descendant still carries the observer.
		this.#insideFinally = true;
		try {
			return this.then(
				(value) => Promise.resolve(onfinally?.()).then(() => value),
				(error) =>
					Promise.resolve(onfinally?.()).then(() => {
						throw error;
					}),
			) as ObservedEffect<T>;
		} finally {
			this.#insideFinally = false;
		}
	}
}

class InvocationEffects {
	#accepting = true;
	readonly #pending = new Set<Promise<unknown>>();
	readonly #unhandled = new Set<{ error: unknown }>();

	track<T>(effect: () => Promise<T>): Promise<T> {
		if (!this.#accepting)
			return Promise.reject(
				new Error("Workflow operation admission is closed"),
			);
		let promise: Promise<T>;
		try {
			promise = effect();
		} catch (error) {
			promise = Promise.reject(error);
		}
		this.#pending.add(promise);
		let observed = false;
		let rejected: { error: unknown } | undefined;
		const observe = () => {
			observed = true;
			if (rejected !== undefined) this.#unhandled.delete(rejected);
		};
		void promise.then(
			() => this.#pending.delete(promise),
			(error: unknown) => {
				this.#pending.delete(promise);
				if (!observed) {
					rejected = { error };
					this.#unhandled.add(rejected);
				}
			},
		);
		// await/Promise.all attach a rejection observer. A detached Promise
		// retains its failure for the terminal drain without changing its API.
		return new ObservedEffect(promise, observe, (branch) =>
			this.trackDerived(branch),
		);
	}

	private trackDerived(branch: Promise<unknown>): () => void {
		this.#pending.add(branch);
		let observed = false;
		let rejected: { error: unknown } | undefined;
		void Promise.prototype.then.call(
			branch,
			() => {
				this.#pending.delete(branch);
			},
			(error: unknown) => {
				this.#pending.delete(branch);
				if (!observed) {
					rejected = { error };
					this.#unhandled.add(rejected);
				}
			},
		);
		return () => {
			observed = true;
			if (rejected !== undefined) this.#unhandled.delete(rejected);
		};
	}

	closeAdmission(): void {
		this.#accepting = false;
	}

	async drain(): Promise<{ failed: boolean; error: unknown }> {
		this.closeAdmission();
		while (this.#pending.size > 0) {
			// Promise.allSettled assimilates thenables and would mark every branch
			// observed, even a detached one. Wait without invoking overridden then.
			await Promise.all(
				[...this.#pending].map(
					(branch) =>
						new Promise<void>((resolve) => {
							void Promise.prototype.then.call(branch, resolve, resolve);
						}),
				),
			);
		}
		return {
			failed: this.#unhandled.size > 0,
			error: this.#unhandled.values().next().value?.error,
		};
	}
}

function attemptId(key: string, number: number): string {
	return `${key}:attempt:${number}`;
}

function summarizeOperation(
	run: WorkflowRunRecord,
	operationId: string,
	operation: OperationCheckpoint,
): void {
	const operations = copyJson(run.operations) as Record<
		string,
		OperationProjection
	>;
	const order = [...run.operationOrder];
	if (!Object.hasOwn(operations, operationId)) order.push(operationId);
	Object.defineProperty(operations, operationId, {
		value: {
			status: operation.status,
			latestAttempt: operation.latestAttempt,
			...(operation.error === undefined
				? {}
				: { error: operation.error.message }),
		},
		writable: true,
		enumerable: true,
		configurable: true,
	});
	while (order.length > MAX_OPERATION_SUMMARIES) {
		delete operations[order.shift()!];
		run.operationsTruncated = (run.operationsTruncated ?? 0) + 1;
	}
	run.operations = operations;
	run.operationOrder = order;
}

function operationEvent(
	type: Extract<
		WorkflowEvent,
		{ readonly type: `operation.${string}` }
	>["type"],
	runId: string,
	operationId: string,
	operation: OperationCheckpoint,
	resolution?: "completed" | "retry" | "unknown",
): WorkflowEvent {
	const latest = operation.attempts.at(-1);
	if (latest === undefined)
		throw new Error(`Operation ${operationId} has no attempt`);
	return {
		type,
		runId,
		operationId,
		attempt: latest.attempt,
		attemptId: latest.attemptId,
		idempotencyKey: idempotencyKey(runId, operationId),
		...(latest.error === undefined ? {} : { error: latest.error }),
		...(resolution === undefined ? {} : { resolution }),
	} as WorkflowEvent;
}

async function persistOperation(
	runId: string,
	operationId: string,
	operation: OperationCheckpoint,
	runtime: WorkflowRuntime,
	context: Context,
	events: readonly WorkflowEvent[],
): Promise<void> {
	await runtime.commit(async (tx, current) => {
		const run = await tx.doc(RUN_DOC, runId, runId);
		if (
			run.stopCommand !== undefined &&
			events.some(
				(event) =>
					event.type === "operation.started" ||
					event.type === "operation.retry_started",
			)
		) {
			throw new WorkflowStoppedError(runId, run.stopCommand.reason);
		}
		const operations = {
			...current.state.checkpoint.operations,
			[operationId]: operation,
		};
		summarizeOperation(
			run as unknown as WorkflowRunRecord,
			operationId,
			operation,
		);
		for (const event of events)
			await writeEvent(tx, current.conversationId, event);
		return {
			status: "running",
			checkpoint: { ...current.state.checkpoint, operations },
		};
	}, context);
}

export async function chooseTerminalInTransaction(
	tx: Tx,
	current: WorkflowRunningTask,
	run: WorkflowRunRecord,
	requested: WorkflowOutcome,
	result: JsonValue,
): Promise<NextTaskState<WorkflowCheckpoint, JsonValue>> {
	if (run.selectedOutcome !== undefined)
		throw new Error(`Workflow ${run.runId} already has a selected outcome`);
	const selected = requested;
	for (const [operationId, operation] of Object.entries(
		current.state.checkpoint.operations,
	)) {
		if (operation.status !== "running") continue;
		const latest = operation.attempts.at(-1);
		if (latest === undefined) continue;
		const unknown: OperationCheckpoint = {
			...operation,
			status: "unknown",
			attempts: [
				...operation.attempts.slice(0, -1),
				{ ...latest, status: "unknown" },
			],
			reconciliationPending: operation.interrupted === "reconcile",
		};
		summarizeOperation(run, operationId, unknown);
		await writeEvent(
			tx,
			current.conversationId,
			operationEvent("operation.interrupted", run.runId, operationId, unknown),
		);
	}
	run.status = selected.status;
	run.selectedOutcome = selected;
	if (selected.status === "completed") {
		await writeEvent(tx, current.conversationId, {
			type: "workflow.completed",
			runId: run.runId,
		});
		return { status: "terminal", outcome: { status: "completed", result } };
	}
	if (selected.status === "failed") {
		await writeEvent(tx, current.conversationId, {
			type: "workflow.failed",
			runId: run.runId,
			error: selected.error,
		});
		return {
			status: "terminal",
			outcome: {
				status: "failed",
				error: {
					message: selected.error.message,
					detail: {
						name: selected.error.name,
						...(selected.error.operationId === undefined
							? {}
							: { operationId: selected.error.operationId }),
						...(selected.error.attemptId === undefined
							? {}
							: { attemptId: selected.error.attemptId }),
					},
				},
			},
		};
	}
	run.cleanup = { status: "pending" };
	await writeEvent(tx, current.conversationId, {
		type: "workflow.stopped",
		runId: run.runId,
		reason: selected.reason,
	});
	return {
		status: "terminal",
		outcome: { status: "aborted", reason: selected.reason },
	};
}

async function reconcileOperation<T extends JsonValue>(
	operationId: string,
	runId: string,
	operation: OperationCheckpoint,
	options: StepDoOptions<T>,
	runtime: WorkflowRuntime,
	context: Context,
	signal: AbortSignal,
): Promise<{ readonly result?: T; readonly retry?: OperationCheckpoint }> {
	if (
		options.reconcile === undefined ||
		operation.reconciliationPending !== true
	) {
		const latest = operation.attempts.at(-1);
		throw new UnknownOperationError(
			operationId,
			latest?.attemptId ?? "missing-attempt",
		);
	}
	const latest = operation.attempts.at(-1);
	if (latest === undefined)
		throw new UnknownOperationError(operationId, "missing-attempt");
	const execution: StepExecution = {
		idempotencyKey: idempotencyKey(runId, operationId),
		attempt: latest.attempt,
		attemptId: latest.attemptId,
		signal,
	};
	let decision: RecoveryResult<T>;
	try {
		decision = await options.reconcile(execution);
	} catch (error) {
		throw new UnknownOperationError(
			operationId,
			latest.attemptId,
			`Reconciliation did not prove an outcome (${errorRecord(error).message})`,
		);
	}
	if (decision.status === "completed") {
		let result: T;
		try {
			result = copyJson(decision.result) as T;
		} catch (error) {
			throw new UnknownOperationError(
				operationId,
				latest.attemptId,
				`Reconciliation returned a non-JSON result (${errorRecord(error).message})`,
			);
		}
		const completed: OperationCheckpoint = {
			...operation,
			status: "completed",
			reconciliationPending: false,
			result,
			attempts: [
				...operation.attempts.slice(0, -1),
				{ ...latest, status: "completed" },
			],
		};
		await persistOperation(runId, operationId, completed, runtime, context, [
			operationEvent(
				"operation.reconciled",
				runId,
				operationId,
				completed,
				"completed",
			),
		]);
		return { result };
	}
	if (decision.status === "unknown") {
		const unresolved: OperationCheckpoint = {
			...operation,
			status: "unknown",
			reconciliationPending: false,
		};
		await persistOperation(runId, operationId, unresolved, runtime, context, [
			operationEvent(
				"operation.reconciled",
				runId,
				operationId,
				unresolved,
				"unknown",
			),
		]);
		throw new UnknownOperationError(operationId, latest.attemptId);
	}
	if (decision.status !== "retry")
		throw new UnknownOperationError(
			operationId,
			latest.attemptId,
			"Reconciliation returned an invalid decision",
		);
	const number = operation.latestAttempt + 1;
	const key = idempotencyKey(runId, operationId);
	const next: OperationCheckpoint = {
		status: "running",
		latestAttempt: number,
		attempts: [
			...operation.attempts,
			{ attempt: number, attemptId: attemptId(key, number), status: "running" },
		],
		retries: operation.retries,
		interrupted: operation.interrupted,
		reconcileEnabled: operation.reconcileEnabled,
		knownFailures: operation.knownFailures,
	};
	await persistOperation(runId, operationId, next, runtime, context, [
		operationEvent(
			"operation.reconciled",
			runId,
			operationId,
			operation,
			"retry",
		),
		operationEvent("operation.retry_started", runId, operationId, next),
	]);
	return { retry: next };
}

async function executeOperation<T extends JsonValue>(
	task: WorkflowRunningTask,
	runtime: WorkflowRuntime,
	context: Context,
	signal: AbortSignal,
	operationId: string,
	callback: (execution: StepExecution) => T | Promise<T>,
	options: StepDoOptions<T>,
): Promise<T> {
	const runId = task.input.runId;
	const retries = options.retries ?? 0;
	const interrupted = options.interrupted ?? "fail";
	if (!Number.isSafeInteger(retries) || retries < 0)
		throw new TypeError("step.do retries must be a non-negative integer");
	if (interrupted === "reconcile" && options.reconcile === undefined) {
		throw new TypeError(
			"step.do interrupted='reconcile' requires a reconciler",
		);
	}
	const reconcileEnabled = options.reconcile !== undefined;
	let operation = Object.hasOwn(task.state.checkpoint.operations, operationId)
		? task.state.checkpoint.operations[operationId]
		: undefined;
	if (
		operation !== undefined &&
		(operation.retries !== retries ||
			operation.interrupted !== interrupted ||
			operation.reconcileEnabled !== reconcileEnabled)
	) {
		throw new Error(
			`Workflow operation ${operationId} changed its retry or interruption policy`,
		);
	}
	if (operation?.status === "completed")
		return copyJson(operation.result as T) as T;
	// Only a running attempt reconstructed from the checkpoint is interrupted.
	// A reconciler-authorized attempt was admitted in this invocation.
	const reconstructedRunning = operation?.status === "running";
	if (operation?.status === "unknown") {
		if (
			interrupted !== "reconcile" ||
			operation.reconciliationPending !== true
		) {
			const latest = operation.attempts.at(-1);
			throw new UnknownOperationError(
				operationId,
				latest?.attemptId ?? "missing-attempt",
			);
		}
		const recovered = await reconcileOperation(
			operationId,
			runId,
			operation,
			options,
			runtime,
			context,
			signal,
		);
		if (recovered.result !== undefined) return recovered.result as T;
		operation = recovered.retry;
	}
	if (reconstructedRunning && operation?.status === "running") {
		const latest = operation.attempts.at(-1);
		if (latest === undefined)
			throw new UnknownOperationError(operationId, "missing-attempt");
		const interruptedOperation: OperationCheckpoint = {
			...operation,
			status: "unknown",
			attempts: [
				...operation.attempts.slice(0, -1),
				{ ...latest, status: "unknown" },
			],
			reconciliationPending: interrupted === "reconcile",
		};
		if (interrupted === "reconcile") {
			await persistOperation(
				runId,
				operationId,
				interruptedOperation,
				runtime,
				context,
				[
					operationEvent(
						"operation.interrupted",
						runId,
						operationId,
						interruptedOperation,
					),
				],
			);
			const recovered = await reconcileOperation(
				operationId,
				runId,
				interruptedOperation,
				options,
				runtime,
				context,
				signal,
			);
			if (recovered.result !== undefined) return recovered.result as T;
			operation = recovered.retry;
		} else if (interrupted === "retry") {
			const number = operation.latestAttempt + 1;
			const key = idempotencyKey(runId, operationId);
			operation = {
				status: "running",
				latestAttempt: number,
				attempts: [
					...interruptedOperation.attempts,
					{
						attempt: number,
						attemptId: attemptId(key, number),
						status: "running",
					},
				],
				retries,
				interrupted,
				reconcileEnabled,
				knownFailures: operation.knownFailures,
			};
			await persistOperation(runId, operationId, operation, runtime, context, [
				operationEvent(
					"operation.interrupted",
					runId,
					operationId,
					interruptedOperation,
				),
				operationEvent(
					"operation.retry_started",
					runId,
					operationId,
					operation,
				),
			]);
		} else {
			await persistOperation(
				runId,
				operationId,
				interruptedOperation,
				runtime,
				context,
				[
					operationEvent(
						"operation.interrupted",
						runId,
						operationId,
						interruptedOperation,
					),
				],
			);
			throw new UnknownOperationError(operationId, latest.attemptId);
		}
	}
	if (operation?.status === "unknown") {
		const latest = operation.attempts.at(-1);
		throw new UnknownOperationError(
			operationId,
			latest?.attemptId ?? "missing-attempt",
		);
	}
	if (operation?.status === "failed") {
		if (!operation.retryable || operation.knownFailures > retries)
			throw errorFrom(
				operation.error ?? { name: "Error", message: "Operation failed" },
			);
	}
	if (operation === undefined || operation.status === "failed") {
		const number = (operation?.latestAttempt ?? 0) + 1;
		const key = idempotencyKey(runId, operationId);
		const first: OperationCheckpoint = {
			status: "running",
			latestAttempt: number,
			attempts: [
				...(operation?.attempts ?? []),
				{
					attempt: number,
					attemptId: attemptId(key, number),
					status: "running",
				},
			],
			retries,
			interrupted,
			reconcileEnabled,
			knownFailures: operation?.knownFailures ?? 0,
		};
		await persistOperation(runId, operationId, first, runtime, context, [
			operation === undefined
				? operationEvent("operation.started", runId, operationId, first)
				: operationEvent("operation.retry_started", runId, operationId, first),
		]);
		operation = first;
	}
	for (;;) {
		if (operation === undefined || operation.status !== "running")
			throw new Error(`Operation ${operationId} has no runnable attempt`);
		const latest = operation.attempts.at(-1);
		if (latest === undefined)
			throw new Error(`Operation ${operationId} has no attempt record`);
		const execution: StepExecution = {
			idempotencyKey: idempotencyKey(runId, operationId),
			attempt: latest.attempt,
			attemptId: latest.attemptId,
			signal,
		};
		let value: T;
		try {
			value = await callback(execution);
		} catch (error) {
			if (signal.aborted) {
				if (signal.reason instanceof WorkflowStoppedError) throw signal.reason;
				throw new UnknownOperationError(
					operationId,
					latest.attemptId,
					"The operation callback was interrupted before its outcome was known",
				);
			}
			const detail = errorRecord(error);
			const retryable = !(error instanceof NonRetryableError);
			const failed: OperationCheckpoint = {
				...operation,
				status: "failed",
				attempts: [
					...operation.attempts.slice(0, -1),
					{ ...latest, status: "failed", error: detail },
				],
				knownFailures: operation.knownFailures + 1,
				retryable,
				error: detail,
			};
			await persistOperation(runId, operationId, failed, runtime, context, [
				operationEvent("operation.failed", runId, operationId, failed),
			]);
			if (!retryable || failed.knownFailures > retries) throw error;
			const nextNumber = failed.latestAttempt + 1;
			const key = idempotencyKey(runId, operationId);
			operation = {
				status: "running",
				latestAttempt: nextNumber,
				attempts: [
					...failed.attempts,
					{
						attempt: nextNumber,
						attemptId: attemptId(key, nextNumber),
						status: "running",
					},
				],
				retries,
				interrupted,
				reconcileEnabled,
				knownFailures: failed.knownFailures,
			};
			await persistOperation(runId, operationId, operation, runtime, context, [
				operationEvent(
					"operation.retry_started",
					runId,
					operationId,
					operation,
				),
			]);
			continue;
		}
		let result: T;
		try {
			result = copyJson(value) as T;
		} catch (error) {
			throw new UnknownOperationError(
				operationId,
				latest.attemptId,
				`Callback completed with an unpersistable result (${errorRecord(error).message})`,
			);
		}
		const completed: OperationCheckpoint = {
			...operation,
			status: "completed",
			result,
			attempts: [
				...operation.attempts.slice(0, -1),
				{ ...latest, status: "completed" },
			],
		};
		try {
			await persistOperation(runId, operationId, completed, runtime, context, [
				operationEvent("operation.completed", runId, operationId, completed),
			]);
		} catch (error) {
			if (signal.aborted && signal.reason instanceof WorkflowStoppedError)
				throw signal.reason;
			throw new UnknownOperationError(
				operationId,
				latest.attemptId,
				`Callback succeeded but completion was not durably committed (${errorRecord(error).message})`,
			);
		}
		return result;
	}
}

function makeWorkflowStep(
	task: WorkflowRunningTask,
	runtime: WorkflowRuntime,
	context: Context,
	effects: InvocationEffects,
	signal: AbortSignal,
): WorkflowStep {
	const visited = new Set<string>();
	return {
		do: (operationId, callback, options = {}) => {
			if (operationId.length === 0)
				return Promise.reject(
					new TypeError("Workflow operation ID must be non-empty"),
				);
			if (visited.has(operationId))
				return Promise.reject(
					new Error(
						`Workflow operation ${operationId} was called more than once in one invocation`,
					),
				);
			visited.add(operationId);
			return effects.track(() =>
				executeOperation(
					task,
					runtime,
					context,
					signal,
					operationId,
					callback,
					options,
				),
			);
		},
	};
}

type TaskResult = JsonValue;
function createWorkflowTask(
	definitions: DefinitionRegistry,
	stopFailures: StopFailures,
) {
	return defineTask<WorkflowTaskInput, WorkflowCheckpoint, TaskResult>({
		name: "pocket.workflow-runtime.task",
		version: 1,
		initial: () => ({ phase: "run", operations: {} }),
		phases: {
			run: async (task, runtime, context) => {
				const stopController = new AbortController();
				const signal = AbortSignal.any([runtime.signal, stopController.signal]);
				const compatible = definitions.has(
					definitionKey(task.input.workflowId, task.input.workflowVersion),
				);
				let effects: InvocationEffects | undefined;
				const control = new RunControl(
					task,
					runtime,
					context,
					stopFailures,
					(reason) => {
						effects?.closeAdmission();
						stopController.abort(
							new WorkflowStoppedError(task.input.runId, reason),
						);
					},
				);
				const runWatch = await runtime.watchDoc(
					RUN_DOC,
					task.input.runId,
					context,
				);
				runWatch?.start(async (value) => {
					if (value?.stopCommand !== undefined)
						await control.decide({ kind: "notify", compatible });
				});
				await control.decide({ kind: "notify", compatible });
				if (control.finished) return;
				if (control.held) {
					await control.decide({
						kind: "park",
						compatible: definitions.has(
							definitionKey(task.input.workflowId, task.input.workflowVersion),
						),
					});
					return;
				}
				const definition = definitions.get(
					definitionKey(task.input.workflowId, task.input.workflowVersion),
				);
				if (
					definition === undefined ||
					definition.id !== task.input.workflowId ||
					definition.version !== task.input.workflowVersion
				) {
					await control.decide({ kind: "park", compatible: false });
					return;
				}
				effects = new InvocationEffects();
				const step = makeWorkflowStep(task, runtime, context, effects, signal);
				let result: JsonValue | undefined;
				let failure: unknown;
				let failed = false;
				try {
					result = copyJson(
						await definition.run({
							input: freezeJson(task.input.input) as never,
							step,
							signal,
						}),
					);
				} catch (error) {
					failure = error;
					failed = true;
				}
				effects.closeAdmission();
				const drained = await effects.drain();
				if (control.finished) return;
				if (!failed && drained.failed) {
					failed = true;
					failure = drained.error;
				}
				await control.decide({
					kind: "terminal",
					outcome: failed
						? { status: "failed", error: errorRecord(failure) }
						: { status: "completed" },
					result: result ?? null,
				});
			},
		},
		abort: async (task, runtime, context) => {
			await new RunControl(
				task,
				runtime,
				context,
				stopFailures,
				() => {},
			).decide({
				kind: "terminal",
				outcome: { status: "stopped", reason: "Workflow stopped" },
				result: null,
			});
		},
	});
}

export const WorkflowRuntimeTask = createWorkflowTask(
	definitions,
	defaultStopFailures,
);
export const workflowRuntimeExtension = defineExtension({
	name: "pocket-workflow-runtime-core",
	tasks: [WorkflowRuntimeTask],
});

/** Create an isolated definition registry and native Task handler for one host. */
export function createWorkflowRuntimeKernel() {
	const registry: DefinitionRegistry = new Map();
	const stopFailures = new StopFailures();
	const task = createWorkflowTask(registry, stopFailures);
	const extension = defineExtension({
		name: "pocket-workflow-runtime-core",
		tasks: [task],
	});
	return {
		task,
		extension,
		createEngine: (harness: Harness) =>
			new WorkflowEngine(harness, registry, task, stopFailures),
	};
}

export class WorkflowEngine {
	readonly #harness: Harness;
	readonly #definitions: DefinitionRegistry;
	readonly #task: typeof WorkflowRuntimeTask;
	readonly #stopFailures: StopFailures;
	readonly #stopWaiters = new Set<(error: Error) => void>();
	#opened = false;
	#closed = false;

	constructor(
		harness: Harness,
		registry: DefinitionRegistry = definitions,
		task = WorkflowRuntimeTask,
		stopFailures = defaultStopFailures,
	) {
		this.#harness = harness;
		this.#definitions = registry;
		this.#task = task;
		this.#stopFailures = stopFailures;
	}

	register<I extends JsonValue, O extends JsonValue>(
		definition: WorkflowDefinition<I, O>,
	): void {
		const key = definitionKey(definition.id, definition.version);
		const existing = this.#definitions.get(key);
		if (existing !== undefined && existing !== definition)
			throw new Error(
				`Workflow ${definition.id}@${definition.version} is already registered`,
			);
		this.#definitions.set(
			key,
			definition as unknown as WorkflowDefinition<JsonValue, JsonValue>,
		);
	}

	async open(context: Context): Promise<void> {
		if (this.#closed) throw new Error("WorkflowEngine is closed");
		this.#opened = true;
		this.#harness.resume();
		await this.#activateCompatible(context);
	}

	async start<I extends JsonValue, O extends JsonValue>(
		definition: WorkflowDefinition<I, O>,
		input: I,
		options: { readonly runId: string },
		context: Context,
	): Promise<WorkflowHandle<O>> {
		if (!this.#opened || this.#closed)
			throw new Error("WorkflowEngine.open() must precede start()");
		if (options.runId.length === 0)
			throw new TypeError("Workflow run ID must be non-empty");
		if (
			!this.#definitions.has(definitionKey(definition.id, definition.version))
		)
			this.register(definition);
		await this.#activateCompatible(context);
		const frozen = canonicalInput(input);
		const root = await this.#harness.root(context);
		const existing = await root.commit(async (tx) => {
			const run = await tx.doc(RUN_DOC, options.runId, options.runId);
			if (run.taskId !== 0) {
				if (
					run.workflowId !== definition.id ||
					run.workflowVersion !== definition.version ||
					run.inputDigest !== frozen.digest ||
					run.inputCanonical !== frozen.canonical
				) {
					throw new Error(
						`Workflow run ID ${options.runId} conflicts with its existing admission`,
					);
				}
				return { taskId: run.taskId };
			}
			const taskId = await tx.createTask(
				this.#task,
				{
					runId: options.runId,
					workflowId: definition.id,
					workflowVersion: definition.version,
					input: frozen.input,
					inputDigest: frozen.digest,
				},
				{ ownership: { kind: "conversation" } },
			);
			run.runId = options.runId;
			run.workflowId = definition.id;
			run.workflowVersion = definition.version;
			run.input = frozen.input;
			run.inputCanonical = frozen.canonical;
			run.inputDigest = frozen.digest;
			run.conversationId = Number(root.id);
			run.taskId = Number(taskId);
			run.status = "running";
			await writeEvent(tx, Number(root.id), {
				type: "workflow.started",
				runId: options.runId,
				workflowId: definition.id,
				workflowVersion: definition.version,
				inputDigest: frozen.digest,
			});
			return { taskId: Number(taskId) };
		}, context);
		void existing;
		return { runId: options.runId };
	}

	async inspect(runId: string, context: Context): Promise<WorkflowInspection> {
		const snapshot = await this.#harness.snapshot(RUN_DOC, runId, context);
		if (snapshot === undefined || snapshot.taskId === 0)
			throw new Error(`Workflow run ${runId} does not exist`);
		return this.#harness.commit(async (tx) => {
			const run = await tx.doc(RUN_DOC, runId, runId);
			const task = await tx.task(run.taskId as TaskId);
			if (task === undefined)
				throw new Error(`Workflow task for run ${runId} does not exist`);
			const status =
				task.state.status === "terminal" || task.state.status === "completing"
					? task.state.outcome.status === "completed"
						? "completed"
						: task.state.outcome.status === "aborted"
							? "stopped"
							: "failed"
					: run.status === "incompatible" && task.state.status === "waiting"
						? "incompatible"
						: "running";
			const operations = copyJson(run.operations) as Record<
				string,
				OperationProjection
			>;
			if (
				(status === "incompatible" && task.state.status === "waiting") ||
				((task.state.status === "terminal" ||
					task.state.status === "completing") &&
					(task.state.outcome.status === "faulted" ||
						task.state.outcome.status === "orphaned"))
			) {
				for (const operation of Object.values(operations)) {
					if (operation.status === "running") operation.status = "unknown";
				}
			}
			return {
				runId,
				workflowId: run.workflowId,
				workflowVersion: run.workflowVersion,
				status,
				operations,
				operationsTruncated: run.operationsTruncated ?? 0,
				...(status === "stopped"
					? {
							cleanup: {
								status:
									task.state.status === "completing"
										? ("pending" as const)
										: ("native-settled" as const),
								nativeTaskId: run.taskId,
							},
						}
					: {}),
			};
		}, context);
	}

	async wait<O extends JsonValue>(runId: string, context: Context): Promise<O> {
		const run = await this.#harness.snapshot(RUN_DOC, runId, context);
		if (run === undefined || run.taskId === 0)
			throw new Error(`Workflow run ${runId} does not exist`);
		const receipt = await this.#harness.waitForTask(
			run.taskId as TaskId<O>,
			context,
		);
		const outcome = receipt.state.outcome;
		if (outcome.status === "completed") return outcome.result as O;
		if (outcome.status === "aborted")
			throw new WorkflowStoppedError(
				runId,
				outcome.reason ?? "Workflow stopped",
			);
		if (
			outcome.status === "failed" ||
			outcome.status === "faulted" ||
			outcome.status === "orphaned"
		) {
			if (outcome.status === "failed") {
				const detail = outcome.error.detail;
				if (
					detail !== null &&
					typeof detail === "object" &&
					!Array.isArray(detail) &&
					detail.name === "UnknownOperationError" &&
					typeof detail.operationId === "string" &&
					typeof detail.attemptId === "string"
				) {
					throw new UnknownOperationError(
						detail.operationId,
						detail.attemptId,
						outcome.error.message,
					);
				}
				const name =
					detail !== null &&
					typeof detail === "object" &&
					!Array.isArray(detail) &&
					typeof detail.name === "string"
						? detail.name
						: "WorkflowFailure";
				throw new WorkflowRunError(runId, {
					name,
					message: outcome.error.message,
				});
			}
			throw new WorkflowRunError(runId, {
				name: outcome.status,
				message:
					outcome.status === "faulted" ? outcome.error.message : outcome.reason,
			});
		}
		throw new Error(`Workflow run ${runId} ended without a recognized outcome`);
	}

	async stop(
		runId: string,
		reason = "Stopped by caller",
		context: Context,
	): Promise<void> {
		if (!this.#opened || this.#closed)
			throw new Error("WorkflowEngine.open() must precede stop()");
		await observeStopCall(
			this.#harness,
			this.#stopFailures,
			(reject) => {
				this.#stopWaiters.add(reject);
				return () => {
					this.#stopWaiters.delete(reject);
				};
			},
			() => this.#closed,
			runId,
			reason,
			context,
		);
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const reject of this.#stopWaiters)
			reject(new Error("WorkflowEngine is closed"));
	}

	async #activateCompatible(context: Context): Promise<void> {
		// Wake IDs deduplicate a command, not a definition's lifetime. A Task may
		// park again on a later host after consuming an earlier activation.
		const activationId = randomUUID();
		await this.#harness.commit(async (tx) => {
			let cursor: Parameters<Tx["scanTasks"]>[2];
			const compatible: { id: TaskId; input: WorkflowTaskInput }[] = [];
			for (;;) {
				const page = await tx.scanTasks(
					{ kind: this.#task.definition.name, status: "waiting" },
					500,
					cursor,
				);
				for (const task of page.items) {
					const input = task.input as WorkflowTaskInput;
					if (
						this.#definitions.has(
							definitionKey(input.workflowId, input.workflowVersion),
						)
					)
						compatible.push({ id: task.id, input });
				}
				if (page.next === undefined) break;
				cursor = page.next;
			}
			for (const { id, input } of compatible) {
				await tx.wakeTask(
					id,
					`workflow-definition:${input.workflowId}:${input.workflowVersion}:${activationId}`,
				);
			}
		}, context);
	}
}
