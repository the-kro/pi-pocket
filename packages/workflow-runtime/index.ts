import { createWorkflowRuntimeKernel } from "./core/index.ts";

export * from "./core/index.ts";
export * from "./agents/profile.ts";
export * from "./agents/recovery.ts";
export { InvocationCoordinator } from "./invocation.ts";
export { WorkflowTimerHost } from "./timer-host.ts";
export type { WorkflowTimerOptions } from "./timer-host.ts";

/** Shared host-independent kernel for adapters that register its Task and own its Harness lifecycle. */
export const workflowRuntimeKernel = createWorkflowRuntimeKernel();
