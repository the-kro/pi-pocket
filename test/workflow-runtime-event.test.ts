import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../packages/workflow-runtime/core/index.ts";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("a durable event delivered before its wait is buffered and consumed once", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-"));
	roots.push(root);
	const registry = createRegistry();
	const kernel = core.createWorkflowRuntimeKernel();
	registry.install(kernel.extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry }, BACKGROUND_CONTEXT);
	const engine = kernel.createEngine(harness);
	let entered!: () => void;
	const bodyEntered = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let continuations = 0;
	const definition = core.defineWorkflow({
		id: "test.production.event-buffer",
		version: 1,
		async run({ step }) {
			entered();
			await gate;
			const first = await step.waitForEvent<{ value: string }>("approval-one", "workflow.approval");
			continuations++;
			const second = await step.waitForEvent<{ value: string }>("approval-two", "workflow.approval");
			continuations++;
			return { first, second };
		},
	});
	try {
		await engine.open(BACKGROUND_CONTEXT);
		await engine.start(definition, null, { runId: "event-buffer" }, BACKGROUND_CONTEXT);
		await bodyEntered;
		const duplicateResults = await Promise.all([
			engine.sendEvent("event-buffer", { id: "event-1", type: "workflow.approval", payload: { value: "yes" } }, BACKGROUND_CONTEXT),
			engine.sendEvent("event-buffer", { id: "event-1", type: "workflow.approval", payload: { value: "yes" } }, BACKGROUND_CONTEXT),
		]);
		assert.equal(duplicateResults.filter(Boolean).length, 1);
		assert.equal(duplicateResults.filter((accepted) => !accepted).length, 1);
		assert.equal(await engine.sendEvent("event-buffer", { id: "event-2", type: "workflow.approval", payload: { value: "no" } }, BACKGROUND_CONTEXT), true);
		await assert.rejects(engine.sendEvent("event-buffer", { id: "event-1", type: "workflow.approval", payload: { value: "conflict" } }, BACKGROUND_CONTEXT), /reused with different content/);
		release();
		assert.deepEqual(await engine.wait("event-buffer", BACKGROUND_CONTEXT), {
			first: { eventId: "event-1", payload: { value: "yes" } },
			second: { eventId: "event-2", payload: { value: "no" } },
		});
		assert.equal(continuations, 2);
	} finally {
		release();
		await engine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("TimerHost reconstructs an overdue event timeout after cold Harness reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-timeout-reopen-"));
	roots.push(root);
	let invocations = 0;
	const definition = core.defineWorkflow({
		id: "test.production.event-timeout-reopen",
		version: 1,
		async run({ step }) {
			invocations++;
			try {
				await step.waitForEvent("decision", "workflow.decision", { timeout: "120ms" });
				return "unexpected";
			} catch (error) {
				if (error instanceof core.WorkflowEventTimeoutError) return "timed-out";
				throw error;
			}
		},
	});
	const firstRegistry = createRegistry();
	const firstKernel = core.createWorkflowRuntimeKernel();
	firstRegistry.install(firstKernel.extension);
	const firstHarness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry: firstRegistry }, BACKGROUND_CONTEXT);
	const firstEngine = firstKernel.createEngine(firstHarness, { scheduleAt: () => () => {} });
	try {
		await firstEngine.open(BACKGROUND_CONTEXT);
		await firstEngine.start(definition, null, { runId: "event-timeout-reopen" }, BACKGROUND_CONTEXT);
		let task: any;
		const expires = Date.now() + 5_000;
		while (task?.state.status !== "waiting") {
			task = (await firstHarness.inspect(BACKGROUND_CONTEXT)).tasks.find((item: any) => item.record.kind === "pocket.workflow-runtime.task")?.record;
			if (Date.now() > expires) throw new Error("Workflow did not enter event timeout wait");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	} finally {
		await firstEngine.close();
		await firstHarness.close(BACKGROUND_CONTEXT);
	}
	await new Promise((resolve) => setTimeout(resolve, 140));
	const secondRegistry = createRegistry();
	const secondKernel = core.createWorkflowRuntimeKernel();
	secondRegistry.install(secondKernel.extension);
	const secondHarness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry: secondRegistry }, BACKGROUND_CONTEXT);
	const secondEngine = secondKernel.createEngine(secondHarness);
	secondEngine.register(definition);
	try {
		await secondEngine.open(BACKGROUND_CONTEXT);
		assert.equal(await secondEngine.wait("event-timeout-reopen", BACKGROUND_CONTEXT), "timed-out");
		assert.equal(invocations, 2);
	} finally {
		await secondEngine.close();
		await secondHarness.close(BACKGROUND_CONTEXT);
	}
});

