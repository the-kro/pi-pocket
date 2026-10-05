import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	type Registry,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, it as nodeIt } from "node:test";
import { allEntries, eventually, textOf, unanswered } from "./workflow-test-support.ts";
import { NonRetryableError, WorkflowEngine, WorkflowTask, workflow } from "../packages/workflow-runtime/index.ts";

const context = BACKGROUND_CONTEXT;
const directories = new Set<string>();

function it(name: string, run: () => void | Promise<void>, timeoutMs?: number) {
	return timeoutMs === undefined ? nodeIt(name, run) : nodeIt(name, { timeout: timeoutMs }, run);
}

function expect<T>(actual: T) {
	const failure = (message: string) => (error: unknown) => {
		assert.ok(error instanceof Error, message);
		assert.ok(error.message.includes(message), `Expected error containing ${JSON.stringify(message)}, got ${error.message}`);
		return true;
	};
	return {
		toBe: (expected: unknown) => assert.strictEqual(actual, expected),
		toEqual: (expected: unknown) => assert.deepStrictEqual(actual, expected),
		toMatchObject: (expected: unknown) => assert.partialDeepStrictEqual(actual, expected),
		toThrow: (message: string) => assert.throws(actual as () => unknown, failure(message)),
		toHaveLength: (length: number) => assert.strictEqual((actual as { length: number }).length, length),
		toContain: (expected: unknown) => {
			if (typeof actual === "string" && typeof expected === "string") assert.ok(actual.includes(expected));
			else assert.ok((actual as readonly unknown[]).includes(expected));
		},
		toBeDefined: () => assert.notStrictEqual(actual, undefined),
		toBeGreaterThan: (expected: number) => assert.ok(typeof actual === "number" && actual > expected),
		toBeInstanceOf: (expected: new (...args: never[]) => unknown) => assert.ok(actual instanceof expected),
		resolves: {
			toBe: async (expected: unknown) => assert.strictEqual(await actual, expected),
			toEqual: async (expected: unknown) => assert.deepStrictEqual(await actual, expected),
		},
		rejects: {
			toThrow: async (message: string) => assert.rejects(actual as Promise<unknown>, failure(message)),
		},
	};
}

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-workflow-"));
	directories.add(directory);
	return join(directory, "workflow.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

function registry(): Registry {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "pocket-workflows-test", tasks: [WorkflowTask] }));
	return registry;
}

async function openHarness(path: string, registry: Registry, now: () => number) {
	return Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry, now }, context);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const crashWorkerPath = fileURLToPath(new URL("./fixtures/workflow-interpreter-crash-worker.ts", import.meta.url));

