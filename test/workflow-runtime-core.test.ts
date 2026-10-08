import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    Harness,
    MemoryStorage,
    type Storage,
    StorageRejected,
    type StorageWrite,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const core = await import("../packages/workflow-runtime/core/index.ts").catch(() => undefined);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const crashWorker = fileURLToPath(
    new URL("./fixtures/workflow-runtime-core-crash-worker.ts", import.meta.url),
);
const directories = new Set<string>();

after(async () => {
    for (const directory of directories) {
        await rm(directory, { recursive: true, force: true });
    }
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-workflow-core-"));

    directories.add(directory);
    const registry = createRegistry();

    registry.install(core!.workflowRuntimeExtension);
    const harness = await Harness.open(
        await openNodeSqliteStorage(join(directory, "workflow.sqlite")),
        { models: createModels(), registry },
        context,
    );
    const engine = new core!.WorkflowEngine(harness);

    await engine.open(context);

    return { directory, harness, engine };
}

async function seedIncompatibleRun(
    database: string,
    runId: string,
    workflowId: string,
): Promise<void> {
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry },
        context,
    );
    const engine = kernel.createEngine(harness);
    let entered!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });

    try {
        await engine.open(context);
        await engine.start(
            core!.defineWorkflow({
                id: workflowId,
                version: 1,
                async run({ signal }) {
                    entered();
                    await new Promise<void>((resolve) => {
                        if (signal.aborted) {
                            return resolve();
                        }

                        signal.addEventListener("abort", () => resolve(), { once: true });
                    });

                    return "left running for host recovery";
                },
            }),
            null,
            { runId },
            context,
        );
        await bodyEntered;
    } finally {
        await engine.close();
        await harness.close(context);
    }
}

function definition(id: string, value: string) {
    return core!.defineWorkflow({
        id,
        version: 1,
        async run() {
            return value;
        },
    });
}

function startWorker(
    mode: string,
    databasePath: string,
    effectLog: string,
    markerPath: string,
    options: Record<string, string> = {},
): ChildProcess {
    return spawn(process.execPath, ["--experimental-strip-types", crashWorker], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_CORE_MODE: mode,
            PI_DB_PATH: databasePath,
            PI_EFFECT_LOG: effectLog,
            PI_MARKER_PATH: markerPath,
            ...options,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function outputUntil(child: ChildProcess, marker: string): Promise<string> {
    if (child.stdout === null || child.stderr === null) {
        throw new Error("Crash worker has no output pipes");
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    let errors = "";

    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new Error(
                        `Timed out waiting for ${marker}; stdout=${output}; stderr=${errors}`,
                    ),
                ),
            15_000,
        );

        child.stdout!.on("data", (chunk: string) => {
            output += chunk;

            if (output.includes(marker)) {
                clearTimeout(timer);
                resolve(output);
            }
        });
        child.stderr!.on("data", (chunk: string) => {
            errors += chunk;
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", (code, signal) => {
            if (!output.includes(marker)) {
                clearTimeout(timer);
                reject(
                    new Error(
                        `Worker exited before ${marker}: code=${code}, signal=${signal}; stdout=${output}; stderr=${errors}`,
                    ),
                );
            }
        });
    });
}

async function killWorker(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    const exited = once(child, "exit");

    child.kill("SIGKILL");
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, "SIGKILL");
}

async function workerExit(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return [child.exitCode, child.signalCode];
    }

    return once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
}

function inspectionFrom(output: string): {
    status: string;
    operations: Record<string, { status: string; latestAttempt: number }>;
} {
    return JSON.parse(output.split("INSPECT:")[1]!) as {
        status: string;
        operations: Record<string, { status: string; latestAttempt: number }>;
    };
}

test("event receipt and wake survive SIGKILL after storage commit but before host acknowledgement", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-workflow-event-crash-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const effects = join(directory, "effects.log");
    const marker = join(directory, "marker");
    const options = { PI_CORE_SCENARIO: "event" };
    let waiter: ChildProcess | undefined = startWorker(
        "event-wait-start",
        database,
        effects,
        marker,
        options,
    );
    let ingress: ChildProcess | undefined;
    let recovered: ChildProcess | undefined;

    try {
        await outputUntil(waiter, "EVENT_WAITING");
        ingress = startWorker("event-ingress-start", database, effects, marker, options);
        await outputUntil(ingress, "STAGED:event-receipt");
        await killWorker(ingress);
        ingress = undefined;
        await killWorker(waiter);
        waiter = undefined;
        recovered = startWorker("event-recover", database, effects, marker, options);
        const output = await outputUntil(recovered, "INSPECT:");

        assert.deepEqual(await workerExit(recovered), [0, null]);
        assert.ok(output.includes('RESULT:{"ok":true}'));
        assert.match(output, /\"status\":\"completed\"/);
    } finally {
        if (ingress !== undefined) {
            await killWorker(ingress);
        }

        if (waiter !== undefined) {
            await killWorker(waiter);
        }

        if (recovered !== undefined) {
            await killWorker(recovered);
        }
    }
});

test("SIGKILL on either side of the atomic admission batch exposes no partial run", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");

    for (const mode of ["admission-before", "admission-after"] as const) {
        const directory = await mkdtemp(join(tmpdir(), `pi-pocket-workflow-${mode}-`));

        directories.add(directory);
        const databasePath = join(directory, "workflow.sqlite");
        const child = startWorker(
            mode,
            databasePath,
            join(directory, "effects.log"),
            join(directory, "marker"),
        );

        try {
            await outputUntil(child, `STAGED:${mode}`);
            await killWorker(child);
            const registry = createRegistry();

            registry.install(core.workflowRuntimeExtension);
            const harness = await Harness.open(
                await openNodeSqliteStorage(databasePath),
                { models: createModels(), registry },
                context,
            );

            try {
                const { tasks, entries } = await harness.commit(async (tx) => {
                    const tasks = await tx.scanTasks(
                        { kind: core.WorkflowRuntimeTask.definition.name },
                        20,
                    );
                    const conversations = await tx.scanConversations({}, 20);
                    const root = conversations.items[0];
                    const entries =
                        root === undefined
                            ? { items: [] as never[] }
                            : await tx.scanEntries({ conversationId: root.id }, 20);

                    return { tasks, entries };
                }, context);

                if (mode === "admission-before") {
                    assert.equal(tasks.items.length, 0);
                    assert.equal(entries.items.length, 0);
                } else {
                    assert.equal(tasks.items.length, 1);
                    const events = entries.items.filter(
                        (entry) => entry.kind === "pocket.workflow-runtime.event",
                    );

                    assert.equal(events.length, 1);
                    const started = events[0];

                    assert.ok(started);
                    assert.equal((started.data as { type: string }).type, "workflow.started");
                }
            } finally {
                await harness.close(context);
            }
        } finally {
            await killWorker(child);
        }
    }
});

test("matching repeated admission with a fresh definition wrapper preserves the registered handler", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();
    let enterBody!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
        enterBody = resolve;
    });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
        releaseBody = resolve;
    });
    let firstCalls = 0;
    let secondCalls = 0;
    const firstDefinition = core.defineWorkflow({
        id: "core.admission.wrapper",
        version: 1,
        async run() {
            firstCalls++;
            enterBody();
            await bodyGate;

            return "registered-handler";
        },
    });
    const repeatedDefinition = core.defineWorkflow({
        id: "core.admission.wrapper",
        version: 1,
        async run() {
            secondCalls++;

            return "replacement-handler";
        },
    });

    try {
        const first = await engine.start(
            firstDefinition,
            { token: "same" },
            { runId: "wrapper-identity" },
            context,
        );

        await bodyEntered;
        const repeated = await engine.start(
            repeatedDefinition,
            { token: "same" },
            { runId: "wrapper-identity" },
            context,
        );

        assert.deepEqual(repeated, first);
        assert.equal(firstCalls, 1);
        assert.equal(secondCalls, 0);
        releaseBody();
        assert.equal(await engine.wait("wrapper-identity", context), "registered-handler");
    } finally {
        releaseBody();
        await engine.close();
        await harness.close(context);
    }
});

test("concurrent equivalent caller-reserved admissions create one durable workflow run", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();

    try {
        const workflow = definition("core.admission.same", "admitted");
        const handles = await Promise.all(
            Array.from({ length: 8 }, (_, index) =>
                engine.start(
                    workflow,
                    index % 2 === 0 ? { left: 1, right: 2 } : { right: 2, left: 1 },
                    { runId: "reserved-1" },
                    context,
                ),
            ),
        );

        assert.deepEqual(new Set(handles.map((handle) => handle.runId)), new Set(["reserved-1"]));
        assert.equal(await engine.wait("reserved-1", context), "admitted");
        const tasks = await harness.commit(
            (tx) => tx.scanTasks({ kind: core.WorkflowRuntimeTask.definition.name }, 20),
            context,
        );

        assert.equal(tasks.items.length, 1);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("prototype-named operations replay from SQLite after SIGKILL without repeating callbacks", async () => {
    for (const id of ["toString", "constructor", "__proto__"]) {
        const directory = await mkdtemp(join(tmpdir(), "pi-pocket-proto-replay-"));

        directories.add(directory);
        const database = join(directory, "workflow.sqlite");
        const log = join(directory, "effects.log");
        const marker = join(directory, "marker");
        const options = { PI_CORE_SCENARIO: "replay", PI_CORE_OPERATION_ID: id };
        const worker = startWorker("replay-start", database, log, marker, options);
        let recovery: ChildProcess | undefined;

        try {
            await outputUntil(worker, "BODY_AFTER_DO");
            await killWorker(worker);
            recovery = startWorker("replay-recover", database, log, marker, options);
            const output = await outputUntil(recovery, "INSPECT:");

            assert.deepEqual(await workerExit(recovery), [0, null]);
            assert.match(output, /RESULT:"done-1"/);
            assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
            const inspection = inspectionFrom(output);

            assert.equal(Object.hasOwn(inspection.operations, id), true);
            assert.equal(inspection.operations[id]?.status, "completed");
        } finally {
            await killWorker(worker);

            if (recovery) {
                await killWorker(recovery);
            }
        }
    }
});

test("a completed step.do is memoized across SIGKILL before workflow terminal selection", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-workflow-replay-"));

    directories.add(directory);
    const databasePath = join(directory, "workflow.sqlite");
    const effectLog = join(directory, "effects.log");
    const markerPath = join(directory, "marker");
    const worker = startWorker("replay-start", databasePath, effectLog, markerPath, {
        PI_CORE_SCENARIO: "replay",
    });
    let recovery: ChildProcess | undefined;

    try {
        await outputUntil(worker, "BODY_AFTER_DO");
        await killWorker(worker);
        recovery = startWorker("replay-recover", databasePath, effectLog, markerPath, {
            PI_CORE_SCENARIO: "replay",
        });
        const output = await outputUntil(recovery, "INSPECT:");
        const [code, signal] = (await once(recovery, "exit")) as [
            number | null,
            NodeJS.Signals | null,
        ];

        assert.deepEqual([code, signal], [0, null]);
        assert.match(output, /RESULT:"done-1"/);
        assert.equal((await readFile(effectLog, "utf8")).trim().split("\n").length, 1);
        const inspection = JSON.parse(output.split("INSPECT:")[1]!) as {
            operations: Record<string, { status: string }>;
        };

        assert.equal(inspection.operations["external-effect"]?.status, "completed");
    } finally {
        await killWorker(worker);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }
    }
});

