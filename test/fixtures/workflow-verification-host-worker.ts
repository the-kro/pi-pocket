import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import type { Shell } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    createGitWorkspaceAdapter,
    defineWorkflow,
    validateVerificationManifest,
    verify,
    WorkflowEngine,
    WorkflowRuntimeTask,
    type VerificationRequest,
    type WorkspaceSafetyAdapter,
} from "../../packages/workflow-runtime/index.ts";

const mode = process.env.PI_VERIFY_HOST_MODE;
const databasePath = process.env.PI_VERIFY_HOST_DB;
const workspaceRoot = process.env.PI_VERIFY_HOST_WORKTREE;
const markerPath = process.env.PI_VERIFY_HOST_MARKERS;
const safetyPath = process.env.PI_VERIFY_HOST_SAFETY;
const runId = "portable-verification-run";
const verificationId = "portable-verification-1";
const context = BACKGROUND_CONTEXT;

if (
    mode === undefined ||
    databasePath === undefined ||
    workspaceRoot === undefined ||
    markerPath === undefined ||
    safetyPath === undefined
) {
    throw new Error("Missing portable verification host-worker configuration");
}

function durableAppend(path: string, content: string): void {
    const descriptor = openSync(path, "a");

    try {
        writeSync(descriptor, content);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function controlledBoundary(): never {
    writeSync(1, "BOUNDARY:aggregate-committed\n");
    setInterval(() => {}, 60_000);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);

    throw new Error("Unreachable portable host crash boundary");
}

async function readSafetyEvidence(): Promise<
    { readonly state: string; readonly epoch: string } | undefined
> {
    try {
        const value = JSON.parse(await readFile(safetyPath!, "utf8")) as {
            readonly state?: unknown;
            readonly epoch?: unknown;
        };

        if (value.state !== "quiescent" || typeof value.epoch !== "string") {
            return undefined;
        }

        return { state: value.state, epoch: value.epoch };
    } catch {
        return undefined;
    }
}

const environment = new NodeExecutionEnv({ cwd: workspaceRoot! });
const workspace = createGitWorkspaceAdapter({
    fileSystem: environment,
    shell: environment,
    context,
    workspaceRoot: workspaceRoot!,
    maxGitOutputBytes: 2 * 1024 * 1024,
    maxWorkspaceFiles: 1000,
    maxSnapshotBytes: 4 * 1024 * 1024,
    maxSnapshotDurationMs: 30_000,
});
const safety: WorkspaceSafetyAdapter = {
    async assertQuiescent() {
        const evidence = await readSafetyEvidence();

        return evidence === undefined
            ? { state: "unknown" }
            : { state: "quiescent", assuranceId: `host-safety:${evidence.epoch}` };
    },
};
const markerShell: Pick<Shell, "exec"> = {
    async exec(command, options, shellContext) {
        if (command.includes("portable-verification-marker")) {
            durableAppend(markerPath!, "dispatch\n");
        }

        return await environment.exec(command, options, shellContext);
    },
};
const adapters = {
    workspace,
    safety,
    shell: markerShell,
    context,
    async environmentForPolicy() {
        return {};
    },
};
const ceilings = {
    maxManifestBytes: 8192,
    maxChecks: 4,
    maxCommandBytes: 4096,
    maxCheckTimeoutMs: 20_000,
    maxAggregateTimeoutMs: 30_000,
    maxCheckOutputBytes: 4096,
    maxAggregateOutputBytes: 8192,
};

async function createRequest(): Promise<VerificationRequest> {
    const subjectRevision = await workspace.snapshot();
    const manifest = await validateVerificationManifest(
        {
            checks: [
                {
                    id: "portable-check",
                    command: process.env.PI_VERIFY_HOST_COMMAND!,
                    cwd: ".",
                    environmentPolicyId: "portable-minimal-v1",
                    required: true,
                    timeoutMs: 10_000,
                    maxOutputBytes: 128,
                },
            ],
            bounds: {
                maxChecks: 1,
                aggregateTimeoutMs: 10_000,
                aggregateOutputBytes: 128,
            },
            resultPolicy: "all-required-checks-pass-v1",
        },
        {
            workspaceRoot: workspaceRoot!,
            ceilings,
            fileSystem: environment,
            context,
        },
    );

    return {
        verificationId,
        workspaceId: subjectRevision.workspaceId,
        subjectRevision,
        manifest,
        runner: { id: "generic-pi-durable-host-example", version: "1" },
    };
}

const workflow = defineWorkflow({
    id: "portable-verification-host-example",
    version: 1,
    async run(workflowContext) {
        const result = await verify(workflowContext, await createRequest(), adapters);

        if (mode === "start") {
            writeSync(1, `AGGREGATE:${JSON.stringify(result)}\n`);
            controlledBoundary();
        }

        return result as unknown as JsonValue;
    },
});

const registry = createRegistry();

registry.install(
    defineExtension({ name: "portable-verification-host-example", tasks: [WorkflowRuntimeTask] }),
);
const storage = await openNodeSqliteStorage(databasePath);
const harness = await Harness.open(storage, { models: createModels(), registry }, context);
const engine = new WorkflowEngine(harness);

engine.register(workflow);
await engine.open(context);

if (mode === "start") {
    await engine.start(workflow, null, { runId }, context);
    await new Promise(() => {});
} else {
    try {
        const result = await engine.wait(runId, context);

        writeSync(1, `RESULT:${JSON.stringify(result)}\n`);
    } finally {
        await engine.close();
        await harness.close(context);
        await environment.cleanup(context);
    }
}
