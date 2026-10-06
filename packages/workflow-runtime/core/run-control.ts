import type { Context, JsonValue } from "@earendil-works/chord";
import { awaitWithContext, withCancel } from "@earendil-works/chord/context";
import {
    type DocumentWatch,
    type Harness,
    StorageRejected,
    type TaskId,
} from "@earendil-works/pi-durable";
import {
    chooseTerminalInTransaction,
    RUN_DOC,
    type WorkflowCheckpoint,
    type WorkflowOutcome,
    type WorkflowRunningTask,
    type WorkflowRunRecord,
    type WorkflowRuntime,
} from "./index.ts";

/** Stop errors belong to individual command observations, not workflow outcomes. */
export class StopFailures {
    readonly #listeners = new Map<string, Set<(request: number, error: unknown) => void>>();
    subscribe(runId: string, listener: (request: number, error: unknown) => void): () => void {
        const listeners = this.#listeners.get(runId) ?? new Set();

        listeners.add(listener);
        this.#listeners.set(runId, listeners);

        return () => {
            listeners.delete(listener);

            if (listeners.size === 0) {
                this.#listeners.delete(runId);
            }
        };
    }
    publish(runId: string, request: number, error: unknown): void {
        for (const listener of this.#listeners.get(runId) ?? []) {
            listener(request, error);
        }
    }
}

type Intent =
    | { readonly kind: "notify"; readonly compatible: boolean }
    | { readonly kind: "park"; readonly compatible: boolean }
    | {
          readonly kind: "terminal";
          readonly outcome: WorkflowOutcome;
          readonly result: JsonValue;
      };

/** The only invocation-local arbiter of ingress, parking, and terminal selection.
 * The promise chain orders control decisions, never operation callbacks. Every
 * decision rereads native state and ingress on the runtime's mutation line.
 */
export class RunControl {
    readonly #task: WorkflowRunningTask;
    readonly #runtime: WorkflowRuntime;
    readonly #context: Context;
    readonly #failures: StopFailures;
    readonly #selected: (reason: string) => void;
    #tail: Promise<void> = Promise.resolve();
    #parked = false;
    #ended = false;
    #hold = false;

    get held(): boolean {
        return this.#hold;
    }
    get finished(): boolean {
        return this.#parked || this.#ended;
    }

    constructor(
        task: WorkflowRunningTask,
        runtime: WorkflowRuntime,
        context: Context,
        failures: StopFailures,
        selected: (reason: string) => void,
    ) {
        this.#task = task;
        this.#runtime = runtime;
        this.#context = context;
        this.#failures = failures;
        this.#selected = selected;
    }

    decide(intent: Intent): Promise<void> {
        const next = this.#tail.then(() => this.#apply(intent));

        this.#tail = next.catch(() => {});

        return next;
    }

    async #apply(intent: Intent): Promise<void> {
        if (this.#parked || this.#ended) {
            return;
        }

        const runId = this.#task.input.runId;
        let reserved: WorkflowCheckpoint["control"];
        let parked = false;
        let ended = false;

        await this.#runtime.commit(async (tx, current) => {
            const run = await tx.doc(RUN_DOC, runId, runId);
            const checkpoint = current.state.checkpoint;

            // Native selection is immutable. No semantic intent can supersede it.
            if (run.selectedOutcome !== undefined) {
                ended = true;

                return { status: "running" as const, checkpoint };
            }

            const command = run.stopCommand;

            if (
                command !== undefined &&
                (command.request ?? 1) > (checkpoint.control?.request ?? 0)
            ) {
                reserved = {
                    request: command.request ?? 1,
                    reason: command.reason,
                    receipt: "reserved",
                };

                return {
                    status: "running" as const,
                    checkpoint: { ...checkpoint, control: reserved },
                };
            }

            if (intent.kind === "park" || checkpoint.control !== undefined) {
                if (intent.kind === "park" || intent.kind === "notify") {
                    run.status = intent.compatible ? "running" : "incompatible";
                }

                parked = true;

                return {
                    status: "waiting" as const,
                    on: [],
                    policy: "allSettled" as const,
                    external: true,
                    checkpoint,
                };
            }

            if (intent.kind === "terminal") {
                ended = true;

                return chooseTerminalInTransaction(
                    tx,
                    current,
                    run as WorkflowRunRecord,
                    intent.outcome,
                    intent.result,
                );
            }

            return { status: "running" as const, checkpoint };
        }, this.#context);
        this.#parked = parked;
        this.#ended = ended;

        if (reserved === undefined) {
            if (parked && this.#hold) {
                this.#hold = true;
            }

            return;
        }

        this.#hold = true;

        // Reservation is durable before stopped selection; a failed selection
        // cannot commit its own rejection receipt. Never infer rollback from a
        // generic storage error or repeat an unresolved reservation.
        try {
            await this.#runtime.commit(async (tx, current) => {
                const run = await tx.doc(RUN_DOC, runId, runId);

                if (run.selectedOutcome !== undefined) {
                    return {
                        status: "running" as const,
                        checkpoint: current.state.checkpoint,
                    };
                }

                return chooseTerminalInTransaction(
                    tx,
                    current,
                    run as WorkflowRunRecord,
                    { status: "stopped", reason: reserved!.reason },
                    null,
                );
            }, this.#context);
            this.#ended = true;
            this.#hold = false;
            this.#selected(reserved.reason);
        } catch (error) {
            if (!(error instanceof StorageRejected)) {
                throw error;
            }

            try {
                await this.#runtime.commit(async (tx, current) => {
                    const run = await tx.doc(RUN_DOC, runId, runId);

                    void run;

                    return {
                        status: "running",
                        checkpoint: {
                            ...current.state.checkpoint,
                            control: { ...reserved!, receipt: "rejected" as const },
                        },
                    };
                }, this.#context);
            } catch (receiptError) {
                this.#runtime.report(receiptError);
            }

            this.#failures.publish(runId, reserved.request, error);
        }
    }
}