test("cold incompatible inspection projects an interrupted effect unknown until explicit retry resumes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-cold-unknown-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const worker = startWorker(
        "unknown-start",
        database,
        join(directory, "effects.log"),
        join(directory, "marker"),
        { PI_CORE_POLICY: "retry" },
    );

    try {
        await outputUntil(worker, "EFFECT:external-effect");
        await killWorker(worker);
        const kernel = core!.createWorkflowRuntimeKernel();
        const registry = createRegistry();

        registry.install(kernel.extension);
        const harness = await Harness.open(
            await openNodeSqliteStorage(database),
            { models: createModels(), registry },
            context,
        );
        const engine = kernel.createEngine(harness);

        try {
            await engine.open(context);
            let inspection = await engine.inspect("core-unknown", context);

            for (let i = 0; i < 100 && inspection.status !== "incompatible"; i++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                inspection = await engine.inspect("core-unknown", context);
            }

            assert.equal(inspection.status, "incompatible");
            assert.equal(inspection.operations["external-effect"]?.status, "unknown");
            assert.equal(
                (await engine.inspect("core-unknown", context)).operations["external-effect"]
                    ?.status,
                "unknown",
            );
            let attempts = 0;

            engine.register(
                core!.defineWorkflow({
                    id: "core.crash.unknown",
                    version: 1,
                    async run({ step }) {
                        return step.do(
                            "external-effect",
                            ({ attempt }) => {
                                attempts++;

                                return `recovered-${attempt}`;
                            },
                            { interrupted: "retry" },
                        );
                    },
                }),
            );
            await engine.open(context);
            assert.equal(await engine.wait("core-unknown", context), "recovered-2");
            assert.equal(attempts, 1);
            assert.equal(
                (await engine.inspect("core-unknown", context)).operations["external-effect"]
                    ?.status,
                "completed",
            );
        } finally {
            await engine.close();
            await harness.close(context);
        }
    } finally {
        await killWorker(worker);
    }
});

test("a durably started operation interrupted by SIGKILL is inspectable as unknown and is not repeated", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-workflow-unknown-"));

    directories.add(directory);
    const databasePath = join(directory, "workflow.sqlite");
    const effectLog = join(directory, "effects.log");
    const markerPath = join(directory, "marker");
    const worker = startWorker("unknown-start", databasePath, effectLog, markerPath);
    let recovery: ChildProcess | undefined;

    try {
        await outputUntil(worker, "EFFECT:external-effect");
        await killWorker(worker);
        recovery = startWorker("unknown-recover", databasePath, effectLog, markerPath);
        const output = await outputUntil(recovery, "INSPECT:");
        const [code, signal] = (await once(recovery, "exit")) as [
            number | null,
            NodeJS.Signals | null,
        ];

        assert.deepEqual([code, signal], [0, null]);
        assert.match(output, /ERROR:UnknownOperationError/);
        const inspection = JSON.parse(output.split("INSPECT:")[1]!) as {
            operations: Record<string, { status: string }>;
        };

        assert.equal(inspection.operations["external-effect"]?.status, "unknown");
        assert.equal((await readFile(effectLog, "utf8")).trim().split("\n").length, 1);
    } finally {
        await killWorker(worker);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }
    }
});

async function recoverInterruptedScenario(
    policy: "fail" | "retry" | "reconcile",
    scenario: string,
    recoveryResult?: string,
) {
    const directory = await mkdtemp(join(tmpdir(), `pi-pocket-workflow-${scenario}-`));

    directories.add(directory);
    const databasePath = join(directory, "workflow.sqlite");
    const effectLog = join(directory, "effects.log");
    const recoveryLog = join(directory, "recovery.log");
    const markerPath = join(directory, "marker");
    const startMode =
        policy === "fail" ? "fail-start" : policy === "retry" ? "retry-start" : "reconcile-start";
    const recoveryMode =
        policy === "fail"
            ? "fail-recover"
            : policy === "retry"
              ? "retry-recover"
              : "reconcile-recover";
    const options = {
        PI_CORE_SCENARIO: scenario,
        PI_CORE_POLICY: policy,
        PI_CORE_RECOVERY_LOG: recoveryLog,
        ...(recoveryResult === undefined ? {} : { PI_CORE_RECOVERY_RESULT: recoveryResult }),
    };
    const first = startWorker(startMode, databasePath, effectLog, markerPath, options);
    let reopened: ChildProcess | undefined;

    try {
        await outputUntil(first, "EFFECT:external-effect");
        await killWorker(first);
        reopened = startWorker(recoveryMode, databasePath, effectLog, markerPath, options);
        const output = await outputUntil(reopened, "INSPECT:");

        assert.deepEqual(await workerExit(reopened), [0, null]);

        return {
            output,
            effects: await readFile(effectLog, "utf8"),
            recoveries: await readFile(recoveryLog, "utf8").catch(() => ""),
            inspection: inspectionFrom(output),
        };
    } finally {
        await killWorker(first);

        if (reopened !== undefined) {
            await killWorker(reopened);
        }
    }
}

test("explicit interrupted fail persists unknown and never invokes the original callback", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const recovered = await recoverInterruptedScenario("fail", "explicit-fail");

    assert.match(recovered.output, /ERROR:UnknownOperationError/);
    assert.equal(recovered.inspection.operations["external-effect"]?.status, "unknown");
    assert.equal(recovered.effects.trim().split("\n").length, 1);
    assert.equal(recovered.recoveries, "");
});

test("interrupted reconcile runs only the reconciler and memoizes its proven result", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const recovered = await recoverInterruptedScenario(
        "reconcile",
        "reconcile-completed",
        "completed",
    );

    assert.match(recovered.output, /RESULT:"reconciled-1"/);
    assert.equal(recovered.inspection.status, "completed");
    assert.equal(recovered.inspection.operations["external-effect"]?.status, "completed");
    assert.equal(recovered.effects.trim().split("\n").length, 1);
    assert.equal(recovered.recoveries.trim().split("\n").length, 1);
});

test("reconciliation retry starts a distinct operation attempt", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const recovered = await recoverInterruptedScenario("reconcile", "reconcile-retry", "retry");

    assert.match(recovered.output, /RESULT:"done-2"/);
    assert.equal(recovered.inspection.operations["external-effect"]?.status, "completed");
    assert.equal(recovered.inspection.operations["external-effect"]?.latestAttempt, 2);
    const attempts = recovered.effects
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { idempotencyKey: string; attemptId: string });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.idempotencyKey, attempts[1]?.idempotencyKey);
    assert.notEqual(attempts[0]?.attemptId, attempts[1]?.attemptId);
});

test("reconciliation unknown remains inspectable as unknown without retrying", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const recovered = await recoverInterruptedScenario("reconcile", "reconcile-unknown", "unknown");

    assert.match(recovered.output, /ERROR:UnknownOperationError/);
    assert.equal(recovered.inspection.operations["external-effect"]?.status, "unknown");
    assert.equal(recovered.effects.trim().split("\n").length, 1);
    assert.equal(recovered.recoveries.trim().split("\n").length, 1);
});

test("explicit interrupted retry starts a fresh attempt without changing logical idempotency identity", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const recovered = await recoverInterruptedScenario("retry", "explicit-retry");

    assert.match(recovered.output, /RESULT:"done-2"/);
    assert.equal(recovered.inspection.operations["external-effect"]?.latestAttempt, 2);
    const attempts = recovered.effects
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { idempotencyKey: string; attemptId: string });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.idempotencyKey, attempts[1]?.idempotencyKey);
    assert.notEqual(attempts[0]?.attemptId, attempts[1]?.attemptId);
});

