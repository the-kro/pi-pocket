import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { canRecoverDefinitelyNotSubmittedTurn } from "../packages/workflow-runtime/agents/recovery.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const crashWorker = join(projectRoot, "test/fixtures/workflow-agent-crash-worker.ts");
const reviewCrashWorkerSource = String.raw`
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const root = process.cwd();
const mode = process.env.PI_REVIEW_MODE;
const database = process.env.PI_REVIEW_DB;
const markers = process.env.PI_REVIEW_MARKERS;
const scenario = process.env.PI_REVIEW_RECOVERY_SCENARIO ?? "single-review";
const context = BACKGROUND_CONTEXT;
const runId = "review-recovery-run";
const threadId = "review-recovery-thread";
const profileId = "review-recovery-profile";

function markDispatch(dispatch) {
    const descriptor = openSync(markers, "a");

    try {
        writeSync(descriptor, "provider-dispatch\n");
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }

    writeSync(1, "REVIEW-DISPATCHED-" + dispatch + "\n");
}

const { AGENT_THREAD_DOC, createWorkflowAgentRuntime, workflowAgentThreadKey } = await import(
    pathToFileURL(join(root, "packages/workflow-runtime/index.ts")).href
);
const { defineWorkflow } = await import(
    pathToFileURL(join(root, "packages/workflow-runtime/core/index.ts")).href
);
const faux = fauxProvider();
const models = createModels();
const baseProvider = faux.provider;
const api = "faux-review-recovery-v1";
let providerDispatchCount = 0;
const provider = {
    ...baseProvider,
    api,
    getModels: (...args) => baseProvider.getModels(...args).map((model) => ({ ...model, api })),
    streamSimple: (...args) => {
        providerDispatchCount += 1;
        markDispatch(providerDispatchCount);

        if (
            mode === "start" &&
            (scenario !== "tampered-first-review" || providerDispatchCount === 2)
        ) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }

        return baseProvider.streamSimple(...args);
    },
};

models.setProvider(provider);
faux.setResponses(
    scenario === "tampered-first-review" && mode === "start"
        ? [
              fauxAssistantMessage("first Review result"),
              fauxAssistantMessage("recovered Review continuation"),
          ]
        : [fauxAssistantMessage("recovered Review result")],
);
const model = models.getModel("faux", "faux-1");
const profile = {
    id: profileId,
    version: 1,
    instructions: "Review the persisted evidence.",
    instructionsVersion: "review-recovery-v1",
    model: { provider: "faux", modelId: "faux-1", api: model.api, providerVersion: "review-v1" },
};
const registry = createRegistry();
const runtime = createWorkflowAgentRuntime({
    harnessOptions: { models, registry },
    agentConfig: {
        profiles: [profile],
        review: {
            profileAllowlist: [profileId],
            authority: { extensions: [], sections: [], tools: [], capabilities: [] },
        },
    },
});
registry.install(runtime.extension);
const workflow = defineWorkflow({
    id: "review-recovery-workflow",
    version: 1,
    async run({ agent }) {
        const resolved = await agent.resolveProfile(profileId);
        const firstTurn = {
            threadId,
            turnId: "review-first-turn",
            profile: profileId,
            content: "Review the evidence.",
            purpose: "review",
            reviewerIdentity: resolved.identity,
            freshThread: true,
        };

        if (scenario === "tampered-first-review") {
            await agent.turn(firstTurn);

            return agent.turn({
                ...firstTurn,
                turnId: "review-second-turn",
                content: "Continue reviewing the evidence.",
                freshThread: false,
            });
        }

        return agent.turn(firstTurn);
    },
});
runtime.register(workflow);
const storage = await openNodeSqliteStorage(database);

if (mode === "tamper") {
    const harness = await Harness.open(storage, { models, registry }, context);
    const key = workflowAgentThreadKey({ runId, threadId, profileId });

    await harness.commit(async (tx) => {
        const current = await tx.doc(AGENT_THREAD_DOC, key, key);
        const firstTurn = current.turns?.[0];

        if (firstTurn?.turnId !== "review-first-turn") {
            throw new Error("Cannot tamper a missing persisted first Review turn");
        }

        Reflect.deleteProperty(firstTurn, "purpose");
        Reflect.deleteProperty(firstTurn, "reviewerIdentity");
        Reflect.deleteProperty(firstTurn, "freshThread");
    }, context);

    await harness.close(context);
    writeSync(1, "TAMPERED:first-review-turn\\n");
} else {
    const host = await runtime.openHost(storage, context, () => undefined);

    if (mode === "start") {
        await runtime.engine.start(workflow, null, { runId }, context);
        await new Promise(() => {});
    } else {
        let result;
        let failure;

        try {
            result = await runtime.engine.wait(runId, context);
        } catch (error) {
            failure = {
                name: error instanceof Error ? error.name : "UnknownError",
                message: error instanceof Error ? error.message : String(error),
            };
        }

        const thread = await host.harness.snapshot(
            AGENT_THREAD_DOC,
            workflowAgentThreadKey({ runId, threadId, profileId }),
            context,
        );

        writeSync(
            1,
            "FINAL:" + JSON.stringify({ result, failure, thread }) + String.fromCharCode(10),
        );
        await host.dispose();
        await runtime.close();
        await host.harness.close(context);
    }
}
`;

