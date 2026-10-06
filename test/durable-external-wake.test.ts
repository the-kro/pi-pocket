import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    Harness,
    MemoryStorage,
    type Storage,
    type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ExternalResults, externalWaiter } from "./fixtures/external-wake-task.ts";

const context = BACKGROUND_CONTEXT;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const directories = new Set<string>();

after(async () => {
    for (const directory of directories) {
        await rm(directory, { recursive: true, force: true });
    }

    directories.clear();
});

async function eventually(
    check: () => boolean | Promise<boolean>,
    description: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (!(await check())) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function openHarness(
    storage: Storage,
    task: ReturnType<typeof externalWaiter>,
): Promise<Harness> {
    const registry = createRegistry();

    registry.install(defineExtension({ name: "external-wake-test", tasks: [task] }));

    return Harness.open(storage, { models: createModels(), registry }, context);
}

async function createWaiter(
    harness: Harness,
    task: ReturnType<typeof externalWaiter>,
): Promise<TaskId<string>> {
    const root = await harness.root(context);

    return root.commit(
        (tx) => tx.createTask(task, null, { ownership: { kind: "conversation" } }),
        context,
    );
}

async function deliverEvent(
    harness: Harness,
    id: TaskId,
    requestId: string,
    value: string,
): Promise<boolean> {
    return harness.commit(async (tx) => {
        const results = await tx.doc(ExternalResults);
        const key = String(id);
        const previous = results.results[key];

        if (
            previous !== undefined &&
            (previous.requestId !== requestId || previous.value !== value)
        ) {
            throw new Error(`Conflicting external event for task ${id}`);
        }

        results.results[key] = { requestId, value };

        return tx.wakeTask(id, requestId);
    }, context);
}

async function sqlitePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-external-wake-"));

    directories.add(directory);

    return join(directory, "session.sqlite");
}

function startCrashWorker(
    mode: "park" | "wake",
    databasePath: string,
    id: TaskId,
    requestId = "crash-event",
    value = "crash result",
): ChildProcess {
    const workerPath = new URL("./fixtures/external-wake-crash-worker.ts", import.meta.url);

    return spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(workerPath)], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_MODE: mode,
            PI_DB_PATH: databasePath,
            PI_TASK_ID: String(id),
            PI_EVENT_ID: requestId,
            PI_EVENT_VALUE: value,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function killAtStorageCommit(child: ChildProcess, label: string): Promise<void> {
    let output = "";
    let errors = "";

    if (child.stdout === null || child.stderr === null) {
        throw new Error("Crash worker did not expose output pipes");
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new Error(`Timed out waiting for ${label}; stdout=${output}; stderr=${errors}`),
                ),
            20_000,
        );

        child.stdout!.on("data", (chunk: string) => {
            output += chunk;

            if (output.includes(`STAGED:${label}`)) {
                clearTimeout(timer);
                resolve();
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
            if (!output.includes(`STAGED:${label}`)) {
                clearTimeout(timer);
                reject(
                    new Error(
                        `Crash worker exited before ${label}: code=${code}, signal=${signal}; stderr=${errors}`,
                    ),
                );
            }
        });
    });
    assert.equal(child.kill("SIGKILL"), true);
    const [, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, "SIGKILL");
}

async function stopCrashWorker(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    const exited = once(child, "exit");

    child.kill("SIGKILL");
    await exited;
}

test("an early idempotent event wake is consumed when the task enters its external wait", async () => {
    const invocations: object[] = [];
    const task = externalWaiter(invocations);
    const harness = await openHarness(new MemoryStorage(), task);

    try {
        const id = await createWaiter(harness, task);

        assert.equal(await deliverEvent(harness, id, "early-event", "arrived early"), true);
        assert.equal(await deliverEvent(harness, id, "early-event", "arrived early"), false);
        harness.resume();
        const receipt = await harness.waitForTask(id, context);

        assert.deepEqual(receipt.state, {
            status: "terminal",
            outcome: { status: "completed", result: "arrived early" },
        });
        assert.equal(invocations.length, 2);
    } finally {
        await harness.close(context);
    }
});

