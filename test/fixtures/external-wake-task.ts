import { defineDoc, defineTask } from "@earendil-works/pi-durable";

export type ExternalResult = { readonly requestId: string; readonly value: string };

export const ExternalResults = defineDoc<{ results: Record<string, ExternalResult> }>({
	kind: "test.external-wake.results",
	version: 1,
	scope: "session",
	initial: () => ({ results: {} }),
});

type Checkpoint = { readonly phase: "start" } | { readonly phase: "resume" };

export function externalWaiter(invocations: object[] = [], onStart?: () => void) {
	return defineTask<null, Checkpoint, string>({
		name: "test.external-wake",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (_task, runtime, context) => {
				onStart?.();
				invocations.push(runtime);
				await runtime.commit(
					() => ({
						status: "waiting",
						checkpoint: { phase: "resume" },
						on: [],
						policy: "allSettled",
						external: true,
					}),
					context,
				);
			},
			resume: async (task, runtime, context) => {
				invocations.push(runtime);
				const event = await runtime.snapshot(ExternalResults, context);
				const value = event?.results[String(task.id)]?.value;
				if (value === undefined) {
					await runtime.commit(
						() => ({
							status: "waiting",
							checkpoint: task.state.checkpoint,
							on: [],
							policy: "allSettled",
							external: true,
						}),
						context,
					);
					return;
				}
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: value } }),
					context,
				);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted", reason: "external wait aborted" } }),
				context,
			),
	});
}