type Worker = { readonly child: ChildProcess; output: string; errors: string };

function startReviewWorker(
    mode: "start" | "recover" | "tamper",
    database: string,
    markers: string,
    scenario = "single-review",
): Worker {
    const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", reviewCrashWorkerSource],
        {
            cwd: projectRoot,
            env: {
                ...process.env,
                PI_REVIEW_MODE: mode,
                PI_REVIEW_DB: database,
                PI_REVIEW_MARKERS: markers,
                PI_REVIEW_RECOVERY_SCENARIO: scenario,
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    const worker: Worker = { child, output: "", errors: "" };

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
        worker.output += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
        worker.errors += chunk;
    });

    return worker;
}

function startWorker(
    mode:
        | "start"
        | "recover"
        | "tamper"
        | "tamper-content"
        | "tamper-native-entry"
        | "tamper-owner-id"
        | "tamper-workflow-task-id"
        | "abort-owner"
        | "terminal-runner"
        | "orphan-missing-provider"
        | "orphan-missing-thread-and-provider",
    database: string,
    markers: string,
    boundary = "none",
): Worker {
    const child = spawn(process.execPath, ["--experimental-strip-types", crashWorker], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_AGENT_MODE: mode,
            PI_AGENT_DB: database,
            PI_AGENT_MARKERS: markers,
            PI_AGENT_BOUNDARY: boundary,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const worker: Worker = { child, output: "", errors: "" };

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
        worker.output += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
        worker.errors += chunk;
    });

    return worker;
}

async function outputUntil(worker: Worker, marker: string): Promise<string> {
    if (worker.output.includes(marker)) {
        return worker.output;
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `Timed out waiting for ${marker}; stdout=${worker.output}; stderr=${worker.errors}`,
                ),
            );
        }, 15_000);
        const poll = setInterval(() => {
            if (worker.output.includes(marker)) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve(worker.output);
            }

            if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
                clearInterval(poll);
                clearTimeout(timer);
                reject(
                    new Error(
                        `Worker exited before ${marker}: code=${worker.child.exitCode}; signal=${worker.child.signalCode}; stdout=${worker.output}; stderr=${worker.errors}`,
                    ),
                );
            }
        }, 5);
    });
}

async function killWorker(worker: Worker): Promise<void> {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        return;
    }

    const exited = once(worker.child, "exit");

    worker.child.kill("SIGKILL");
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, "SIGKILL");
}