test("a buffered event survives cold Harness reopen and is consumed after a prior sleep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-reopen-"));
	roots.push(root);
	const deadline = Date.now() + 150;
	let invocations = 0;
	let continuations = 0;
	const definition = core.defineWorkflow({
		id: "test.production.event-reopen",
		version: 1,
		async run({ step }) {
			invocations++;
			await step.sleepUntil("hold", deadline);
			const event = await step.waitForEvent<{ answer: number }>("answer", "workflow.answer");
			continuations++;
			return { eventId: event.eventId, payload: event.payload };
		},
	});
	const firstRegistry = createRegistry();
	const firstKernel = core.createWorkflowRuntimeKernel();
	firstRegistry.install(firstKernel.extension);
	const firstHarness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry: firstRegistry }, BACKGROUND_CONTEXT);
	const firstEngine = firstKernel.createEngine(firstHarness, { scheduleAt: () => () => {} });
	try {
		await firstEngine.open(BACKGROUND_CONTEXT);
		await firstEngine.start(definition, null, { runId: "event-reopen" }, BACKGROUND_CONTEXT);
		let task: any;
		const expires = Date.now() + 5_000;
		while (task?.state.status !== "waiting") {
			task = (await firstHarness.inspect(BACKGROUND_CONTEXT)).tasks.find((item: any) => item.record.kind === "pocket.workflow-runtime.task")?.record;
			if (Date.now() > expires) throw new Error("Workflow did not enter its initial sleep");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(task.state.checkpoint.waits.hold.status, "unresolved");
		assert.equal(await firstEngine.sendEvent("event-reopen", { id: "offline-answer", type: "workflow.answer", payload: { answer: 42 } }, BACKGROUND_CONTEXT), true);
	} finally {
		await firstEngine.close();
		await firstHarness.close(BACKGROUND_CONTEXT);
	}
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 10)));
	const secondRegistry = createRegistry();
	const secondKernel = core.createWorkflowRuntimeKernel();
	secondRegistry.install(secondKernel.extension);
	const secondHarness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry: secondRegistry }, BACKGROUND_CONTEXT);
	const secondEngine = secondKernel.createEngine(secondHarness);
	secondEngine.register(definition);
	try {
		await secondEngine.open(BACKGROUND_CONTEXT);
		assert.deepEqual(await secondEngine.wait("event-reopen", BACKGROUND_CONTEXT), {
			eventId: "offline-answer",
			payload: { answer: 42 },
		});
		assert.equal(invocations, 2);
		assert.equal(continuations, 1);
	} finally {
		await secondEngine.close();
		await secondHarness.close(BACKGROUND_CONTEXT);
	}
});

