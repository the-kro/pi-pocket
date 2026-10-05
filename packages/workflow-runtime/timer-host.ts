import type { Context, JsonValue } from "@earendil-works/chord";
import type { Cursor, Harness, TaskId, TaskRecord } from "@earendil-works/pi-durable";

export type WorkflowTimerOptions = {
	readonly scheduleAt: (at: number, callback: () => void) => () => void;
	/** Diagnostic policy only: must not throw. No retry or workflow outcome is decided here. */
	readonly onTimerError?: (error: unknown) => void;
};

/** Resident host adapter; Pi schedules execution after an idempotent wake. */
export class WorkflowTimerHost<S extends JsonValue> {
	readonly #harness: Harness;
	readonly #kind: string;
	readonly #deadline: (checkpoint: S) => number | undefined;
	readonly #options: WorkflowTimerOptions;
	readonly #onError: (error: unknown) => void;
	readonly #timers = new Map<TaskId, () => void>();
	#unsubscribe: (() => void) | undefined;
	#context: Context | undefined;

	constructor(
		harness: Harness,
		kind: string,
		deadline: (checkpoint: S) => number | undefined,
		options: WorkflowTimerOptions,
	) {
		this.#harness = harness;
		this.#kind = kind;
		this.#deadline = deadline;
		this.#options = options;
		this.#onError = options.onTimerError ?? ((error) => console.error("Workflow timer wake failed", error));
	}

	async open(context: Context): Promise<void> {
		this.#context = context;
		// Subscribe first so a wait committed during the paginated scan is observed.
		this.#unsubscribe = this.#harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type === "task" && change.value.kind === this.#kind) {
					this.#observeTask(change.value as TaskRecord<JsonValue, S, JsonValue>);
				}
			}
		});
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await this.#harness.commit(
				(tx) => tx.scanTasks({ kind: this.#kind, status: "waiting" }, 256, cursor),
				context,
			);
			for (const record of page.items) this.#observeTask(record as TaskRecord<JsonValue, S, JsonValue>);
			if (page.next === undefined) break;
			cursor = page.next;
		}
	}

	close(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const cancel of this.#timers.values()) cancel();
		this.#timers.clear();
	}

	#observeTask(record: TaskRecord<JsonValue, S, JsonValue>): void {
		const id = record.id;
		const existing = this.#timers.get(id);
		if (record.state.status !== "waiting" || record.state.external !== true || record.wakePending === true) {
			existing?.();
			this.#timers.delete(id);
			return;
		}
		const wakeAt = this.#deadline(record.state.checkpoint);
		if (wakeAt === undefined) {
			existing?.();
			this.#timers.delete(id);
			return;
		}
		if (existing !== undefined) return;
		const cancel = this.#options.scheduleAt(wakeAt, () => {
			this.#timers.delete(id);
			const context = this.#context;
			if (context === undefined) return;
			void this.#harness.commit((tx) => tx.wakeTask(id, `sleep:${id}:${wakeAt}`), context).catch(this.#onError);
		});
		this.#timers.set(id, cancel);
	}
}