test("known callback failures retry with a new attempt ID and stable logical idempotency key", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();
    let attempts = 0;

    try {
        const workflow = core.defineWorkflow({
            id: "core.operation.known-retry",
            version: 1,
            async run({ step }) {
                return step.do(
                    "effect",
                    async ({ idempotencyKey, attempt, attemptId }) => {
                        attempts += 1;

                        if (attempts === 1) {
                            throw new Error("temporary failure");
                        }

                        return { idempotencyKey, attempt, attemptId };
                    },
                    { retries: 1 },
                );
            },
        });
        const handle = await engine.start(workflow, null, { runId: "known-retry" }, context);
        const result = (await engine.wait(handle.runId, context)) as {
            idempotencyKey: string;
            attempt: number;
            attemptId: string;
        };

        assert.equal(attempts, 2);
        assert.equal(result.attempt, 2);
        assert.notEqual(result.attemptId, `${result.idempotencyKey}:attempt:1`);
        const inspection = await engine.inspect(handle.runId, context);

        assert.equal(inspection.operations.effect?.status, "completed");
        assert.equal(inspection.operations.effect?.latestAttempt, 2);
        const events = await harness.commit(async (tx) => {
            const conversations = await tx.scanConversations({}, 10);

            return tx.scanEntries({ conversationId: conversations.items[0]!.id }, 20);
        }, context);
        const operationEvents = events.items
            .slice()
            .reverse()
            .map(
                (entry) =>
                    entry.data as {
                        type: string;
                        attemptId?: string;
                        idempotencyKey?: string;
                    },
            )
            .filter((event) => event.type.startsWith("operation."));

        assert.deepEqual(
            operationEvents.map((event) => event.type),
            [
                "operation.started",
                "operation.failed",
                "operation.retry_started",
                "operation.completed",
            ],
        );
        const retries = operationEvents.filter(
            (event) =>
                event.type === "operation.started" || event.type === "operation.retry_started",
        );

        assert.equal(retries[0]?.idempotencyKey, retries[1]?.idempotencyKey);
        assert.notEqual(retries[0]?.attemptId, retries[1]?.attemptId);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("successful external effect with a rejected completion commit stays unknown and is never failed/retried", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-workflow-completion-fault-"));

    directories.add(directory);
    const backing = await openNodeSqliteStorage(join(directory, "workflow.sqlite"));
    let injected = 0;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    commitContext: Parameters<Storage["commit"]>[1],
                ) => {
                    const completesOperation = writes.some(
                        (write) =>
                            write.type === "entry" &&
                            write.value.kind === "pocket.workflow-runtime.event" &&
                            write.value.data !== null &&
                            typeof write.value.data === "object" &&
                            !Array.isArray(write.value.data) &&
                            write.value.data.type === "operation.completed",
                    );

                    if (completesOperation && injected === 0) {
                        injected += 1;

                        throw new StorageRejected(
                            "injected operation completion storage rejection",
                        );
                    }

                    return target.commit(writes, commitContext);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const registry = createRegistry();

    registry.install(core.workflowRuntimeExtension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const engine = new core.WorkflowEngine(harness);
    let effects = 0;

    try {
        await engine.open(context);
        const workflow = core.defineWorkflow({
            id: "core.operation.completion-fault",
            version: 1,
            async run({ step }) {
                return step.do(
                    "effect",
                    async () => {
                        effects += 1;

                        return "effect-succeeded";
                    },
                    { retries: 4 },
                );
            },
        });
        const handle = await engine.start(workflow, null, { runId: "completion-fault" }, context);

        await assert.rejects(engine.wait(handle.runId, context), /UnknownOperationError/);
        assert.equal(injected, 1);
        assert.equal(effects, 1);
        const inspection = await engine.inspect(handle.runId, context);

        assert.equal(inspection.operations.effect?.status, "unknown");
        const events = await harness.commit(async (tx) => {
            const conversations = await tx.scanConversations({}, 10);

            return tx.scanEntries({ conversationId: conversations.items[0]!.id }, 50);
        }, context);
        const types = events.items
            .map((entry) => entry.data as { type?: string })
            .map((event) => event.type);

        assert.ok(types.includes("operation.interrupted"));
        assert.ok(types.includes("workflow.failed"));
        assert.ok(!types.includes("operation.failed"));
        assert.ok(!types.includes("operation.retry_started"));
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("NonRetryableError bypasses configured known-failure retries", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();
    let attempts = 0;

    try {
        const workflow = core.defineWorkflow({
            id: "core.operation.non-retryable",
            version: 1,
            async run({ step }) {
                return step.do(
                    "fatal",
                    async () => {
                        attempts += 1;

                        throw new core!.NonRetryableError("policy rejected");
                    },
                    { retries: 5 },
                );
            },
        });
        const handle = await engine.start(workflow, null, { runId: "non-retryable" }, context);

        await assert.rejects(engine.wait(handle.runId, context), /policy rejected/);
        assert.equal(attempts, 1);
        const inspection = await engine.inspect(handle.runId, context);

        assert.equal(inspection.operations.fatal?.status, "failed");
        assert.equal(inspection.operations.fatal?.latestAttempt, 1);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("a rejected stop revision remains a durable hold before a reopened body can reenter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-fence-reopen-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const firstBacking = await openNodeSqliteStorage(database);
    let rejected = false;
    const firstStorage = new Proxy(firstBacking, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    commitContext: Parameters<Storage["commit"]>[1],
                ) => {
                    if (
                        !rejected &&
                        writes.some(
                            (write) =>
                                write.type === "entry" &&
                                JSON.stringify(write.value).includes('"workflow.stopped"'),
                        )
                    ) {
                        rejected = true;

                        throw new StorageRejected("persisted stop selection rejected");
                    }

                    return target.commit(writes, commitContext);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;

    const openHost = async (storage: Storage) => {
        const kernel = core!.createWorkflowRuntimeKernel();
        const registry = createRegistry();

        registry.install(kernel.extension);
        const harness = await Harness.open(storage, { models: createModels(), registry }, context);

        return { harness, engine: kernel.createEngine(harness) };
    };

    const first = await openHost(firstStorage);
    let bodyCalls = 0;
    let firstBodyEntered!: () => void;
    const enteredFirst = new Promise<void>((resolve) => {
        firstBodyEntered = resolve;
    });
    const workflow = core!.defineWorkflow({
        id: "core.stop.fence.reopen",
        version: 1,
        async run({ signal }) {
            bodyCalls++;

            if (bodyCalls === 1) {
                firstBodyEntered();
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        return resolve();
                    }

                    signal.addEventListener("abort", () => resolve(), { once: true });
                });
            }

            return "body-completed";
        },
    });

    try {
        await first.engine.open(context);
        await first.engine.start(workflow, null, { runId: "fenced-reopen" }, context);
        await enteredFirst;
        await assert.rejects(
            first.engine.stop("fenced-reopen", "revision one", context),
            /persisted stop selection rejected/,
        );
        assert.equal(rejected, true);
        await first.engine.close();
        await first.harness.close(context);

        const secondBacking = await openNodeSqliteStorage(database);
        let resolveParked!: () => void;
        const parked = new Promise<void>((resolve) => {
            resolveParked = resolve;
        });
        const secondStorage = new Proxy(secondBacking, {
            get(target, property, receiver) {
                if (property === "commit") {
                    return async (
                        writes: readonly StorageWrite[],
                        commitContext: Parameters<Storage["commit"]>[1],
                    ) => {
                        const waiting = writes.some(
                            (write) =>
                                write.type === "task" &&
                                write.value.state.status === "waiting" &&
                                write.value.state.external === true &&
                                write.value.wakePending !== true,
                        );
                        const result = await target.commit(writes, commitContext);

                        if (waiting) {
                            resolveParked();
                        }

                        return result;
                    };
                }

                const value = Reflect.get(target, property, receiver) as unknown;

                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Storage;
        const second = await openHost(secondStorage);
        let secondBodyEntered!: () => void;
        const enteredSecond = new Promise<void>((resolve) => {
            secondBodyEntered = resolve;
        });

        // Install a fresh definition whose body records any forbidden re-entry, then returns.
        second.engine.register(
            core!.defineWorkflow({
                id: workflow.id,
                version: workflow.version,
                async run() {
                    bodyCalls++;
                    secondBodyEntered();

                    return "unexpected-reentry";
                },
            }),
        );
        await second.engine.open(context);
        await Promise.race([
            parked,
            enteredSecond.then(() => {
                throw new Error("reopened workflow body reentered a consumed stop revision");
            }),
        ]);
        assert.equal(bodyCalls, 1);
        await second.engine.stop("fenced-reopen", "revision two", context);
        await assert.rejects(second.engine.wait("fenced-reopen", context), /stopped/);
        await second.engine.close();
        await second.harness.close(context);
    } finally {
        await first.engine.close();
        await first.harness.close(context).catch(() => {});
    }
});

for (const bodyOutcome of ["return", "throw"] as const) {
    test(`rejected stop revision holds a live body's ${bodyOutcome} until a new revision`, async () => {
        const backing = new MemoryStorage();
        let attempts = 0;
        const storage = new Proxy(backing, {
            get(target, property, receiver) {
                if (property === "commit") {
                    return async (
                        writes: readonly StorageWrite[],
                        commitContext: Parameters<Storage["commit"]>[1],
                    ) => {
                        if (
                            writes.some(
                                (write) =>
                                    write.type === "entry" &&
                                    JSON.stringify(write.value).includes('"workflow.stopped"'),
                            )
                        ) {
                            attempts++;

                            if (attempts === 1) {
                                throw new StorageRejected("first selection rejected");
                            }
                        }

                        return target.commit(writes, commitContext);
                    };
                }

                const value = Reflect.get(target, property, receiver) as unknown;

                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Storage;
        const kernel = core!.createWorkflowRuntimeKernel();
        const registry = createRegistry();

        registry.install(kernel.extension);
        const harness = await Harness.open(storage, { models: createModels(), registry }, context);
        const engine = kernel.createEngine(harness);
        let entered!: () => void;
        const bodyEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const bodyRelease = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            await engine.open(context);
            const workflow = core!.defineWorkflow({
                id: `core.stop.body.${bodyOutcome}`,
                version: 1,
                async run() {
                    entered();
                    await bodyRelease;

                    if (bodyOutcome === "throw") {
                        throw new Error("natural body failure");
                    }

                    return "natural body result";
                },
            });

            await engine.start(workflow, null, { runId: `body-${bodyOutcome}` }, context);
            await bodyEntered;
            await assert.rejects(
                engine.stop(`body-${bodyOutcome}`, "first", context),
                /first selection rejected/,
            );
            release();
            // A storage barrier below waits for the body-driven transition without relying on scheduler timing.
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(attempts, 1, "a consumed revision cannot select again");
            assert.equal((await engine.inspect(`body-${bodyOutcome}`, context)).status, "running");
            await engine.stop(`body-${bodyOutcome}`, "second", context);
            assert.equal(attempts, 2);
            await assert.rejects(engine.wait(`body-${bodyOutcome}`, context), /stopped/);
        } finally {
            release();
            await engine.close();
            await harness.close(context);
        }
    });
}

test("one rejected stop selection rejects its caller without aborting body, then explicit retry selects stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-rollback-"));

    directories.add(directory);
    const backing = await openNodeSqliteStorage(join(directory, "workflow.sqlite"));
    let rejects = 0;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    commitContext: Parameters<Storage["commit"]>[1],
                ) => {
                    if (
                        rejects === 0 &&
                        writes.some(
                            (write) =>
                                write.type === "entry" &&
                                write.value.kind === "pocket.workflow-runtime.event" &&
                                write.value.data !== null &&
                                typeof write.value.data === "object" &&
                                !Array.isArray(write.value.data) &&
                                write.value.data.type === "workflow.stopped",
                        )
                    ) {
                        rejects++;

                        throw new StorageRejected("injected stop selection rollback");
                    }

                    return target.commit(writes, commitContext);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const engine = kernel.createEngine(harness);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    let aborted = false;

    try {
        await engine.open(context);
        const workflow = core!.defineWorkflow({
            id: "core.stop.rollback",
            version: 1,
            async run({ signal }) {
                enter();
                await new Promise<void>((resolve) =>
                    signal.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            resolve();
                        },
                        { once: true },
                    ),
                );

                return "after abort";
            },
        });

        await engine.start(workflow, null, { runId: "stop-rollback" }, context);
        await entered;
        await assert.rejects(
            engine.stop("stop-rollback", "first", context),
            /injected stop selection rollback/,
        );
        assert.equal(rejects, 1);
        assert.equal(aborted, false);
        assert.equal((await engine.inspect("stop-rollback", context)).status, "running");
        await engine.stop("stop-rollback", "retry", context);
        assert.equal(aborted, true);
        await assert.rejects(engine.wait("stop-rollback", context), /stopped/);
        assert.equal((await engine.inspect("stop-rollback", context)).status, "stopped");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("engine close during stop watch acquisition disposes the late watch without admitting a command", async () => {
    const backing = new MemoryStorage();
    let commandWrites = 0;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return (writes: readonly StorageWrite[], ctx: Parameters<Storage["commit"]>[1]) => {
                    if (
                        writes.some(
                            (write) =>
                                write.type === "document.change" &&
                                JSON.stringify(write).includes('"stopCommand"'),
                        )
                    ) {
                        commandWrites++;
                    }

                    return target.commit(writes, ctx);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    let enterWatch!: () => void;
    const watchEntered = new Promise<void>((resolve) => {
        enterWatch = resolve;
    });
    let releaseWatch!: () => void;
    const watchGate = new Promise<void>((resolve) => {
        releaseWatch = resolve;
    });
    let resolveLateStop!: () => void;
    const lateStopCalled = new Promise<void>((resolve) => {
        resolveLateStop = resolve;
    });
    let lateWatch: { readonly closed: Promise<unknown> } | undefined;
    let lateStops = 0;
    const originalWatchDoc = harness.watchDoc.bind(harness);
    const forwarded = new Proxy(harness, {
        get(target, property, receiver) {
            if (property === "watchDoc") {
                return async (...args: Parameters<Harness["watchDoc"]>) => {
                    const watch = await originalWatchDoc(...args);

                    if ((args[0] as unknown) !== core!.RUN_DOC || watch === undefined) {
                        return watch;
                    }

                    enterWatch();
                    const observed = new Proxy(watch, {
                        get(handle, key, _handleReceiver) {
                            if (key === "stop") {
                                return async () => {
                                    lateStops++;
                                    resolveLateStop();

                                    return watch.stop();
                                };
                            }

                            const value = Reflect.get(handle, key, watch) as unknown;

                            return typeof value === "function" ? value.bind(watch) : value;
                        },
                    });

                    lateWatch = observed;
                    await watchGate;

                    return observed;
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Harness;
    const engine = kernel.createEngine(forwarded);
    let bodyEntered!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
        bodyEntered = resolve;
    });

    try {
        await engine.open(context);
        await engine.start(
            core!.defineWorkflow({
                id: "core.stop.close-watch",
                version: 1,
                async run({ signal }) {
                    bodyEntered();
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );

                    return "stopped";
                },
            }),
            null,
            { runId: "close-watch" },
            context,
        );
        await bodyStarted;
        const stopping = engine.stop("close-watch", "close", context);

        await watchEntered;
        await engine.close();
        await assert.rejects(stopping, /WorkflowEngine is closed/);
        assert.equal(commandWrites, 0);
        releaseWatch();
        await lateStopCalled;
        await lateWatch!.closed;
        assert.equal(lateStops, 1);
        assert.equal(commandWrites, 0);
    } finally {
        releaseWatch();
        await engine.close();
        await harness.close(context);
    }
});

test("caller cancellation releases stop observers without cancelling an admitted selection", async () => {
    const backing = new MemoryStorage();
    let enterSelection!: () => void;
    const selectionEntered = new Promise<void>((resolve) => {
        enterSelection = resolve;
    });
    let releaseSelection!: () => void;
    const selectionGate = new Promise<void>((resolve) => {
        releaseSelection = resolve;
    });
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    ctx: Parameters<Storage["commit"]>[1],
                ) => {
                    if (
                        writes.some(
                            (write) =>
                                write.type === "entry" &&
                                write.value.kind === "pocket.workflow-runtime.event" &&
                                JSON.stringify(write.value.data).includes('"workflow.stopped"'),
                        )
                    ) {
                        enterSelection();
                        await selectionGate;
                    }

                    return target.commit(writes, ctx);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    let waiterEntered!: () => void;
    const waitForTaskEntered = new Promise<void>((resolve) => {
        waiterEntered = resolve;
    });
    let waiterAborts = 0;
    let watchStops = 0;
    let watchClosed!: Promise<unknown>;
    const forwarded = new Proxy(harness, {
        get(target, property, receiver) {
            if (property === "waitForTask") {
                return (
                    id: Parameters<Harness["waitForTask"]>[0],
                    ctx: Parameters<Harness["waitForTask"]>[1],
                ) => {
                    if (ctx.abortSignal !== undefined) {
                        waiterEntered();
                        ctx.abortSignal.addEventListener(
                            "abort",
                            () => {
                                waiterAborts++;
                            },
                            { once: true },
                        );
                    }

                    return target.waitForTask(id, ctx);
                };
            }

            if (property === "watchDoc") {
                return async (...args: Parameters<Harness["watchDoc"]>) => {
                    const watch = await target.watchDoc(...args);

                    if ((args[0] as unknown) !== core!.RUN_DOC || watch === undefined) {
                        return watch;
                    }

                    watchClosed = watch.closed;

                    return new Proxy(watch, {
                        get(handle, key, _handleReceiver) {
                            if (key === "stop") {
                                return async () => {
                                    watchStops++;

                                    return watch.stop();
                                };
                            }

                            const value = Reflect.get(handle, key, watch) as unknown;

                            return typeof value === "function" ? value.bind(watch) : value;
                        },
                    });
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Harness;
    const engine = kernel.createEngine(forwarded);
    const caller = withCancel(context);
    let bodyAborted = false;
    let bodyEntered!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
        bodyEntered = resolve;
    });

    try {
        await engine.open(context);
        await engine.start(
            core!.defineWorkflow({
                id: "core.stop.caller-cancel",
                version: 1,
                async run({ signal }) {
                    bodyEntered();
                    await new Promise<void>((resolve) =>
                        signal.addEventListener(
                            "abort",
                            () => {
                                bodyAborted = true;
                                resolve();
                            },
                            { once: true },
                        ),
                    );

                    return "stopped";
                },
            }),
            null,
            { runId: "caller-cancel" },
            context,
        );
        await bodyStarted;
        const stopping = engine.stop("caller-cancel", "operator", caller.context);

        await Promise.all([selectionEntered, waitForTaskEntered]);
        caller.cancel(new Error("stop caller aborted"));
        await assert.rejects(stopping, /stop caller aborted/);
        assert.equal(waiterAborts, 1);
        assert.equal(watchStops, 1);
        await watchClosed;
        assert.equal(
            bodyAborted,
            false,
            "caller cancellation does not cancel the durable workflow task",
        );
        releaseSelection();
        await assert.rejects(engine.wait("caller-cancel", context), /stopped/);
        assert.equal(
            bodyAborted,
            true,
            "the selected semantic stop still aborts the workflow body",
        );
    } finally {
        releaseSelection();
        await engine.close();
        await harness.close(context);
    }
});

test("engine close releases a stop caller held before initial snapshot and never submits a command", async () => {
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry },
        context,
    );
    let entered!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    let release!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => {
        release = resolve;
    });
    let commands = 0;
    const forwarded = new Proxy(harness, {
        get(target, property, receiver) {
            if (property === "snapshot") {
                return async (...args: Parameters<Harness["snapshot"]>) => {
                    entered();
                    await snapshotRelease;

                    return target.snapshot(...args);
                };
            }

            if (property === "commit") {
                return async (...args: Parameters<Harness["commit"]>) => {
                    commands++;

                    return target.commit(...args);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Harness;
    const engine = kernel.createEngine(forwarded);

    try {
        await engine.open(context);
        const stopping = engine.stop("not-admitted", "late", context);

        await snapshotEntered;
        await engine.close();
        await assert.rejects(stopping, /WorkflowEngine is closed/);
        assert.equal(
            commands,
            2,
            "open scans deadlines before compatible activation and stop submits no command",
        );
    } finally {
        release();
        await engine.close();
        await harness.close(context);
    }
});

test("a rejected stop observation cancels its native waiter without cancelling the live task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-waiter-"));

    directories.add(directory);
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const backing = await openNodeSqliteStorage(join(directory, "workflow.sqlite"));
    let rejected = 0;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    ctx: Parameters<Storage["commit"]>[1],
                ) => {
                    if (
                        rejected < 3 &&
                        writes.some(
                            (write) =>
                                write.type === "entry" &&
                                JSON.stringify(write.value).includes('"workflow.stopped"'),
                        )
                    ) {
                        rejected++;

                        throw new StorageRejected("waiter selection rejected");
                    }

                    return target.commit(writes, ctx);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    let entered!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    let release!: () => void;
    const bodyRelease = new Promise<void>((resolve) => {
        release = resolve;
    });
    let bodyAborted = false;
    let waiterCalls = 0;
    let waiterAborts = 0;
    let watchStops = 0;
    const watchClosed: Promise<unknown>[] = [];
    const forwarded = new Proxy(harness, {
        get(target, property, receiver) {
            if (property === "waitForTask") {
                return (
                    id: Parameters<Harness["waitForTask"]>[0],
                    ctx: Parameters<Harness["waitForTask"]>[1],
                ) => {
                    waiterCalls++;
                    ctx.abortSignal?.addEventListener(
                        "abort",
                        () => {
                            waiterAborts++;
                        },
                        { once: true },
                    );

                    return target.waitForTask(id, ctx);
                };
            }

            if (property === "watchDoc") {
                return async (...args: Parameters<Harness["watchDoc"]>) => {
                    const watch = await target.watchDoc(...args);

                    if ((args[0] as unknown) !== core!.RUN_DOC || watch === undefined) {
                        return watch;
                    }

                    watchClosed.push(watch.closed);

                    return new Proxy(watch, {
                        get(handle, key, _receiver) {
                            if (key === "stop") {
                                return async () => {
                                    watchStops++;

                                    return watch.stop();
                                };
                            }

                            const value = Reflect.get(handle, key, watch) as unknown;

                            return typeof value === "function" ? value.bind(watch) : value;
                        },
                    });
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Harness;
    const engine = kernel.createEngine(forwarded);

    try {
        await engine.open(context);
        const workflow = core!.defineWorkflow({
            id: "core.stop.waiter",
            version: 1,
            async run({ signal }) {
                signal.addEventListener(
                    "abort",
                    () => {
                        bodyAborted = true;
                    },
                    { once: true },
                );
                entered();
                await bodyRelease;

                return "done";
            },
        });

        await engine.start(workflow, null, { runId: "waiter" }, context);
        await bodyEntered;

        for (let revision = 1; revision <= 3; revision++) {
            const stopError = await engine.stop("waiter", `revision ${revision}`, context).then(
                () => undefined,
                (error: unknown) => error,
            );
            const state = await harness.snapshot(core!.RUN_DOC, "waiter", context);

            assert.equal(state?.stopCommand?.request, revision);
            assert.equal(
                state?.selectedOutcome,
                undefined,
                `revision ${revision} must not preselect`,
            );
            assert.equal(bodyAborted, false, `revision ${revision} must not abort the live body`);
            assert.ok(
                stopError,
                `revision ${revision} returned success after ${rejected} injected failures`,
            );
            assert.match(String(stopError), /waiter selection rejected/);
            assert.equal(waiterCalls, revision);
            assert.equal(waiterAborts, revision, "each native wait context must be cancelled");
            assert.equal(watchStops, revision, "each command watch must be stopped");
            await watchClosed[revision - 1];
        }

        assert.equal(rejected, 3);
        assert.equal((await engine.inspect("waiter", context)).status, "running");
        await engine.stop("waiter", "explicit retry", context);
        assert.equal(waiterCalls, 4);
        assert.equal(waiterAborts, 4);
        assert.equal(watchStops, 4);
        release();
        await assert.rejects(engine.wait("waiter", context), /stopped/);
    } finally {
        release();
        await engine.close();
        await harness.close(context);
    }
});

test("closing the engine releases a stop caller waiting for native selection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-close-"));

    directories.add(directory);
    const backing = await openNodeSqliteStorage(join(directory, "workflow.sqlite"));
    let enterSelection!: () => void;
    const selecting = new Promise<void>((resolve) => {
        enterSelection = resolve;
    });
    let releaseSelection!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseSelection = resolve;
    });
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    commitContext: Parameters<Storage["commit"]>[1],
                ) => {
                    if (
                        writes.some(
                            (write) =>
                                write.type === "entry" &&
                                write.value.kind === "pocket.workflow-runtime.event" &&
                                write.value.data !== null &&
                                typeof write.value.data === "object" &&
                                !Array.isArray(write.value.data) &&
                                write.value.data.type === "workflow.stopped",
                        )
                    ) {
                        enterSelection();
                        await gate;
                    }

                    return target.commit(writes, commitContext);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const engine = kernel.createEngine(harness);

    try {
        await engine.open(context);
        const workflow = core!.defineWorkflow({
            id: "core.stop.close",
            version: 1,
            async run({ signal }) {
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );

                return "body finished";
            },
        });

        await engine.start(workflow, null, { runId: "stop-close" }, context);
        const stopping = engine.stop("stop-close", "close", context);

        await selecting;
        // The held storage transaction serializes inspection; close need not wait.
        await engine.close();
        await assert.rejects(stopping, /WorkflowEngine is closed/);
        releaseSelection();
        await assert.rejects(engine.wait("stop-close", context), /stopped/);
    } finally {
        releaseSelection();
        await engine.close();
        await harness.close(context);
    }
});

test("closing the engine releases a stop caller even while command commit is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-command-close-"));

    directories.add(directory);
    const backing = await openNodeSqliteStorage(join(directory, "workflow.sqlite"));
    let enterCommit!: () => void;
    const committing = new Promise<void>((resolve) => {
        enterCommit = resolve;
    });
    let releaseCommit!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
    });
    let blocked = false;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    commitContext: Parameters<Storage["commit"]>[1],
                ) => {
                    if (
                        !blocked &&
                        writes.some(
                            (write) =>
                                write.type === "document.change" &&
                                JSON.stringify(write).includes("stopCommand"),
                        )
                    ) {
                        blocked = true;
                        enterCommit();
                        await gate;
                    }

                    return target.commit(writes, commitContext);
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const engine = kernel.createEngine(harness);

    try {
        await engine.open(context);
        const workflow = core!.defineWorkflow({
            id: "core.stop.command.close",
            version: 1,
            async run({ signal }) {
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );

                return "after abort";
            },
        });

        await engine.start(workflow, null, { runId: "stop-command-close" }, context);
        const stopping = engine.stop("stop-command-close", "close", context);

        await committing;
        await engine.close();
        await assert.rejects(stopping, /WorkflowEngine is closed/);
        releaseCommit();
        await assert.rejects(engine.wait("stop-command-close", context), /stopped/);
    } finally {
        releaseCommit();
        await engine.close();
        await harness.close(context);
    }
});

test("stop selects a durable stopped outcome through the running invocation", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });

    try {
        const workflow = core.defineWorkflow({
            id: "core.stop.active",
            version: 1,
            async run({ signal }) {
                entered();
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );

                return "body-observed-stop";
            },
        });
        const handle = await engine.start(workflow, null, { runId: "stop-active" }, context);

        await started;
        await engine.stop(handle.runId, "operator request", context);
        const inspection = await engine.inspect(handle.runId, context);

        assert.equal(inspection.status, "stopped");
        await assert.rejects(engine.wait(handle.runId, context), /stopped/);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("concurrent step.do transitions merge against the latest checkpoint", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();

    try {
        const workflow = core.defineWorkflow({
            id: "core.operation.parallel-merge",
            version: 1,
            async run({ step }) {
                const [left, right] = await Promise.all([
                    step.do("left", async () => "L"),
                    step.do("right", async () => "R"),
                ]);

                return { left, right };
            },
        });
        const handle = await engine.start(workflow, null, { runId: "parallel-merge" }, context);

        assert.deepEqual(await engine.wait(handle.runId, context), {
            left: "L",
            right: "R",
        });
        const inspection = await engine.inspect(handle.runId, context);

        assert.equal(inspection.operations.left?.status, "completed");
        assert.equal(inspection.operations.right?.status, "completed");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("reusing a caller-reserved run ID for conflicting input is rejected", async () => {
    assert.ok(core, "the production workflow runtime core module must exist");
    const { harness, engine } = await fixture();

    try {
        const workflow = definition("core.admission.conflict", "admitted");

        await engine.start(workflow, { value: 1 }, { runId: "reserved-conflict" }, context);
        await assert.rejects(
            engine.start(workflow, { value: 2 }, { runId: "reserved-conflict" }, context),
            /run ID.*conflict/i,
        );
        const tasks = await harness.commit(
            (tx) => tx.scanTasks({ kind: core.WorkflowRuntimeTask.definition.name }, 20),
            context,
        );

        assert.equal(tasks.items.length, 1);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("terminal draining closes admission and unawaited failed effects cannot select success", async () => {
    const { harness, engine } = await fixture();
    let release!: () => void;
    let admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
        admitted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let late: Promise<unknown> | undefined;
    let exposedStep:
        { do(id: string, callback: () => Promise<string>): Promise<string> } | undefined;

    try {
        const workflow = core!.defineWorkflow({
            id: "core.terminal.drain",
            version: 1,
            async run({ step }) {
                void step.do("first", async () => {
                    admitted();
                    await gate;

                    throw new Error("unawaited effect failed");
                });
                await entered;
                exposedStep = step;

                return "premature success";
            },
        });
        const run = await engine.start(workflow, null, { runId: "terminal-drain" }, context);

        await entered;
        await new Promise((resolve) => setTimeout(resolve, 20));
        late = exposedStep!.do("late", async () => "must-not-run");
        assert.ok(late);
        await assert.rejects(late!, /admission is closed/);
        release();
        await assert.rejects(engine.wait(run.runId, context), /unawaited effect failed/);
        assert.equal((await engine.inspect(run.runId, context)).status, "failed");
    } finally {
        release();
        await engine.close();
        await harness.close(context);
    }
});

test("undefined thrown by workflow is a failure, not successful completion", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.undefined.failure",
            version: 1,
            async run(): Promise<string> {
                throw undefined;
            },
        });

        await engine.start(workflow, null, { runId: "undefined-failure" }, context);
        await assert.rejects(engine.wait("undefined-failure", context));
        assert.equal((await engine.inspect("undefined-failure", context)).status, "failed");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("unregistered definition parks durably and can be stopped without running body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-workflow-incompatible-"));

    directories.add(directory);
    const databasePath = join(directory, "workflow.sqlite");
    const workflow = core!.defineWorkflow({
        id: "core.incompatible.park",
        version: 1,
        async run() {
            await new Promise(() => {});

            return "original";
        },
    });
    const firstKernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(firstKernel.extension);
    const first = await Harness.open(
        await openNodeSqliteStorage(databasePath),
        { models: createModels(), registry },
        context,
    );
    const firstEngine = firstKernel.createEngine(first);

    await firstEngine.open(context);
    await firstEngine.start(workflow, null, { runId: "incompatible-park" }, context);
    await firstEngine.close();
    await first.close(context);
    const secondKernel = core!.createWorkflowRuntimeKernel();
    const secondRegistry = createRegistry();

    secondRegistry.install(secondKernel.extension);
    const reopened = await Harness.open(
        await openNodeSqliteStorage(databasePath),
        { models: createModels(), registry: secondRegistry },
        context,
    );
    const engine = secondKernel.createEngine(reopened);

    try {
        await engine.open(context);
        let inspection = await engine.inspect("incompatible-park", context);

        for (let i = 0; i < 100 && inspection.status === "running"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            inspection = await engine.inspect("incompatible-park", context);
        }

        assert.equal(inspection.status, "incompatible");
        await engine.stop("incompatible-park", "operator stop", context);
        await assert.rejects(engine.wait("incompatible-park", context), /stopped/);
        assert.equal((await engine.inspect("incompatible-park", context)).status, "stopped");
    } finally {
        await engine.close();
        await reopened.close(context);
    }
});

test("stopped outcome is selected in native COMPLETING before owned child abort settles; cleanup cannot overwrite it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-owned-"));

    directories.add(directory);
    let abortReached!: () => void;
    let releaseAbort!: () => void;
    const aborting = new Promise<void>((resolve) => {
        abortReached = resolve;
    });
    const abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
    });
    const child = (await import("@earendil-works/pi-durable")).defineTask({
        name: "core.test.owned",
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
            abortReached();
            await abortGate;

            throw new Error("owned cleanup failed");
        },
    });
    const registry = createRegistry();

    registry.install(core!.workflowRuntimeExtension);
    registry.install(defineExtension({ name: "core-test-owned", tasks: [child] }));
    const database = join(directory, "workflow.sqlite");
    const harness = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry },
        context,
    );
    let stopWaiterAborts = 0;
    let stopWatchStops = 0;
    let stopWatchClosed: Promise<unknown> | undefined;
    const observedHarness = new Proxy(harness, {
        get(target, property, receiver) {
            if (property === "waitForTask") {
                return (
                    id: Parameters<Harness["waitForTask"]>[0],
                    ctx: Parameters<Harness["waitForTask"]>[1],
                ) => {
                    if (ctx.abortSignal !== undefined) {
                        ctx.abortSignal.addEventListener(
                            "abort",
                            () => {
                                stopWaiterAborts++;
                            },
                            { once: true },
                        );
                    }

                    return target.waitForTask(id, ctx);
                };
            }

            if (property === "watchDoc") {
                return async (...args: Parameters<Harness["watchDoc"]>) => {
                    const watch = await target.watchDoc(...args);

                    if ((args[0] as unknown) !== core!.RUN_DOC || watch === undefined) {
                        return watch;
                    }

                    stopWatchClosed = watch.closed;

                    return new Proxy(watch, {
                        get(handle, key, handleReceiver) {
                            if (key === "stop") {
                                return async () => {
                                    stopWatchStops++;

                                    return watch.stop();
                                };
                            }

                            const value = Reflect.get(handle, key, watch) as unknown;

                            return typeof value === "function" ? value.bind(watch) : value;
                        },
                    });
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Harness;
    const engine = new core!.WorkflowEngine(observedHarness);
    let bodyStarted!: () => void;
    const bodyEntered = new Promise<void>((resolve) => {
        bodyStarted = resolve;
    });

    try {
        await engine.open(context);
        const workflow = core!.defineWorkflow({
            id: "core.stop.owned",
            version: 1,
            async run({ signal }) {
                bodyStarted();
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );

                return "cannot complete after stop";
            },
        });

        await engine.start(workflow, null, { runId: "stop-owned" }, context);
        await bodyEntered;
        const childId = await harness.commit(async (tx) => {
            const tasks = await tx.scanTasks(
                { kind: core!.WorkflowRuntimeTask.definition.name },
                10,
            );

            return tx.createTask(child, null, {
                ownership: { kind: "task", taskId: tasks.items[0]!.id },
            });
        }, context);

        await engine.stop("stop-owned", "owner request", context);
        assert.equal(
            stopWaiterAborts,
            1,
            "selected stop releases its nonterminal Task observation",
        );
        assert.equal(stopWatchStops, 1, "selected stop releases its run-document watch");
        await stopWatchClosed;
        await aborting;
        const tasks = await harness.commit(
            (tx) => tx.scanTasks({ kind: core!.WorkflowRuntimeTask.definition.name }, 10),
            context,
        );

        assert.equal(tasks.items[0]?.state.status, "completing");

        if (tasks.items[0]?.state.status === "completing") {
            assert.equal(tasks.items[0].state.outcome.status, "aborted");
        }

        const duringCleanup = await engine.inspect("stop-owned", context);

        assert.equal(duringCleanup.status, "stopped");
        assert.equal(duringCleanup.cleanup?.status, "pending");
        assert.ok(duringCleanup.cleanup?.nativeTaskId);
        releaseAbort();
        await assert.rejects(engine.wait("stop-owned", context), /stopped/);
        const childReceipt = await harness.commit((tx) => tx.task(childId), context);

        assert.equal(childReceipt?.state.status, "terminal");

        if (childReceipt?.state.status === "terminal") {
            assert.equal(childReceipt.state.outcome.status, "faulted");
        }

        assert.equal((await engine.inspect("stop-owned", context)).status, "stopped");
    } finally {
        releaseAbort();
        await engine.close();
        await harness.close(context);
    }
});

test("earlier native COMPLETING completion or failure wins a later stop request", async () => {
    for (const outcome of ["completed", "failed"] as const) {
        const directory = await mkdtemp(join(tmpdir(), "pi-pocket-selected-order-"));

        directories.add(directory);
        let releaseBody!: () => void;
        let entered!: () => void;
        let releaseChild!: () => void;
        const bodyGate = new Promise<void>((resolve) => {
            releaseBody = resolve;
        });
        const bodyEntered = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const childGate = new Promise<void>((resolve) => {
            releaseChild = resolve;
        });
        const child = (await import("@earendil-works/pi-durable")).defineTask({
            name: "core.test.order-child",
            version: 1,
            initial: () => ({ phase: "run" as const }),
            phases: {
                run: async (_task, runtime) => {
                    await Promise.race([
                        childGate,
                        new Promise<void>((resolve) =>
                            runtime.signal.addEventListener("abort", () => resolve(), {
                                once: true,
                            }),
                        ),
                    ]);
                },
            },
            abort: async () => {
                await childGate;
            },
        });
        const registry = createRegistry();

        registry.install(core!.workflowRuntimeExtension);
        registry.install(defineExtension({ name: "core-test-order-child", tasks: [child] }));
        const harness = await Harness.open(
            await openNodeSqliteStorage(join(directory, "workflow.sqlite")),
            { models: createModels(), registry },
            context,
        );
        const engine = new core!.WorkflowEngine(harness);

        try {
            await engine.open(context);
            const workflow = core!.defineWorkflow({
                id: `core.order.${outcome}`,
                version: 1,
                async run() {
                    entered();
                    await bodyGate;

                    if (outcome === "failed") {
                        throw new Error("selected failure");
                    }

                    return "selected success";
                },
            });

            await engine.start(workflow, null, { runId: `order-${outcome}` }, context);
            await bodyEntered;
            await harness.commit(async (tx) => {
                const tasks = await tx.scanTasks(
                    { kind: core!.WorkflowRuntimeTask.definition.name },
                    10,
                );

                await tx.createTask(child, null, {
                    ownership: { kind: "task", taskId: tasks.items[0]!.id },
                });
            }, context);
            releaseBody();
            let state = "";

            for (let i = 0; i < 100; i++) {
                const tasks = await harness.commit(
                    (tx) => tx.scanTasks({ kind: core!.WorkflowRuntimeTask.definition.name }, 10),
                    context,
                );

                state = tasks.items[0]?.state.status ?? "";

                if (state === "completing") {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            assert.equal(state, "completing");
            await engine.stop(`order-${outcome}`, "too late", context);
            assert.equal((await engine.inspect(`order-${outcome}`, context)).status, outcome);
            releaseChild();

            if (outcome === "completed") {
                assert.equal(await engine.wait(`order-${outcome}`, context), "selected success");
            } else {
                await assert.rejects(engine.wait(`order-${outcome}`, context), /selected failure/);
            }
        } finally {
            releaseBody();
            releaseChild();
            await engine.close();
            await harness.close(context);
        }
    }
});

test("SIGKILL after stopped selection during native child cancellation retains stopped on fresh reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-crash-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const log = join(directory, "effects.log");
    const marker = join(directory, "marker");
    const worker = startWorker("cancel-start", database, log, marker, {
        PI_CORE_SCENARIO: "cancel",
    });
    let recovery: ChildProcess | undefined;

    try {
        await outputUntil(worker, "CHILD_ABORT_ENTERED");
        await killWorker(worker);
        recovery = startWorker("cancel-recover", database, log, marker, {
            PI_CORE_SCENARIO: "cancel",
        });
        const output = await outputUntil(recovery, "INSPECT:");

        assert.deepEqual(await workerExit(recovery), [0, null]);
        assert.match(output, /ERROR:WorkflowStoppedError/);
        assert.equal(inspectionFrom(output).status, "stopped");
    } finally {
        await killWorker(worker);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }
    }
});

test("ambiguous post-commit storage acknowledgement is resolved from durable checkpoint on fresh reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-ambiguous-completion-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const log = join(directory, "effects.log");
    const marker = join(directory, "marker");
    const worker = startWorker("ambiguous-start", database, log, marker, {
        PI_CORE_SCENARIO: "ambiguous",
    });
    let recovery: ChildProcess | undefined;

    try {
        await outputUntil(worker, "AMBIGUOUS:completion-committed");
        await killWorker(worker);
        recovery = startWorker("ambiguous-recover", database, log, marker, {
            PI_CORE_SCENARIO: "ambiguous",
        });
        const output = await outputUntil(recovery, "INSPECT:");

        assert.deepEqual(await workerExit(recovery), [0, null]);
        assert.match(output, /RESULT:"done-1"/);
        assert.equal(inspectionFrom(output).operations["external-effect"]?.status, "completed");
        assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
    } finally {
        await killWorker(worker);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }
    }
});

