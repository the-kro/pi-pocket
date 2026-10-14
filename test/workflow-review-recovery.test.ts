import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const crashWorker = join(projectRoot, "test/fixtures/workflow-review-crash-worker.ts");

type Worker = { readonly child: ChildProcess; output: string; errors: string };
type WorkerMode =
    | "blocked-wait"
    | "stop-during-review"
    | "recover-stopped"
    | "pause-after-review-receipt"
    | "pause-after-provider-dispatch"
    | "pause-before-review-binding"
    | "pause-before-native-dispatch"
    | "pause-after-native-result"
    | "pause-after-second-native-result"
    | "pause-before-read-tool"
    | "recover";
type WorkerOptions = {
    readonly scenario?:
        | "single-review"
        | "stale-revision"
        | "repair-continuation"
        | "blocked-wait"
        | "cross-gate-owner"
        | "read-tool-recovery";
    readonly workspace?: string;
    readonly effects?: string;
};

type ReviewResultRecord = {
    readonly decision: {
        readonly verdict: string;
        readonly summary: string;
        readonly reason?: string;
    };
    readonly gateId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly requestDigest: string;
    readonly verificationId: string;
    readonly subjectRevision: string;
};

function startWorker(
    mode: WorkerMode,
    database: string,
    markers: string,
    options: WorkerOptions = {},
): Worker {
    const child = spawn(process.execPath, ["--experimental-strip-types", crashWorker], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_REVIEW_RECOVERY_MODE: mode,
            PI_REVIEW_RECOVERY_DB: database,
            PI_REVIEW_RECOVERY_MARKERS: markers,
            PI_REVIEW_RECOVERY_SCENARIO: options.scenario ?? "single-review",
            ...(options.workspace === undefined
                ? {}
                : { PI_REVIEW_RECOVERY_WORKSPACE: options.workspace }),
            ...(options.effects === undefined
                ? {}
                : { PI_REVIEW_RECOVERY_EFFECTS: options.effects }),
        },
        stdio: ["pipe", "pipe", "pipe"],
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
        }, 20_000);
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

function recordAfter<T>(output: string, marker: string): T {
    const start = output.indexOf(marker);

    assert.notEqual(start, -1, `Expected output marker ${marker}`);

    const line = output.slice(start + marker.length).split("\n", 1)[0] ?? "";

    return JSON.parse(line) as T;
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
    worker.child.stdin?.end();

    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        assert.equal(worker.child.exitCode, 0, worker.errors);
        assert.equal(worker.child.signalCode, null, worker.errors);

        return;
    }

    const [code, signal] = (await once(worker.child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
    ];

    assert.equal(signal, null, worker.errors);
    assert.equal(code, 0, worker.errors);
}

async function dispatchMarkers(path: string): Promise<string[]> {
    try {
        return (await readFile(path, "utf8")).split("\n").filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw error;
    }
}

async function assertColdRecoveryFromBoundary(
    mode:
        | "pause-before-review-binding"
        | "pause-before-native-dispatch"
        | "pause-after-native-result",
    boundary: string,
    expectedBefore: string[] = [],
    expectedAfter: string[] = ["provider-dispatch"],
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-recovery-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker(mode, database, markers);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, boundary);

        assert.ok(firstOutput.includes(boundary));
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), expectedBefore);

        recovery = startWorker("recover", database, markers);
        const recoveredOutput = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const recovered = recordAfter<ReviewResultRecord>(recoveredOutput, "FINAL:");

        assert.equal(recovered.decision.verdict, "APPROVED");
        assert.equal(recovered.gateId, "review-gate-cold-recovery");
        assert.equal(recovered.turnId, "review-turn-cold-recovery");
        assert.deepEqual(await dispatchMarkers(markers), expectedAfter);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
}

test("cold reopen starts Review after death before its gate binding", async () => {
    await assertColdRecoveryFromBoundary("pause-before-review-binding", "BEFORE-REVIEW-BINDING:");
});

test("cold reopen completes Review after death before native dispatch", async () => {
    await assertColdRecoveryFromBoundary("pause-before-native-dispatch", "BEFORE-NATIVE-DISPATCH:");
});

test("cold reopen replays a completed native result before the Review receipt", async () => {
    await assertColdRecoveryFromBoundary(
        "pause-after-native-result",
        "NATIVE-TURN-RESULT:",
        ["provider-dispatch"],
        ["provider-dispatch"],
    );
});