test("parks without an invocation and wakes in a fresh invocation at its checkpoint", async () => {
    const invocations: object[] = [];
    const task = externalWaiter(invocations);
    const harness = await openHarness(new MemoryStorage(), task);

    try {
        const id = await createWaiter(harness, task);

        harness.resume();
        await eventually(
            async () => (await harness.getTask(id, context))?.state.status === "waiting",
            "external wait",
        );

        const inspected = (await harness.inspect(context)).tasks.find(
            (item) => item.record.id === id,
        );

        assert.deepEqual(inspected?.state, { kind: "waiting", on: [], external: true });
        const graph = await harness.taskGraph(context);

        assert.deepEqual(graph.value.tasks[String(id)]?.state, {
            status: "waiting",
            phase: "resume",
            on: [],
            policy: "allSettled",
            external: true,
        });
        graph.dispose();
        assert.deepEqual((await harness.getTask(id, context))?.state, {
            status: "waiting",
            checkpoint: { phase: "resume" },
            on: [],
            policy: "allSettled",
            external: true,
        });
        assert.equal(invocations.length, 1);

        assert.equal(await deliverEvent(harness, id, "event-1", "received"), true);
        const receipt = await harness.waitForTask(id, context);

        assert.deepEqual(receipt.state, {
            status: "terminal",
            outcome: { status: "completed", result: "received" },
        });
        assert.equal(receipt.wakeRequests, undefined);
        assert.equal(receipt.wakePending, undefined);
        assert.equal(invocations.length, 2);
        assert.notEqual(invocations[0], invocations[1]);
    } finally {
        await harness.close(context);
    }
});

test("applies an event buffered while the harness is down before resuming the parked task", async () => {
    const path = await sqlitePath();
    const task = externalWaiter();
    const first = await openHarness(await openNodeSqliteStorage(path), task);
    const id = await createWaiter(first, task);

    first.resume();
    await eventually(
        async () => (await first.getTask(id, context))?.state.status === "waiting",
        "the parked task",
    );
    await first.close(context);

    const queuePath = `${path}.events.json`;

    await writeFile(
        queuePath,
        JSON.stringify({ requestId: "offline-event", value: "queued offline" }),
    );
    const queued = JSON.parse(await readFile(queuePath, "utf8")) as {
        requestId: string;
        value: string;
    };
    const second = await openHarness(await openNodeSqliteStorage(path), task);

    try {
        assert.deepEqual((await second.getTask(id, context))?.state, {
            status: "waiting",
            checkpoint: { phase: "resume" },
            on: [],
            policy: "allSettled",
            external: true,
        });
        assert.equal(await deliverEvent(second, id, queued.requestId, queued.value), true);
        second.resume();
        assert.deepEqual((await second.waitForTask(id, context)).state.outcome, {
            status: "completed",
            result: "queued offline",
        });
    } finally {
        await second.close(context);
    }
});

test("collapses duplicate deliveries to one wake", async () => {
    const invocations: object[] = [];
    const task = externalWaiter(invocations);
    const harness = await openHarness(new MemoryStorage(), task);

    try {
        const id = await createWaiter(harness, task);

        harness.resume();
        await eventually(
            async () => (await harness.getTask(id, context))?.state.status === "waiting",
            "external wait",
        );
        assert.equal(await deliverEvent(harness, id, "same-event", "once"), true);
        assert.equal(await deliverEvent(harness, id, "same-event", "once"), false);
        assert.deepEqual((await harness.waitForTask(id, context)).state.outcome, {
            status: "completed",
            result: "once",
        });
        assert.equal(invocations.length, 2);
    } finally {
        await harness.close(context);
    }
});