test("registered wrong version blocks reentry until exact definition is registered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-version-mismatch-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const firstKernel = core!.createWorkflowRuntimeKernel();
    const firstRegistry = createRegistry();

    firstRegistry.install(firstKernel.extension);
    const first = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry: firstRegistry },
        context,
    );
    const original = firstKernel.createEngine(first);

    await original.open(context);
    const v1 = core!.defineWorkflow({
        id: "core.versioned",
        version: 1,
        async run({ signal }) {
            await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
            );

            return "old";
        },
    });

    await original.start(v1, null, { runId: "versioned" }, context);
    await original.close();
    await first.close(context);
    const secondKernel = core!.createWorkflowRuntimeKernel();
    const secondRegistry = createRegistry();

    secondRegistry.install(secondKernel.extension);
    const reopened = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry: secondRegistry },
        context,
    );
    const engine = secondKernel.createEngine(reopened);
    let bodyCalls = 0;

    try {
        engine.register(
            core!.defineWorkflow({
                id: "core.versioned",
                version: 2,
                async run() {
                    bodyCalls++;

                    return "wrong";
                },
            }),
        );
        await engine.open(context);
        let status = "running";

        for (let i = 0; i < 100 && status === "running"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            status = (await engine.inspect("versioned", context)).status;
        }

        assert.equal(status, "incompatible");
        assert.equal(bodyCalls, 0);
        engine.register(
            core!.defineWorkflow({
                id: "core.versioned",
                version: 1,
                async run() {
                    bodyCalls++;

                    return "compatible";
                },
            }),
        );
        // Registration after open becomes active on the next explicit open/activation call.
        await engine.open(context);
        assert.equal(await engine.wait("versioned", context), "compatible");
        assert.equal(bodyCalls, 1);
        assert.equal((await engine.inspect("versioned", context)).status, "completed");
    } finally {
        await engine.close();
        await reopened.close(context);
    }
});

