/** Durable workflow task registration for application-managed workflows. */
import { defineExtension } from "@earendil-works/pi-durable";
import { pocketWorkflowRuntime } from "../../../packages/workflow-runtime/core/index.ts";
import type { PocketHost } from "../host.ts";

export default function createWorkflows(_host: PocketHost) {
	return defineExtension({ name: "pocket-workflows", tasks: [pocketWorkflowRuntime.task] });
}
