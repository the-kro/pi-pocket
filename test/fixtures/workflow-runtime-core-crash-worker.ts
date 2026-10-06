import { appendFile, readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    defineTask,
    Harness,
    type Storage,
    StorageRejected,
    type StorageWrite,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    defineWorkflow,
    recovery,
    type WorkflowCheckpoint,
    WorkflowEngine,
    WorkflowRuntimeTask,
} from "../../packages/workflow-runtime/core/index.ts";

const mode = process.env.PI_CORE_MODE;
const scenario = process.env.PI_CORE_SCENARIO ?? "unknown";
const operationId = process.env.PI_CORE_OPERATION_ID ?? "external-effect";
const policy = process.env.PI_CORE_POLICY ?? "default";
const recoveryResult = process.env.PI_CORE_RECOVERY_RESULT ?? "completed";
const databasePath = process.env.PI_DB_PATH;
const effectLog = process.env.PI_EFFECT_LOG;
const markerPath = process.env.PI_MARKER_PATH;
const recoveryLog = process.env.PI_RECOVERY_LOG ?? `${effectLog}.recovery`;
const bodyLog = `${effectLog}.bodies`;
const stopAttemptLog = `${effectLog}.stop-attempts`;
let releaseStopHold!: () => void;
const stopHold = new Promise<void>((resolve) => {
    releaseStopHold = resolve;
});
let enterStopBody!: () => void;
const stopBodyEntered = new Promise<void>((resolve) => {
    enterStopBody = resolve;
});

if (databasePath === undefined || effectLog === undefined || markerPath === undefined) {
    throw new Error("Missing workflow core crash-worker configuration");
}

const backing = await openNodeSqliteStorage(databasePath);
const isAdmission = (writes: readonly StorageWrite[]) =>
    writes.some(
        (write) =>
            write.type === "task" && write.value.kind === WorkflowRuntimeTask.definition.name,
    ) &&
    writes.some(
        (write) =>
            write.type === "document.create" && write.record.kind === "pocket.workflow-runtime.run",
    ) &&
    writes.some(
        (write) => write.type === "entry" && write.value.kind === "pocket.workflow-runtime.event",
    );

function controlFrom(write: StorageWrite): WorkflowCheckpoint["control"] | undefined {
    if (write.type !== "task" || write.value.kind !== WorkflowRuntimeTask.definition.name) {
        return undefined;
    }

    const state = write.value.state;

    if (state.status === "terminal" || state.status === "completing") {
        return undefined;
    }

    return (state.checkpoint as unknown as WorkflowCheckpoint).control;
}

const storage = new Proxy(backing, {
    get(target, property, receiver) {
        if (property === "commit") {
            return async (
                writes: readonly StorageWrite[],
                context: Parameters<Storage["commit"]>[1],
            ) => {
                if (mode === "admission-before" && isAdmission(writes)) {
                    process.stdout.write("STAGED:admission-before\n");
                    setInterval(() => {}, 60_000);
                    await new Promise(() => {});
                }

                const workflowEvents = writes.flatMap((write) =>
                    write.type === "entry" &&
                    write.value.kind === "pocket.workflow-runtime.event" &&
                    write.value.data !== null &&
                    typeof write.value.data === "object" &&
                    !Array.isArray(write.value.data) &&
                    typeof write.value.data.type === "string"
                        ? [write.value.data as { type: string; reason?: string }]
                        : [],
                );
                const eventTypes = workflowEvents.map((event) => event.type);
                const stopAttempt = workflowEvents.find(
                    (event) => event.type === "workflow.stopped",
                );

                if (scenario === "stop-fence" && stopAttempt?.reason !== undefined) {
                    await appendFile(
                        stopAttemptLog,
                        `${stopAttempt.reason}${String.fromCharCode(10)}`,
                    );
                }

                const controlWrite = writes.find((write) => controlFrom(write)?.request === 1);

                if (
                    mode === "stop-reservation-start" &&
                    controlWrite !== undefined &&
                    controlFrom(controlWrite)?.receipt === "reserved"
                ) {
                    await target.commit(writes, context);
                    process.stdout.write("STAGED:stop-reservation");
                    setInterval(() => {}, 60_000);
                    await new Promise(() => {});
                }

                if (mode === "stop-receipt-start" && stopAttempt !== undefined) {
                    throw new StorageRejected("injected stop selection rollback");
                }

                if (
                    mode === "stop-receipt-start" &&
                    controlWrite !== undefined &&
                    controlFrom(controlWrite)?.receipt === "rejected"
                ) {
                    process.stdout.write("STAGED:stop-rejection-no-receipt");
                    setInterval(() => {}, 60_000);
                    await new Promise(() => {});
                }

                if (mode === "pending-start" && eventTypes.includes("operation.completed")) {
                    throw new (await import("@earendil-works/pi-durable")).StorageRejected(
                        "completion rollback",
                    );
                }

                if (
                    (mode === "pending-start" || mode === "pending-middle") &&
                    eventTypes.includes("workflow.failed")
                ) {
                    process.stdout.write(`STAGED:${mode}\n`);
                    await new Promise(() => {});
                }

                const seq = await target.commit(writes, context);

                if (
                    mode === "event-ingress-start" &&
                    workflowEvents.some((event) => event.type === "event.received")
                ) {
                    process.stdout.write("STAGED:event-receipt");
                    setInterval(() => {}, 60_000);
                    await new Promise(() => {});
                }

                if (
                    mode === "stop-hold-recover" &&
                    writes.some(
                        (write) =>
                            write.type === "task" &&
                            write.value.kind === WorkflowRuntimeTask.definition.name &&
                            write.value.state.status === "waiting" &&
                            write.value.state.external === true,
                    )
                ) {
                    process.stdout.write("HOLD_READY");
                    releaseStopHold();
                }

                if (
                    mode === "ambiguous-start" &&
                    writes.some(
                        (write) =>
                            write.type === "entry" &&
                            write.value.kind === "pocket.workflow-runtime.event" &&
                            typeof write.value.data === "object" &&
                            write.value.data !== null &&
                            !Array.isArray(write.value.data) &&
                            write.value.data.type === "operation.completed",
                    )
                ) {
                    process.stdout.write("AMBIGUOUS:completion-committed\n");

                    throw new Error("Storage acknowledgement lost after durable commit");
                }

                if (mode === "admission-after" && isAdmission(writes)) {
                    process.stdout.write("STAGED:admission-after\n");
                    setInterval(() => {}, 60_000);
                    await new Promise(() => {});
                }

                return seq;
            };
        }

        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
    },
}) as Storage;
const registry = createRegistry();