test("workflow may handle a known step failure and complete without unhandled drain failure", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.handled.failure",
            version: 1,
            async run({ step }) {
                try {
                    await step.do("may-fail", async () => {
                        throw new Error("handled");
                    });
                } catch {
                    return "handled successfully";
                }

                return "unreachable";
            },
        });

        await engine.start(workflow, null, { runId: "handled-failure" }, context);
        assert.equal(await engine.wait("handled-failure", context), "handled successfully");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("unawaited step failure that settles before ordinary drain cannot become success", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.early.unawaited",
            version: 1,
            async run({ step }) {
                void step.do("unawaited", async () => {
                    throw new Error("early unawaited failure");
                });
                await new Promise((resolve) => setTimeout(resolve, 15));

                return "invalid success";
            },
        });

        await engine.start(workflow, null, { runId: "early-unawaited" }, context);
        await assert.rejects(engine.wait("early-unawaited", context), /early unawaited failure/);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("bounded inspection summaries disclose truncation without losing journal history", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.summary.bound",
            version: 1,
            async run({ step }) {
                for (let i = 0; i < 66; i++) {
                    await step.do(`op-${i}`, async () => i);
                }

                return "complete";
            },
        });

        await engine.start(workflow, null, { runId: "bounded-summary" }, context);
        assert.equal(await engine.wait("bounded-summary", context), "complete");
        const inspection = await engine.inspect("bounded-summary", context);

        assert.equal(Object.keys(inspection.operations).length, 64);
        assert.equal(inspection.operationsTruncated, 2);
        const entries = await harness.commit(async (tx) => {
            const conversations = await tx.scanConversations({}, 10);

            return tx.scanEntries({ conversationId: conversations.items[0]!.id }, 200);
        }, context);

        assert.equal(
            entries.items.filter(
                (entry) => (entry.data as { type?: string }).type === "operation.completed",
            ).length,
            66,
        );
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("terminal inspection retains operation result summary after native checkpoint retirement", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.retired.checkpoint",
            version: 1,
            async run({ step }) {
                return step.do("saved", async () => 42);
            },
        });

        await engine.start(workflow, null, { runId: "retired-checkpoint" }, context);
        assert.equal(await engine.wait("retired-checkpoint", context), 42);
        const tasks = await harness.commit(
            (tx) => tx.scanTasks({ kind: core!.WorkflowRuntimeTask.definition.name }, 10),
            context,
        );

        assert.equal(tasks.items[0]?.state.status, "terminal");
        assert.equal(Object.hasOwn(tasks.items[0]!.state, "checkpoint"), false);
        const inspection = await engine.inspect("retired-checkpoint", context);

        assert.equal(inspection.status, "completed");
        assert.equal(inspection.operations.saved?.status, "completed");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("prototype-named operation IDs execute and remain own inspection properties", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.prototype.ids",
            version: 1,
            async run({ step }) {
                for (const id of ["toString", "constructor", "__proto__"]) {
                    assert.equal(await step.do(id, () => id), id);
                }

                return "done";
            },
        });

        await engine.start(workflow, null, { runId: "prototype-ids" }, context);
        assert.equal(await engine.wait("prototype-ids", context), "done");
        const inspection = await engine.inspect("prototype-ids", context);

        assert.deepEqual(Object.keys(inspection.operations).sort(), [
            "__proto__",
            "constructor",
            "toString",
        ]);

        for (const id of ["toString", "constructor", "__proto__"]) {
            assert.equal(Object.hasOwn(inspection.operations, id), true);
            assert.equal(inspection.operations[id]?.status, "completed");
        }

        assert.equal(Object.getPrototypeOf(inspection.operations), Object.prototype);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("step.do returns a native Promise while preserving unhandled failure tracking", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.promise.identity",
            version: 1,
            async run({ step }) {
                const effect = step.do("effect", async () => "value");

                assert.ok(effect instanceof Promise);

                return await effect;
            },
        });

        await engine.start(workflow, null, { runId: "promise-identity" }, context);
        assert.equal(await engine.wait("promise-identity", context), "value");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("downstream Promise catch and try/await handle step failures without hiding detached failures", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.promise.chain.handled",
            version: 1,
            async run({ step }) {
                const chained = await step
                    .do("chained", () => {
                        throw new Error("chained failure");
                    })
                    .then((value) => value)
                    .finally(() => {})
                    .catch(() => "recovered");
                let caught = false;

                try {
                    await step
                        .do("await-derived", () => {
                            throw new Error("awaited failure");
                        })
                        .then((value) => value);
                } catch {
                    caught = true;
                }

                assert.equal(caught, true);

                return chained;
            },
        });

        await engine.start(workflow, null, { runId: "chain-handled" }, context);
        assert.equal(await engine.wait("chain-handled", context), "recovered");
        assert.equal((await engine.inspect("chain-handled", context)).status, "completed");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("a handled Promise branch cannot hide an unhandled sibling branch", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.promise.fork",
            version: 1,
            async run({ step }) {
                const effect = step.do("fork", () => {
                    throw new Error("unhandled sibling failure");
                });

                void effect.then((value) => value);
                await effect.catch(() => "handled branch");

                return "not-success";
            },
        });

        await engine.start(workflow, null, { runId: "promise-fork" }, context);
        await assert.rejects(engine.wait("promise-fork", context), /unhandled sibling failure/);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("detached then/finally without a catch still fails ordinary terminal drain", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow({
            id: "core.detached.chain",
            version: 1,
            async run({ step }) {
                void step
                    .do("detached", () => {
                        throw new Error("unhandled chain failure");
                    })
                    .then((value) => value)
                    .finally(() => {});

                return "not-success";
            },
        });

        await engine.start(workflow, null, { runId: "detached-chain" }, context);
        await assert.rejects(engine.wait("detached-chain", context), /unhandled chain failure/);
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("stop selected first cannot be replaced by a later body failure", async () => {
    const { harness, engine } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });

    try {
        const workflow = core!.defineWorkflow({
            id: "core.stop.beats.failure",
            version: 1,
            async run({ signal }) {
                entered();
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );

                throw new Error("failure after stopped selection");
            },
        });

        await engine.start(workflow, null, { runId: "stop-beats-failure" }, context);
        await started;
        await engine.stop("stop-beats-failure", "chosen stop", context);
        await assert.rejects(engine.wait("stop-beats-failure", context), /stopped/);
        assert.equal((await engine.inspect("stop-beats-failure", context)).status, "stopped");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("logical idempotency tuple encoding distinguishes delimiter-colliding run and operation IDs", async () => {
    const { harness, engine } = await fixture();

    try {
        const workflow = core!.defineWorkflow<{ operation: string }, string>({
            id: "core.keys.tuple",
            version: 1,
            async run({ input, step }) {
                return step.do(input.operation, async ({ idempotencyKey }) => idempotencyKey);
            },
        });

        await engine.start(workflow, { operation: "b:c" }, { runId: "a" }, context);
        await engine.start(workflow, { operation: "c" }, { runId: "a:b" }, context);
        const left = await engine.wait<string>("a", context);
        const right = await engine.wait<string>("a:b", context);

        assert.notEqual(left, right);
        assert.equal(Buffer.from(left.split(":")[1]!, "base64url").toString("utf8"), '["a","b:c"]');
        assert.equal(
            Buffer.from(right.split(":")[1]!, "base64url").toString("utf8"),
            '["a:b","c"]',
        );
    } finally {
        await engine.close();
        await harness.close(context);
    }
});

test("native orphaned or faulted outcome never reports a live operation as running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-native-orphan-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const firstKernel = core!.createWorkflowRuntimeKernel();
    const firstRegistry = createRegistry();

    firstRegistry.install(firstKernel.extension);
    const first = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry: firstRegistry },
        context,
    );
    const original = firstKernel.createEngine(first);

    await original.open(context);
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const workflow = core!.defineWorkflow({
        id: "core.native.orphan",
        version: 1,
        async run({ step }) {
            return step.do("external", async ({ signal }) => {
                entered();
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );

                return "never";
            });
        },
    });

    await original.start(workflow, null, { runId: "native-orphan" }, context);
    await callbackEntered;
    await original.close();
    await first.close(context);
    const incompatibleTask = (await import("@earendil-works/pi-durable")).defineTask({
        name: core!.WorkflowRuntimeTask.definition.name,
        version: 2,
        initial: () => ({ phase: "run" as const }),
        phases: {
            run: async () => {
                throw new Error("version 2 must not run v1 checkpoint");
            },
        },
        abort: async () => {},
    });
    const registry = createRegistry();

    registry.install(defineExtension({ name: "core-native-orphan", tasks: [incompatibleTask] }));
    const reopened = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry },
        context,
    );
    const engine = new core!.WorkflowEngine(reopened);

    try {
        await engine.open(context);
        const tasks = await reopened.commit(
            (tx) => tx.scanTasks({ kind: core!.WorkflowRuntimeTask.definition.name }, 10),
            context,
        );

        await reopened.abortTask(tasks.items[0]!.id, context);
        const receipt = await reopened.waitForTask(tasks.items[0]!.id, context);

        assert.equal(receipt.state.outcome.status, "orphaned");
        const inspection = await engine.inspect("native-orphan", context);

        assert.equal(inspection.status, "failed");
        assert.equal(inspection.operations.external?.status, "unknown");
    } finally {
        await engine.close();
        await reopened.close(context);
    }
});