test("an event delivered after its wait deadline loses to timeout even before the timer callback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-timeout-race-"));
	roots.push(root);
	const registry = createRegistry();
	const kernel = core.createWorkflowRuntimeKernel();
	registry.install(kernel.extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry }, BACKGROUND_CONTEXT);
	const engine = kernel.createEngine(harness, { scheduleAt: () => () => {} });
	const definition = core.defineWorkflow({
		id: "test.production.event-timeout-race",
		version: 1,
		async run({ step }) {
			try {
				const event = await step.waitForEvent("race", "workflow.race", { timeout: "40ms" });
				return { outcome: "event", eventId: event.eventId };
			} catch (error) {
				if (error instanceof core.WorkflowEventTimeoutError) return { outcome: "timeout", eventId: null };
				throw error;
			}
		},
	});
	try {
		await engine.open(BACKGROUND_CONTEXT);
		await engine.start(definition, null, { runId: "event-timeout-race" }, BACKGROUND_CONTEXT);
		let task: any;
		const expires = Date.now() + 5_000;
		while (task?.state.status !== "waiting") {
			task = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find((item: any) => item.record.kind === "pocket.workflow-runtime.task")?.record;
			if (Date.now() > expires) throw new Error("Workflow did not park for timeout race");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const dueAt = task.state.checkpoint.waits.race.dueAt;
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueAt - Date.now() + 10)));
		assert.equal(await engine.sendEvent("event-timeout-race", { id: "too-late", type: "workflow.race", payload: null }, BACKGROUND_CONTEXT), true);
		assert.deepEqual(await engine.wait("event-timeout-race", BACKGROUND_CONTEXT), { outcome: "timeout", eventId: null });
		const run = await harness.snapshot(core.RUN_DOC, "event-timeout-race", BACKGROUND_CONTEXT);
		assert.equal(run?.currentWait?.outcome, "timeout");
		assert.equal(run?.events?.find((event) => event.eventId === "too-late")?.consumedBy, undefined, "the late event stays buffered and is not consumed by the timed-out wait");
	} finally {
		await engine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("event wait timeout is durable and resolves through the TimerHost once", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-timeout-"));
	roots.push(root);
	const registry = createRegistry();
	const kernel = core.createWorkflowRuntimeKernel();
	registry.install(kernel.extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry }, BACKGROUND_CONTEXT);
	const engine = kernel.createEngine(harness);
	let outcomes = 0;
	const definition = core.defineWorkflow({
		id: "test.production.event-timeout",
		version: 1,
		async run({ step }) {
			try {
				await step.waitForEvent("never-arrives", "workflow.never", { timeout: "80ms" });
				return "unexpected-event";
			} catch (error) {
				if (!(error instanceof core.WorkflowEventTimeoutError)) throw error;
				outcomes++;
				return error.name;
			}
		},
	});
	try {
		await engine.open(BACKGROUND_CONTEXT);
		await engine.start(definition, null, { runId: "event-timeout" }, BACKGROUND_CONTEXT);
		assert.equal(await engine.wait("event-timeout", BACKGROUND_CONTEXT), "WorkflowEventTimeoutError");
		assert.equal(outcomes, 1);
	} finally {
		await engine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a concurrent second wait for the same event type is rejected while the first remains durable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-ambiguous-"));
	roots.push(root);
	const registry = createRegistry();
	const kernel = core.createWorkflowRuntimeKernel();
	registry.install(kernel.extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry }, BACKGROUND_CONTEXT);
	const engine = kernel.createEngine(harness, { scheduleAt: () => () => {} });
	let conflicts = 0;
	let invocations = 0;
	const definition = core.defineWorkflow({
		id: "test.production.event-ambiguous",
		version: 1,
		async run({ step }) {
			invocations++;
			const first = step.waitForEvent("first", "workflow.shared");
			try {
				await step.waitForEvent("second", "workflow.shared");
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("already has an active wait")) throw error;
				conflicts++;
			}
			const event = await first;
			return event.eventId;
		},
	});
	try {
		await engine.open(BACKGROUND_CONTEXT);
		await engine.start(definition, null, { runId: "event-ambiguous" }, BACKGROUND_CONTEXT);
		let task: any;
		const expires = Date.now() + 5_000;
		while (task?.state.status !== "waiting") {
			task = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find((item: any) => item.record.kind === "pocket.workflow-runtime.task")?.record;
			if (Date.now() > expires) throw new Error("First event wait did not park");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(conflicts, 1);
		assert.equal(Object.keys(task.state.checkpoint.waits).length, 1);
		assert.equal(await engine.sendEvent("event-ambiguous", { id: "only-active", type: "workflow.shared", payload: null }, BACKGROUND_CONTEXT), true);
		assert.equal(await engine.wait("event-ambiguous", BACKGROUND_CONTEXT), "only-active");
		assert.equal(conflicts, 2);
		assert.equal(invocations, 2);
	} finally {
		await engine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});

test("a delivered event atomically resolves an active external wait and resumes its workflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocket-production-event-live-"));
	roots.push(root);
	const registry = createRegistry();
	const kernel = core.createWorkflowRuntimeKernel();
	registry.install(kernel.extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(root, "runtime.sqlite")), { models: createModels(), registry }, BACKGROUND_CONTEXT);
	const engine = kernel.createEngine(harness);
	let continuations = 0;
	const definition = core.defineWorkflow({
		id: "test.production.event-live",
		version: 1,
		async run({ step }) {
			const event = await step.waitForEvent<{ approved: boolean }>("decision", "workflow.decision");
			continuations++;
			return event.payload.approved;
		},
	});
	try {
		await engine.open(BACKGROUND_CONTEXT);
		await engine.start(definition, null, { runId: "event-live" }, BACKGROUND_CONTEXT);
		let task: any;
		const expires = Date.now() + 5_000;
		while (task?.state.status !== "waiting") {
			task = (await harness.inspect(BACKGROUND_CONTEXT)).tasks.find((item: any) => item.record.kind === "pocket.workflow-runtime.task")?.record;
			if (Date.now() > expires) throw new Error("Workflow did not enter its event wait");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal((await engine.inspect("event-live", BACKGROUND_CONTEXT)).status, "waiting");
		assert.equal(await engine.sendEvent("event-live", { id: "decision-1", type: "workflow.decision", payload: { approved: true } }, BACKGROUND_CONTEXT), true);
		assert.equal(await engine.wait("event-live", BACKGROUND_CONTEXT), true);
		assert.equal(continuations, 1);
		await assert.rejects(engine.sendEvent("event-live", { id: "late-event", type: "workflow.decision", payload: { approved: false } }, BACKGROUND_CONTEXT), /already terminal/);
	} finally {
		await engine.close();
		await harness.close(BACKGROUND_CONTEXT);
	}
});