async function successfulExit(worker: Worker): Promise<void> {
    const [code, signal] = (await once(worker.child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
    ];

    assert.equal(signal, null, worker.errors);
    assert.equal(code, 0, worker.errors);
}

function payloadAfter(output: string, marker: string): Record<string, unknown> {
    const line = output.split("\n").find((candidate) => candidate.startsWith(marker));

    assert.ok(line, `Missing ${marker} in ${output}`);

    return JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
}

async function dispatchMarkers(path: string): Promise<string[]> {
    try {
        return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw error;
    }
}

test("only reserved turns are eligible for recovery without a native submission", () => {
    const common = {
        activeWorkflowOwner: true,
        exactTurn: true,
        submission: undefined,
    };

    assert.equal(canRecoverDefinitelyNotSubmittedTurn({ ...common, turnStatus: "reserved" }), true);
    assert.equal(
        canRecoverDefinitelyNotSubmittedTurn({ ...common, turnStatus: "not-completed" }),
        false,
    );
});

test("reopen replays an exact fresh Review first turn with its persisted identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-review-recovery-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startReviewWorker("start", database, markers);
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "REVIEW-DISPATCHED");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);

        recovery = startReviewWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const final = payloadAfter(output, "FINAL:") as {
            readonly result: { readonly content: { readonly text: string }[] };
            readonly thread: {
                readonly status: string;
                readonly turns: readonly {
                    readonly status: string;
                    readonly purpose?: string;
                    readonly freshThread?: boolean;
                    readonly reviewerIdentity?: { readonly fingerprint?: string };
                }[];
            };
        };
        const firstTurn = final.thread.turns[0];

        assert.equal(final.thread.status, "ready");
        assert.equal(final.thread.turns.length, 1);
        assert.equal(firstTurn?.status, "completed");
        assert.equal(firstTurn?.purpose, "review");
        assert.equal(firstTurn?.freshThread, true);
        assert.equal(typeof firstTurn?.reviewerIdentity?.fingerprint, "string");
        assert.equal(final.result.content[0]?.text, "recovered Review result");
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("recovery fences a Review continuation whose first turn lost freshness admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-review-freshness-recovery-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const scenario = "tampered-first-review";
    const first = startReviewWorker("start", database, markers, scenario);
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "REVIEW-DISPATCHED-2");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);

        tamper = startReviewWorker("tamper", database, markers, scenario);
        const tampered = await outputUntil(tamper, "TAMPERED:");

        await successfulExit(tamper);
        assert.match(tampered, /TAMPERED:first-review-turn/);

        recovery = startReviewWorker("recover", database, markers, scenario);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const final = payloadAfter(output, "FINAL:") as {
            readonly failure?: { readonly message: string };
            readonly thread: {
                readonly status: string;
                readonly turns: readonly {
                    readonly status: string;
                    readonly purpose?: string;
                    readonly freshThread?: boolean;
                }[];
            };
        };

        assert.ok(final.failure);
        assert.equal(final.thread.status, "unknown");
        assert.equal(final.thread.turns[0]?.purpose, undefined);
        assert.equal(final.thread.turns[1]?.purpose, "review");
        assert.equal(final.thread.turns[1]?.freshThread, false);
        assert.equal(final.thread.turns[1]?.status, "unknown");
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen replays workflow intent when killed before atomic agent intent commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-no-intent-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "before-intent-commit");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:before-intent-commit");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string; result?: { content?: { text?: string }[] } }[];
        };

        assert.equal(preopen, null);
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.deepEqual(thread.turns[0]?.result?.content, [
            { type: "text", text: "saved before runner receipt" },
        ]);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen replays the exact committed native answer before adapter receipts without redispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-answer-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "answer-committed");
    let recovery: Worker | undefined;

    try {
        const crashed = await outputUntil(first, "BOUNDARY:answer-committed:");
        const boundary = payloadAfter(crashed, "BOUNDARY:answer-committed:");

        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: {
                status: string;
                submissionId?: number;
                answerEntryId?: number;
                result?: { role?: string; content?: { text?: string }[] };
            }[];
        };
        const turn = thread.turns[0]!;

        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(turn.status, "completed");
        assert.equal(turn.submissionId, boundary.submissionId);
        assert.equal(turn.answerEntryId, boundary.answerEntryId);
        assert.equal(turn.result?.role, "assistant");
        assert.deepEqual(turn.result?.content, [
            { type: "text", text: "saved before runner receipt" },
        ]);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen may dispatch an exact turn whose intent committed before any native submission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-intent-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "intent-committed");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:intent-committed");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string; result?: { content?: { text?: string }[] } }[];
        };

        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.deepEqual(thread.turns[0]?.result?.content, [
            { type: "text", text: "saved before runner receipt" },
        ]);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences a matching runner identity from an unsupported Task version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-version-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "intent-committed");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:intent-committed");
        await killWorker(first);

        tamper = startWorker("tamper", database, markers);
        await outputUntil(tamper, "TAMPERED:runner-version-2");
        await successfulExit(tamper);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as {
            version: number;
            abortRequested?: boolean;
            state: { status: string; outcome?: { status: string } };
        };

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.version, 2);
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "orphaned");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences task content that no longer matches the durable agent intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-content-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "intent-committed");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:intent-committed");
        await killWorker(first);

        tamper = startWorker("tamper-content", database, markers);
        await outputUntil(tamper, "TAMPERED:runner-content");
        await successfulExit(tamper);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences a placed native input that no longer matches the immutable turn intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-native-input-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "submission-committed");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:submission-committed:");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        tamper = startWorker("tamper-native-entry", database, markers);
        await outputUntil(tamper, "TAMPERED:native-entry");
        await successfulExit(tamper);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences a persisted submission reference that points elsewhere", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-submission-reference-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "submission-committed");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:submission-committed:");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers, "tamper-turn-submission-id");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);
        assert.match(output, /SETUP:TAMPERED:turn-submission-id:0/);
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences a not-completed turn instead of retrying its logical turn ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-not-completed-turn-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "turn-not-completed-classified");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:turn-not-completed-classified");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const beforeRecovery = payloadAfter(output, "PRE-RECOVERY:") as {
            threadStatus: string;
            turnStatus: string;
            runnerStatus: string;
            runnerAbortRequested: boolean;
            ownerStatus: string;
            ownerAbortRequested: boolean;
            ownerTaskId: number;
            ownerConversationId: number;
            ownerRunId: string;
            runStatus: string;
            runTaskId: number;
            runHasStopCommand: boolean;
            runHasSelectedOutcome: boolean;
            threadProviderSessionId: string;
            providerSessionId: string;
            nativeConversationOwner: { taskId: number; conversationId: number };
        };
        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const runner = final.runner as {
            state: { status: string; outcome?: { status: string } };
        };

        assert.equal(beforeRecovery.threadStatus, "ready");
        assert.equal(beforeRecovery.turnStatus, "not-completed");
        assert.equal(beforeRecovery.runnerStatus, "pending");
        assert.equal(beforeRecovery.runnerAbortRequested, false);
        assert.equal(beforeRecovery.ownerStatus, "pending");
        assert.equal(beforeRecovery.ownerAbortRequested, false);
        assert.equal(beforeRecovery.ownerTaskId, beforeRecovery.runTaskId);
        assert.equal(beforeRecovery.ownerRunId, "agent-crash-run");
        assert.equal(beforeRecovery.runStatus, "running");
        assert.equal(beforeRecovery.runHasStopCommand, false);
        assert.equal(beforeRecovery.runHasSelectedOutcome, false);
        assert.equal(beforeRecovery.nativeConversationOwner?.taskId, beforeRecovery.ownerTaskId);
        assert.equal(
            beforeRecovery.nativeConversationOwner?.conversationId,
            beforeRecovery.ownerConversationId,
        );
        assert.equal(beforeRecovery.threadProviderSessionId, beforeRecovery.providerSessionId);
        assert.equal(preopen.status, "unknown");
        assert.equal(preopen.turns[0]?.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen rejects stale and duplicate raw AgentDoc selections before provider progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-raw-selection-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "agent-selection-malformed-committed");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:agent-selection-malformed-committed");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const beforeRecovery = payloadAfter(output, "PRE-RECOVERY:") as {
            agentExtensions: string[];
            agentTools: string[];
        };
        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const runner = final.runner as {
            state: { status: string; outcome?: { status: string } };
        };

        assert.deepEqual(beforeRecovery.agentExtensions, [
            "crash-fixture-unsafe-effect",
            "missing-agent-extension",
            "crash-fixture-unsafe-effect",
        ]);
        assert.deepEqual(beforeRecovery.agentTools, [
            "unsafe_effect",
            "missing-agent-tool",
            "unsafe_effect",
        ]);
        assert.equal(preopen.status, "unknown");
        assert.equal(preopen.turns[0]?.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences malformed selections with an active safe ToolTask before native Agent resolution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-raw-selection-safe-tool-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const toolMarkers = `${markers}.tools`;
    const boundary = "agent-selection-malformed-safe-tool";
    const first = startWorker("start", database, markers, boundary);
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, `BOUNDARY:${boundary}`);
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        recovery = startWorker("recover", database, markers, boundary);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { turnId: string; status: string }[];
        };
        const runner = final.runner as {
            state: { status: string; outcome?: { status: string } };
        };
        const nativeTasks = final.nativeTasks as {
            kind: string;
            status: string;
            outcome?: string;
        }[];

        assert.equal(final.nativeAgentResolutionAttempted, false);
        assert.ok(preopen.turns.some((turn) => turn.turnId === "crash-turn"));
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns.find((turn) => turn.turnId === "crash-turn")?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.ok(
            nativeTasks.some(
                (task) =>
                    task.kind === "pi.tool" &&
                    task.status === "terminal" &&
                    task.outcome === "aborted",
            ),
            JSON.stringify(nativeTasks),
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences a numeric-string submission reference before provider progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-string-submission-reference-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "mapping-committed");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:mapping-committed");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers, "tamper-turn-submission-id-string");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);
        assert.match(output, /SETUP:TAMPERED:turn-submission-id-string:[0-9]+/);
        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { status: string }[];
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "unknown");
        assert.equal(preopen.turns[0]?.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), []);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences orphan native work when its ProviderDoc mapping is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-orphan-provider-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        tamper = startWorker("orphan-missing-provider", database, markers);
        const tampered = await outputUntil(tamper, "ORPHANED:");

        await successfulExit(tamper);
        assert.match(tampered, /provider-mapping-missing-runner-terminal/);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const nativeTasks = final.nativeTasks as {
            kind: string;
            status: string;
            outcome?: string;
        }[];

        assert.equal(
            thread.status,
            "unknown",
            JSON.stringify({ thread, nativeTasks, markers: await dispatchMarkers(markers) }),
        );
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.ok(
            nativeTasks.some(
                (task) =>
                    task.kind === "pi.generation" &&
                    task.status === "terminal" &&
                    task.outcome === "aborted",
            ),
        );
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen aborts orphan native work correlated only by terminal runner conversation ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-orphan-both-missing-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        tamper = startWorker("orphan-missing-thread-and-provider", database, markers);
        const tampered = await outputUntil(tamper, "ORPHANED:");

        await successfulExit(tamper);
        const orphaned = payloadAfter(tampered, "ORPHANED:") as {
            reason: string;
            conversationId: number;
            runnerTaskId: number;
            threadStillCurrent: boolean;
        };

        assert.equal(orphaned.reason, "thread-and-provider-mapping-missing-runner-terminal");
        assert.equal(orphaned.threadStillCurrent, false);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const final = payloadAfter(output, "FINAL:");
        const runner = final.runner as {
            id: number;
            state: { status: string; outcome?: { status: string } };
        };
        const nativeTasks = final.nativeTasks as {
            id: number;
            conversationId: number;
            kind: string;
            status: string;
            outcome?: string;
        }[];
        const replacementThread = final.thread as { conversationId: number } | undefined;

        assert.equal(runner.id, orphaned.runnerTaskId);
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.notEqual(replacementThread?.conversationId, orphaned.conversationId);
        assert.ok(
            nativeTasks.some(
                (task) =>
                    task.conversationId === orphaned.conversationId &&
                    task.kind === "pi.generation" &&
                    task.status === "terminal" &&
                    task.outcome === "aborted",
            ),
            JSON.stringify({ nativeTasks, markers: await dispatchMarkers(markers) }),
        );
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen recreates the private section view before resuming native work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-section-view-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "section-view-submission-committed");
    let recovery: Worker | undefined;

    try {
        const submitted = await outputUntil(first, "BOUNDARY:submission-committed:");
        const submissionBoundary = payloadAfter(submitted, "BOUNDARY:submission-committed:");

        await killWorker(first);
        assert.equal(submissionBoundary.status, "placed");
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers, "section-view-submission-committed");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const preopenAuthorityInput = preopen.authorityInput as {
            readonly selectionViews: readonly {
                readonly sourceName: string;
                readonly selectedName: string;
                readonly sections: readonly string[];
            }[];
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };

        assert.deepEqual(preopenAuthorityInput.selectionViews[0]?.sections, [
            "crash-section-alpha",
        ]);
        assert.match(
            preopenAuthorityInput.selectionViews[0]?.selectedName ?? "",
            /^pocket\.workflow-runtime\.agent-section-view:/,
        );
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes a committed placement at the exact initial generation prepare", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-submission-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "submission-committed");
    let recovery: Worker | undefined;

    try {
        const submitted = await outputUntil(first, "BOUNDARY:submission-committed:");
        const submissionBoundary = payloadAfter(submitted, "BOUNDARY:submission-committed:");

        await killWorker(first);
        assert.equal(submissionBoundary.status, "placed");
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativeTasks = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            readonly kind: string;
            readonly version: number;
            readonly status: string;
            readonly checkpoint: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.deepEqual(
            nativeTasks.map(({ kind, version, status, checkpoint }) => ({
                kind,
                version,
                status,
                checkpoint,
            })),
            [
                {
                    kind: "pi.generation",
                    version: 1,
                    status: "pending",
                    checkpoint: { phase: "prepare", attempt: 1 },
                },
            ],
        );
        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes a mapped submission at the exact initial generation prepare", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-mapping-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "mapping-committed");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:mapping-committed");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), []);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativeTasks = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            readonly kind: string;
            readonly version: number;
            readonly status: string;
            readonly checkpoint: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.deepEqual(
            nativeTasks.map(({ kind, version, status, checkpoint }) => ({
                kind,
                version,
                status,
                checkpoint,
            })),
            [
                {
                    kind: "pi.generation",
                    version: 1,
                    status: "pending",
                    checkpoint: { phase: "prepare", attempt: 1 },
                },
            ],
        );
        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences runner ownership that no longer matches its workflow thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-owner-mismatch-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        tamper = startWorker("tamper-owner-id", database, markers);
        await outputUntil(tamper, "TAMPERED:runner-owner");
        await successfulExit(tamper);

        recovery = startWorker("recover", database, markers, "recovery-preopen");
        const output = await outputUntil(recovery, "BOUNDARY:recovery-preopen");
        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { status: string }[];
        };

        assert.equal(preopen.status, "unknown");
        assert.equal(preopen.turns[0]?.status, "unknown");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences a runner with a mismatched workflowTaskId", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-workflow-task-id-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let tamper: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        tamper = startWorker("tamper-workflow-task-id", database, markers);
        await outputUntil(tamper, "TAMPERED:workflow-task-id");
        await successfulExit(tamper);

        recovery = startWorker("recover", database, markers, "recovery-preopen");
        const output = await outputUntil(recovery, "BOUNDARY:recovery-preopen");
        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            turns: { status: string }[];
        };

        assert.equal(preopen.status, "unknown");
        assert.equal(preopen.turns[0]?.status, "unknown");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (tamper !== undefined && tamper.child.exitCode === null) {
            await killWorker(tamper);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences adapter-owned native work when its runner is no longer active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-orphan-native-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let orphanRunner: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        orphanRunner = startWorker("terminal-runner", database, markers);
        await outputUntil(orphanRunner, "TERMINAL:runner");
        await successfulExit(orphanRunner);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as { status: string; turns: { status: string }[] };
        const nativeTasks = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.ok(nativeTasks.every((task) => task.status === "terminal"));
        assert.ok(nativeTasks.some((task) => task.outcome === "aborted"));
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (orphanRunner !== undefined && orphanRunner.child.exitCode === null) {
            await killWorker(orphanRunner);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen lets Pi Durable reissue an uncertain provider dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-unknown-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen rechecks stop selected during timer scanning before Harness resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-timer-open-race-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "timer-open-race");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:timer-open-race");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        recovery = startWorker("recover", database, markers, "timer-open-race");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeTasks = final.nativeTasks as { kind: string; outcome: string | null }[];

        assert.ok(output.includes("STOP-SELECTED-DURING-TIMER-SCAN"));
        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "closed");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.ok(
            nativeTasks.some((task) => task.kind === "pi.generation" && task.outcome === "aborted"),
            JSON.stringify(nativeTasks),
        );
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen rechecks stop selection committed between attach and open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-open-abort-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        recovery = startWorker("recover", database, markers, "stop-before-open");
        const beforeOpen = await outputUntil(recovery, "STOP-SELECTED-BETWEEN-ATTACH-OPEN:");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.ok(beforeOpen.includes('"status":"closed"'));
        assert.equal(preopen.status, "closed");
        assert.equal(thread.status, "closed");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen does not resume provider work after its workflow owner is abort-requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-owner-abort-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "provider-dispatched");
    let ownerAbort: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        ownerAbort = startWorker("abort-owner", database, markers);
        await outputUntil(ownerAbort, "OWNER-ABORTED:");
        await successfulExit(ownerAbort);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (ownerAbort !== undefined && ownerAbort.child.exitCode === null) {
            await killWorker(ownerAbort);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences provider progress after an effectful tool Task fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-tool-failed-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const toolMarkers = `${markers}.tools`;
    const first = startWorker("start", database, markers, "tool-effect-then-fail");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:tool-effect-then-fail");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        recovery = startWorker("recover", database, markers, "tool-effect-then-fail");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativePreopen = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            id: number;
            owner?: number;
            conversationId: number;
            kind: string;
            status: string;
            outcome?: { status: string };
            checkpoint?: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:") as {
            status: string;
            conversationId: number;
        };
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeTasks = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        const generation = nativePreopen.find((task) => task.kind === "pi.generation");
        const failedTool = nativePreopen.find((task) => task.kind === "pi.tool");

        assert.ok(generation, JSON.stringify(nativePreopen));
        assert.ok(failedTool, JSON.stringify(nativePreopen));
        assert.equal(generation.checkpoint?.phase, "tools");
        assert.deepEqual(generation.checkpoint?.tools, [failedTool.id]);
        assert.equal(failedTool.status, "terminal");
        assert.equal(failedTool.outcome?.status, "failed");
        assert.equal(failedTool.owner, generation.id);
        assert.equal(failedTool.conversationId, preopen.conversationId);
        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[1]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.ok(
            nativeTasks.some((task) => task.kind === "pi.tool" && task.outcome === "failed"),
            JSON.stringify(nativeTasks),
        );
        assert.ok(
            nativeTasks.some((task) => task.kind === "pi.generation" && task.outcome === "aborted"),
            JSON.stringify(nativeTasks),
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen fences an unsafe native tool execution before replaying its side effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-tool-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const toolMarkers = `${markers}.tools`;
    const first = startWorker("start", database, markers, "tool-dispatched");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:tool-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        recovery = startWorker("recover", database, markers, "tool-dispatched");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativeTasks = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            readonly kind: string;
            readonly status: string;
            readonly checkpoint: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeSettlements = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        assert.ok(
            nativeTasks.some(
                (task) =>
                    task.kind === "pi.tool" &&
                    task.checkpoint.phase === "execute" &&
                    task.checkpoint.replay === "unsafe",
            ),
            JSON.stringify(nativeTasks),
        );
        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(thread.turns[1]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.ok(
            nativeSettlements.every((task) => task.status === "terminal"),
            JSON.stringify(nativeSettlements),
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes provider prepare after a completed tool round without replaying its tool effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-tool-prepare-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const toolMarkers = `${markers}.tools`;
    const first = startWorker("start", database, markers, "tool-round-prepare");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:tool-round-prepare");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        recovery = startWorker("recover", database, markers, "tool-round-prepare");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativeTasks = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            readonly kind: string;
            readonly status: string;
            readonly checkpoint: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeSettlements = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        assert.ok(
            nativeTasks.some(
                (task) =>
                    task.kind === "pi.generation" &&
                    task.checkpoint.phase === "prepare" &&
                    task.checkpoint.attempt === 1,
            ),
            JSON.stringify(nativeTasks),
        );
        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(thread.turns[1]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.ok(nativeSettlements.every((task) => task.status === "terminal"));
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes a later provider round after a completed native tool effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-tool-round-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const toolMarkers = `${markers}.tools`;
    const first = startWorker("start", database, markers, "later-provider-after-tool");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:later-provider-after-tool");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        recovery = startWorker("recover", database, markers, "later-provider-after-tool");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeSettlements = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(thread.turns[1]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.ok(nativeSettlements.every((task) => task.status === "terminal"));
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes an in-flight compaction summary with its generation descendant", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-compaction-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "compaction-dispatched");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:compaction-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);

        recovery = startWorker("recover", database, markers, "compaction-dispatched");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativeTasks = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            readonly kind: string;
            readonly status: string;
            readonly checkpoint: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeSettlements = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        assert.ok(
            nativeTasks.some((task) => task.kind === "pi.compaction"),
            JSON.stringify(nativeTasks),
        );
        assert.ok(
            nativeTasks.some(
                (task) => task.kind === "pi.generation" && task.checkpoint.phase === "prepare",
            ),
            JSON.stringify(nativeTasks),
        );
        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(thread.turns[1]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.ok(nativeSettlements.every((task) => task.status === "terminal"));
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen may reissue a deferred poll dispatched before a crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-poll-dispatch-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const pollMarkers = `${markers}.polls`;
    const first = startWorker("start", database, markers, "deferred-poll-dispatched");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:deferred-poll-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
        assert.deepEqual(await dispatchMarkers(pollMarkers), ["faux-deferred-poll"]);

        recovery = startWorker("recover", database, markers, "deferred-poll-dispatched");
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeTasks = final.nativeTasks as { status: string }[];

        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.ok(nativeTasks.every((task) => task.status === "terminal"));
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
        assert.deepEqual(await dispatchMarkers(pollMarkers), [
            "faux-deferred-poll",
            "faux-deferred-poll",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes deferred generation polling through native Models", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-poll-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "generation-poll");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:generation-poll");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const nativeTasks = payloadAfter(output, "NATIVE-PREATTACH:") as unknown as {
            readonly kind: string;
            readonly status: string;
            readonly checkpoint: Record<string, unknown>;
        }[];
        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeSettlements = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];

        assert.deepEqual(
            nativeTasks.map(({ kind, status, checkpoint }) => ({
                kind,
                status,
                phase: checkpoint.phase,
                attempt: checkpoint.attempt,
                model: checkpoint.model,
            })),
            [
                {
                    kind: "pi.generation",
                    status: "pending",
                    phase: "poll",
                    attempt: 1,
                    model: {
                        provider: "faux",
                        modelId: "faux-1",
                    },
                },
            ],
        );
        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.ok(nativeSettlements.every((task) => task.status === "terminal"));
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);
        assert.deepEqual(await dispatchMarkers(`${markers}.polls`), ["faux-deferred-poll"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen resumes a later provider round while preserving a prior settled native turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-later-round-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "later-provider-dispatched");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:later-provider-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };
        const nativeTasks = final.nativeTasks as {
            kind: string;
            status: string;
            outcome: string | null;
        }[];
        const generations = nativeTasks.filter((task) => task.kind === "pi.generation");

        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(thread.turns[1]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.ok(generations.every((task) => task.status === "terminal"));
        assert.ok(nativeTasks.every((task) => task.status === "terminal"));
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen lets native recovery classify a provider response after a crash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-response-crash-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("start", database, markers, "response-before-classify");
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:response-before-classify");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["faux-provider-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "ready");
        assert.equal(thread.status, "ready");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "completed");
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("reopen reapplies an unknown fence committed before abort after another kill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-agent-repeat-fence-"));
    const database = join(directory, "agent.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const toolMarkers = `${markers}.tools`;
    const first = startWorker("start", database, markers, "tool-dispatched");
    let fenced: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        await outputUntil(first, "BOUNDARY:tool-dispatched");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        fenced = startWorker("recover", database, markers, "unknown-fence-committed");
        const fenceOutput = await outputUntil(fenced, "BOUNDARY:unknown-fence-committed");

        assert.doesNotMatch(fenceOutput, /RECOVERY:native-abort-requested:/);
        await killWorker(fenced);
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const output = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const preopen = payloadAfter(output, "PREOPEN:");
        const final = payloadAfter(output, "FINAL:");
        const thread = final.thread as {
            status: string;
            turns: { status: string }[];
        };
        const runner = final.runner as { state: { status: string; outcome?: { status: string } } };

        assert.equal(preopen.status, "unknown");
        assert.equal(thread.status, "unknown");
        assert.equal(thread.turns[0]?.status, "completed");
        assert.equal(thread.turns[1]?.status, "unknown");
        assert.equal(runner.state.status, "terminal");
        assert.equal(runner.state.outcome?.status, "aborted");
        assert.deepEqual(await dispatchMarkers(markers), [
            "faux-provider-dispatch",
            "faux-provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(toolMarkers), ["faux-tool-dispatch"]);
    } finally {
        await killWorker(first);

        if (fenced !== undefined && fenced.child.exitCode === null) {
            await killWorker(fenced);
        }

        if (recovery !== undefined && recovery.child.exitCode === null) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});
