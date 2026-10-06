import { appendFile, readFile } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { WorkflowEngine, WorkflowTask, workflow } from "../../packages/workflow-runtime/legacy.ts";

const mode = process.env.PI_MODE;
const now = Number(process.env.PI_NOW);
const wakeAt = Number(process.env.PI_WAKE_AT);
const databasePath = process.env.PI_DB_PATH;
const effectLog = process.env.PI_EFFECT_LOG;
if (
	databasePath === undefined ||
	effectLog === undefined ||
	!Number.isSafeInteger(now) ||
	!Number.isSafeInteger(wakeAt)
) {
	throw new Error("Missing workflow crash worker configuration");
}

const registry = createRegistry();
registry.install(defineExtension({ name: "pocket-workflows-test", tasks: [WorkflowTask] }));
const harness = await Harness.open(
	await openNodeSqliteStorage(databasePath),
	{
		models: createModels(),
		registry,
		now: () => now,
	},
	BACKGROUND_CONTEXT,
);
const engine = new WorkflowEngine(harness, {
	scheduleAt: (deadline, callback) => {
		const timer = setTimeout(callback, Math.max(0, deadline - now));
		return () => clearTimeout(timer);
	},
});
const feature = workflow<{ wakeAt: number }, { plan: string; finished: string }>(
	"spike.sigkill-reentry",
	async ({ input, step }) => {
		const plan = await step.do("plan", async () => {
			await appendFile(effectLog, "plan\n");
			return "memoized";
		});
		await step.sleepUntil("pause", input.wakeAt);
		const finished = await step.do("finish", async () => {
			await appendFile(effectLog, "finish\n");
			return "resumed";
		});
		return { plan, finished };
	},
);
const uncertainFeature = workflow<JsonValue, string>("spike.uncertain-effect", async ({ step }) =>
	step.do<string>(
		"effect",
		async (execution?: { readonly idempotencyKey: string; readonly attempt: number }) => {
			const key = execution?.idempotencyKey ?? "missing-key";
			const attempt = execution?.attempt ?? 0;
			if (mode === "retry-start" && attempt === 1) {
				process.stdout.write(`ATTEMPT:${attempt}\n`);
				await new Promise(() => {});
			}
			await appendFile(effectLog, `effect:${key}\n`);
			process.stdout.write(`EFFECT:${key}\n`);
			if (mode === "attempt-start") await new Promise(() => {});
			return `executed:${attempt}`;
		},
		{
			recover: async (execution: { readonly idempotencyKey: string }) => {
				let effects = "";
				try {
					effects = await readFile(effectLog, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				return effects.includes(`effect:${execution.idempotencyKey}\n`)
					? { status: "completed", result: `reconciled:${execution.idempotencyKey}` }
					: { status: "retry" };
			},
		},
	),
);

await engine.open(BACKGROUND_CONTEXT);
if (mode === "start") {
	const root = await harness.root(BACKGROUND_CONTEXT);
	const handle = await engine.start(feature, { wakeAt }, root, BACKGROUND_CONTEXT);
	process.stdout.write(`HANDLE:${handle.id}\n`);
	while ((await engine.inspect(handle, BACKGROUND_CONTEXT)).status !== "waiting") {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	process.stdout.write("PARKED\n");
	await new Promise(() => {});
} else if (mode === "attempt-start" || mode === "retry-start") {
	const root = await harness.root(BACKGROUND_CONTEXT);
	const handle = await engine.start(uncertainFeature, null, root, BACKGROUND_CONTEXT);
	process.stdout.write(`HANDLE:${handle.id}\n`);
	await new Promise(() => {});
} else if (mode === "recover" || mode === "attempt-recover" || mode === "retry-recover") {
	const workflowId = process.env.PI_WORKFLOW_ID;
	if (workflowId === undefined) throw new Error("Missing workflow ID for recovery");
	const result = await engine.wait({ id: workflowId }, BACKGROUND_CONTEXT);
	process.stdout.write(`RESULT:${JSON.stringify(result)}\n`);
} else {
	throw new Error(`Unknown workflow crash worker mode: ${mode}`);
}

await engine.close();
await harness.close(BACKGROUND_CONTEXT);
