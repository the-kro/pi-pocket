import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
    createRegistry,
    defineExtension,
    Harness,
    type Storage,
    type StorageWrite,
} from "@earendil-works/pi-durable";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import type { Shell } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    defineWorkflow,
    WorkflowEngine,
    WorkflowRuntimeTask,
    type WorkflowContext,
} from "../../packages/workflow-runtime/core/index.ts";
import { validateVerificationManifest } from "../../packages/workflow-runtime/verification/manifest.ts";
import { verify } from "../../packages/workflow-runtime/verification/verify.ts";
import type {
    VerificationRequest,
    VerificationResult,
    WorkspaceRevision,
} from "../../packages/workflow-runtime/verification/types.ts";

const mode = process.env.PI_VERIFY_MODE;
const databasePath = process.env.PI_VERIFY_DB;
const workspaceRoot = process.env.PI_VERIFY_ROOT;
const markerPath = process.env.PI_VERIFY_MARKERS;
const safetyPath = process.env.PI_VERIFY_SAFETY;
const boundary = process.env.PI_VERIFY_BOUNDARY ?? "none";
const variant = process.env.PI_VERIFY_VARIANT ?? "base";
const scenario = process.env.PI_VERIFY_SCENARIO ?? "single";
const runId = process.env.PI_VERIFY_RUN_ID ?? "verification-run";
const verificationId = process.env.PI_VERIFY_ID ?? "verification-1";
const context = BACKGROUND_CONTEXT;
const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const REQUEST_VARIANTS = [
    "revision",
    "manifest",
    "command",
    "cwd",
    "environment",
    "runner",
    "bounds",
] as const;
const aggregateResolvers = new Map<string, () => void>();
const aggregatePromises = new Map<string, Promise<void>>();

for (const requestVariant of REQUEST_VARIANTS) {
    let resolveAggregate!: () => void;

    aggregatePromises.set(
        requestVariant,
        new Promise<void>((resolve) => {
            resolveAggregate = resolve;
        }),
    );
    aggregateResolvers.set(requestVariant, resolveAggregate);
}

if (
    mode === undefined ||
    databasePath === undefined ||
    workspaceRoot === undefined ||
    markerPath === undefined ||
    safetyPath === undefined
) {
    throw new Error("Missing verification crash-worker configuration");
}

let currentRevision = REVISION_A;
let snapshotCalls = 0;
let admissionCalls = 0;
let signalCommandStarted!: () => void;
const commandStarted = new Promise<void>((resolve) => {
    signalCommandStarted = resolve;
});

function controlledBoundary(name: string): never {
    writeSync(1, `BOUNDARY:${name}\n`);
    setInterval(() => {}, 60_000);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);

    throw new Error("Unreachable crash boundary");
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

async function safetyState(): Promise<string> {
    try {
        return (await readFile(safetyPath!, "utf8")).trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "quiescent";
        }

        throw error;
    }
}

function workflowEvent(
    writes: readonly StorageWrite[],
): { readonly type: string; readonly operationId?: string } | undefined {
    for (const write of writes) {
        if (
            write.type !== "entry" ||
            write.value.kind !== "pocket.workflow-runtime.event" ||
            write.value.data === null ||
            typeof write.value.data !== "object" ||
            Array.isArray(write.value.data)
        ) {
            continue;
        }

        const event = write.value.data as {
            readonly type?: unknown;
            readonly operationId?: unknown;
        };

        if (typeof event.type === "string" && event.type.startsWith("operation.")) {
            return {
                type: event.type,
                ...(typeof event.operationId === "string"
                    ? { operationId: event.operationId }
                    : {}),
            };
        }
    }

    return undefined;
}

const backingStorage = await openNodeSqliteStorage(databasePath);
const storage = new Proxy(backingStorage, {
    get(target, property, receiver) {
        if (property === "commit") {
            return async (
                writes: readonly StorageWrite[],
                commitContext: Parameters<Storage["commit"]>[1],
            ) => {
                const event = workflowEvent(writes);
                const operationId = event?.operationId ?? "";
                const holdsAggregate =
                    mode === "start" &&
                    boundary === "before-aggregate-commit" &&
                    event?.type === "operation.completed" &&
                    operationId.endsWith(":aggregate");
                const holdsReconciliation =
                    mode === "recover" &&
                    boundary === "reconcile-before-commit" &&
                    event?.type === "operation.reconciled" &&
                    operationId.includes(":check:");

                if (holdsAggregate) {
                    controlledBoundary("before-aggregate-commit");
                }

                if (holdsReconciliation) {
                    controlledBoundary("reconcile-before-commit");
                }

                return await target.commit(writes, commitContext);
            };
        }

        const value = Reflect.get(target, property, receiver) as unknown;

        return typeof value === "function" ? value.bind(target) : value;
    },
}) as Storage;

