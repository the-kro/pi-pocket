import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { WorkflowEngine, WorkflowTask, workflow } from "../packages/workflow-runtime/legacy.ts";
import { eventually } from "./workflow-test-support.ts";

test("a timer wake failure is reported and re-armed without deciding the workflow outcome", async () => {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "pocket-workflows-test", tasks: [WorkflowTask] }));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry, now: () => 1_000 },
		BACKGROUND_CONTEXT,
	);
	const failures: unknown[] = [];
	let fire: (() => void) | undefined;
	let scheduled = 0;
	const engine = new WorkflowEngine(harness, {
		scheduleAt: (_at, callback) => {
			scheduled++;
			fire = callback;
			return () => {};
		},
		onTimerError: (error: unknown) => failures.push(error),
	});
	try {
		await engine.open(BACKGROUND_CONTEXT);
		const definition = workflow<null, null>("spike.timer-report", async ({ step }) => {
			await step.sleepUntil("pause", 10_000);
			return null;
		});
		const handle = await engine.start(definition, null, await harness.root(BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
		await eventually(() => fire !== undefined);
		assert.equal((await engine.inspect(handle, BACKGROUND_CONTEXT)).status, "waiting");
		await harness.close(BACKGROUND_CONTEXT);
		fire!();
		await eventually(() => failures.length === 1);
		assert.ok(failures[0] instanceof Error);
		assert.equal(scheduled, 2, "a failed infrastructure wake is re-armed");
	} finally {
		await engine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});
