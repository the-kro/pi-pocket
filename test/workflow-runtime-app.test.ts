import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PocketHost } from "../src/server/host.ts";
import createWorkflows from "../src/server/extensions/workflows.ts";
import { WorkflowEngine, WorkflowTask, workflow } from "../packages/workflow-runtime/index.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-workflow-runtime-"));
const dataDir = join(root, "data");
const workingDirectory = join(root, "work");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workingDirectory, { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { PocketApp } = await import("../src/server/app.ts");
type App = Awaited<ReturnType<typeof PocketApp.open>>;
let app: App | undefined;

after(async () => {
	await app?.close();
	rmSync(root, { recursive: true, force: true });
});

async function eventually(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("Pocket re-arms a parked workflow timer once per Harness and keeps it across extension reloads", async () => {
	const registry = createRegistry();
	registry.install(createWorkflows({} as PocketHost));
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dataDir, "pocket.sqlite")),
		{ models: createModels(), registry },
		BACKGROUND_CONTEXT,
	);
	const seedEngine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
	const wakeAt = Date.now() + 2_500;
	const sleeping = workflow<{ wakeAt: number }, string>("pocket.runtime-restart", async ({ input, step }) => {
		await step.sleepUntil("deadline", input.wakeAt);
		return "timer-resumed";
	});
	let taskId: TaskId | undefined;
	try {
		await seedEngine.open(BACKGROUND_CONTEXT);
		const handle = await seedEngine.start(
			sleeping,
			{ wakeAt },
			await harness.root(BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		await eventually(async () => (await seedEngine.inspect(handle, BACKGROUND_CONTEXT)).status === "waiting", "the stored sleep");
		const record = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find(
			(item) => item.record.kind === WorkflowTask.definition.name,
		);
		assert.ok(record);
		taskId = record.record.id as typeof taskId;
	} finally {
		await seedEngine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
	assert.ok(taskId);
	const storedTaskId = taskId;

	const appLog: string[] = [];
	app = await PocketApp.open({ dataDir, defaultCwd: workingDirectory, supervised: false, log: (line) => appLog.push(line) });
	const engine = app.workflowEngine;
	assert.ok(engine);
	let addedSubscriptions = 0;
	const subscribeCommits = app.harness.subscribeCommits.bind(app.harness);
	app.harness.subscribeCommits = (listener) => {
		addedSubscriptions++;
		return subscribeCommits(listener);
	};
	await app.reloadExtension("workflows.ts");
	await app.reloadExtension("workflows.ts");
	assert.equal(app.workflowEngine, engine, "extension reloads must not replace the Harness-owned timer runtime");
	assert.equal(addedSubscriptions, 0, "extension reloads must not create another Harness subscription");
	const closeRuntime = engine.close.bind(engine);
	let runtimeCloses = 0;
	engine.close = async () => {
		runtimeCloses++;
		await closeRuntime();
	};
	const closing = app.close();
	assert.equal(app.close(), closing, "concurrent app close calls share one Harness lifecycle");
	await closing;
	assert.equal(runtimeCloses, 1);
	app = undefined;
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, wakeAt - Date.now() + 25)));
	assert.ok(!appLog.some((line) => line.includes("workflow timer wake failed")), "closed timers must not wake a closed Harness");

	app = await PocketApp.open({ dataDir, defaultCwd: workingDirectory, supervised: false, log: () => {} });
	assert.notEqual(app.workflowEngine, engine, "a new Harness gets a new timer runtime");
	await eventually(async () => (await app!.harness.getTask(storedTaskId, BACKGROUND_CONTEXT))?.state.status === "terminal", "the timer wake");
	const recovered = await app.harness.getTask(storedTaskId, BACKGROUND_CONTEXT);
	assert.deepEqual(recovered?.state, {
		status: "terminal",
		outcome: { status: "completed", result: "timer-resumed" },
	});
});
