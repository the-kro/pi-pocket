import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

const extensionsDirectory = fileURLToPath(new URL("../src/server/extensions/", import.meta.url));

test("the workflow task extension stays enabled so persisted workflow tasks can resume", () => {
	const loader = new ExtensionLoader(createRegistry(), {} as PocketHost, extensionsDirectory, () => false);
	try {
		const workflows = loader.list().find((module) => module.file === "workflows.ts");
		assert.ok(workflows, "the workflow runtime must be a discoverable extension module");
		assert.equal(workflows.required, true);
		assert.equal(workflows.enabled, true);
	} finally {
		loader.close();
	}
});
