import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { VerificationResult } from "../packages/workflow-runtime/index.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hostWorker = join(projectRoot, "test/fixtures/workflow-verification-host-worker.ts");

type Worker = { readonly child: ChildProcess; output: string; errors: string };

function startWorker(
    mode: "start" | "recover",
    paths: { directory: string; worktree: string; command: string },
): Worker {
    const child = spawn(process.execPath, ["--experimental-strip-types", hostWorker], {
        cwd: projectRoot,
        env: {
            ...process.env,
            PI_VERIFY_HOST_MODE: mode,
            PI_VERIFY_HOST_DB: join(paths.directory, "host.sqlite"),
            PI_VERIFY_HOST_WORKTREE: paths.worktree,
            PI_VERIFY_HOST_MARKERS: join(paths.directory, "dispatches.log"),
            PI_VERIFY_HOST_SAFETY: join(paths.directory, "safety.json"),
            PI_VERIFY_HOST_COMMAND: paths.command,
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
        }, 30_000);
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
                        `Host worker exited before ${marker}: code=${worker.child.exitCode}; signal=${worker.child.signalCode}; stdout=${worker.output}; stderr=${worker.errors}`,
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
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        assert.equal(worker.child.signalCode, null, worker.errors);
        assert.equal(worker.child.exitCode, 0, worker.errors);

        return;
    }

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

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

test("generic Pi Durable consumer verifies a real Git worktree and replays after host restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-pocket-verification-host-"));
    const repository = join(directory, "repository");
    const worktree = join(directory, "worktree");
    const commandScript =
        'const marker = "portable-verification-marker"; process.stdout.write("portable verification\\n");';
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(commandScript)}`;
    let start: Worker | undefined;
    let recovery: Worker | undefined;

    try {
        execFileSync("git", ["init", "-q", repository]);
        execFileSync("git", ["-C", repository, "config", "user.email", "host@example.test"]);
        execFileSync("git", ["-C", repository, "config", "user.name", "Portable Host"]);
        await writeFile(join(repository, "tracked.txt"), "committed workspace state\n");
        execFileSync("git", ["-C", repository, "add", "tracked.txt"]);
        execFileSync("git", ["-C", repository, "commit", "-q", "-m", "initial"]);
        execFileSync("git", ["-C", repository, "worktree", "add", "--detach", worktree, "HEAD"]);
        await writeFile(
            join(directory, "safety.json"),
            JSON.stringify({ state: "quiescent", epoch: "durable-host-attestation-1" }),
        );

        start = startWorker("start", { directory, worktree, command });
        const initialOutput = await outputUntil(start, "BOUNDARY:aggregate-committed");
        const committed = payloadAfter<VerificationResult>(initialOutput, "AGGREGATE:");

        assert.equal(committed.status, "passed");
        assert.equal(committed.subjectRevision.length, 64);
        assert.deepEqual(committed.checks, [
            {
                checkId: "portable-check",
                status: "passed",
                exitCode: 0,
                evidence: "portable verification\n",
                observedOutputBytes: 22,
                truncated: false,
                termination: "none",
            },
        ]);
        await killWorker(start);

        recovery = startWorker("recover", { directory, worktree, command });
        const recoveredOutput = await outputUntil(recovery, "RESULT:");

        await successfulExit(recovery);
        const recovered = payloadAfter<VerificationResult>(recoveredOutput, "RESULT:");

        assert.deepEqual(recovered, committed);
        assert.equal(JSON.stringify(recovered), JSON.stringify(committed));
        assert.deepEqual(
            (await readFile(join(directory, "dispatches.log"), "utf8")).trim().split("\n"),
            ["dispatch"],
        );
        assert.equal(
            await readFile(join(worktree, "tracked.txt"), "utf8"),
            "committed workspace state\n",
        );
    } finally {
        if (start !== undefined) {
            await killWorker(start);
        }

        if (recovery !== undefined) {
            await killWorker(recovery);
        }

        await rm(directory, { recursive: true, force: true });
    }
});