const registry = createRegistry();

registry.install(
    defineExtension({ name: "verification-crash-fixture", tasks: [WorkflowRuntimeTask] }),
);
const harness = await Harness.open(storage, { models: createModels(), registry }, context);
const engine = new WorkflowEngine(harness);
const environment = new NodeExecutionEnv({ cwd: workspaceRoot! });
const checkCount = scenario === "two-checks" ? 2 : 1;
const hostCeilings = {
    maxManifestBytes: 16_384,
    maxChecks: 4,
    maxCommandBytes: 2048,
    maxCheckTimeoutMs: 5000,
    maxAggregateTimeoutMs: 10_000,
    maxCheckOutputBytes: 4096,
    maxAggregateOutputBytes: 8192,
};

async function createRequest(currentVariant = variant): Promise<VerificationRequest> {
    const checks = Array.from({ length: checkCount }, (_, index) => {
        const id = index === 0 ? "check-one" : "check-two";

        return {
            id: currentVariant === "manifest" && index === 0 ? "changed-check" : id,
            command:
                currentVariant === "command" && index === 0
                    ? "fixture changed-command"
                    : `fixture ${id}`,
            cwd: currentVariant === "cwd" && index === 0 ? "sub" : ".",
            environmentPolicyId:
                currentVariant === "environment" && index === 0
                    ? "fixture-env-v2"
                    : "fixture-env-v1",
            required: true,
            timeoutMs: 1000,
            maxOutputBytes: 1024,
        };
    });
    const manifest = await validateVerificationManifest(
        {
            checks,
            bounds: {
                maxChecks: checkCount,
                aggregateTimeoutMs: currentVariant === "bounds" ? 4001 : 4000,
                aggregateOutputBytes: currentVariant === "bounds" ? 4097 : 4096,
            },
            resultPolicy: "all-required-checks-pass-v1",
        },
        {
            workspaceRoot: workspaceRoot!,
            ceilings: hostCeilings,
            fileSystem: environment,
            context,
        },
    );
    const subjectDigest = currentVariant === "revision" ? REVISION_B : REVISION_A;
    const subjectRevision: WorkspaceRevision = {
        workspaceId: "verification-fixture-workspace",
        digest: subjectDigest,
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };

    return {
        verificationId,
        workspaceId: subjectRevision.workspaceId,
        subjectRevision,
        manifest,
        runner: {
            id: "verification-fixture-runner",
            version: currentVariant === "runner" ? "2" : "1",
        },
    };
}

const shell: Pick<Shell, "exec"> = {
    async exec(command, options, shellContext) {
        if (mode === "stop-start") {
            durableAppend(markerPath!, "check-one\n");
            signalCommandStarted();
            writeSync(1, "COMMAND-STARTED\n");

            return await new Promise((resolve) => {
                const signal = shellContext.abortSignal;

                if (signal?.aborted) {
                    durableAppend(markerPath!, "cleanup:complete\n");
                    writeSync(1, "CLEANUP:complete\n");
                    resolve({
                        ok: false,
                        error: new ExecutionError("aborted", "selected workflow stop"),
                    });

                    return;
                }

                signal?.addEventListener(
                    "abort",
                    () => {
                        durableAppend(markerPath!, "cleanup:complete\n");
                        writeSync(1, "CLEANUP:complete\n");
                        resolve({
                            ok: false,
                            error: new ExecutionError("aborted", "selected workflow stop"),
                        });
                    },
                    { once: true },
                );
            });
        }

        if (mode === "start" && boundary === "before-spawn") {
            controlledBoundary("before-spawn");
        }

        const checkId = command.endsWith("check-two") ? "check-two" : "check-one";

        durableAppend(markerPath!, `${checkId}\n`);
        options?.onOutput?.(`evidence:${checkId}`, shellContext);

        if (mode === "start" && boundary === "after-effect") {
            durableAppend(safetyPath!, "unknown\n");
            controlledBoundary("after-effect");
        }

        if (scenario === "drift") {
            currentRevision = REVISION_B;
        }

        return { ok: true, value: { exitCode: 0 } };
    },
};