test("waking a compatible definition clears stale incompatible inspection before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-compatible-running-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const firstKernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(firstKernel.extension);
    const first = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry },
        context,
    );
    const original = firstKernel.createEngine(first);

    await original.open(context);
    const firstDefinition = core!.defineWorkflow({
        id: "core.compatible.status",
        version: 1,
        async run({ signal }) {
            await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
            );

            return "old";
        },
    });

    await original.start(firstDefinition, null, { runId: "compatible-status" }, context);
    await original.close();
    await first.close(context);
    const secondKernel = core!.createWorkflowRuntimeKernel();
    const secondRegistry = createRegistry();

    secondRegistry.install(secondKernel.extension);
    const reopened = await Harness.open(
        await openNodeSqliteStorage(database),
        { models: createModels(), registry: secondRegistry },
        context,
    );
    const engine = secondKernel.createEngine(reopened);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    try {
        await engine.open(context);
        let status = "running";

        for (let i = 0; i < 100 && status === "running"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            status = (await engine.inspect("compatible-status", context)).status;
        }

        assert.equal(status, "incompatible");
        engine.register(
            core!.defineWorkflow({
                id: "core.compatible.status",
                version: 1,
                async run() {
                    entered();
                    await gate;

                    return "new";
                },
            }),
        );
        await engine.open(context);
        await started;
        assert.equal((await engine.inspect("compatible-status", context)).status, "running");
        release();
        assert.equal(await engine.wait("compatible-status", context), "new");
    } finally {
        release();
        await engine.close();
        await reopened.close(context);
    }
});

