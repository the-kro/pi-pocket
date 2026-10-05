/** Durable workflow task registration for application-managed workflows. */
import { defineExtension } from "@earendil-works/pi-durable";
import { WorkflowTask } from "../../../packages/workflow-runtime/index.ts";
import type { PocketHost } from "../host.ts";

export default function createWorkflows(_host: PocketHost) {
	return defineExtension({ name: "pocket-workflows", tasks: [WorkflowTask] });
}
