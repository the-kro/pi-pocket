import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { VerificationResult } from "../packages/workflow-runtime/verification/types.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const crashWorker = join(projectRoot, "test/fixtures/workflow-verification-crash-worker.ts");
const directories = new Set<string>();

type Worker = { readonly child: ChildProcess; output: string; errors: string };

function startWorker(
    mode: string,
    directory: string,
    options: {
        readonly boundary?: string;
        readonly variant?: string;
        readonly runId?: string;
        readonly verificationId?: string;
        readonly scenario?: string;
    } = {},
): Worker {
    const child = spawn(process.execPath, ["--experimental-strip-types", crashWorker], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_VERIFY_MODE: mode,
            PI_VERIFY_DB: join(directory, "verification.sqlite"),
            PI_VERIFY_ROOT: join(directory, "workspace"),
            PI_VERIFY_MARKERS: join(directory, "dispatches.log"),
            PI_VERIFY_SAFETY: join(directory, "safety-state"),
            PI_VERIFY_BOUNDARY: options.boundary ?? "none",
            PI_VERIFY_VARIANT: options.variant ?? "base",
            PI_VERIFY_RUN_ID: options.runId ?? "verification-run",
            PI_VERIFY_ID: options.verificationId ?? "verification-1",
            PI_VERIFY_SCENARIO: options.scenario ?? "single",
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

function payloadAfter<T>(output: string, marker: string): T {
    const line = output.split("\n").find((candidate) => candidate.startsWith(marker));

    assert.ok(line, `Missing ${marker} in ${output}`);

    return JSON.parse(line.slice(marker.length)) as T;
}

async function fixtureDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-verification-recovery-"));

    directories.add(directory);
    await mkdir(join(directory, "workspace", "sub"), { recursive: true });

    return directory;
}

async function dispatchMarkers(directory: string): Promise<string[]> {
    try {
        return (await readFile(join(directory, "dispatches.log"), "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw error;
    }
}

async function crashAt(
    boundary: string,
    scenario = "single",
): Promise<{ directory: string; worker: Worker }> {
    const directory = await fixtureDirectory();
    const worker = startWorker("start", directory, { boundary, scenario });

    await outputUntil(worker, `BOUNDARY:${boundary}`);

    return { directory, worker };
}

async function recover(directory: string, options: Parameters<typeof startWorker>[2] = {}) {
    const worker = startWorker("recover", directory, options);
    const output = await outputUntil(worker, "RESULT:");

    await successfulExit(worker);

    return { worker, output, result: payloadAfter<VerificationResult>(output, "RESULT:") };
}

after(async () => {
    await Promise.all(
        [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

test("reopen admits a check that had not started before the first safety gate", async () => {
    const { directory, worker } = await crashAt("before-first-admission");

    try {
        await killWorker(worker);
        const recovered = await recover(directory);

        assert.equal(recovered.result.status, "passed");
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("reopen reconciles a started check before spawn without dispatching it", async () => {
    const { directory, worker } = await crashAt("before-spawn");

    try {
        await killWorker(worker);
        const recovered = await recover(directory);

        assert.equal(recovered.result.status, "interrupted");
        assert.deepEqual(
            recovered.result.checks.map((check) => check.status),
            ["interrupted"],
        );
        assert.deepEqual(await dispatchMarkers(directory), []);
    } finally {
        await killWorker(worker);
    }
});

test("reopen never repeats an external effect without its durable check result", async () => {
    const { directory, worker } = await crashAt("after-effect");

    try {
        await killWorker(worker);
        const recovered = await recover(directory);

        assert.equal(recovered.result.status, "interrupted");
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("checks after an uncertain required check remain not-run after reopen", async () => {
    const { directory, worker } = await crashAt("after-effect", "two-checks");

    try {
        await killWorker(worker);
        const recovered = await recover(directory, { scenario: "two-checks" });

        assert.equal(recovered.result.status, "interrupted");
        assert.deepEqual(
            recovered.result.checks.map((check) => check.status),
            ["interrupted", "not-run"],
        );
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("reopen reuses a completed check and runs only the not-yet-started later check", async () => {
    const { directory, worker } = await crashAt("between-checks", "two-checks");

    try {
        await killWorker(worker);
        const recovered = await recover(directory, { scenario: "two-checks" });

        assert.equal(recovered.result.status, "passed");
        assert.deepEqual(
            recovered.result.checks.map((check) => check.checkId),
            ["check-one", "check-two"],
        );
        assert.deepEqual(await dispatchMarkers(directory), ["check-one", "check-two"]);
    } finally {
        await killWorker(worker);
    }
});

test("reopen safely recomputes aggregation after all completed check receipts", async () => {
    const { directory, worker } = await crashAt("before-aggregate-commit");

    try {
        await killWorker(worker);
        const recovered = await recover(directory);

        assert.equal(recovered.result.status, "passed");
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("completed result replays literally after a full process restart", async () => {
    const { directory, worker } = await crashAt("after-aggregate");

    try {
        const initialOutput = await outputUntil(worker, "AGGREGATE:");
        const committed = payloadAfter<VerificationResult>(initialOutput, "AGGREGATE:");

        await killWorker(worker);
        const recovered = await recover(directory);

        assert.deepEqual(recovered.result, committed);
        assert.equal(JSON.stringify(recovered.result), JSON.stringify(committed));
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("a crash during interruption reconciliation remains interrupted without redispatch", async () => {
    const { directory, worker } = await crashAt("after-effect");

    try {
        await killWorker(worker);
        const reconciling = startWorker("recover", directory, {
            boundary: "reconcile-before-commit",
        });

        await outputUntil(reconciling, "BOUNDARY:reconcile-before-commit");
        await killWorker(reconciling);
        const recovered = await recover(directory);

        assert.equal(recovered.result.status, "interrupted");
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("changed request identities after completed results reject before command replay", async () => {
    const variants = ["revision", "manifest", "command", "cwd", "environment", "runner", "bounds"];
    const directory = await fixtureDirectory();
    const starting = startWorker("start-changes", directory);
    let recovery: Worker | undefined;

    try {
        const initialOutput = await outputUntil(starting, "ALL-AGGREGATES:");

        assert.deepEqual(payloadAfter<string[]>(initialOutput, "ALL-AGGREGATES:"), variants);
        await killWorker(starting);
        recovery = startWorker("recover-changes", directory);
        const recoveryOutput = await outputUntil(recovery, "CONFLICTS:");

        await successfulExit(recovery);

        assert.deepEqual(payloadAfter<string[]>(recoveryOutput, "CONFLICTS:"), variants);
        // Recovered runs emit independently; conflict order follows scheduling, not request order.
        assert.deepEqual(
            [...recoveryOutput.matchAll(/^CONFLICT:([^\r\n]+)$/gm)].map((match) => match[1]).sort(),
            [...variants].sort(),
        );
        assert.deepEqual(
            await dispatchMarkers(directory),
            variants.map(() => "check-one"),
        );
    } finally {
        await killWorker(starting);

        if (recovery !== undefined) {
            await killWorker(recovery);
        }
    }
});

test("post-check workspace drift and failed snapshots cannot persist a passing result", async (t) => {
    for (const scenario of ["drift", "snapshot-failure", "promotion-unknown"]) {
        await t.test(scenario, async () => {
            const directory = await fixtureDirectory();
            const worker = startWorker("run", directory, { scenario });

            try {
                const output = await outputUntil(worker, "WAIT-RESULT:");

                await successfulExit(worker);

                const result = payloadAfter<VerificationResult>(output, "WAIT-RESULT:");

                assert.equal(result.status, "interrupted");

                if (scenario === "promotion-unknown") {
                    assert.equal(result.checks[0]?.status, "passed");
                }

                assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);
            } finally {
                await killWorker(worker);
            }
        });
    }
});

test("unknown workspace safety survives restart and a fresh verification ID", async () => {
    const { directory, worker } = await crashAt("after-effect");

    try {
        await killWorker(worker);
        const recovered = await recover(directory);

        assert.equal(recovered.result.status, "interrupted");

        const fresh = startWorker("fresh-id", directory, {
            runId: "verification-run-fresh",
            verificationId: "verification-2",
        });
        const freshOutput = await outputUntil(fresh, "RESULT:");

        await successfulExit(fresh);

        assert.equal(
            payloadAfter<VerificationResult>(freshOutput, "RESULT:").status,
            "interrupted",
        );
        assert.deepEqual(await dispatchMarkers(directory), ["check-one"]);

        await writeFile(join(directory, "safety-state"), "quiescent\n");
        const safe = startWorker("fresh-id", directory, {
            runId: "verification-run-safe",
            verificationId: "verification-3",
        });
        const safeOutput = await outputUntil(safe, "RESULT:");

        await successfulExit(safe);

        assert.equal(payloadAfter<VerificationResult>(safeOutput, "RESULT:").status, "passed");
        assert.deepEqual(await dispatchMarkers(directory), ["check-one", "check-one"]);
    } finally {
        await killWorker(worker);
    }
});

test("selected stop cancels the shell, remains stopped after reopen, and schedules no later check", async () => {
    const directory = await fixtureDirectory();
    const worker = startWorker("stop-start", directory, { scenario: "two-checks" });

    try {
        const output = await outputUntil(worker, "STOP-SELECTED:");

        assert.match(output, /CLEANUP:complete/);
        await killWorker(worker);

        const recovered = startWorker("recover-stop", directory, { scenario: "two-checks" });
        const recoveredOutput = await outputUntil(recovered, "INSPECT:");

        await successfulExit(recovered);
        const inspection = payloadAfter<{ status: string }>(recoveredOutput, "INSPECT:");

        assert.equal(inspection.status, "stopped");
        assert.deepEqual(await dispatchMarkers(directory), ["check-one", "cleanup:complete"]);
    } finally {
        await killWorker(worker);
    }
});