test("an admitted stop command wins before incompatible parking and a rejected selection needs a new request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-command-first-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");

    await seedIncompatibleRun(database, "command-first", "core.stop.command-first");
    const backing = await openNodeSqliteStorage(database);
    const trace: string[] = [];
    let releaseCommand!: () => void;
    const commandGate = new Promise<void>((resolve) => {
        releaseCommand = resolve;
    });
    let enterCommand!: () => void;
    const commandEntered = new Promise<void>((resolve) => {
        enterCommand = resolve;
    });
    let releaseNativeWatch!: () => void;
    const nativeWatchGate = new Promise<void>((resolve) => {
        releaseNativeWatch = resolve;
    });
    let enterNativeWatch!: () => void;
    const nativeWatchEntered = new Promise<void>((resolve) => {
        enterNativeWatch = resolve;
    });
    let firstParked!: () => void;
    const parked = new Promise<void>((resolve) => {
        firstParked = resolve;
    });
    let attempts = 0;
    let parkedCount = 0;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    ctx: Parameters<Storage["commit"]>[1],
                ) => {
                    const command = writes.some(
                        (write) =>
                            write.type === "document.change" &&
                            JSON.stringify(write).includes('"stopCommand"'),
                    );
                    const selection = writes.some(
                        (write) =>
                            write.type === "entry" &&
                            write.value.kind === "pocket.workflow-runtime.event" &&
                            JSON.stringify(write.value.data).includes('"workflow.stopped"'),
                    );
                    const park = writes.some(
                        (write) =>
                            write.type === "task" &&
                            write.value.state.status === "waiting" &&
                            write.value.state.external === true &&
                            write.value.wakePending !== true,
                    );

                    if (command) {
                        trace.push("command-enter");

                        if (trace.filter((item) => item === "command-enter").length === 1) {
                            enterCommand();
                            await commandGate;
                        }
                    }

                    if (selection) {
                        attempts++;
                        trace.push(`selection-${attempts}`);

                        if (attempts === 1) {
                            throw new StorageRejected("forced command-first selection rejection");
                        }
                    }

                    if (park) {
                        trace.push("park-enter");
                    }

                    const result = await target.commit(writes, ctx);

                    if (command) {
                        trace.push("command-committed");
                    }

                    if (park) {
                        parkedCount++;
                        trace.push("park-committed");

                        if (parkedCount === 1) {
                            firstParked();
                        }
                    }

                    return result;
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const originalWatchDoc = harness.watchDoc.bind(harness);
    let holdNativeWatch = true;

    Object.defineProperty(harness, "watchDoc", {
        configurable: true,
        value: async (...args: Parameters<Harness["watchDoc"]>) => {
            const watch = await originalWatchDoc(...args);

            if (holdNativeWatch && (args[0] as unknown) === core!.RUN_DOC) {
                holdNativeWatch = false;
                enterNativeWatch();
                await nativeWatchGate;
            }

            return watch;
        },
    });
    const engine = kernel.createEngine(harness);
    let opening: Promise<void> | undefined;

    try {
        opening = engine.open(context);
        await nativeWatchEntered;
        await opening;
        const stopping = engine.stop("command-first", "operator", context);

        await commandEntered;
        releaseNativeWatch();
        releaseCommand();
        await assert.rejects(stopping, /forced command-first selection rejection/);
        await parked;
        assert.equal(attempts, 1);
        assert.equal((await engine.inspect("command-first", context)).status, "incompatible");
        await engine.stop("command-first", "explicit retry", context);
        await assert.rejects(engine.wait("command-first", context), /stopped/);
        assert.equal(attempts, 2);
        assert.ok(trace.indexOf("command-committed") < trace.indexOf("selection-1"));
        assert.ok(trace.indexOf("selection-1") < trace.indexOf("park-committed"));
    } finally {
        releaseNativeWatch();
        releaseCommand();
        await opening?.catch(() => {});
        await engine.close();
        await harness.close(context);
    }
});