test("cold reopen enforces durable reviewer thread ownership across gates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-thread-owner-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const effects = join(directory, "workflow-effects.log");

    await writeFile(effects, "");

    const options = { scenario: "cross-gate-owner" as const, effects };
    const first = startWorker("pause-after-native-result", database, markers, options);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, "NATIVE-TURN-RESULT:");

        assert.ok(firstOutput.includes("NATIVE-TURN-RESULT:"));
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);

        recovery = startWorker("recover", database, markers, options);
        const conflictOutput = await outputUntil(recovery, "CROSS-GATE-REJECTED:");

        await successfulExit(recovery);

        const rejection = recordAfter<{ readonly message: string }>(
            conflictOutput,
            "CROSS-GATE-REJECTED:",
        );

        assert.match(rejection.message, /already reserved for a different Review gate/i);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("cold reopen safely replays an audited Review read tool under its authority guard", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-read-tool-recovery-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const effects = join(directory, "workflow-effects.log");

    await writeFile(effects, "");

    const options = { scenario: "read-tool-recovery" as const, effects };
    const first = startWorker("pause-before-read-tool", database, markers, options);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, "SAFE-READ-EXECUTING:");

        assert.ok(firstOutput.includes("SAFE-READ-EXECUTING:"));
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
        assert.deepEqual(await dispatchMarkers(effects), ["verification-a", "read-execute"]);

        recovery = startWorker("recover", database, markers, options);
        const recoveredOutput = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const recovered = recordAfter<{
            readonly result: ReviewResultRecord;
            readonly thread: {
                readonly turns: readonly {
                    readonly turnId: string;
                    readonly status: string;
                    readonly effectiveAuthority?: {
                        readonly delegation?: boolean;
                        readonly capabilities?: readonly string[];
                        readonly tools?: readonly { readonly name: string }[];
                    };
                }[];
            };
        }>(recoveredOutput, "FINAL:");

        assert.equal(recovered.result.decision.verdict, "APPROVED");
        assert.equal(
            recovered.result.decision.summary,
            "Revision A received an approval that must not cross a revision change.",
        );
        assert.equal(recovered.result.turnId, "review-turn-cold-recovery");
        assert.deepEqual(
            recovered.thread.turns.map((turn) => ({ turnId: turn.turnId, status: turn.status })),
            [{ turnId: "review-turn-cold-recovery", status: "completed" }],
        );
        assert.equal(recovered.thread.turns[0]?.effectiveAuthority?.delegation, false);
        assert.deepEqual(recovered.thread.turns[0]?.effectiveAuthority?.capabilities, [
            "filesystem.read",
        ]);
        assert.deepEqual(
            recovered.thread.turns[0]?.effectiveAuthority?.tools?.map((tool) => tool.name),
            ["read", "submit_workflow_review_decision"],
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
            "provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(effects), [
            "verification-a",
            "read-execute",
            "read-execute",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("cold recovery rejects revision A and requires fresh Verify and Review on revision B", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-revision-recovery-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const effects = join(directory, "workflow-effects.log");
    const workspace = join(directory, "workspace-revision.json");
    const revisionA = {
        workspaceId: "review-cold-recovery-workspace",
        digest: "a".repeat(64),
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };
    const revisionB = { ...revisionA, digest: "c".repeat(64) };
    const options = { scenario: "stale-revision" as const, workspace, effects };

    await writeFile(workspace, JSON.stringify(revisionA));

    const first = startWorker("pause-after-native-result", database, markers, options);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, "NATIVE-TURN-RESULT:");
        const nativeResult = recordAfter<{
            readonly verdict: string;
            readonly summary: string;
        }>(firstOutput, "NATIVE-TURN-RESULT:");

        assert.deepEqual(nativeResult, {
            verdict: "APPROVED",
            summary: "Revision A received an approval that must not cross a revision change.",
        });
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
        assert.deepEqual(await dispatchMarkers(effects), ["verification-a"]);

        recovery = startWorker("recover", database, markers, options);
        const recoveredOutput = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const recovered = recordAfter<{
            readonly result: {
                readonly staleFailure: string;
                readonly verificationA: {
                    readonly verificationId: string;
                    readonly subjectRevision: string;
                };
                readonly revisionB: { readonly digest: string };
                readonly verificationB: {
                    readonly verificationId: string;
                    readonly subjectRevision: string;
                };
                readonly second: ReviewResultRecord;
            };
            readonly thread: {
                readonly conversationId: number | string;
                readonly turns: readonly {
                    readonly turnId: string;
                    readonly status: string;
                    readonly policyBinding?: {
                        readonly policyId?: string;
                        readonly input: { readonly firstTurn?: boolean };
                    };
                }[];
            };
        }>(recoveredOutput, "FINAL:");

        assert.match(recovered.result.staleFailure, /revision changed before promotion/i);
        assert.equal(
            recovered.result.verificationA.verificationId,
            "review-cold-recovery-verification",
        );
        assert.equal(recovered.result.verificationA.subjectRevision, revisionA.digest);
        assert.equal(recovered.result.revisionB.digest, revisionB.digest);
        assert.equal(
            recovered.result.verificationB.verificationId,
            "review-cold-recovery-verification-b",
        );
        assert.equal(recovered.result.verificationB.subjectRevision, revisionB.digest);
        assert.equal(recovered.result.second.turnId, "review-turn-cold-recovery-2");
        assert.equal(recovered.result.second.verificationId, "review-cold-recovery-verification-b");
        assert.equal(recovered.result.second.subjectRevision, revisionB.digest);
        assert.notEqual(recovered.thread.conversationId, undefined);
        assert.deepEqual(
            recovered.thread.turns.map((turn) => ({
                turnId: turn.turnId,
                status: turn.status,
                policyId: turn.policyBinding?.policyId,
                firstTurn: turn.policyBinding?.input.firstTurn,
            })),
            [
                {
                    turnId: "review-turn-cold-recovery",
                    status: "completed",
                    policyId: "workflow-review",
                    firstTurn: true,
                },
                {
                    turnId: "review-turn-cold-recovery-2",
                    status: "completed",
                    policyId: "workflow-review",
                    firstTurn: false,
                },
            ],
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(effects), ["verification-a", "verification-b"]);
        assert.deepEqual(JSON.parse(await readFile(workspace, "utf8")), revisionB);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("a repaired Review pass resumes on the same conversation with a fresh turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-continuation-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const effects = join(directory, "workflow-effects.log");
    const workspace = join(directory, "workspace-revision.json");
    const revisionA = {
        workspaceId: "review-cold-recovery-workspace",
        digest: "a".repeat(64),
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };
    const revisionB = { ...revisionA, digest: "c".repeat(64) };
    const options = { scenario: "repair-continuation" as const, workspace, effects };

    await writeFile(workspace, JSON.stringify(revisionA));

    const first = startWorker("pause-after-second-native-result", database, markers, options);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, "SECOND-NATIVE-TURN-RESULT:");
        const nativeResult = recordAfter<{ readonly verdict: string; readonly summary: string }>(
            firstOutput,
            "SECOND-NATIVE-TURN-RESULT:",
        );

        assert.deepEqual(nativeResult, {
            verdict: "APPROVED",
            summary: "Fresh revision B passed its independent review.",
        });
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(effects), [
            "verification-a",
            "repair",
            "verification-b",
        ]);

        recovery = startWorker("recover", database, markers, options);
        const recoveredOutput = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const recovered = recordAfter<{
            readonly result: {
                readonly first: ReviewResultRecord;
                readonly second: ReviewResultRecord;
                readonly freshRevision: { readonly digest: string };
                readonly verificationA: {
                    readonly verificationId: string;
                    readonly subjectRevision: string;
                };
                readonly verificationB: {
                    readonly verificationId: string;
                    readonly subjectRevision: string;
                };
                readonly repair: { readonly repaired: boolean };
            };
            readonly thread: {
                readonly conversationId: number | string;
                readonly turns: readonly {
                    readonly turnId: string;
                    readonly status: string;
                    readonly policyBinding?: {
                        readonly policyId?: string;
                        readonly input: { readonly firstTurn?: boolean };
                    };
                }[];
            };
        }>(recoveredOutput, "FINAL:");

        assert.equal(recovered.result.first.decision.verdict, "CHANGES_REQUIRED");
        assert.equal(recovered.result.first.verificationId, "review-cold-recovery-verification");
        assert.equal(recovered.result.first.subjectRevision, revisionA.digest);
        assert.equal(recovered.result.repair.repaired, true);
        assert.equal(recovered.result.freshRevision.digest, revisionB.digest);
        assert.equal(
            recovered.result.verificationB.verificationId,
            "review-cold-recovery-verification-b",
        );
        assert.equal(recovered.result.verificationB.subjectRevision, revisionB.digest);
        assert.equal(recovered.result.second.decision.verdict, "APPROVED");
        assert.equal(
            recovered.result.second.decision.summary,
            "Fresh revision B passed its independent review.",
        );
        assert.equal(recovered.result.second.turnId, "review-turn-cold-recovery-2");
        assert.equal(recovered.result.second.verificationId, "review-cold-recovery-verification-b");
        assert.equal(recovered.result.second.subjectRevision, revisionB.digest);
        assert.notEqual(recovered.thread.conversationId, undefined);
        assert.deepEqual(
            recovered.thread.turns.map((turn) => ({
                turnId: turn.turnId,
                status: turn.status,
                policyId: turn.policyBinding?.policyId,
                firstTurn: turn.policyBinding?.input.firstTurn,
            })),
            [
                {
                    turnId: "review-turn-cold-recovery",
                    status: "completed",
                    policyId: "workflow-review",
                    firstTurn: true,
                },
                {
                    turnId: "review-turn-cold-recovery-2",
                    status: "completed",
                    policyId: "workflow-review",
                    firstTurn: false,
                },
            ],
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(effects), [
            "verification-a",
            "repair",
            "verification-b",
        ]);
        assert.deepEqual(JSON.parse(await readFile(workspace, "utf8")), revisionB);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("a selected stop during Review remains stopped after cold reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-stopped-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("stop-during-review", database, markers);
    let recovery: Worker | undefined;

    try {
        const waitingOutput = await outputUntil(first, "PROVIDER-DISPATCHED:");

        assert.ok(waitingOutput.includes("PROVIDER-DISPATCHED:"));
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
        first.child.stdin!.write(
            `${JSON.stringify({ command: "stop", reason: "owner selected stop" })}\n`,
        );
        const selectedOutput = await outputUntil(first, "STOP-SELECTED:");
        const stoppedOutput = await outputUntil(first, "STOPPED:");

        assert.ok(selectedOutput.includes("STOP-SELECTED:"));
        assert.equal(
            recordAfter<{ readonly name: string }>(stoppedOutput, "STOPPED:").name,
            "WorkflowStoppedError",
        );
        assert.ok(!stoppedOutput.includes("FINAL:"));
        await successfulExit(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);

        recovery = startWorker("recover-stopped", database, markers);
        const reopenedOutput = await outputUntil(recovery, "REOPENED-STOPPED:");

        await successfulExit(recovery);

        assert.equal(
            recordAfter<{ readonly name: string }>(reopenedOutput, "REOPENED-STOPPED:").name,
            "WorkflowStoppedError",
        );
        assert.ok(!reopenedOutput.includes("FINAL:"));
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("BLOCKED review parks durably and consumes exact guidance once after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-blocked-wait-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const effects = join(directory, "workflow-effects.log");
    const workspace = join(directory, "workspace-revision.json");
    const revisionA = {
        workspaceId: "review-cold-recovery-workspace",
        digest: "a".repeat(64),
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };
    const revisionB = { ...revisionA, digest: "c".repeat(64) };
    const options = { scenario: "blocked-wait" as const, workspace, effects };
    const event = {
        id: "review-guidance-event-1",
        type: "review-guidance",
        payload: {
            occurrenceId: "review-guidance-occurrence-1",
            guidance: "Use the new verification and continue on the repaired revision.",
        },
    };

    await writeFile(workspace, JSON.stringify(revisionA));

    const first = startWorker("blocked-wait", database, markers, options);
    let recovery: Worker | undefined;

    try {
        const waitingOutput = await outputUntil(first, "BLOCKED-WAIT-READY:");
        const blocked = recordAfter<ReviewResultRecord>(waitingOutput, "BLOCKED-VERDICT:");
        const firstWait = recordAfter<{
            readonly status: string;
            readonly current?: { readonly waitId?: string };
        }>(waitingOutput, "BLOCKED-WAIT-READY:");

        assert.deepEqual(blocked.decision, {
            verdict: "BLOCKED",
            summary: "Review cannot safely proceed.",
            reason: "Owner guidance is required before another verification.",
        });
        assert.equal(firstWait.status, "waiting");
        assert.equal(firstWait.current?.waitId, "review-guidance-occurrence-1");
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
        assert.deepEqual(await dispatchMarkers(effects), ["verification-a"]);

        recovery = startWorker("recover", database, markers, options);
        const reopenedWaitOutput = await outputUntil(recovery, "BLOCKED-WAIT-READY:");
        const reopenedWait = recordAfter<{
            readonly status: string;
            readonly current?: { readonly waitId?: string };
        }>(reopenedWaitOutput, "BLOCKED-WAIT-READY:");

        assert.equal(reopenedWait.status, "waiting");
        assert.equal(reopenedWait.current?.waitId, "review-guidance-occurrence-1");
        recovery.child.stdin!.write(`${JSON.stringify(event)}\n`);

        const sentOutput = await outputUntil(recovery, "EVENT-SENT:");

        assert.deepEqual(recordAfter(sentOutput, "EVENT-SENT:"), {
            accepted: true,
            eventId: event.id,
        });
        const finalOutput = await outputUntil(recovery, "FINAL:");

        recovery.child.stdin!.end();
        await successfulExit(recovery);

        const final = recordAfter<{
            readonly result: {
                readonly blocked: ReviewResultRecord;
                readonly guidance: {
                    readonly eventId: string;
                    readonly payload: { readonly occurrenceId: string; readonly guidance: string };
                };
                readonly repair: { readonly repaired: boolean };
                readonly revisionB: { readonly digest: string };
                readonly verificationB: {
                    readonly verificationId: string;
                    readonly subjectRevision: string;
                };
                readonly second: ReviewResultRecord;
            };
            readonly thread: {
                readonly conversationId: number | string;
                readonly turns: readonly {
                    readonly turnId: string;
                    readonly status: string;
                    readonly policyBinding?: {
                        readonly policyId?: string;
                        readonly input: { readonly firstTurn?: boolean };
                    };
                }[];
            };
        }>(finalOutput, "FINAL:");

        assert.deepEqual(final.result.blocked, blocked);
        assert.deepEqual(final.result.guidance, {
            eventId: event.id,
            payload: event.payload,
        });
        assert.equal(final.result.repair.repaired, true);
        assert.equal(final.result.revisionB.digest, revisionB.digest);
        assert.equal(
            final.result.verificationB.verificationId,
            "review-cold-recovery-verification-b",
        );
        assert.equal(final.result.verificationB.subjectRevision, revisionB.digest);
        assert.equal(final.result.second.decision.verdict, "APPROVED");
        assert.equal(final.result.second.turnId, "review-turn-cold-recovery-2");
        assert.equal(final.result.second.subjectRevision, revisionB.digest);
        assert.notEqual(final.thread.conversationId, undefined);
        assert.deepEqual(
            final.thread.turns.map((turn) => ({
                turnId: turn.turnId,
                status: turn.status,
                policyId: turn.policyBinding?.policyId,
                firstTurn: turn.policyBinding?.input.firstTurn,
            })),
            [
                {
                    turnId: "review-turn-cold-recovery",
                    status: "completed",
                    policyId: "workflow-review",
                    firstTurn: true,
                },
                {
                    turnId: "review-turn-cold-recovery-2",
                    status: "completed",
                    policyId: "workflow-review",
                    firstTurn: false,
                },
            ],
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
        assert.deepEqual(await dispatchMarkers(effects), [
            "verification-a",
            "guidance-consumed",
            "repair-after-guidance",
            "verification-b",
        ]);
        assert.deepEqual(JSON.parse(await readFile(workspace, "utf8")), revisionB);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("cold recovery records a duplicate dispatch when a provider outcome is ambiguous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-ambiguous-provider-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("pause-after-provider-dispatch", database, markers);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, "UNKNOWN-PROVIDER-DISPATCH:");
        const attempted = recordAfter<{ readonly attempt: number }>(
            firstOutput,
            "UNKNOWN-PROVIDER-DISPATCH:",
        );

        assert.equal(attempted.attempt, 1);
        await killWorker(first);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const recoveredOutput = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        const recovered = recordAfter<ReviewResultRecord>(recoveredOutput, "FINAL:");

        assert.equal(recovered.decision.verdict, "APPROVED");
        assert.equal(
            recovered.decision.summary,
            "Revision A received an approval that must not cross a revision change.",
        );
        assert.deepEqual(await dispatchMarkers(markers), [
            "provider-dispatch",
            "provider-dispatch",
        ]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("cold reopen replays the exact Review receipt without redispatching a completed turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-review-recovery-"));
    const database = join(directory, "review.sqlite");
    const markers = join(directory, "provider-dispatches.log");
    const first = startWorker("pause-after-review-receipt", database, markers);
    let recovery: Worker | undefined;

    try {
        const firstOutput = await outputUntil(first, "REVIEW-RECEIPT:");
        const persisted = recordAfter<ReviewResultRecord>(firstOutput, "REVIEW-RECEIPT:");

        await killWorker(first);

        assert.equal(persisted.decision.verdict, "APPROVED");
        assert.equal(persisted.gateId, "review-gate-cold-recovery");
        assert.equal(persisted.turnId, "review-turn-cold-recovery");
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);

        recovery = startWorker("recover", database, markers);
        const recoveredOutput = await outputUntil(recovery, "FINAL:");

        await successfulExit(recovery);

        assert.deepEqual(recordAfter<ReviewResultRecord>(recoveredOutput, "FINAL:"), persisted);
        assert.deepEqual(await dispatchMarkers(markers), ["provider-dispatch"]);
    } finally {
        await killWorker(first);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});