registry.install(
    defineExtension({
        name: "workflow-core-crash-test",
        tasks: [WorkflowRuntimeTask],
    }),
);
const owned = defineTask({
    name: "core.crash.owned",
    version: 1,
    initial: () => ({ phase: "run" as const }),
    phases: {
        run: async (_task, runtime) => {
            await new Promise<void>((resolve) =>
                runtime.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                }),
            );
        },
    },
    abort: async () => {
        if (mode === "cancel-start") {
            process.stdout.write("CHILD_ABORT_ENTERED\n");
            await new Promise(() => {});
        }
    },
});

registry.install(defineExtension({ name: "workflow-core-crash-owned", tasks: [owned] }));
const harness = await Harness.open(
    storage,
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
);
const engine = new WorkflowEngine(harness);
const feature = defineWorkflow({
    id: `core.crash.${scenario}`,
    version: 1,
    async run({ step, signal }) {
        if (scenario === "event") {
            const event = await step.waitForEvent<{ ok: boolean }>("signal", "core.signal");

            await appendFile(
                effectLog,
                `${event.eventId}:${event.payload.ok ? "true" : "false"}\n`,
            );

            return event.payload;
        }

        if (scenario === "stop-fence") {
            await appendFile(bodyLog, `${mode}${String.fromCharCode(10)}`);
            process.stdout.write(`BODY:${mode}`);
            enterStopBody();

            if (mode === "stop-hold-recover") {
                return "unexpected-reentry";
            }

            await new Promise<void>((resolve) => {
                if (signal.aborted) {
                    return resolve();
                }

                signal.addEventListener("abort", () => resolve(), { once: true });
            });

            return "after stop";
        }

        if (scenario === "cancel") {
            if (mode === "cancel-recover") {
                throw new Error("Stopped workflow body resurrected");
            }

            await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
            );

            return "unexpected-success";
        }

        const options = {
            ...(policy === "default"
                ? {}
                : { interrupted: policy as "fail" | "retry" | "reconcile" }),
            ...(policy === "reconcile"
                ? {
                      reconcile: async (execution: {
                          readonly idempotencyKey: string;
                          readonly attempt: number;
                          readonly attemptId: string;
                      }) => {
                          await appendFile(
                              recoveryLog,
                              `${execution.attempt}:${execution.attemptId}\n`,
                          );
                          process.stdout.write("RECONCILE:external-effect\n");

                          if (recoveryResult === "retry") {
                              return recovery.retry();
                          }

                          if (recoveryResult === "unknown") {
                              return recovery.unknown();
                          }

                          if (recoveryResult === "throw") {
                              throw new Error("reconciler interrupted");
                          }

                          return recovery.completed(`reconciled-${execution.attempt}`);
                      },
                  }
                : {}),
        };
        const result = await step.do(
            operationId,
            async (execution) => {
                if (mode?.endsWith("-recover") && policy !== "retry" && execution.attempt === 1) {
                    let previous = "";

                    try {
                        previous = await readFile(effectLog, "utf8");
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                            throw error;
                        }
                    }

                    if (previous.length > 0) {
                        throw new Error("The operation callback was repeated");
                    }
                }

                await appendFile(
                    effectLog,
                    `${JSON.stringify({ attempt: execution.attempt, idempotencyKey: execution.idempotencyKey, attemptId: execution.attemptId })}\n`,
                );
                process.stdout.write("EFFECT:external-effect\n");

                if (
                    mode?.endsWith("-start") &&
                    scenario !== "persisted-retry" &&
                    scenario !== "replay" &&
                    scenario !== "ambiguous"
                ) {
                    setInterval(() => {}, 60_000);
                    await new Promise(() => {});
                }

                return `done-${execution.attempt}`;
            },
            options,
        );

        if (scenario === "replay") {
            process.stdout.write("BODY_AFTER_DO\n");

            if (mode === "replay-start") {
                setInterval(() => {}, 60_000);
                await new Promise(() => {});
            }
        }

        return result;
    },
});