test("an incompatible park already admitted before stop remains nonterminal until an explicit retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-park-first-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");

    await seedIncompatibleRun(database, "park-first", "core.stop.park-first");
    const backing = await openNodeSqliteStorage(database);
    const trace: string[] = [];
    let releasePark!: () => void;
    const parkGate = new Promise<void>((resolve) => {
        releasePark = resolve;
    });
    let enterPark!: () => void;
    const parkEntered = new Promise<void>((resolve) => {
        enterPark = resolve;
    });
    let enterSnapshot!: () => void;
    const snapshotRequested = new Promise<void>((resolve) => {
        enterSnapshot = resolve;
    });
    let afterRollbackPark!: () => void;
    const parkedAfterRollback = new Promise<void>((resolve) => {
        afterRollbackPark = resolve;
    });
    let attempts = 0;
    let parkCount = 0;
    const storage = new Proxy(backing, {
        get(target, property, receiver) {
            if (property === "commit") {
                return async (
                    writes: readonly StorageWrite[],
                    ctx: Parameters<Storage["commit"]>[1],
                ) => {
                    const command = writes.some(
                        (write) =>
                            write.type === "document.change" &&
                            JSON.stringify(write).includes('"stopCommand"'),
                    );
                    const selection = writes.some(
                        (write) =>
                            write.type === "entry" &&
                            write.value.kind === "pocket.workflow-runtime.event" &&
                            JSON.stringify(write.value.data).includes('"workflow.stopped"'),
                    );
                    const park = writes.some(
                        (write) =>
                            write.type === "task" &&
                            write.value.state.status === "waiting" &&
                            write.value.state.external === true,
                    );

                    if (park) {
                        parkCount++;
                        trace.push(`park-${parkCount}-enter`);

                        if (parkCount === 1) {
                            enterPark();
                            await parkGate;
                        }
                    }

                    if (command) {
                        trace.push("command-enter");
                    }

                    if (selection) {
                        attempts++;
                        trace.push(`selection-${attempts}`);

                        if (attempts === 1) {
                            throw new StorageRejected("forced park-first selection rejection");
                        }
                    }

                    const result = await target.commit(writes, ctx);

                    if (command) {
                        trace.push("command-committed");
                    }

                    if (park) {
                        trace.push(`park-${parkCount}-committed`);

                        if (parkCount === 2) {
                            afterRollbackPark();
                        }
                    }

                    return result;
                };
            }

            const value = Reflect.get(target, property, receiver) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as Storage;
    const kernel = core!.createWorkflowRuntimeKernel();
    const registry = createRegistry();

    registry.install(kernel.extension);
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    const originalSnapshot = harness.snapshot.bind(harness);
    let signalNextSnapshot = true;

    Object.defineProperty(harness, "snapshot", {
        configurable: true,
        value: async (...args: Parameters<Harness["snapshot"]>) => {
            if (signalNextSnapshot && (args[0] as unknown) === core!.RUN_DOC) {
                signalNextSnapshot = false;
                enterSnapshot();
            }

            return originalSnapshot(...args);
        },
    });
    const engine = kernel.createEngine(harness);
    let opening: Promise<void> | undefined;

    try {
        opening = engine.open(context);
        await parkEntered;
        const stopping = engine.stop("park-first", "operator", context);

        await snapshotRequested;
        releasePark();
        await opening;
        await assert.rejects(stopping, /forced park-first selection rejection/);
        await parkedAfterRollback;
        assert.equal(attempts, 1);
        assert.equal((await engine.inspect("park-first", context)).status, "incompatible");
        await engine.stop("park-first", "explicit retry", context);
        await assert.rejects(engine.wait("park-first", context), /stopped/);
        assert.equal(attempts, 2);
        assert.ok(trace.indexOf("park-1-committed") < trace.indexOf("command-enter"));
        assert.ok(trace.indexOf("command-committed") < trace.indexOf("selection-1"));
    } finally {
        releasePark();
        await opening?.catch(() => {});
        await engine.close();
        await harness.close(context);
    }
});

test("durable stop fences survive SIGKILL after reservation and after selection rollback", async () => {
    for (const mode of ["stop-reservation-start", "stop-receipt-start"] as const) {
        const directory = await mkdtemp(join(tmpdir(), `pi-pocket-${mode}-`));

        directories.add(directory);
        const database = join(directory, "workflow.sqlite");
        const effects = join(directory, "effects.log");
        const marker = join(directory, "marker");
        const first = startWorker(mode, database, effects, marker, {
            PI_CORE_SCENARIO: "stop-fence",
        });
        let recovered: ChildProcess | undefined;

        try {
            const staged =
                mode === "stop-reservation-start"
                    ? "STAGED:stop-reservation"
                    : "STAGED:stop-rejection-no-receipt";

            await outputUntil(first, staged);
            await killWorker(first);
            recovered = startWorker("stop-hold-recover", database, effects, marker, {
                PI_CORE_SCENARIO: "stop-fence",
            });
            const output = await outputUntil(recovered, "INSPECT:");

            assert.deepEqual(await workerExit(recovered), [0, null]);
            assert.equal(inspectionFrom(output).status, "stopped");
            const bodies = (await readFile(`${effects}.bodies`, "utf8"))
                .trim()
                .split(String.fromCharCode(10));

            assert.deepEqual(bodies, [mode], "the consumed revision cannot restart the body");
            const attempts = (await readFile(`${effects}.stop-attempts`, "utf8"))
                .trim()
                .split(String.fromCharCode(10));

            assert.deepEqual(
                attempts,
                mode === "stop-reservation-start"
                    ? ["revision one"]
                    : ["revision one", "revision one"],
            );
        } finally {
            await killWorker(first);

            if (recovered !== undefined) {
                await killWorker(recovered);
            }
        }
    }
});

test("persisted unknown reconciliation retry executes its fresh attempt exactly once across three hosts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-persisted-retry-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");
    const effects = join(directory, "effects.log");
    const recoveries = join(directory, "recoveries.log");
    const marker = join(directory, "marker");
    const options = {
        PI_CORE_SCENARIO: "persisted-retry",
        PI_CORE_POLICY: "reconcile",
        PI_RECOVERY_LOG: recoveries,
    };
    const first = startWorker("pending-start", database, effects, marker, options);
    let second: ChildProcess | undefined;
    let third: ChildProcess | undefined;

    try {
        await outputUntil(first, "STAGED:pending-start");
        await killWorker(first);
        second = startWorker("pending-middle", database, effects, marker, {
            ...options,
            PI_CORE_RECOVERY_RESULT: "throw",
        });
        await outputUntil(second, "STAGED:pending-middle");
        await killWorker(second);
        third = startWorker("pending-recover", database, effects, marker, {
            ...options,
            PI_CORE_RECOVERY_RESULT: "retry",
        });
        const output = await outputUntil(third, "INSPECT:");

        assert.deepEqual(await workerExit(third), [0, null]);
        assert.match(output, /RESULT:"done-2"/);
        const calls = (await readFile(effects, "utf8"))
            .trim()
            .split("\n")
            .map(
                (line) =>
                    JSON.parse(line) as {
                        attempt: number;
                        attemptId: string;
                        idempotencyKey: string;
                    },
            );

        assert.deepEqual(
            calls.map((call) => call.attempt),
            [1, 2],
        );
        assert.notEqual(calls[0]!.attemptId, calls[1]!.attemptId);
        assert.equal(calls[0]!.idempotencyKey, calls[1]!.idempotencyKey);
        const observations = (await readFile(recoveries, "utf8")).trim().split("\n");

        assert.equal(observations.length, 2);
        assert.ok(observations.every((line) => line === `1:${calls[0]!.attemptId}`));
        const registry = createRegistry();

        registry.install(core!.workflowRuntimeExtension);
        const harness = await Harness.open(
            await openNodeSqliteStorage(database),
            { models: createModels(), registry },
            context,
        );

        try {
            const events = await harness.commit(async (tx) => {
                const conversations = await tx.scanConversations({}, 10);

                return tx.scanEntries({ conversationId: conversations.items[0]!.id }, 50);
            }, context);
            const history = events.items.map(
                (entry) =>
                    entry.data as {
                        type: string;
                        attemptId?: string;
                        resolution?: string;
                    },
            );

            assert.deepEqual(
                history
                    .filter((event) => event.type === "operation.interrupted")
                    .map((event) => event.attemptId),
                [calls[0]!.attemptId],
            );
            assert.deepEqual(
                history
                    .filter((event) => event.type === "operation.reconciled")
                    .map((event) => [event.attemptId, event.resolution]),
                [[calls[0]!.attemptId, "retry"]],
            );
            assert.deepEqual(
                history
                    .filter((event) => event.type === "operation.retry_started")
                    .map((event) => event.attemptId),
                [calls[1]!.attemptId],
            );
            assert.deepEqual(
                history
                    .filter((event) => event.type === "operation.completed")
                    .map((event) => event.attemptId),
                [calls[1]!.attemptId],
            );
        } finally {
            await harness.close(context);
        }
    } finally {
        await killWorker(first);

        if (second !== undefined) {
            await killWorker(second);
        }

        if (third !== undefined) {
            await killWorker(third);
        }
    }
});

for (const compatible of [false, true]) {
    test(`${compatible ? "pre-body compatible" : "incompatible"} stop rollback parks without fault and a new explicit stop selects stopped`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "pi-pocket-stop-park-"));

        directories.add(directory);
        const database = join(directory, "workflow.sqlite");
        let bodyCalls = 0;
        const workflow = core!.defineWorkflow({
            id: `core.stop.park.${compatible}`,
            version: 1,
            async run() {
                bodyCalls++;

                return "body must not run";
            },
        });
        const firstKernel = core!.createWorkflowRuntimeKernel();
        const firstRegistry = createRegistry();

        firstRegistry.install(firstKernel.extension);
        const first = await Harness.open(
            await openNodeSqliteStorage(database),
            { models: createModels(), registry: firstRegistry },
            context,
        );
        const original = firstKernel.createEngine(first);

        await original.open(context);
        await original.start(
            core!.defineWorkflow({
                id: workflow.id,
                version: workflow.version,
                async run({ signal }) {
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );

                    return "original";
                },
            }),
            null,
            { runId: "park-stop" },
            context,
        );
        await original.close();
        await first.close(context);
        let rejected = 0;
        const backing = await openNodeSqliteStorage(database);
        const storage = new Proxy(backing, {
            get(target, property, receiver) {
                if (property === "commit") {
                    return async (
                        writes: readonly StorageWrite[],
                        commitContext: Parameters<Storage["commit"]>[1],
                    ) => {
                        if (
                            rejected === 0 &&
                            writes.some(
                                (write) =>
                                    write.type === "entry" &&
                                    write.value.kind === "pocket.workflow-runtime.event" &&
                                    write.value.data !== null &&
                                    typeof write.value.data === "object" &&
                                    !Array.isArray(write.value.data) &&
                                    write.value.data.type === "workflow.stopped",
                            )
                        ) {
                            rejected++;

                            throw new StorageRejected("injected parked stop rollback");
                        }

                        return target.commit(writes, commitContext);
                    };
                }

                const value = Reflect.get(target, property, receiver) as unknown;

                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as Storage;
        const kernel = core!.createWorkflowRuntimeKernel();
        const registry = createRegistry();

        registry.install(kernel.extension);
        const harness = await Harness.open(storage, { models: createModels(), registry }, context);
        const engine = kernel.createEngine(harness);

        try {
            await engine.open(context);
            let status = "running";

            for (let i = 0; i < 100 && status === "running"; i++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                status = (await engine.inspect("park-stop", context)).status;
            }

            assert.equal(status, "incompatible");

            if (compatible) {
                engine.register(workflow);
            }

            await assert.rejects(
                engine.stop("park-stop", "operator", context),
                /injected parked stop rollback/,
            );
            assert.equal(rejected, 1);
            assert.equal(
                (await engine.inspect("park-stop", context)).status,
                compatible ? "running" : "incompatible",
            );
            assert.equal(bodyCalls, 0);
            await engine.stop("park-stop", "explicit retry", context);
            await assert.rejects(engine.wait("park-stop", context), /stopped/);
            assert.equal((await engine.inspect("park-stop", context)).status, "stopped");
            assert.equal(bodyCalls, 0);
        } finally {
            await engine.close();
            await harness.close(context);
        }
    });
}

test("same compatible version reactivates a parked run on two separate hosts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-rewake-"));

    directories.add(directory);
    const database = join(directory, "workflow.sqlite");

    const openHost = async () => {
        const kernel = core!.createWorkflowRuntimeKernel();
        const registry = createRegistry();

        registry.install(kernel.extension);
        const harness = await Harness.open(
            await openNodeSqliteStorage(database),
            { models: createModels(), registry },
            context,
        );

        return { harness, engine: kernel.createEngine(harness) };
    };

    const first = await openHost();
    const original = core!.defineWorkflow({
        id: "core.compatible.reactivate",
        version: 1,
        async run({ signal }) {
            await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
            );

            return "old";
        },
    });

    await first.engine.open(context);
    await first.engine.start(original, null, { runId: "reactivate" }, context);
    await first.engine.close();
    await first.harness.close(context);
    let effectCalls = 0;
    let firstBody!: () => void;
    const enteredFirst = new Promise<void>((resolve) => {
        firstBody = resolve;
    });
    const second = await openHost();

    try {
        await second.engine.open(context);
        let status = "running";

        for (let i = 0; i < 100 && status === "running"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            status = (await second.engine.inspect("reactivate", context)).status;
        }

        assert.equal(status, "incompatible");
        second.engine.register(
            core!.defineWorkflow({
                id: "core.compatible.reactivate",
                version: 1,
                async run({ step, signal }) {
                    await step.do("one", () => {
                        effectCalls++;

                        return "memo";
                    });
                    firstBody();
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );

                    return "unfinished";
                },
            }),
        );
        await second.engine.open(context);
        await enteredFirst;
        assert.equal(effectCalls, 1);
    } finally {
        await second.engine.close();
        await second.harness.close(context);
    }

    const third = await openHost();
    let secondBody = 0;

    try {
        await third.engine.open(context);
        let status = "running";

        for (let i = 0; i < 100 && status === "running"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            status = (await third.engine.inspect("reactivate", context)).status;
        }

        assert.equal(status, "incompatible");
        third.engine.register(
            core!.defineWorkflow({
                id: "core.compatible.reactivate",
                version: 1,
                async run({ step }) {
                    secondBody++;

                    return step.do("one", () => {
                        effectCalls++;

                        return "unexpected repeat";
                    });
                },
            }),
        );
        await third.engine.open(context);
        assert.equal(await third.engine.wait("reactivate", context), "memo");
        assert.equal(secondBody, 1);
        assert.equal(effectCalls, 1);
        assert.equal((await third.engine.inspect("reactivate", context)).status, "completed");
    } finally {
        await third.engine.close();
        await third.harness.close(context);
    }
});

test("open runs final readiness and controlled cancellation before scheduling resumes", async () => {
    const registry = createRegistry();
    const events: string[] = [];
    let harness!: Harness;

    let startWorkflow: () => Promise<void> = async () => {};

    const kernel = core!.createWorkflowRuntimeKernel({
        beforeOpen: () => {
            events.push("before-open");
        },
        beforeResume: () => {
            events.push("before-resume");
        },
        beforeProgress: async () => {
            events.push("before-progress");
            assert.equal((await harness.inspect(context)).scheduling, "paused");
            await startWorkflow();
        },
    });

    registry.install(kernel.extension);
    harness = await Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry },
        context,
    );
    const engine = kernel.createEngine(harness);

    startWorkflow = async () => {
        await engine.start(
            core!.defineWorkflow({
                id: "core.before-progress",
                version: 1,
                run: () => "started",
            }),
            null,
            { runId: "core-before-progress" },
            context,
        );
    };

    try {
        await engine.open(context);
        assert.deepEqual(events, ["before-open", "before-resume", "before-progress"]);
        assert.equal((await harness.inspect(context)).scheduling, "running");
        assert.equal(await engine.wait("core-before-progress", context), "started");
    } finally {
        await engine.close();
        await harness.close(context);
    }
});
