import { createWorkflowRuntimeKernel } from "./core/index.ts";

export * from "./core/index.ts";
export * from "./agents/index.ts";
export { InvocationCoordinator } from "./invocation.ts";
export { WorkflowTimerHost } from "./timer-host.ts";
export type { WorkflowTimerOptions } from "./timer-host.ts";
export * from "./verification/index.ts";
export * from "./review/index.ts";

/** Shared host-independent kernel for adapters that register its Task and own its Harness lifecycle. */
export const workflowRuntimeKernel = createWorkflowRuntimeKernel();