/** A stop call observes the command without owning or cancelling the native Task. */
export async function observeStopCall(
    harness: Harness,
    failures: StopFailures,
    registerClose: (reject: (error: Error) => void) => () => void,
    isClosed: () => boolean,
    runId: string,
    reason: string,
    context: Context,
): Promise<void> {
    const child = withCancel(context);
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<never>((_, reject) => {
        rejectClosed = reject;
    });

    void closed.catch(() => {});
    const unregisterClose = registerClose((error) => {
        child.cancel(error);
        rejectClosed(error);
    });
    let watch: DocumentWatch<WorkflowRunRecord> | undefined;
    let unsubscribe: (() => void) | undefined;

    const check = () => {
        if (isClosed()) {
            throw new Error("WorkflowEngine is closed");
        }

        if (child.context.abortSignal?.aborted) {
            throw child.context.abortSignal.reason ?? new Error("Stop context aborted");
        }
    };

    try {
        check();
        const initial = await awaitWithContext(
            harness.snapshot(RUN_DOC, runId, child.context),
            child.context,
        );

        check();

        if (initial === undefined || initial.taskId === 0) {
            throw new Error(`Workflow run ${runId} does not exist`);
        }

        const acquisition = harness.watchDoc(RUN_DOC, runId, child.context);

        // Some forwarding observers may settle after cancellation. Dispose their
        // late handle even when the caller has already exited.
        void acquisition.then(
            (late) => {
                if (child.context.abortSignal?.aborted && late !== undefined) {
                    void late.stop();
                }
            },
            () => {},
        );
        watch = await awaitWithContext(acquisition, child.context);
        check();

        if (watch === undefined) {
            throw new Error(`Workflow run ${runId} does not exist`);
        }

        let resolveSelected!: () => void;
        const selected = new Promise<void>((resolve) => {
            resolveSelected = resolve;
        });

        const observe = (value: Readonly<WorkflowRunRecord> | null) => {
            if (value?.selectedOutcome !== undefined) {
                resolveSelected();
            }
        };

        let requested: number | undefined;
        const earlyFailures = new Map<number, unknown>();
        let rejectFailure!: (error: unknown) => void;
        const failure = new Promise<never>((_, reject) => {
            rejectFailure = reject;
        });

        void failure.catch(() => {});
        unsubscribe = failures.subscribe(runId, (request, error) => {
            if (request === requested) {
                rejectFailure(error);
            } else {
                earlyFailures.set(request, error);
            }
        });
        watch.start(async (value) => {
            observe(value as Readonly<WorkflowRunRecord> | null);
        });
        observe(watch.value as Readonly<WorkflowRunRecord> | null);
        check();
        // Admission, once entered, settles independently of the observer scope.
        const admission = harness.commit(async (tx) => {
            check();
            const run = await tx.doc(RUN_DOC, runId, runId);

            check();
            const task = await tx.task(run.taskId as TaskId);

            check();

            if (task === undefined) {
                throw new Error(`Workflow task for run ${runId} does not exist`);
            }

            if (
                run.selectedOutcome !== undefined ||
                task.state.status === "completing" ||
                task.state.status === "terminal"
            ) {
                return undefined;
            }

            run.stopCommand = {
                reason: run.stopCommand?.reason ?? reason.slice(0, 1_000),
                request: (run.stopCommand?.request ?? 0) + 1,
            };

            if (task.state.status === "waiting") {
                await tx.wakeTask(task.id, `workflow-stop:${runId}:${run.stopCommand.request}`);
            }

            return run.stopCommand.request;
        }, child.context);

        requested = await awaitWithContext(admission, child.context);
        check();

        if (requested === undefined) {
            return;
        }

        if (earlyFailures.has(requested)) {
            rejectFailure(earlyFailures.get(requested));
        }

        observe(watch.value as Readonly<WorkflowRunRecord> | null);
        const nativeTerminal = harness
            .waitForTask(initial.taskId as TaskId, child.context)
            .then(async () => {
                const latest = await harness.snapshot(RUN_DOC, runId, child.context);

                if (latest?.selectedOutcome === undefined) {
                    throw new Error(`Workflow ${runId} ended before stop selection`);
                }
            });

        await awaitWithContext(
            Promise.race([selected, failure, closed, nativeTerminal]),
            child.context,
        );
    } finally {
        child.cancel();
        unsubscribe?.();
        unregisterClose();

        if (watch !== undefined) {
            await watch.stop();
        }
    }
}
