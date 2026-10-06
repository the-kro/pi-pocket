import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../packages/workflow-runtime/core/index.ts";

const roots: string[] = [];

after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function openAt(
    root: string,
    scheduleAt: (at: number, callback: () => void) => () => void = (at, callback) => {
        const timer = setTimeout(callback, Math.max(0, at - Date.now()));

        return () => clearTimeout(timer);
    },
    definitions: core.WorkflowDefinition<any, any>[] = [],
) {
    const registry = createRegistry();
    const kernel = core.createWorkflowRuntimeKernel();

    registry.install(kernel.extension);
    const harness = await Harness.open(
        await openNodeSqliteStorage(join(root, "runtime.sqlite")),
        { models: createModels(), registry },
        BACKGROUND_CONTEXT,
    );
    const engine = kernel.createEngine(harness, { scheduleAt });

    for (const definition of definitions) {
        engine.register(definition);
    }

    await engine.open(BACKGROUND_CONTEXT);

    return { root, harness, engine };
}

async function fixture(scheduleAt?: (at: number, callback: () => void) => () => void) {
    const root = await mkdtemp(join(tmpdir(), "pocket-production-sleep-"));

    roots.push(root);

    return openAt(root, scheduleAt);
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
    const expires = performance.now() + 5_000;

    while (!(await check())) {
        if (performance.now() >= expires) {
            throw new Error("Timed out waiting for production sleep state");
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("reopening a workflow engine leaves no TimerHost subscriptions after close", async () => {
    const registry = createRegistry();
    const kernel = core.createWorkflowRuntimeKernel();

    registry.install(kernel.extension);
    const harness = await Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry },
        BACKGROUND_CONTEXT,
    );
    const subscribe = harness.subscribeCommits.bind(harness);
    let activeSubscriptions = 0;

    harness.subscribeCommits = (listener) => {
        const unsubscribe = subscribe(listener);

        activeSubscriptions++;

        return () => {
            activeSubscriptions--;
            unsubscribe();
        };
    };

    const engine = kernel.createEngine(harness, { scheduleAt: () => () => {} });

    try {
        await engine.open(BACKGROUND_CONTEXT);
        await engine.open(BACKGROUND_CONTEXT);
        await engine.close();
        assert.equal(activeSubscriptions, 0);
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("production sleepUntil parks externally and resumes through fresh replay after explicit wake", async () => {
    const { harness, engine } = await fixture(() => () => {});
    const deadline = Date.now() + 150;
    let invocations = 0;
    let continued = 0;
    const definition = core.defineWorkflow({
        id: "test.production.sleep-until",
        version: 1,
        async run({ step }) {
            invocations++;
            await step.sleepUntil("pause", deadline);
            continued++;

            return "resumed";
        },
    });

    try {
        const handle = await engine.start(
            definition,
            null,
            { runId: "sleep-until" },
            BACKGROUND_CONTEXT,
        );
        let task: any;

        await eventually(async () => {
            const snapshot = await harness.inspect(BACKGROUND_CONTEXT);

            task = snapshot.tasks.find(
                (item: any) => item.record.kind === "pocket.workflow-runtime.task",
            );

            return task?.record.state.status === "waiting";
        });
        assert.equal(task.record.state.external, true);
        assert.equal(task.record.state.checkpoint.waits.pause.dueAt, deadline);
        assert.equal(task.record.state.checkpoint.waits.pause.status, "unresolved");
        const inspection = await engine.inspect(handle.runId, BACKGROUND_CONTEXT);

        assert.equal(inspection.status, "waiting");
        assert.deepEqual(inspection.current, { waitId: "pause", kind: "sleep", dueAt: deadline });
        assert.equal(invocations, 1);
        assert.equal(continued, 0, "post-sleep TypeScript is not resident while parked");

        await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline - Date.now() + 10)),
        );
        await harness.commit(
            (tx) => tx.wakeTask(task.record.id, "test-sleep-wake:pause"),
            BACKGROUND_CONTEXT,
        );
        assert.equal(await engine.wait(handle.runId, BACKGROUND_CONTEXT), "resumed");
        assert.equal(invocations, 2, "wake starts a fresh workflow invocation");
        assert.equal(continued, 1, "post-sleep work executes once");
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("repeated TimerHost callbacks use one idempotent wake for a sleep", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocket-production-timer-repeat-"));

    roots.push(root);
    const registry = createRegistry();
    const kernel = core.createWorkflowRuntimeKernel();

    registry.install(kernel.extension);
    const harness = await Harness.open(
        await openNodeSqliteStorage(join(root, "runtime.sqlite")),
        { models: createModels(), registry },
        BACKGROUND_CONTEXT,
    );
    let fire!: () => void;
    const engine = kernel.createEngine(harness, {
        scheduleAt: (_at, callback) => {
            fire = callback;

            return () => {};
        },
    });
    let invocations = 0;
    const deadline = Date.now() + 70;
    const workflow = core.defineWorkflow({
        id: "test.production.timer-repeat",
        version: 1,
        async run({ step }) {
            invocations++;
            await step.sleepUntil("only-wake", deadline);

            return "elapsed";
        },
    });

    try {
        await engine.open(BACKGROUND_CONTEXT);
        await engine.start(workflow, null, { runId: "timer-repeat" }, BACKGROUND_CONTEXT);
        const expires = Date.now() + 5_000;

        while (fire === undefined) {
            if (Date.now() > expires) {
                throw new Error("TimerHost did not arm the sleep");
            }

            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        await new Promise((resolve) => setTimeout(resolve, 80));
        fire();
        fire();
        fire();
        assert.equal(await engine.wait("timer-repeat", BACKGROUND_CONTEXT), "elapsed");
        assert.equal(invocations, 2);
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("stopping an external sleep wins over a later deadline wake", async () => {
    const { harness, engine } = await fixture(() => () => {});
    const workflow = core.defineWorkflow({
        id: "test.production.stop-sleep",
        version: 1,
        async run({ step }) {
            await step.sleepUntil("forever", Date.now() + 60_000);

            return "must-not-complete";
        },
    });

    try {
        await engine.start(workflow, null, { runId: "stop-sleep" }, BACKGROUND_CONTEXT);
        let task: any;

        await eventually(async () => {
            task = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
                (item: any) => item.record.kind === "pocket.workflow-runtime.task",
            )?.record;

            return task?.state.status === "waiting";
        });
        await engine.stop("stop-sleep", "requested stop", BACKGROUND_CONTEXT);
        await assert.rejects(
            engine.wait("stop-sleep", BACKGROUND_CONTEXT),
            core.WorkflowStoppedError,
        );
        const stopped = await harness.getTask(task.id, BACKGROUND_CONTEXT);

        assert.equal(stopped?.state.status, "terminal");
        assert.equal(
            await harness.commit(
                (tx) => tx.wakeTask(task.id, "late-after-stop"),
                BACKGROUND_CONTEXT,
            ),
            false,
        );
        assert.equal((await engine.inspect("stop-sleep", BACKGROUND_CONTEXT)).status, "stopped");
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("two logical sleep IDs remain independent in the production checkpoint", async () => {
    const { harness, engine } = await fixture(() => () => {});
    const realNow = Date.now;
    let now = realNow();

    Date.now = () => now;
    const firstDeadline = now + 80;
    const secondDeadline = now + 180;
    const workflow = core.defineWorkflow({
        id: "test.production.two-sleeps",
        version: 1,
        async run({ step }) {
            await step.sleepUntil("first", firstDeadline);
            await step.sleepUntil("second", secondDeadline);

            return "both";
        },
    });

    try {
        await engine.start(workflow, null, { runId: "two-sleeps" }, BACKGROUND_CONTEXT);
        let task: any;

        await eventually(async () => {
            task = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
                (item: any) => item.record.kind === "pocket.workflow-runtime.task",
            )?.record;

            return task?.state.status === "waiting";
        });
        assert.equal(task.state.checkpoint.waits.first.dueAt, firstDeadline);
        assert.equal(task.state.checkpoint.waits.second, undefined);
        now = firstDeadline + 10;
        await harness.commit((tx) => tx.wakeTask(task.id, "two-sleeps:first"), BACKGROUND_CONTEXT);
        await eventually(async () => {
            task = await harness.getTask(task.id, BACKGROUND_CONTEXT);

            return (
                task?.state.status === "waiting" && task.state.checkpoint.waits.second !== undefined
            );
        });
        assert.equal(task.state.checkpoint.waits.first.status, "resolved");
        assert.equal(task.state.checkpoint.waits.second.dueAt, secondDeadline);
        now = secondDeadline + 10;
        await harness.commit((tx) => tx.wakeTask(task.id, "two-sleeps:second"), BACKGROUND_CONTEXT);
        assert.equal(await engine.wait("two-sleeps", BACKGROUND_CONTEXT), "both");
    } finally {
        Date.now = realNow;
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("production TimerHost reconstructs overdue deadline waits and wakes them", async () => {
    const { harness, engine } = await fixture();
    let invocations = 0;
    const deadline = Date.now() + 100;
    const definition = core.defineWorkflow({
        id: "test.production.timer-host",
        version: 1,
        async run({ step }) {
            invocations++;
            await step.sleepUntil("deadline", deadline);

            return "timer-fired";
        },
    });

    try {
        const handle = await engine.start(
            definition,
            null,
            { runId: "timer-host" },
            BACKGROUND_CONTEXT,
        );

        assert.equal(await engine.wait(handle.runId, BACKGROUND_CONTEXT), "timer-fired");
        assert.equal(invocations, 2);
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});

test("a sleeping production wait survives cold Harness reopen and consumes an idempotent wake once", async () => {
    const first = await fixture(() => () => {});
    const deadline = Date.now() + 250;
    let invocations = 0;
    let afterSleep = 0;
    const definition = core.defineWorkflow({
        id: "test.production.sleep-reopen",
        version: 1,
        async run({ step }) {
            invocations++;
            await step.sleepUntil("scheduled", deadline);
            afterSleep++;

            return "done";
        },
    });
    let taskId: number;

    try {
        await first.engine.start(definition, null, { runId: "sleep-reopen" }, BACKGROUND_CONTEXT);
        let record: any;

        await eventually(async () => {
            record = (await first.harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
                (item: any) => item.record.kind === "pocket.workflow-runtime.task",
            )?.record;

            return record?.state.status === "waiting";
        });
        taskId = record.id;
        assert.equal(record.state.checkpoint.waits.scheduled.dueAt, deadline);
    } finally {
        await first.engine.close();
        await first.harness.close(BACKGROUND_CONTEXT);
    }

    const second = await openAt(first.root, () => () => {});

    second.engine.register(definition);

    try {
        const parked = await second.harness.getTask(taskId as never, BACKGROUND_CONTEXT);

        assert.equal(parked?.state.status, "waiting");
        assert.equal(parked?.state.external, true);
        assert.equal(
            (parked?.state.checkpoint as core.WorkflowCheckpoint).waits?.scheduled?.dueAt,
            deadline,
        );
        assert.equal(invocations, 1, "opening a host does not activate an external wait");
        await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline - Date.now() + 10)),
        );
        const firstWake = await second.harness.commit(
            (tx) => tx.wakeTask(taskId as never, "sleep-reopen-wake"),
            BACKGROUND_CONTEXT,
        );
        const duplicateWake = await second.harness.commit(
            (tx) => tx.wakeTask(taskId as never, "sleep-reopen-wake"),
            BACKGROUND_CONTEXT,
        );

        assert.equal(firstWake, true);
        assert.equal(duplicateWake, false);
        second.harness.resume();
        await eventually(
            async () =>
                (await second.harness.getTask(taskId as never, BACKGROUND_CONTEXT))?.state
                    .status === "terminal",
        );
        assert.equal(await second.engine.wait("sleep-reopen", BACKGROUND_CONTEXT), "done");
        assert.equal(invocations, 2);
        assert.equal(afterSleep, 1);
        assert.equal(
            (await second.engine.inspect("sleep-reopen", BACKGROUND_CONTEXT)).status,
            "completed",
        );
    } finally {
        await second.engine.close();
        await second.harness.close(BACKGROUND_CONTEXT);
    }
});

test("TimerHost reconstructs and fires an overdue wait after cold storage reopen", async () => {
    const first = await fixture(() => () => {});
    const deadline = Date.now() + 120;
    let invocations = 0;
    const definition = core.defineWorkflow({
        id: "test.production.timer-restart",
        version: 1,
        async run({ step }) {
            invocations++;
            await step.sleepUntil("restart-deadline", deadline);

            return "recovered";
        },
    });

    try {
        await first.engine.start(definition, null, { runId: "timer-restart" }, BACKGROUND_CONTEXT);
        await eventually(async () =>
            (await first.harness.inspect(BACKGROUND_CONTEXT)).tasks.some(
                (item: any) =>
                    item.record.kind === "pocket.workflow-runtime.task" &&
                    item.record.state.status === "waiting",
            ),
        );
    } finally {
        await first.engine.close();
        await first.harness.close(BACKGROUND_CONTEXT);
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 10)));
    const recovered = await openAt(first.root, undefined, [definition]);

    try {
        assert.equal(await recovered.engine.wait("timer-restart", BACKGROUND_CONTEXT), "recovered");
        assert.equal(invocations, 2);
    } finally {
        await recovered.engine.close();
        await recovered.harness.close(BACKGROUND_CONTEXT);
    }
});

test("step.sleep persists and reuses its first absolute deadline on replay", async () => {
    const { harness, engine } = await fixture(() => () => {});
    let invocations = 0;
    let afterSleep = 0;
    const definition = core.defineWorkflow({
        id: "test.production.relative-sleep",
        version: 1,
        async run({ step }) {
            invocations++;
            await step.sleep("delay", "150ms");
            afterSleep++;

            return "finished";
        },
    });

    try {
        await engine.start(definition, null, { runId: "relative-sleep" }, BACKGROUND_CONTEXT);
        let record: any;

        await eventually(async () => {
            record = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
                (item: any) => item.record.kind === "pocket.workflow-runtime.task",
            )?.record;

            return record?.state.status === "waiting";
        });
        const originalDueAt = record.state.checkpoint.waits.delay.dueAt;

        assert.equal(record.state.checkpoint.waits.delay.durationMs, 150);
        await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, originalDueAt - Date.now() + 10)),
        );
        await harness.commit(
            (tx) => tx.wakeTask(record.id, "relative-sleep-wake"),
            BACKGROUND_CONTEXT,
        );
        assert.equal(await engine.wait("relative-sleep", BACKGROUND_CONTEXT), "finished");
        assert.equal(invocations, 2);
        assert.equal(afterSleep, 1);
        const inspection = await engine.inspect("relative-sleep", BACKGROUND_CONTEXT);

        assert.equal(inspection.status, "completed");
    } finally {
        await engine.close();
        await harness.close(BACKGROUND_CONTEXT);
    }
});