test("rolls back a waiting checkpoint when SIGKILL interrupts the park commit", async () => {
    const path = await sqlitePath();
    const task = externalWaiter();
    const seeded = await openHarness(await openNodeSqliteStorage(path), task);
    const id = await createWaiter(seeded, task);

    await seeded.close(context);

    const worker = startCrashWorker("park", path, id);

    try {
        await killAtStorageCommit(worker, "park");
    } finally {
        await stopCrashWorker(worker);
    }

    const recovered = await openHarness(await openNodeSqliteStorage(path), task);

    try {
        assert.deepEqual((await recovered.getTask(id, context))?.state, {
            status: "pending",
            checkpoint: { phase: "start" },
        });
        recovered.resume();
        await eventually(
            async () => (await recovered.getTask(id, context))?.state.status === "waiting",
            "recovered external wait",
        );
        assert.deepEqual((await recovered.getTask(id, context))?.state, {
            status: "waiting",
            checkpoint: { phase: "resume" },
            on: [],
            policy: "allSettled",
            external: true,
        });
    } finally {
        await recovered.close(context);
    }
});

test("rolls back event data and wake intent when SIGKILL interrupts the wake commit", async () => {
    const path = await sqlitePath();
    const task = externalWaiter();
    const seeded = await openHarness(await openNodeSqliteStorage(path), task);
    const id = await createWaiter(seeded, task);

    seeded.resume();
    await eventually(
        async () => (await seeded.getTask(id, context))?.state.status === "waiting",
        "external wait",
    );
    await seeded.close(context);

    const worker = startCrashWorker("wake", path, id, "crash-event", "crash result");

    try {
        await killAtStorageCommit(worker, "wake");
    } finally {
        await stopCrashWorker(worker);
    }

    const recovered = await openHarness(await openNodeSqliteStorage(path), task);

    try {
        assert.deepEqual((await recovered.getTask(id, context))?.state, {
            status: "waiting",
            checkpoint: { phase: "resume" },
            on: [],
            policy: "allSettled",
            external: true,
        });
        assert.equal((await recovered.getTask(id, context))?.wakePending, undefined);
        assert.equal(await recovered.snapshot(ExternalResults, context), undefined);
        assert.equal(await deliverEvent(recovered, id, "crash-event", "crash result"), true);
        recovered.resume();
        assert.deepEqual((await recovered.waitForTask(id, context)).state.outcome, {
            status: "completed",
            result: "crash result",
        });
    } finally {
        await recovered.close(context);
    }
});

test("retains concurrent distinct wake requests while applying idempotency per request ID", async () => {
    const task = externalWaiter();
    const harness = await openHarness(new MemoryStorage(), task);

    try {
        const id = await createWaiter(harness, task);
        const accepted = await harness.commit(
            (tx) =>
                Promise.all([
                    tx.wakeTask(id, "concurrent-a"),
                    tx.wakeTask(id, "concurrent-a"),
                    tx.wakeTask(id, "concurrent-b"),
                    tx.wakeTask(id, "concurrent-b"),
                ]),
            context,
        );

        assert.deepEqual(accepted, [true, false, true, false]);
        const record = await harness.getTask(id, context);

        assert.equal(record?.wakeRequests?.length, 2);
        assert.deepEqual(new Set(record?.wakeRequests), new Set(["concurrent-a", "concurrent-b"]));
        const retries = await harness.commit(
            (tx) => Promise.all([tx.wakeTask(id, "concurrent-a"), tx.wakeTask(id, "concurrent-b")]),
            context,
        );

        assert.deepEqual(retries, [false, false]);
    } finally {
        await harness.close(context);
    }
});

test("aborts an externally parked task without waiting for its event", async () => {
    const invocations: object[] = [];
    const task = externalWaiter(invocations);
    const harness = await openHarness(new MemoryStorage(), task);

    try {
        const id = await createWaiter(harness, task);

        harness.resume();
        await eventually(
            async () => (await harness.getTask(id, context))?.state.status === "waiting",
            "external wait",
        );
        assert.equal(await harness.abortTask(id, context), "marked");
        assert.deepEqual((await harness.waitForTask(id, context)).state.outcome, {
            status: "aborted",
            reason: "external wait aborted",
        });
        assert.equal(invocations.length, 1);
    } finally {
        await harness.close(context);
    }
});