function spawnCrashWorker(
	mode: "start" | "recover" | "attempt-start" | "attempt-recover" | "retry-start" | "retry-recover",
	path: string,
	effectLog: string,
	workflowId = "",
) {
	return spawn(process.execPath, ["--experimental-strip-types", crashWorkerPath], {
		cwd: repoRoot,
		env: {
			...process.env,
			PI_MODE: mode,
			PI_DB_PATH: path,
			PI_EFFECT_LOG: effectLog,
			PI_NOW: mode === "start" ? "1000" : "11000",
			PI_WAKE_AT: "10000",
			PI_WORKFLOW_ID: workflowId,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForOutput(child: ReturnType<typeof spawn>, marker: string | readonly string[]): Promise<string> {
	const stdout = child.stdout;
	const stderr = child.stderr;
	if (stdout === null || stderr === null) throw new Error("Workflow worker did not expose output pipes");
	stdout.setEncoding("utf8");
	stderr.setEncoding("utf8");
	let output = "";
	let errors = "";
	const markers = typeof marker === "string" ? [marker] : marker;
	const label = markers.join(" or ");
	const matched = () => markers.some((candidate) => output.includes(candidate));
	return new Promise((resolveOutput, rejectOutput) => {
		const cleanup = () => {
			clearTimeout(timer);
			stdout.off("data", onStdout);
			stderr.off("data", onStderr);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onStdout = (chunk: string) => {
			output += chunk;
			if (matched()) {
				cleanup();
				resolveOutput(output);
			}
		};
		const onStderr = (chunk: string) => {
			errors += chunk;
		};
		const onError = (error: Error) => {
			cleanup();
			rejectOutput(error);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (matched()) return;
			cleanup();
			rejectOutput(
				new Error(`Workflow worker exited before ${label}: code=${code}, signal=${signal}; stderr=${errors}`),
			);
		};
		const timer = setTimeout(() => {
			cleanup();
			rejectOutput(new Error(`Timed out waiting for ${label}; stdout=${output}; stderr=${errors}`));
		}, 20_000);
		stdout.on("data", onStdout);
		stderr.on("data", onStderr);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

async function workerExit(child: ReturnType<typeof spawn>): Promise<[number | null, NodeJS.Signals | null]> {
	if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
	return once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
}

async function killWorker(child: ReturnType<typeof spawn>): Promise<NodeJS.Signals | null> {
	if (child.exitCode !== null || child.signalCode !== null) return child.signalCode;
	const exited = workerExit(child);
	child.kill("SIGKILL");
	const [, signal] = await exited;
	return signal;
}

function fakeClock(initial: number) {
	let current = initial;
	let sequence = 0;
	const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
	return {
		now: () => current,
		scheduleAt: (at: number, callback: () => void) => {
			const id = ++sequence;
			if (at <= current) {
				queueMicrotask(callback);
				return () => {};
			}
			timers.set(id, { at, callback });
			return () => timers.delete(id);
		},
		advanceTo: (at: number) => {
			current = at;
			for (const [id, timer] of timers) {
				if (timer.at > current) continue;
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

describe("workflow runtime", () => {
	it("re-enters from the beginning, reuses a completed step, and keeps sleep's absolute deadline", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(1_000);
		let planCalls = 0;
		let finishCalls = 0;
		let finallyCalls = 0;
		const feature = workflow<{ value: number; suffix: string }>("spike.memoized-sleep", async ({ input, step }) => {
			const plan = await step.do("plan", async () => {
				planCalls++;
				return { value: input.value };
			});
			try {
				await step.sleep("pause", 100);
			} finally {
				finallyCalls++;
			}
			const finished = await step.do("finish", async () => {
				finishCalls++;
				return `${plan.value}:${input.suffix}`;
			});
			return { plan, finished };
		});

		const definitions = registry();
		let harness = await openHarness(path, definitions, clock.now);
		let engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		await engine.open(context);
		const root = await harness.root(context);
		const handle = await engine.start(feature, { value: 7, suffix: "ok" }, root, context);
		await eventually(async () => (await engine.inspect(handle, context)).status === "waiting");
		const waiting = await harness.inspect(context);
		assert.ok(
			waiting.tasks.some(
				(task) => task.record.kind === WorkflowTask.definition.name && task.state.kind === "waiting",
			),
		);
		expect(planCalls).toBe(1);
		expect(finishCalls).toBe(0);
		expect(finallyCalls).toBe(1);
		await engine.close();
		await harness.close(context);

		// Reopening before wakeAt keeps the same absolute deadline; it does not restart a duration.
		clock.advanceTo(1_090);
		harness = await openHarness(path, definitions, clock.now);
		engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		await engine.open(context);
		await eventually(async () => (await engine.inspect(handle, context)).status === "waiting");
		expect(planCalls).toBe(1);
		expect(finishCalls).toBe(0);
		expect(finallyCalls).toBe(1);
		await engine.close();
		await harness.close(context);

		// Reopening after wakeAt continues immediately and returns the memoized plan value.
		clock.advanceTo(1_200);
		harness = await openHarness(path, definitions, clock.now);
		engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		await engine.open(context);
		await expect(engine.wait(handle, context)).resolves.toEqual({
			plan: { value: 7 },
			finished: "7:ok",
		});
		expect(planCalls).toBe(1);
		expect(finishCalls).toBe(1);
		expect(finallyCalls).toBe(2);
		await engine.close();
		await harness.close(context);
	});

	it("retries a known step failure and records the retry separately from the final result", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(2_000);
		let attempts = 0;
		const feature = workflow<JsonValue, string>("spike.retry", async ({ step }) =>
			step.do(
				"transient",
				async () => {
					attempts++;
					if (attempts === 1) throw new Error("temporary outage");
					return "recovered";
				},
				{ retries: 1 },
			),
		);
		const definitions = registry();
		const harness = await openHarness(path, definitions, clock.now);
		const engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(feature, null, root, context);
			await expect(engine.wait(handle, context)).resolves.toBe("recovered");
			expect(attempts).toBe(2);
			const inspection = await engine.inspect(handle, context);
			expect(inspection).toMatchObject({
				status: "completed",
				steps: { transient: { status: "completed", attempt: 2, retryCount: 1 } },
			});
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("accepts an event before the wait and consumes duplicate delivery once", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(3_000);
		const entered = deferred<void>();
		const release = deferred<void>();
		const feature = workflow<JsonValue, string>("spike.event-before-wait", async ({ step }) => {
			await step.do("hold", async () => {
				entered.resolve();
				await release.promise;
				return null;
			});
			const event = await step.waitForEvent("approval", "approved");
			return `${event.eventId}:${JSON.stringify(event.payload)}`;
		});
		const definitions = registry();
		const harness = await openHarness(path, definitions, clock.now);
		const engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(feature, null, root, context);
			await entered.promise;
			expect(await engine.sendEvent(handle, "approval-1", "approved", { actor: "board" }, context)).toBe(true);
			expect(await engine.sendEvent(handle, "approval-1", "approved", { actor: "board" }, context)).toBe(false);
			release.resolve();
			await expect(engine.wait(handle, context)).resolves.toBe('approval-1:{"actor":"board"}');
			expect((await engine.inspect(handle, context)).steps.approval).toMatchObject({ status: "completed" });
		} finally {
			release.resolve();
			await engine.close();
			await harness.close(context);
		}
	});

	it("queues an event while the harness is closed and replays it after reopen", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(4_000);
		const feature = workflow<JsonValue, string>("spike.event-offline", async ({ step }) => {
			const event = await step.waitForEvent("approval", "approved");
			return JSON.stringify(event.payload);
		});
		const definitions = registry();
		let harness = await openHarness(path, definitions, clock.now);
		let engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		await engine.open(context);
		const root = await harness.root(context);
		const handle = await engine.start(feature, null, root, context);
		await eventually(async () => (await engine.inspect(handle, context)).status === "waiting");
		await engine.close();
		await harness.close(context);

		harness = await openHarness(path, definitions, clock.now);
		engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		try {
			await engine.open(context);
			expect(await engine.sendEvent(handle, "approval-2", "approved", { decision: "yes" }, context)).toBe(true);
			expect(await engine.sendEvent(handle, "approval-2", "approved", { decision: "yes" }, context)).toBe(false);
			await expect(engine.wait(handle, context)).resolves.toBe('{"decision":"yes"}');
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("persists non-retryable failures without spending retry budget", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(5_000);
		let attempts = 0;
		const feature = workflow<JsonValue, string>("spike.non-retryable", async ({ step }) =>
			step.do(
				"fatal",
				async () => {
					attempts++;
					throw new NonRetryableError("policy rejected");
				},
				{ retries: 5 },
			),
		);
		const definitions = registry();
		const harness = await openHarness(path, definitions, clock.now);
		const engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(feature, null, root, context);
			await expect(engine.wait(handle, context)).rejects.toThrow("policy rejected");
			expect(attempts).toBe(1);
			expect((await engine.inspect(handle, context)).steps.fatal).toMatchObject({
				status: "failed",
				attempt: 1,
				retryCount: 0,
			});
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("rejects reusing one logical step ID twice in the same invocation", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(6_000);
		let calls = 0;
		const feature = workflow<JsonValue, JsonValue>("spike.duplicate-step", async ({ step }) => {
			await step.do("only-once", () => {
				calls++;
				return 1;
			});
			await step.do("only-once", () => {
				calls++;
				return 2;
			});
			return null;
		});
		const definitions = registry();
		const harness = await openHarness(path, definitions, clock.now);
		const engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(feature, null, root, context);
			await expect(engine.wait(handle, context)).rejects.toThrow("was called more than once");
			expect(calls).toBe(1);
			expect((await engine.inspect(handle, context)).status).toBe("failed");
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("runs independent named steps concurrently through Promise.all", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(7_000);
		const bothStarted = deferred<void>();
		const release = deferred<void>();
		const started: string[] = [];
		const feature = workflow<{ left: string; right: string }, { left: string; right: string }>(
			"spike.parallel",
			async ({ input, step }) => {
				const resolve = async (stepId: string, value: string) =>
					step.do(stepId, async () => {
						started.push(stepId);
						if (started.length === 2) bothStarted.resolve();
						await release.promise;
						return value;
					});
				const [left, right] = await Promise.all([resolve("left", input.left), resolve("right", input.right)]);
				return { left, right };
			},
		);
		const definitions = registry();
		const harness = await openHarness(path, definitions, clock.now);
		const engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(feature, { left: "L", right: "R" }, root, context);
			const completion = engine.wait(handle, context);
			await bothStarted.promise;
			expect(started).toHaveLength(2);
			release.resolve();
			await expect(completion).resolves.toEqual({ left: "L", right: "R" });
			expect((await engine.inspect(handle, context)).steps).toMatchObject({
				left: { status: "completed", attempt: 1 },
				right: { status: "completed", attempt: 1 },
			});
		} finally {
			release.resolve();
			await engine.close();
			await harness.close(context);
		}
	});

	it("joins sibling step effects before persisting a parallel failure", async () => {
		const path = await sqlitePath();
		const harness = await openHarness(path, registry(), () => 1_000);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		const siblingStarted = deferred<void>();
		const releaseSibling = deferred<void>();
		const effects: string[] = [];
		const definition = workflow<null, string>("spike.parallel-failure", async ({ step }) => {
			await Promise.all([
				step.do("failure", async () => {
					await siblingStarted.promise;
					throw new NonRetryableError("parallel branch failed");
				}),
				step.do("sibling-effect", async () => {
					siblingStarted.resolve();
					await releaseSibling.promise;
					effects.push("finished");
					return "effect-result";
				}),
			]);
			return "unexpected success";
		});
		let settled = false;
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(definition, null, root, context);
			const outcome = engine.wait(handle, context).then(
				(result) => ({ status: "completed" as const, result }),
				(error: Error) => ({ status: "failed" as const, error }),
			);
			void outcome.then(() => {
				settled = true;
			});
			await siblingStarted.promise;
			await eventually(async () => (await engine.inspect(handle, context)).steps.failure?.status === "failed");
			expect(settled).toBe(false);
			releaseSibling.resolve();
			const result = await outcome;
			expect(result.status).toBe("failed");
			expect(effects).toEqual(["finished"]);
		} finally {
			releaseSibling.resolve();
			await engine.close();
			await harness.close(context);
		}
	});

	it("rearms a parked timer beyond the first 256 workflow records after reopen", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(1_000);
		const harness = await openHarness(path, registry(), () => clock.now());
		const engine = new WorkflowEngine(harness, { scheduleAt: clock.scheduleAt });
		const eventWaiter = workflow<{ index: number }, JsonValue>(
			"spike.page-event-padding",
			async ({ input, step }) => {
				return (await step.waitForEvent("hold", `unused-${input.index}`)).payload;
			},
		);
		const sleeper = workflow<null, string>("spike.page-sleep", async ({ step }) => {
			await step.sleepUntil("pause", 10_000);
			return "awake";
		});
		let originalClosed = false;
		try {
			await engine.open(context);
			const root = await harness.root(context);
			await root.commit(async (tx) => {
				for (let index = 0; index < 257; index += 1) {
					await tx.createTask(
						WorkflowTask,
						{
							workflowId: `${root.id}/padding/${index}`,
							workflowName: eventWaiter.name,
							workflowVersion: eventWaiter.version,
							input: { index },
						},
						{ ownership: { kind: "conversation" } },
					);
				}
			}, context);
			await eventually(async () => {
				const page = await harness.commit(
					(tx) => tx.scanTasks({ kind: WorkflowTask.definition.name, status: "waiting" }, 300),
					context,
				);
				return (
					page.items.filter((task) => (task.input as { workflowName: string }).workflowName === eventWaiter.name)
						.length === 257
				);
			});
			const sleeperHandle = await engine.start(sleeper, null, root, context);
			await eventually(async () => (await engine.inspect(sleeperHandle, context)).status === "waiting");
			await engine.close();
			await harness.close(context);
			originalClosed = true;

			const reopened = await openHarness(path, registry(), () => clock.now());
			const rearmed: number[] = [];
			const recoveredEngine = new WorkflowEngine(reopened, {
				scheduleAt: (deadline) => {
					rearmed.push(deadline);
					return () => {};
				},
			});
			try {
				await recoveredEngine.open(context);
				expect(rearmed).toContain(10_000);
			} finally {
				await recoveredEngine.close();
				await reopened.close(context);
			}
		} finally {
			await engine.close();
			if (!originalClosed) await harness.close(context);
		}
	}, 30_000);

	it("survives SIGKILL while parked and resumes from its saved step checkpoint", async () => {
		const path = await sqlitePath();
		const effectLog = join(dirname(path), "workflow-effects.log");
		const worker = spawnCrashWorker("start", path, effectLog);
		let recovery: ReturnType<typeof spawn> | undefined;
		try {
			const output = await waitForOutput(worker, "PARKED");
			const workflowId = output
				.split("\n")
				.find((line) => line.startsWith("HANDLE:"))
				?.slice("HANDLE:".length);
			expect(workflowId).toBeDefined();
			expect(await readFile(effectLog, "utf8")).toBe("plan\n");
			expect(await killWorker(worker)).toBe("SIGKILL");

			const harness = await openHarness(path, registry(), () => 11_000);
			try {
				const task = (await harness.inspect(context)).tasks.find(
					(item) => item.record.kind === WorkflowTask.definition.name,
				);
				expect(task?.record.state).toMatchObject({
					status: "waiting",
					external: true,
					checkpoint: { steps: { plan: { kind: "do", status: "completed", result: "memoized" } } },
				});
			} finally {
				await harness.close(context);
			}

			recovery = spawnCrashWorker("recover", path, effectLog, workflowId!);
			const recoveredOutput = await waitForOutput(recovery, "RESULT:");
			const [code, signal] = await workerExit(recovery);
			expect([code, signal]).toEqual([0, null]);
			expect(recoveredOutput).toContain('RESULT:{"plan":"memoized","finished":"resumed"}');
			expect(await readFile(effectLog, "utf8")).toBe("plan\nfinish\n");
		} finally {
			await killWorker(worker);
			if (recovery !== undefined) await killWorker(recovery);
		}
	});

	it("retries an interrupted attempt only after reconciliation reports no effect", async () => {
		const path = await sqlitePath();
		const effectLog = join(dirname(path), "retry-effects.log");
		const worker = spawnCrashWorker("retry-start", path, effectLog);
		let recovery: ReturnType<typeof spawn> | undefined;
		try {
			await waitForOutput(worker, "ATTEMPT:1");
			expect(await killWorker(worker)).toBe("SIGKILL");
			const harness = await openHarness(path, registry(), () => 11_000);
			let workflowId = "";
			try {
				const task = (await harness.inspect(context)).tasks.find(
					(item) =>
						item.record.kind === WorkflowTask.definition.name &&
						(item.record.input as { workflowName: string }).workflowName === "spike.uncertain-effect",
				);
				expect(task?.record.state).toMatchObject({
					status: "pending",
					checkpoint: { steps: { effect: { kind: "do", status: "running", attempt: 1 } } },
				});
				workflowId = (task?.record.input as { workflowId: string }).workflowId;
			} finally {
				await harness.close(context);
			}

			recovery = spawnCrashWorker("retry-recover", path, effectLog, workflowId);
			const output = await waitForOutput(recovery, "RESULT:");
			expect(output).toContain('RESULT:"executed:2"');
			const [code, signal] = await workerExit(recovery);
			expect([code, signal]).toEqual([0, null]);
			expect(await readFile(effectLog, "utf8")).toBe(`effect:${workflowId}/effect\n`);
		} finally {
			await killWorker(worker);
			if (recovery !== undefined) await killWorker(recovery);
		}
	});

	it("models compensation as an explicit memoized reverse step", async () => {
		const path = await sqlitePath();
		const harness = await openHarness(path, registry(), () => 1_000);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		const effects: string[] = [];
		const compensated = workflow<null, string>("spike.compensation", async ({ step }) => {
			await step.do("reserve", async () => {
				effects.push("reserve");
				return "reservation-1";
			});
			try {
				await step.do("charge", async () => {
					effects.push("charge");
					throw new NonRetryableError("payment declined");
				});
			} catch {
				await step.do("release-reservation", async () => {
					effects.push("release");
					return "released";
				});
				throw new NonRetryableError("compensated failure");
			}
			return "charged";
		});
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(compensated, null, root, context);
			await expect(engine.wait(handle, context)).rejects.toThrow("compensated failure");
			expect(effects).toEqual(["reserve", "charge", "release"]);
			expect((await engine.inspect(handle, context)).steps).toMatchObject({
				reserve: { status: "completed" },
				charge: { status: "failed" },
				"release-reservation": { status: "completed" },
			});
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("drains concurrent step effects before parking on a sleep", async () => {
		const path = await sqlitePath();
		const clock = fakeClock(1_000);
		const harness = await openHarness(path, registry(), () => clock.now());
		const parked = deferred<void>();
		const effectStarted = deferred<void>();
		const releaseEffect = deferred<void>();
		const effects: string[] = [];
		const engine = new WorkflowEngine(harness, {
			scheduleAt: (at, callback) => {
				parked.resolve();
				return clock.scheduleAt(at, callback);
			},
		});
		const definition = workflow<null, string>("spike.parallel-effect-and-sleep", async ({ step }) => {
			const sleep = step.sleepUntil("pause", 10_000);
			const effect = step.do("effect", async () => {
				effectStarted.resolve();
				await releaseEffect.promise;
				effects.push("finished");
				return "effect-result";
			});
			await Promise.all([sleep, effect]);
			return "finished";
		});
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(definition, null, root, context);
			const startedBeforePark = await Promise.race([
				effectStarted.promise.then(() => "effect" as const),
				parked.promise.then(() => "parked" as const),
			]);
			expect(startedBeforePark).toBe("effect");
			const parkedBeforeEffectFinished = await Promise.race([
				parked.promise.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
			]);
			expect(parkedBeforeEffectFinished).toBe(false);
			releaseEffect.resolve();
			await parked.promise;
			expect(effects).toEqual(["finished"]);
			clock.advanceTo(10_000);
			expect(await engine.wait(handle, context)).toBe("finished");
		} finally {
			releaseEffect.resolve();
			clock.advanceTo(10_000);
			await engine.close();
			await harness.close(context);
		}
	});

	it("keeps event-vs-park races and conflicting event-ID reuse deterministic", async () => {
		const path = await sqlitePath();
		const harness = await openHarness(path, registry(), () => 1_000);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		try {
			await engine.open(context);
			const root = await harness.root(context);
			for (let index = 0; index < 16; index += 1) {
				const reachedWait = deferred<void>();
				const definition = workflow<{ index: number }, JsonValue>(`spike.event-race-${index}`, async ({ step }) => {
					reachedWait.resolve();
					return (await step.waitForEvent("receive", "result")).payload;
				});
				const handle = await engine.start(definition, { index }, root, context);
				await reachedWait.promise;
				if (index % 2 === 1) {
					await eventually(async () => (await engine.inspect(handle, context)).status === "waiting");
				}
				const eventId = `race-${index}`;
				const payload = { index };
				expect(await engine.sendEvent(handle, eventId, "result", payload, context)).toBe(true);
				expect(await engine.sendEvent(handle, eventId, "result", payload, context)).toBe(false);
				await expect(
					engine.sendEvent(handle, eventId, "result", { index, conflicting: true }, context),
				).rejects.toThrow("reused with different content");
				expect(await engine.wait(handle, context)).toEqual(payload);
			}
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("runs one real Durable generation as a replay-safe agent step", async () => {
		const path = await sqlitePath();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("The durable answer is 42.")]);
		const harness = await Harness.open(
			await openNodeSqliteStorage(path),
			{ models, registry: registry(), now: () => 1_000 },
			context,
		);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		const conversationReady = deferred<Conversation>();
		let agentConversation: Conversation | undefined;
		let workflowTaskId: TaskId | undefined;
		const agentWorkflow = workflow<null, string>("spike.agent-step", async ({ step }) =>
			step.do("agent", async ({ idempotencyKey, signal }) => {
				const agentContext = withAbortSignal(signal, context);
				const conversation = await awaitWithContext(conversationReady.promise, agentContext);
				const submission = await conversation.submit(
					{ type: "input", content: "What is the durable answer?", requestId: idempotencyKey },
					agentContext,
				);
				const settled = await submission.wait(agentContext);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Agent submission ended as ${settled.status}`);
				}
				const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), agentContext);
				const text = textOf(answer?.model?.[0]);
				if (text === undefined) throw new Error("Agent returned no text answer");
				return text;
			}),
		);
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(agentWorkflow, null, root, context);
			await eventually(async () => {
				const task = (await harness.inspect(context)).tasks.find(
					(item) =>
						item.record.kind === WorkflowTask.definition.name &&
						(item.record.input as { workflowId: string }).workflowId === handle.id,
				);
				if (task === undefined) return false;
				workflowTaskId = task.record.id;
				return true;
			});
			if (workflowTaskId === undefined) throw new Error("Workflow Task was not visible for agent ownership");
			agentConversation = await harness.createConversation(
				{
					ownership: { kind: "task", taskId: workflowTaskId },
					agent: { model: { provider: "faux", modelId: "faux-1" } },
				},
				context,
			);
			conversationReady.resolve(agentConversation);
			expect(await engine.wait(handle, context)).toBe("The durable answer is 42.");
			expect((await allEntries(agentConversation)).map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		} finally {
			if (workflowTaskId !== undefined) await harness.abortTask(workflowTaskId, context);
			await engine.close();
			await harness.close(context);
		}
	});

	it("aborting a workflow cancels its owned agent generation and step waiter", async () => {
		const path = await sqlitePath();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const pendingAgent = unanswered();
		faux.setResponses([pendingAgent.step]);
		const harness = await Harness.open(
			await openNodeSqliteStorage(path),
			{ models, registry: registry(), now: () => 1_000 },
			context,
		);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		const conversationReady = deferred<Conversation>();
		let workflowTaskId: TaskId | undefined;
		const agentWorkflow = workflow<null, string>("spike.agent-abort", async ({ step }) =>
			step.do("agent", async ({ idempotencyKey, signal }) => {
				const agentContext = withAbortSignal(signal, context);
				const conversation = await awaitWithContext(conversationReady.promise, agentContext);
				const submission = await conversation.submit(
					{ type: "input", content: "Wait for this answer.", requestId: idempotencyKey },
					agentContext,
				);
				const settled = await submission.wait(agentContext);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Agent submission ended as ${settled.status}`);
				}
				return "unexpected answer";
			}),
		);
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(agentWorkflow, null, root, context);
			await eventually(async () => {
				const task = (await harness.inspect(context)).tasks.find(
					(item) =>
						item.record.kind === WorkflowTask.definition.name &&
						(item.record.input as { workflowId: string }).workflowId === handle.id,
				);
				if (task === undefined) return false;
				workflowTaskId = task.record.id;
				return true;
			});
			if (workflowTaskId === undefined) throw new Error("Workflow Task was not visible for agent ownership");
			const ownedAgentConversation = await harness.createConversation(
				{
					ownership: { kind: "task", taskId: workflowTaskId },
					agent: { model: { provider: "faux", modelId: "faux-1" } },
				},
				context,
			);
			conversationReady.resolve(ownedAgentConversation);
			await pendingAgent.reached;
			await harness.abortTask(workflowTaskId, context);
			await expect(engine.wait(handle, context)).rejects.toThrow("ended with aborted");
			const tasks = await harness.commit(
				(tx) => tx.scanTasks({ conversationId: ownedAgentConversation.id }, 20),
				context,
			);
			expect(tasks.items.length).toBeGreaterThan(0);
			expect(tasks.items.every((task) => task.state.status === "terminal")).toBe(true);
		} finally {
			if (workflowTaskId !== undefined) await harness.abortTask(workflowTaskId, context);
			await engine.close();
			await harness.close(context);
		}
	}, 15_000);

	it("composes a durable child workflow through owned Task join", async () => {
		const path = await sqlitePath();
		const harness = await openHarness(path, registry(), () => 1_000);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		const childStarted = deferred<void>();
		const releaseChild = deferred<void>();
		const child = workflow<{ value: string }, { value: string }>("spike.child-transform", async ({ input, step }) => {
			const value = await step.do("uppercase", async () => {
				childStarted.resolve();
				await releaseChild.promise;
				return input.value.toUpperCase();
			});
			return { value };
		});
		const parent = workflow<{ value: string }, { value: string }>("spike.parent-join", async ({ input, step }) => {
			const childResult = await step.runChild("transform", child, { value: input.value });
			return { value: `${childResult.value}!` };
		});
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(parent, { value: "child" }, root, context);
			await childStarted.promise;
			const graph = await harness.taskGraph(context);
			try {
				const childNode = Object.values(graph.value.tasks).find(
					(node) => node.kind === WorkflowTask.definition.name && node.owner !== undefined,
				);
				expect(childNode).toBeDefined();
				expect(graph.value.tasks[String(childNode!.owner)]?.state.status).toBe("waiting");
			} finally {
				graph.dispose();
			}
			releaseChild.resolve();
			expect(await engine.wait(handle, context)).toEqual({ value: "CHILD!" });
			expect((await engine.inspect(handle, context)).steps.transform).toMatchObject({
				status: "completed",
				result: { value: "CHILD" },
			});
		} finally {
			releaseChild.resolve();
			await engine.close();
			await harness.close(context);
		}
	});

	it("keeps slash-containing sibling and nested child step IDs distinct", async () => {
		const path = await sqlitePath();
		const harness = await openHarness(path, registry(), () => 1_000);
		const engine = new WorkflowEngine(harness, { scheduleAt: () => () => {} });
		const child = workflow<null, string>("spike.identity-child", async () => "child");
		const nested = workflow<null, string>("spike.identity-nested", async ({ step }) =>
			step.runChild("b", child, null),
		);
		const parent = workflow<null, string>("spike.identity-parent", async ({ step }) => {
			const sibling = await step.runChild("a/b", child, null);
			const descendant = await step.runChild("a", nested, null);
			return `${sibling}/${descendant}`;
		});
		try {
			await engine.open(context);
			const root = await harness.root(context);
			const handle = await engine.start(parent, null, root, context);
			expect(await engine.wait(handle, context)).toBe("child/child");
		} finally {
			await engine.close();
			await harness.close(context);
		}
	});

	it("reconciles an uncertain effect after SIGKILL during step.do instead of repeating it", async () => {
		const path = await sqlitePath();
		const effectLog = join(dirname(path), "uncertain-effects.log");
		const worker = spawnCrashWorker("attempt-start", path, effectLog);
		let recovery: ReturnType<typeof spawn> | undefined;
		try {
			await waitForOutput(worker, "EFFECT:");
			expect(await killWorker(worker)).toBe("SIGKILL");
			const harness = await openHarness(path, registry(), () => 11_000);
			let workflowId: string;
			try {
				const task = (await harness.inspect(context)).tasks.find(
					(item) =>
						item.record.kind === WorkflowTask.definition.name &&
						(item.record.input as { workflowName: string }).workflowName === "spike.uncertain-effect",
				);
				expect(task?.record.state).toMatchObject({
					status: "pending",
					checkpoint: { steps: { effect: { kind: "do", status: "running", attempt: 1 } } },
				});
				workflowId = (task?.record.input as { workflowId: string }).workflowId;
			} finally {
				await harness.close(context);
			}

			recovery = spawnCrashWorker("attempt-recover", path, effectLog, workflowId!);
			const recoveredOutput = await waitForOutput(recovery, ["RESULT:", "EFFECT:"]);
			expect(recoveredOutput).toContain(`RESULT:"reconciled:${workflowId}/effect"`);
			const [code, signal] = await workerExit(recovery);
			expect([code, signal]).toEqual([0, null]);
			expect((await readFile(effectLog, "utf8")).trim().split("\n")).toHaveLength(1);
		} finally {
			await killWorker(worker);
			if (recovery !== undefined) await killWorker(recovery);
		}
	});
});