const workspace = {
    async snapshot(): Promise<WorkspaceRevision> {
        snapshotCalls += 1;

        if (scenario === "snapshot-failure" && snapshotCalls > checkCount) {
            throw new Error("fixture cannot prove the final subject revision");
        }

        return {
            workspaceId: "verification-fixture-workspace",
            digest: currentRevision,
            algorithm: "sha256",
            coverage: "git-head-index-worktree-v1",
        };
    },
};
const safety = {
    async assertQuiescent(request: {
        readonly phase: "admission" | "promotion";
        readonly priorAssuranceId?: string;
    }) {
        if (scenario === "promotion-unknown" && request.phase === "promotion") {
            return { state: "unknown" as const };
        }

        if (request.phase === "admission") {
            admissionCalls += 1;

            if (mode === "start" && boundary === "before-first-admission" && admissionCalls === 1) {
                controlledBoundary("before-first-admission");
            }

            if (mode === "start" && boundary === "between-checks" && admissionCalls === 2) {
                controlledBoundary("between-checks");
            }
        }

        const state = await safetyState();

        if (state !== "quiescent") {
            return { state: "unknown" as const };
        }

        return {
            state: "quiescent" as const,
            assuranceId: request.priorAssuranceId ?? "fixture-safety-assurance-v1",
        };
    },
};

const adapters = {
    workspace,
    safety,
    shell,
    context,
    async environmentForPolicy() {
        return {};
    },
};

const workflow = defineWorkflow({
    id: "workflow-verification-crash-fixture",
    version: 1,
    async run(workflowContext: WorkflowContext<JsonValue>) {
        const input =
            workflowContext.input !== null &&
            typeof workflowContext.input === "object" &&
            !Array.isArray(workflowContext.input)
                ? (workflowContext.input as { readonly testCase?: string })
                : {};
        const currentVariant = mode === "recover-changes" ? (input.testCase ?? "base") : variant;
        const request = await createRequest(currentVariant);
        let result: VerificationResult;

        try {
            result = await verify(workflowContext, request, adapters);
        } catch (error) {
            if (
                mode === "recover-changes" &&
                input.testCase !== undefined &&
                error instanceof Error &&
                error.name === "VerificationRequestConflict"
            ) {
                writeSync(1, `CONFLICT:${input.testCase}\n`);

                return null;
            }

            throw error;
        }

        if (mode === "start-changes" && input.testCase !== undefined) {
            writeSync(1, `AGGREGATE:${input.testCase}:${JSON.stringify(result)}\n`);
            aggregateResolvers.get(input.testCase)?.();

            await new Promise(() => {});
        }

        if (mode === "start" && boundary === "after-aggregate") {
            writeSync(1, `AGGREGATE:${JSON.stringify(result)}\n`);
            controlledBoundary("after-aggregate");
        }

        writeSync(1, `RESULT:${JSON.stringify(result)}\n`);

        return result as unknown as JsonValue;
    },
});

engine.register(workflow);
await engine.open(context);

if (mode === "start-changes") {
    for (const requestVariant of REQUEST_VARIANTS) {
        await engine.start(
            workflow,
            { testCase: requestVariant },
            { runId: `${runId}:${requestVariant}` },
            context,
        );
        await aggregatePromises.get(requestVariant)!;
    }

    writeSync(1, `ALL-AGGREGATES:${JSON.stringify(REQUEST_VARIANTS)}\n`);
    setInterval(() => {}, 60_000);
    await new Promise(() => {});
} else if (mode === "start") {
    await engine.start(workflow, null, { runId }, context);
    await new Promise(() => {});
} else if (mode === "stop-start") {
    await engine.start(workflow, null, { runId }, context);
    await commandStarted;
    await engine.stop(runId, "operator selected stop", context);
    writeSync(1, `STOP-SELECTED:${JSON.stringify(await engine.inspect(runId, context))}\n`);
    controlledBoundary("stop-selected");
} else if (mode === "run" || mode === "fresh-id") {
    await engine.start(workflow, null, { runId }, context);

    try {
        const durableResult = await engine.wait(runId, context);

        writeSync(1, `WAIT-RESULT:${JSON.stringify(durableResult)}\n`);
    } catch (error) {
        writeSync(
            1,
            `WORKFLOW-ERROR:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}\n`,
        );
    }
} else if (mode === "recover-changes") {
    for (const requestVariant of REQUEST_VARIANTS) {
        await engine.wait(`${runId}:${requestVariant}`, context);
    }

    writeSync(1, `CONFLICTS:${JSON.stringify(REQUEST_VARIANTS)}\n`);
} else {
    try {
        await engine.wait(runId, context);
    } catch (error) {
        writeSync(
            1,
            `WORKFLOW-ERROR:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}\n`,
        );
    }

    writeSync(1, `INSPECT:${JSON.stringify(await engine.inspect(runId, context))}\n`);
}

await engine.close();
await harness.close(context);