engine.register(feature);
await engine.open(BACKGROUND_CONTEXT);

if (mode === "event-wait-start") {
    await engine.start(feature, null, { runId: "core-event" }, BACKGROUND_CONTEXT);
    const deadline = Date.now() + 10_000;

    for (;;) {
        const inspection = await engine.inspect("core-event", BACKGROUND_CONTEXT);

        if (inspection.status === "waiting") {
            break;
        }

        if (Date.now() > deadline) {
            throw new Error("Event workflow did not park");
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    process.stdout.write("EVENT_WAITING");
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
} else if (mode === "event-ingress-start") {
    await engine.sendEvent(
        "core-event",
        { id: "crash-event", type: "core.signal", payload: { ok: true } },
        BACKGROUND_CONTEXT,
    );
} else if (mode === "event-recover") {
    const result = await engine.wait("core-event", BACKGROUND_CONTEXT);

    process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
    process.stdout.write(
        `INSPECT:${JSON.stringify(await engine.inspect("core-event", BACKGROUND_CONTEXT))}`,
    );
} else if (mode === "stop-reservation-start" || mode === "stop-receipt-start") {
    await engine.start(feature, null, { runId: "core-stop-fence" }, BACKGROUND_CONTEXT);
    await stopBodyEntered;
    await engine.stop("core-stop-fence", "revision one", BACKGROUND_CONTEXT);
    await new Promise(() => {});
} else if (mode === "stop-hold-recover") {
    const keepAlive = setInterval(() => {}, 60_000);

    await stopHold;
    await engine.stop("core-stop-fence", "revision two", BACKGROUND_CONTEXT);

    try {
        await engine.wait("core-stop-fence", BACKGROUND_CONTEXT);
    } catch {}

    process.stdout.write(
        `INSPECT:${JSON.stringify(await engine.inspect("core-stop-fence", BACKGROUND_CONTEXT))}`,
    );
    clearInterval(keepAlive);
} else if (mode === "cancel-start") {
    await engine.start(feature, null, { runId: "core-cancel" }, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
        const tasks = await tx.scanTasks({ kind: WorkflowRuntimeTask.definition.name }, 10);

        await tx.createTask(owned, null, {
            ownership: { kind: "task", taskId: tasks.items[0]!.id },
        });
    }, BACKGROUND_CONTEXT);
    await engine.stop("core-cancel", "operator stopped", BACKGROUND_CONTEXT);
    process.stdout.write(
        `SELECTED:${JSON.stringify(await engine.inspect("core-cancel", BACKGROUND_CONTEXT))}\n`,
    );
    await new Promise(() => {});
} else if (mode === "admission-before" || mode === "admission-after") {
    await engine.start(feature, null, { runId: `core-${scenario}` }, BACKGROUND_CONTEXT);
    await new Promise(() => {});
} else if (mode?.endsWith("-start") || mode === "unknown-start") {
    await engine.start(feature, null, { runId: `core-${scenario}` }, BACKGROUND_CONTEXT);
    await new Promise(() => {});
} else if (
    mode?.endsWith("-recover") ||
    mode === "pending-middle" ||
    mode === "unknown-recover" ||
    mode === "replay-recover"
) {
    try {
        const result = await engine.wait(`core-${scenario}`, BACKGROUND_CONTEXT);

        process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stdout.write(`ERROR:${error instanceof Error ? error.name : String(error)}\n`);
    }

    const inspection = await engine.inspect(`core-${scenario}`, BACKGROUND_CONTEXT);

    process.stdout.write(`INSPECT:${JSON.stringify(inspection)}\n`);
}

await engine.close();
await harness.close(BACKGROUND_CONTEXT);
