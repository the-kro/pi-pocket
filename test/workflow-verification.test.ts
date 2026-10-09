import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import type { FileSystem, Shell } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type {
    CheckResult,
    VerificationCheck,
    VerificationManifest,
    VerificationResult,
    WorkspaceAdapter,
    WorkspaceRevision,
    WorkspaceSafetyAdapter,
} from "../packages/workflow-runtime/verification/types.ts";

const manifestApi = await import("../packages/workflow-runtime/verification/manifest.ts").catch(
    () => undefined,
);
const workspaceApi = await import("../packages/workflow-runtime/verification/workspace.ts").catch(
    () => undefined,
);
const commandApi = await import("../packages/workflow-runtime/verification/command.ts").catch(
    () => undefined,
);
const resultApi = await import("../packages/workflow-runtime/verification/result.ts").catch(
    () => undefined,
);
const temporaryDirectories = new Set<string>();

after(async () => {
    await Promise.all(
        [...temporaryDirectories].map((directory) =>
            rm(directory, { recursive: true, force: true }),
        ),
    );
});

async function gitRepository(): Promise<{ root: string; environment: NodeExecutionEnv }> {
    const root = await mkdtemp(join(tmpdir(), "pi-pocket-verification-"));

    temporaryDirectories.add(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "verification@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Verification Test"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: root });

    return { root, environment: new NodeExecutionEnv({ cwd: root }) };
}

function gitWorkspace(
    root: string,
    environment: NodeExecutionEnv,
    options: Record<string, unknown> = {},
) {
    assert.ok(workspaceApi, "the public workspace adapter seam must be available");

    return workspaceApi.createGitWorkspaceAdapter({
        fileSystem: environment,
        shell: environment,
        context: BACKGROUND_CONTEXT,
        workspaceRoot: root,
        ...options,
    });
}

const ceilings = {
    maxManifestBytes: 16_384,
    maxChecks: 8,
    maxCommandBytes: 1024,
    maxCheckTimeoutMs: 60_000,
    maxAggregateTimeoutMs: 120_000,
    maxCheckOutputBytes: 8192,
    maxAggregateOutputBytes: 32_768,
};

function api() {
    assert.ok(manifestApi, "the public verification manifest seam must be available");

    return manifestApi;
}

function check(overrides: Record<string, unknown> = {}) {
    return {
        id: "tests",
        command: "npm test",
        cwd: ".",
        environmentPolicyId: "node-ci-v1",
        required: true,
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        ...overrides,
    };
}

function manifest(checks = [check()], overrides: Record<string, unknown> = {}) {
    return {
        checks,
        bounds: {
            maxChecks: 8,
            aggregateTimeoutMs: 10_000,
            aggregateOutputBytes: 8192,
        },
        resultPolicy: "all-required-checks-pass-v1" as const,
        ...overrides,
    };
}

const testFileSystem: Pick<FileSystem, "canonicalPath"> = {
    async canonicalPath(path) {
        return { ok: true, value: resolve(path) };
    },
};

async function validate(value = manifest(), workspaceRoot = "/workspace/repo", limits = ceilings) {
    return api().validateVerificationManifest(value, {
        workspaceRoot,
        ceilings: limits,
        fileSystem: testFileSystem,
        context: BACKGROUND_CONTEXT,
    });
}

async function requestForResults(value = manifest()) {
    const validated = await validate(value);
    const revision: WorkspaceRevision = {
        workspaceId: "workspace-result-test",
        digest: "c".repeat(64),
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };

    return {
        verificationId: "verify-result-test",
        workspaceId: revision.workspaceId,
        subjectRevision: revision,
        manifest: validated,
        runner: { id: "test-runner", version: "1" },
    };
}

test("Target 4 contracts expose revision, safety, manifest, check, and result identities", async () => {
    const verificationCheck: VerificationCheck = {
        id: "tests",
        command: "npm test",
        cwd: ".",
        environmentPolicyId: "node-ci-v1",
        required: true,
        timeoutMs: 1000,
        maxOutputBytes: 1024,
    };
    const verificationManifest: VerificationManifest = {
        checks: [verificationCheck],
        bounds: {
            maxChecks: 1,
            aggregateTimeoutMs: 1000,
            aggregateOutputBytes: 1024,
        },
        resultPolicy: "all-required-checks-pass-v1",
    };
    const revision: WorkspaceRevision = {
        workspaceId: "workspace-1",
        digest: "a".repeat(64),
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };
    const workspace: WorkspaceAdapter = { snapshot: async () => revision };
    const safety: WorkspaceSafetyAdapter = {
        async assertQuiescent(request) {
            return request.phase === "promotion"
                ? { state: "quiescent", assuranceId: "host-durable-evidence-1" }
                : { state: "unknown" };
        },
    };
    const checkResult: CheckResult = { checkId: "tests", status: "interrupted" };
    const result: VerificationResult = {
        verificationId: "verify-1",
        requestDigest: "b".repeat(64),
        workspaceId: revision.workspaceId,
        subjectRevision: revision.digest,
        status: "interrupted",
        checks: [checkResult],
    };

    assert.equal((await workspace.snapshot()).digest, revision.digest);
    assert.equal(
        (
            await safety.assertQuiescent({
                phase: "promotion",
                verificationId: result.verificationId,
                workspaceId: revision.workspaceId,
                subjectRevision: revision.digest,
            })
        ).state,
        "quiescent",
    );
    assert.equal(verificationManifest.checks[0]?.id, result.checks[0]?.checkId);
});

test("verification manifests reject an empty check list", async () => {
    await assert.rejects(validate(manifest([])), /at least one check/);
});

test("verification manifests reject sparse check arrays", async () => {
    const checks = new Array<VerificationCheck>(1);

    await assert.rejects(validate(manifest(checks)), /check.*array|check.*entry/i);
});

test("verification host ceilings must be finite positive integers", async () => {
    await assert.rejects(
        validate(manifest(), "/workspace/repo", { ...ceilings, maxCommandBytes: Infinity }),
        /ceilings must be positive safe integers/,
    );
});

test("verification manifests reject oversized serialized requests", async () => {
    await assert.rejects(
        validate(manifest(), "/workspace/repo", { ...ceilings, maxManifestBytes: 32 }),
        /size ceiling/,
    );
});

test("verification checks cannot exceed per-check timeout and output ceilings", async () => {
    await assert.rejects(
        validate(
            manifest([check({ timeoutMs: 60_001 })], {
                bounds: {
                    maxChecks: 1,
                    aggregateTimeoutMs: 60_001,
                    aggregateOutputBytes: 1024,
                },
            }),
        ),
        /timeout ceiling/,
    );
});

test("verification checks cannot exceed per-check output ceilings", async () => {
    await assert.rejects(
        validate(
            manifest([check({ maxOutputBytes: 8193 })], {
                bounds: {
                    maxChecks: 1,
                    aggregateTimeoutMs: 1000,
                    aggregateOutputBytes: 8193,
                },
            }),
        ),
        /output ceiling/,
    );
});

test("verification checks cannot exceed aggregate timeout and output bounds", async () => {
    await assert.rejects(
        validate(
            manifest(
                [check({ id: "first", timeoutMs: 6000 }), check({ id: "second", timeoutMs: 6000 })],
                {
                    bounds: {
                        maxChecks: 2,
                        aggregateTimeoutMs: 10_000,
                        aggregateOutputBytes: 2048,
                    },
                },
            ),
        ),
        /aggregate timeout bound/,
    );

    await assert.rejects(
        validate(
            manifest(
                [
                    check({ id: "first", maxOutputBytes: 5000 }),
                    check({ id: "second", maxOutputBytes: 5000 }),
                ],
                {
                    bounds: {
                        maxChecks: 2,
                        aggregateTimeoutMs: 2000,
                        aggregateOutputBytes: 8192,
                    },
                },
            ),
        ),
        /aggregate output bound/,
    );
});

test("aggregate timeout and output bounds cannot widen host ceilings", async () => {
    await assert.rejects(
        validate(
            manifest([check()], {
                bounds: {
                    maxChecks: 1,
                    aggregateTimeoutMs: 120_001,
                    aggregateOutputBytes: 1024,
                },
            }),
        ),
        /aggregate timeout ceiling/,
    );
});

test("verification manifest bounds cannot widen host ceilings", async () => {
    await assert.rejects(
        validate(
            manifest([check()], {
                bounds: {
                    maxChecks: 9,
                    aggregateTimeoutMs: 10_000,
                    aggregateOutputBytes: 8192,
                },
            }),
        ),
        /check-count ceiling/,
    );
});

test("verification manifests reject unsupported result policies", async () => {
    await assert.rejects(
        validate(manifest([check()], { resultPolicy: "pass-on-any-check" })),
        /result policy/,
    );
});

test("verification manifests reject secret-bearing fields outside the canonical schema", async () => {
    await assert.rejects(
        validate(manifest([check()], { environment: { TOKEN: "secret" } })),
        /unsupported fields/,
    );
});

test("verification manifests require an explicit environment policy identity", async () => {
    await assert.rejects(
        validate(manifest([check({ environmentPolicyId: "" })])),
        /environment policy/,
    );
});

test("verification manifests reject environment values rather than binding secrets", async () => {
    await assert.rejects(
        validate(manifest([check({ env: { TOKEN: "secret" } })])),
        /unsupported fields/,
    );
});

test("verification commands are bounded by UTF-8 byte length", async () => {
    await assert.rejects(
        validate(manifest([check({ command: "🙂" })]), "/workspace/repo", {
            ...ceilings,
            maxCommandBytes: 3,
        }),
        /command exceeds its byte ceiling/,
    );
});

test("verification check count cannot exceed its requested ceiling", async () => {
    await assert.rejects(
        validate(
            manifest([check({ id: "first" }), check({ id: "second" })], {
                bounds: {
                    maxChecks: 1,
                    aggregateTimeoutMs: 2000,
                    aggregateOutputBytes: 2048,
                },
            }),
        ),
        /check-count ceiling/,
    );
});

test("verification manifests reject empty command strings", async () => {
    await assert.rejects(validate(manifest([check({ command: "  " })])), /command/);
});

test("verification manifests reject working directories outside the workspace", async () => {
    await assert.rejects(
        validate(manifest([check({ cwd: "../outside" })])),
        /workspace-relative path/,
    );
});

test("verification manifests reject a cwd symlink that resolves outside the workspace", async () => {
    const { root, environment } = await gitRepository();
    const outsideRoot = await mkdtemp(join(tmpdir(), "pi-pocket-verification-outside-"));

    temporaryDirectories.add(outsideRoot);
    await symlink(outsideRoot, join(root, "outside-link"));

    await assert.rejects(
        api().validateVerificationManifest(manifest([check({ cwd: "outside-link" })]), {
            workspaceRoot: root,
            ceilings,
            fileSystem: environment,
            context: BACKGROUND_CONTEXT,
        }),
        /outside.*workspace|workspace.*outside/i,
    );
});

test("verification manifests reject non-boolean required policy", async () => {
    await assert.rejects(validate(manifest([check({ required: "true" })])), /required.*boolean/);
});

test("verification manifests reject unstable check ids", async () => {
    await assert.rejects(validate(manifest([check({ id: "not a stable id" })])), /check id/);
});

test("verification manifests reject duplicate stable check ids", async () => {
    await assert.rejects(validate(manifest([check(), check()])), /Duplicate verification check id/);
});

test("validated manifest and check order are frozen", async () => {
    const validated = await validate(
        manifest([
            check({ id: "typecheck", cwd: "./src//" }),
            check({ id: "tests", cwd: "tests" }),
        ]),
    );

    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.checks), true);
    assert.equal(Object.isFrozen(validated.checks[0]), true);
    assert.deepEqual(
        validated.checks.map(({ id, cwd, effectiveCwd }) => ({ id, cwd, effectiveCwd })),
        [
            { id: "typecheck", cwd: "src", effectiveCwd: "/workspace/repo/src" },
            { id: "tests", cwd: "tests", effectiveCwd: "/workspace/repo/tests" },
        ],
    );
});

test("manifest validation freezes caller-owned checks before root path resolution", async () => {
    let releaseRoot!: () => void;
    let signalRootStarted!: () => void;
    const rootGate = new Promise<void>((resolve) => {
        releaseRoot = resolve;
    });
    const rootStarted = new Promise<void>((resolve) => {
        signalRootStarted = resolve;
    });
    const fileSystem: Pick<FileSystem, "canonicalPath"> = {
        async canonicalPath(path) {
            signalRootStarted();
            await rootGate;

            return { ok: true, value: path };
        },
    };
    const callerOwnedCheck = check({ cwd: "src" });
    const callerOwnedChecks = [callerOwnedCheck];
    const pendingValidation = api().validateVerificationManifest(manifest(callerOwnedChecks), {
        workspaceRoot: "/workspace/repo",
        ceilings,
        fileSystem,
        context: BACKGROUND_CONTEXT,
    });

    await rootStarted;
    callerOwnedCheck.command = "npm run changed";
    callerOwnedCheck.timeoutMs = 2000;
    callerOwnedCheck.id = "mutated-after-validation-start";
    callerOwnedChecks.length = 0;
    releaseRoot();

    const validated = await pendingValidation;

    assert.equal(validated.checks[0]?.command, "npm test");
    assert.equal(validated.checks[0]?.timeoutMs, 1000);
    assert.equal(validated.checks[0]?.id, "tests");
});

test("request binding requires stable verification and runner identities", async () => {
    const revision = {
        workspaceId: "workspace-1",
        digest: "a".repeat(64),
        algorithm: "sha256" as const,
        coverage: "git-head-index-worktree-v1" as const,
    };
    const request = {
        verificationId: "verify-1",
        workspaceId: revision.workspaceId,
        subjectRevision: revision,
        manifest: await validate(),
        runner: { id: "git-shell-runner", version: "1" },
    };

    assert.throws(
        () => api().createVerificationBinding({ ...request, verificationId: "not stable" }),
        /verificationId/,
    );

    const oversizedWorkspaceId = "w".repeat(257);

    assert.throws(
        () =>
            api().createVerificationBinding({
                ...request,
                workspaceId: oversizedWorkspaceId,
                subjectRevision: { ...revision, workspaceId: oversizedWorkspaceId },
            }),
        /workspaceId/,
    );
});

test("request bindings cover ordered checks, policy, runner, workspace, revision, and bounds", async () => {
    const revision = {
        workspaceId: "node-fs:/workspace/repo",
        digest: "a".repeat(64),
        algorithm: "sha256" as const,
        coverage: "git-head-index-worktree-v1" as const,
    };
    const baseManifest = await validate(
        manifest([check({ id: "first" }), check({ id: "second" })], {
            bounds: {
                maxChecks: 2,
                aggregateTimeoutMs: 2000,
                aggregateOutputBytes: 2048,
            },
        }),
    );
    const baseRequest = {
        verificationId: "verify-1",
        workspaceId: revision.workspaceId,
        subjectRevision: revision,
        manifest: baseManifest,
        runner: { id: "git-shell-runner", version: "1" },
    };
    const baseDigest = api().createVerificationBinding(baseRequest).digest;
    const changedManifests = await Promise.all([
        validate(
            manifest([check({ id: "second" }), check({ id: "first" })], {
                bounds: {
                    maxChecks: 2,
                    aggregateTimeoutMs: 2000,
                    aggregateOutputBytes: 2048,
                },
            }),
        ),
        validate(
            manifest([check({ id: "first", command: "npm run lint" }), check({ id: "second" })], {
                bounds: {
                    maxChecks: 2,
                    aggregateTimeoutMs: 2000,
                    aggregateOutputBytes: 2048,
                },
            }),
        ),
        validate(
            manifest([check({ id: "first", cwd: "src" }), check({ id: "second" })], {
                bounds: {
                    maxChecks: 2,
                    aggregateTimeoutMs: 2000,
                    aggregateOutputBytes: 2048,
                },
            }),
        ),
        validate(
            manifest(
                [
                    check({ id: "first", environmentPolicyId: "node-ci-v2" }),
                    check({ id: "second" }),
                ],
                {
                    bounds: {
                        maxChecks: 2,
                        aggregateTimeoutMs: 2000,
                        aggregateOutputBytes: 2048,
                    },
                },
            ),
        ),
        validate(
            manifest([check({ id: "first" }), check({ id: "second" })], {
                bounds: {
                    maxChecks: 2,
                    aggregateTimeoutMs: 3000,
                    aggregateOutputBytes: 2048,
                },
            }),
        ),
    ]);
    const changedRequests = [
        ...changedManifests.map((changedManifest) => ({
            ...baseRequest,
            manifest: changedManifest,
        })),
        { ...baseRequest, verificationId: "verify-2" },
        { ...baseRequest, runner: { id: "other-runner", version: "1" } },
        { ...baseRequest, runner: { id: "git-shell-runner", version: "2" } },
        {
            ...baseRequest,
            subjectRevision: { ...revision, digest: "b".repeat(64) },
        },
        {
            ...baseRequest,
            workspaceId: "node-fs:/another-workspace",
            subjectRevision: { ...revision, workspaceId: "node-fs:/another-workspace" },
        },
    ];

    for (const request of changedRequests) {
        assert.notEqual(api().createVerificationBinding(request).digest, baseDigest);
    }
});

test("a logical verification id conflicts when its subject revision changes", async () => {
    const currentApi = api();
    const revision = {
        workspaceId: "node-fs:/workspace/repo",
        digest: "a".repeat(64),
        algorithm: "sha256" as const,
        coverage: "git-head-index-worktree-v1" as const,
    };
    const request = {
        verificationId: "verify-1",
        workspaceId: revision.workspaceId,
        subjectRevision: revision,
        manifest: await validate(),
        runner: { id: "git-shell-runner", version: "1" },
    };
    const original = currentApi.createVerificationBinding(request);
    const changed = currentApi.createVerificationBinding({
        ...request,
        subjectRevision: { ...revision, digest: "b".repeat(64) },
    });

    assert.throws(
        () => currentApi.assertVerificationBindingUnchanged(original, changed),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "verification_request_conflict" &&
            "retryable" in error &&
            error.retryable === false,
    );
});

test("Git workspace adapter rejects hidden index states", async () => {
    const { root, environment } = await gitRepository();

    execFileSync("git", ["update-index", "--assume-unchanged", "tracked.txt"], { cwd: root });

    await assert.rejects(
        gitWorkspace(root, environment).snapshot(),
        /assume-unchanged or skip-worktree/,
    );

    execFileSync("git", ["update-index", "--no-assume-unchanged", "tracked.txt"], { cwd: root });
    execFileSync("git", ["update-index", "--skip-worktree", "tracked.txt"], { cwd: root });

    await assert.rejects(
        gitWorkspace(root, environment).snapshot(),
        /assume-unchanged or skip-worktree/,
    );
});

test("Git workspace adapter rejects unsupported submodule revisions", async () => {
    const { root, environment } = await gitRepository();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
    }).trim();

    execFileSync(
        "git",
        ["update-index", "--add", "--cacheinfo", `160000,${commit},nested-module`],
        {
            cwd: root,
        },
    );
    execFileSync("git", ["commit", "-q", "-m", "submodule pointer"], { cwd: root });

    await assert.rejects(
        gitWorkspace(root, environment).snapshot(),
        /submodules are not supported/,
    );
});

test("Git workspace adapter rejects replacement-character path encodings", async () => {
    const { root, environment } = await gitRepository();

    await writeFile(join(root, "unsupported-\ufffd-name"), "unsupported path");

    await assert.rejects(
        gitWorkspace(root, environment).snapshot(),
        /unsupported workspace path encoding/,
    );
});

test("Git and filesystem access stay on injected capabilities and explicit workspace paths", async () => {
    assert.ok(workspaceApi);

    const { root, environment } = await gitRepository();

    await writeFile(join(root, "untracked.txt"), "content\n");
    environment.cwd = tmpdir();
    const calls: Array<{ command: string; cwd?: string }> = [];
    const fileSystemCalls: Array<{ method: string; path: string }> = [];
    const injectedFileSystem = new Proxy(environment, {
        get(target, property) {
            if (property === "canonicalPath") {
                return (path: string, context: Context) => {
                    fileSystemCalls.push({ method: "canonicalPath", path });

                    return target.canonicalPath(path, context);
                };
            }

            if (property === "joinPath") {
                return (parts: string[], context: Context) => {
                    fileSystemCalls.push({ method: "joinPath", path: parts.join("/") });

                    return target.joinPath(parts, context);
                };
            }

            if (property === "fileInfo") {
                return (path: string, context: Context) => {
                    fileSystemCalls.push({ method: "fileInfo", path });

                    return target.fileInfo(path, context);
                };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const injectedShell = {
        exec(
            command: string,
            options: { cwd?: string } | undefined,
            context: typeof BACKGROUND_CONTEXT,
        ) {
            calls.push({ command, cwd: options?.cwd });

            return environment.exec(command, options, context);
        },
        cleanup(context: typeof BACKGROUND_CONTEXT) {
            return environment.cleanup(context);
        },
    };
    const canonicalRoot = await environment.canonicalPath(root, BACKGROUND_CONTEXT);

    assert.ok(canonicalRoot.ok);
    const adapter = workspaceApi.createGitWorkspaceAdapter({
        fileSystem: injectedFileSystem,
        shell: injectedShell,
        context: BACKGROUND_CONTEXT,
        workspaceRoot: root,
    });

    await adapter.snapshot();

    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.cwd === canonicalRoot.value));
    assert.ok(
        fileSystemCalls.some((call) => call.method === "canonicalPath" && call.path === root),
    );
    assert.ok(fileSystemCalls.some((call) => call.method === "joinPath"));
    assert.ok(fileSystemCalls.some((call) => call.method === "fileInfo"));
    assert.ok(
        fileSystemCalls
            .filter((call) => call.method === "fileInfo")
            .every((call) => call.path.startsWith(canonicalRoot.value)),
    );
    assert.equal(environment.cwd, tmpdir());
});

test("Git workspace adapter fails closed when an injected Git command fails", async () => {
    assert.ok(workspaceApi);

    const { root, environment } = await gitRepository();
    const failingShell = {
        async exec() {
            return {
                ok: false as const,
                error: new ExecutionError("spawn_error", "fixture command failure"),
            };
        },
        async cleanup() {},
    };
    const adapter = workspaceApi.createGitWorkspaceAdapter({
        fileSystem: environment,
        shell: failingShell,
        context: BACKGROUND_CONTEXT,
        workspaceRoot: root,
    });

    await assert.rejects(adapter.snapshot(), /command failed/);
});

test("Git workspace snapshots do not execute repository clean filters", async () => {
    const { root, environment } = await gitRepository();
    const marker = join(root, "filter-ran");

    await writeFile(join(root, ".gitattributes"), "filtered.txt filter=marker\n");
    await writeFile(join(root, "filtered.txt"), "committed content\n");
    execFileSync(
        "git",
        ["config", "filter.marker.clean", "sh -c 'printf invoked >> filter-ran; cat'"],
        { cwd: root },
    );
    execFileSync("git", ["add", ".gitattributes", "filtered.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "configured clean filter"], { cwd: root });
    await rm(marker, { force: true });
    await writeFile(join(root, "filtered.txt"), "modified working content\n");

    await gitWorkspace(root, environment).snapshot();

    await assert.rejects(access(marker), { code: "ENOENT" });
});

test("Git workspace revision binds renamed paths in normalized order", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const before = await adapter.snapshot();

    execFileSync("git", ["mv", "tracked.txt", "renamed file.txt"], { cwd: root });

    const renamed = await adapter.snapshot();
    const replay = await adapter.snapshot();

    assert.notEqual(renamed.digest, before.digest);
    assert.equal(renamed.digest, replay.digest);
});

test("Git workspace snapshots reject undecodable tracked symlink target evidence", async () => {
    const { root, environment } = await gitRepository();
    const path = join(root, "tracked-link");

    await symlink("first-target", path);
    execFileSync("git", ["add", "tracked-link"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "symlink"], { cwd: root });
    await unlink(path);
    await symlink("unsupported-\ufffd-target", path);

    await assert.rejects(
        gitWorkspace(root, environment).snapshot(),
        /undecodable workspace symlink target/,
    );
});

test("Git workspace revision includes tracked symlink targets", async () => {
    const { root, environment } = await gitRepository();
    const path = join(root, "tracked-link");

    await symlink("first-target", path);
    execFileSync("git", ["add", "tracked-link"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "symlink"], { cwd: root });
    const adapter = gitWorkspace(root, environment);
    const first = await adapter.snapshot();

    await unlink(path);
    await symlink("second-target", path);

    const second = await adapter.snapshot();

    assert.notEqual(second.digest, first.digest);
});

test("Git workspace revision includes tracked executable mode", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const ordinary = await adapter.snapshot();

    await chmod(join(root, "tracked.txt"), 0o755);

    const executable = await adapter.snapshot();

    assert.notEqual(executable.digest, ordinary.digest);
});

test("Git workspace revision includes tracked deletions", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const before = await adapter.snapshot();

    await unlink(join(root, "tracked.txt"));

    const afterDeletion = await adapter.snapshot();

    assert.notEqual(afterDeletion.digest, before.digest);
});

test("Git workspace revision changes for an unstaged edit while HEAD remains fixed", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
    }).trim();
    const before = await adapter.snapshot();

    await writeFile(join(root, "tracked.txt"), "unstaged content\n");

    const afterHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
    }).trim();
    const after = await adapter.snapshot();

    assert.equal(afterHead, beforeHead, "the Git HEAD-only reference did not change");
    assert.notEqual(after.digest, before.digest);
});

test("Git workspace snapshots bound tracked as well as untracked file content", async () => {
    const { root, environment } = await gitRepository();

    await writeFile(join(root, "large-tracked.bin"), Buffer.alloc(1024 * 1024 + 1, 0));
    execFileSync("git", ["add", "large-tracked.bin"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "large tracked file"], { cwd: root });

    await assert.rejects(
        gitWorkspace(root, environment, { maxSnapshotBytes: 1024 * 1024 }).snapshot(),
        /snapshot byte ceiling/,
    );
});

test("Git workspace snapshots fail closed when file content exceeds the byte bound", async () => {
    const { root, environment } = await gitRepository();

    await writeFile(join(root, "large.txt"), "this exceeds the configured cap\n");

    await assert.rejects(
        gitWorkspace(root, environment, { maxSnapshotBytes: 8 }).snapshot(),
        /snapshot byte ceiling/,
    );
});

test("Git workspace snapshots fail closed when Git listing output exceeds its bound", async () => {
    const { root, environment } = await gitRepository();

    await assert.rejects(
        gitWorkspace(root, environment, { maxGitOutputBytes: 1 }).snapshot(),
        /output ceiling/,
    );
});

test("Git workspace snapshots enforce one finite deadline across filesystem and Git work", async () => {
    assert.ok(workspaceApi);

    const { root, environment } = await gitRepository();
    const delayedFileSystem = new Proxy(environment, {
        get(target, property) {
            if (property === "canonicalPath") {
                return async (path: string, context: Context) => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 10));

                    return target.canonicalPath(path, context);
                };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const adapter = gitWorkspace(root, environment, {
        fileSystem: delayedFileSystem,
        maxSnapshotDurationMs: 1,
    });

    await assert.rejects(adapter.snapshot(), /snapshot.*duration|duration.*snapshot/i);
});

test("Git workspace snapshots fail closed when tracked and untracked file counts exceed the bound", async () => {
    const { root, environment } = await gitRepository();

    await writeFile(join(root, "new.txt"), "untracked\n");

    await assert.rejects(
        gitWorkspace(root, environment, { maxWorkspaceFiles: 1 }).snapshot(),
        /file-count ceiling/,
    );
});

test("Git workspace snapshots exclude ignored untracked generated files", async () => {
    const { root, environment } = await gitRepository();

    await writeFile(join(root, ".gitignore"), "*.generated\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "ignore generated output"], { cwd: root });
    await writeFile(join(root, "result.generated"), "first generated output\n");

    const adapter = gitWorkspace(root, environment);
    const first = await adapter.snapshot();

    await writeFile(join(root, "result.generated"), "second generated output\n");

    const second = await adapter.snapshot();

    assert.equal(second.digest, first.digest);
});

test("Git workspace adapter honors explicit generated-path exclusions", async () => {
    const { root, environment } = await gitRepository();

    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "output.txt"), "first generated result\n");
    execFileSync("git", ["add", "generated/output.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "tracked generated output"], { cwd: root });

    const excludedAdapter = gitWorkspace(root, environment, { excludePaths: ["generated/./"] });
    const first = await excludedAdapter.snapshot();

    await writeFile(join(root, "generated", "output.txt"), "second generated result\n");

    const worktreeEdit = await excludedAdapter.snapshot();

    execFileSync("git", ["add", "generated/output.txt"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "different generated output"], { cwd: root });

    const committedEdit = await excludedAdapter.snapshot();

    await writeFile(join(root, "generated", "new-output.txt"), "untracked generated result\n");

    const untrackedEdit = await excludedAdapter.snapshot();
    const included = await gitWorkspace(root, environment).snapshot();

    assert.equal(worktreeEdit.digest, first.digest);
    assert.equal(committedEdit.digest, first.digest);
    assert.equal(untrackedEdit.digest, first.digest);
    assert.notEqual(included.digest, untrackedEdit.digest);
});

test("Git workspace revision includes untracked executable mode", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const path = join(root, "new-script.sh");

    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const ordinary = await adapter.snapshot();

    await chmod(path, 0o755);
    const executable = await adapter.snapshot();

    assert.notEqual(executable.digest, ordinary.digest);
});

test("Git workspace revision includes untracked symlink targets", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const path = join(root, "new-link");

    await symlink("first-target", path);
    const first = await adapter.snapshot();

    await unlink(path);
    await symlink("second-target", path);
    const second = await adapter.snapshot();

    assert.notEqual(second.digest, first.digest);
});

test("Git workspace revision includes untracked file contents", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);

    await writeFile(join(root, "new.txt"), "first untracked value\n");
    const first = await adapter.snapshot();

    await writeFile(join(root, "new.txt"), "second untracked value\n");
    const second = await adapter.snapshot();

    assert.notEqual(second.digest, first.digest);
});

test("Git workspace identity distinguishes index state from the same worktree content", async () => {
    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);

    await writeFile(join(root, "tracked.txt"), "staged value\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "worktree value\n");
    const unstaged = await adapter.snapshot();

    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    const staged = await adapter.snapshot();

    assert.notEqual(staged.digest, unstaged.digest);
});

test("Git workspace snapshots have a deterministic content identity", async () => {
    assert.ok(workspaceApi, "the public workspace adapter seam must be available");

    const { root, environment } = await gitRepository();
    const adapter = gitWorkspace(root, environment);
    const first = await adapter.snapshot();
    const second = await adapter.snapshot();

    assert.equal(first.workspaceId, second.workspaceId);
    assert.equal(first.digest, second.digest);
    assert.match(first.digest, /^[a-f0-9]{64}$/);
    assert.equal(first.algorithm, "sha256");
    assert.equal(first.coverage, "git-head-index-worktree-v1");
});

test("verification manifest validation freezes effective cwd and request identity", async () => {
    const validated = await validate(
        manifest([check({ timeoutMs: 30_000, maxOutputBytes: 4096 })], {
            bounds: {
                maxChecks: 8,
                aggregateTimeoutMs: 30_000,
                aggregateOutputBytes: 8192,
            },
        }),
        "/workspace/repo",
    );

    assert.equal(validated.checks[0]?.effectiveCwd, "/workspace/repo");
    assert.equal(validated.checks[0]?.id, "tests");

    const revision = {
        workspaceId: "node-fs:/workspace/repo",
        digest: "a".repeat(64),
        algorithm: "sha256" as const,
        coverage: "git-head-index-worktree-v1" as const,
    };
    const request = {
        verificationId: "verify-1",
        workspaceId: revision.workspaceId,
        subjectRevision: revision,
        manifest: validated,
        runner: { id: "git-shell-runner", version: "1" },
    };

    assert.equal(
        api().createVerificationBinding(request).digest,
        api().createVerificationBinding(request).digest,
    );
});

test("command adapter runs a real public Shell check in its injected cwd", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const { root, environment } = await gitRepository();
    const command = `${process.execPath} -e 'process.stdout.write(process.cwd()+"|"+process.env.VERIFICATION_MARKER)'`;
    const validated = await api().validateVerificationManifest(manifest([check({ command })]), {
        workspaceRoot: root,
        ceilings,
        fileSystem: environment,
        context: BACKGROUND_CONTEXT,
    });
    const evidence = `${validated.checks[0]?.effectiveCwd}|injected`;
    const adapter = commandApi.createVerificationCommandAdapter({
        shell: environment,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });
    const result = await adapter.run({
        check: validated.checks[0]!,
        environment: { VERIFICATION_MARKER: "injected" },
        remainingAggregateOutputBytes: 8192,
    });

    assert.deepEqual(result, {
        checkId: "tests",
        status: "passed",
        exitCode: 0,
        evidence,
        observedOutputBytes: Buffer.byteLength(evidence, "utf8"),
        truncated: false,
        termination: "none",
    });
});

test("command adapter marks queued later checks not-run after a required interruption", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const calls: string[] = [];
    const shell: Pick<Shell, "exec"> = {
        async exec(command) {
            calls.push(command);

            if (command === "first") {
                return {
                    ok: false,
                    error: new ExecutionError("timeout", "first required check timed out"),
                };
            }

            return { ok: true, value: { exitCode: 0 } };
        },
    };
    const validated = await validate(
        manifest([
            check({ id: "first", command: "first" }),
            check({ id: "second", command: "second" }),
        ]),
    );
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });
    const firstRun = adapter.run({
        check: validated.checks[0]!,
        environment: {},
        remainingAggregateOutputBytes: 8192,
    });
    const secondRun = adapter.run({
        check: validated.checks[1]!,
        environment: {},
        remainingAggregateOutputBytes: 8192,
    });

    assert.deepEqual(await firstRun, {
        checkId: "first",
        status: "interrupted",
        observedOutputBytes: 0,
        truncated: false,
        termination: "timeout",
    });
    assert.deepEqual(await secondRun, { checkId: "second", status: "not-run" });
    assert.deepEqual(calls, ["first"]);
});

test("command adapter serializes concurrent checks in request order", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
        signalFirstStarted = resolve;
    });
    const calls: string[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    let secondStartedBeforeRelease = false;
    const shell: Pick<Shell, "exec"> = {
        async exec(command) {
            calls.push(command);
            activeCalls++;
            maxActiveCalls = Math.max(maxActiveCalls, activeCalls);

            if (command === "first") {
                signalFirstStarted();
                await firstGate;
            } else {
                secondStartedBeforeRelease = true;
            }

            activeCalls--;

            return { ok: true, value: { exitCode: 0 } };
        },
    };
    const validated = await validate(
        manifest([
            check({ id: "first", command: "first" }),
            check({ id: "second", command: "second" }),
        ]),
    );
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });
    const firstRun = adapter.run({
        check: validated.checks[0]!,
        environment: {},
        remainingAggregateOutputBytes: 8192,
    });

    await firstStarted;
    const secondRun = adapter.run({
        check: validated.checks[1]!,
        environment: {},
        remainingAggregateOutputBytes: 8192,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondStartedWhileFirstWasRunning = secondStartedBeforeRelease;

    releaseFirst();

    await Promise.all([firstRun, secondRun]);

    assert.equal(secondStartedWhileFirstWasRunning, false);
    assert.equal(maxActiveCalls, 1);
    assert.deepEqual(calls, ["first", "second"]);
});

test("command adapter records a nonzero exit as failed-check data", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const { root, environment } = await gitRepository();
    const validated = await api().validateVerificationManifest(
        manifest([check({ command: `${process.execPath} -e 'process.exit(7)'` })]),
        {
            workspaceRoot: root,
            ceilings,
            fileSystem: environment,
            context: BACKGROUND_CONTEXT,
        },
    );
    const adapter = commandApi.createVerificationCommandAdapter({
        shell: environment,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "failed",
            exitCode: 7,
            observedOutputBytes: 0,
            truncated: false,
            termination: "none",
        },
    );
});

test("command adapter truncates on valid UTF-8 boundaries and keeps draining output", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    let deliveredChunks = 0;
    const shell: Pick<Shell, "exec"> = {
        async exec(_command, shellOptions, context) {
            deliveredChunks++;
            shellOptions?.onOutput?.("ab€", context);
            deliveredChunks++;
            shellOptions?.onOutput?.("discard me", context);

            return { ok: true, value: { exitCode: 0 } };
        },
    };
    const validated = await validate(manifest([check({ maxOutputBytes: 4 })]));
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });
    const result = await adapter.run({
        check: validated.checks[0]!,
        environment: {},
        remainingAggregateOutputBytes: 100,
    });

    assert.equal(deliveredChunks, 2);
    assert.deepEqual(result, {
        checkId: "tests",
        status: "passed",
        exitCode: 0,
        evidence: "ab",
        observedOutputBytes: 5,
        truncated: true,
        termination: "none",
    });
});

test("command adapter observes the remaining aggregate evidence ceiling", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec(_command, shellOptions, context) {
            shellOptions?.onOutput?.("12345", context);

            return { ok: true, value: { exitCode: 0 } };
        },
    };
    const validated = await validate(manifest([check({ maxOutputBytes: 8 })]));
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 3,
        }),
        {
            checkId: "tests",
            status: "passed",
            exitCode: 0,
            evidence: "123",
            observedOutputBytes: 4,
            truncated: true,
            termination: "none",
        },
    );
});

test("command adapter records known spawn failures as failed evidence", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec() {
            return {
                ok: false,
                error: new ExecutionError("spawn_error", "spawn was rejected"),
            };
        },
    };
    const validated = await validate();
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "failed",
            failureCode: "spawn_error",
            observedOutputBytes: 0,
            truncated: false,
            termination: "none",
        },
    );
});

test("timeout remains interrupted even when buffered output looks successful", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec(_command, shellOptions, context) {
            shellOptions?.onOutput?.("looks passed", context);

            return {
                ok: false,
                error: new ExecutionError("timeout", "deadline reached"),
            };
        },
    };
    const validated = await validate();
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "interrupted",
            evidence: "looks passed",
            observedOutputBytes: 12,
            truncated: false,
            termination: "timeout",
        },
    );
});

test("selected workflow cancellation reaches Shell and propagates as a stop", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const controller = new AbortController();
    const stopReason = new Error("selected workflow stop");
    let signalCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
        signalCommandStarted = resolve;
    });
    const shell: Pick<Shell, "exec"> = {
        async exec(_command, _shellOptions, context) {
            signalCommandStarted();
            const signal = context.abortSignal;

            return await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    resolve({
                        ok: false,
                        error: new ExecutionError("aborted", "Shell was cancelled"),
                    });
                }, 100);

                signal?.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        resolve({
                            ok: false,
                            error: new ExecutionError("aborted", "Shell was cancelled"),
                        });
                    },
                    { once: true },
                );
            });
        },
    };
    const validated = await validate();
    const adapterOptions = {
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
        signal: controller.signal,
    };
    const adapter = commandApi.createVerificationCommandAdapter(adapterOptions);
    const run = adapter.run({
        check: validated.checks[0]!,
        environment: {},
        remainingAggregateOutputBytes: 8192,
    });

    await commandStarted;
    controller.abort(stopReason);

    await assert.rejects(run, (error: unknown) => error === stopReason);
});

test("host shell cancellation without a selected workflow stop is interrupted", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec() {
            return {
                ok: false,
                error: new ExecutionError("aborted", "host execution context cancelled"),
            };
        },
    };
    const validated = await validate();
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "interrupted",
            observedOutputBytes: 0,
            truncated: false,
            termination: "cancelled",
        },
    );
});

test("an unexpected shell exception is an unknown interrupted outcome", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec() {
            throw new Error("transport outcome is uncertain");
        },
    };
    const validated = await validate();
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "interrupted",
            observedOutputBytes: 0,
            truncated: false,
            termination: "unknown",
        },
    );
});

test("an unknown Shell execution result is an interrupted outcome", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec() {
            return {
                ok: false,
                error: new ExecutionError("unknown", "execution status unavailable"),
            };
        },
    };
    const validated = await validate();
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "interrupted",
            observedOutputBytes: 0,
            truncated: false,
            termination: "unknown",
        },
    );
});

test("an invalid Shell exit code is an unknown interrupted outcome", async () => {
    assert.ok(commandApi, "the public verification command adapter must be available");

    const shell: Pick<Shell, "exec"> = {
        async exec() {
            return { ok: true, value: { exitCode: Number.NaN } };
        },
    };
    const validated = await validate();
    const adapter = commandApi.createVerificationCommandAdapter({
        shell,
        context: BACKGROUND_CONTEXT,
        maxCheckTimeoutMs: 60_000,
        maxCheckOutputBytes: 8192,
    });

    assert.deepEqual(
        await adapter.run({
            check: validated.checks[0]!,
            environment: {},
            remainingAggregateOutputBytes: 8192,
        }),
        {
            checkId: "tests",
            status: "interrupted",
            observedOutputBytes: 0,
            truncated: false,
            termination: "unknown",
        },
    );
});

test("result aggregation requires exactly one outcome per manifest check", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "first" }), check({ id: "second" })]),
    );

    assert.throws(
        () => resultApi.aggregateVerificationResult(request, []),
        /one outcome for each manifest check/,
    );
    assert.throws(
        () =>
            resultApi.aggregateVerificationResult(request, [
                { checkId: "first", status: "passed", exitCode: 0 },
            ]),
        /one outcome for each manifest check/,
    );
});

test("result aggregation preserves exact identity for all conclusive passes", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const validated = await validate(
        manifest(
            [
                check({ id: "types", maxOutputBytes: 256 }),
                check({ id: "tests", maxOutputBytes: 256 }),
            ],
            {
                bounds: {
                    maxChecks: 2,
                    aggregateTimeoutMs: 2000,
                    aggregateOutputBytes: 1024,
                },
            },
        ),
    );
    const revision: WorkspaceRevision = {
        workspaceId: "workspace-result-test",
        digest: "c".repeat(64),
        algorithm: "sha256",
        coverage: "git-head-index-worktree-v1",
    };
    const request = {
        verificationId: "verify-result-test",
        workspaceId: revision.workspaceId,
        subjectRevision: revision,
        manifest: validated,
        runner: { id: "test-runner", version: "1" },
    };
    const checks: CheckResult[] = [
        { checkId: "types", status: "passed", exitCode: 0, termination: "none" },
        {
            checkId: "tests",
            status: "passed",
            exitCode: 0,
            evidence: "ok",
            observedOutputBytes: 2,
            truncated: false,
            termination: "none",
        },
    ];
    const result = resultApi.aggregateVerificationResult(request, checks);

    assert.deepEqual(result, {
        verificationId: "verify-result-test",
        requestDigest: api().createVerificationBinding(request).digest,
        workspaceId: revision.workspaceId,
        subjectRevision: revision.digest,
        status: "passed",
        checks,
    });
});

test("result aggregation retains known failures while later checks pass", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "types" }), check({ id: "tests" })]),
    );
    const checks: CheckResult[] = [
        { checkId: "types", status: "failed", exitCode: 2, termination: "none" },
        { checkId: "tests", status: "passed", exitCode: 0, termination: "none" },
    ];

    const result = resultApi.aggregateVerificationResult(request, checks);

    assert.equal(result.status, "failed");
    assert.deepEqual(result.checks, checks);
});

test("required interruption dominates known failures and permits only later not-run checks", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "types" }), check({ id: "unit" }), check({ id: "integration" })]),
    );
    const checks: CheckResult[] = [
        { checkId: "types", status: "failed", exitCode: 2, termination: "none" },
        { checkId: "unit", status: "interrupted", termination: "timeout" },
        { checkId: "integration", status: "not-run" },
    ];

    const result = resultApi.aggregateVerificationResult(request, checks);

    assert.equal(result.status, "interrupted");
    assert.deepEqual(result.checks, checks);
});

test("result aggregation rejects not-run checks without an earlier required interruption", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "types" }), check({ id: "tests" })]),
    );

    assert.throws(
        () =>
            resultApi.aggregateVerificationResult(request, [
                { checkId: "types", status: "passed", exitCode: 0 },
                { checkId: "tests", status: "not-run" },
            ]),
        /earlier required interruption/,
    );
});

test("revision or safety invalidation permits blocked not-run outcomes but never a pass", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "types" }), check({ id: "tests" })]),
    );
    const result = resultApi.aggregateVerificationResult(
        request,
        [
            { checkId: "types", status: "not-run" },
            { checkId: "tests", status: "not-run" },
        ],
        { subjectValid: false },
    );

    assert.equal(result.status, "interrupted");
    assert.deepEqual(
        result.checks.map((check) => check.status),
        ["not-run", "not-run"],
    );

    const changedSubject = resultApi.aggregateVerificationResult(
        request,
        [
            { checkId: "types", status: "passed", exitCode: 0 },
            { checkId: "tests", status: "passed", exitCode: 0 },
        ],
        { subjectValid: false },
    );

    assert.equal(changedSubject.status, "interrupted");
});

test("result aggregation forbids running checks after a required interruption", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "types" }), check({ id: "tests" })]),
    );

    assert.throws(
        () =>
            resultApi.aggregateVerificationResult(request, [
                { checkId: "types", status: "interrupted", termination: "timeout" },
                { checkId: "tests", status: "passed", exitCode: 0 },
            ]),
        /after a required interruption must be not-run/,
    );
});

test("an optional interruption allows later checks but cannot produce passed", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "advisory", required: false }), check({ id: "required" })]),
    );
    const checks: CheckResult[] = [
        { checkId: "advisory", status: "interrupted", termination: "unknown" },
        { checkId: "required", status: "passed", exitCode: 0, termination: "none" },
    ];

    const result = resultApi.aggregateVerificationResult(request, checks);

    assert.equal(result.status, "interrupted");
    assert.deepEqual(result.checks, checks);
});

test("a known failure determines status when only an optional check is interrupted", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "advisory", required: false }), check({ id: "required" })]),
    );
    const checks: CheckResult[] = [
        { checkId: "advisory", status: "interrupted", termination: "unknown" },
        { checkId: "required", status: "failed", exitCode: 2, termination: "none" },
    ];

    assert.equal(resultApi.aggregateVerificationResult(request, checks).status, "failed");
});

test("result aggregation rejects unknown fields before copying durable evidence", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults();
    const pollutedResult = {
        checkId: "tests",
        status: "passed",
        exitCode: 0,
        termination: "none",
        spillPath: "/tmp/unbounded-output.log",
        secretPayload: "private-output".repeat(1024),
    } as CheckResult;

    assert.throws(
        () => resultApi.aggregateVerificationResult(request, [pollutedResult]),
        /unknown verification check field/,
    );
});

test("result aggregation rejects unknown fields on not-run outcomes", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ id: "first" }), check({ id: "second" })]),
    );
    const notRun = {
        checkId: "second",
        status: "not-run",
        spillPath: "/tmp/secret-spill",
    } as CheckResult;

    assert.throws(
        () =>
            resultApi.aggregateVerificationResult(request, [
                { checkId: "first", status: "interrupted", termination: "timeout" },
                notRun,
            ]),
        /unknown verification check field/,
    );
});

test("result aggregation rejects evidence above its per-check size ceiling", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults(
        manifest([check({ maxOutputBytes: 4 })], {
            bounds: {
                maxChecks: 1,
                aggregateTimeoutMs: 1000,
                aggregateOutputBytes: 4,
            },
        }),
    );
    const oversized: CheckResult = {
        checkId: "tests",
        status: "passed",
        exitCode: 0,
        evidence: "12345",
        observedOutputBytes: 5,
        truncated: false,
        termination: "none",
    };

    assert.throws(
        () => resultApi.aggregateVerificationResult(request, [oversized]),
        /per-check evidence ceiling/,
    );
});

test("result aggregation rejects evidence above the aggregate byte ceiling", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const baseRequest = await requestForResults(
        manifest(
            [check({ id: "first", maxOutputBytes: 2 }), check({ id: "second", maxOutputBytes: 2 })],
            {
                bounds: {
                    maxChecks: 2,
                    aggregateTimeoutMs: 2000,
                    aggregateOutputBytes: 4,
                },
            },
        ),
    );
    const request = {
        ...baseRequest,
        manifest: {
            ...baseRequest.manifest,
            bounds: { ...baseRequest.manifest.bounds, aggregateOutputBytes: 2 },
        },
    };
    const checks: CheckResult[] = [
        {
            checkId: "first",
            status: "passed",
            exitCode: 0,
            evidence: "aa",
            observedOutputBytes: 2,
            truncated: false,
            termination: "none",
        },
        {
            checkId: "second",
            status: "passed",
            exitCode: 0,
            evidence: "bb",
            observedOutputBytes: 2,
            truncated: false,
            termination: "none",
        },
    ];

    assert.throws(
        () => resultApi.aggregateVerificationResult(request, checks),
        /aggregate evidence ceiling/,
    );
});

test("result aggregation rejects unsupported failure-code values", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults();
    const unsupportedFailure = {
        checkId: "tests",
        status: "failed",
        exitCode: 2,
        failureCode: "secret_payload",
        termination: "none",
    } as unknown as CheckResult;

    assert.throws(
        () => resultApi.aggregateVerificationResult(request, [unsupportedFailure]),
        /unsupported verification failure code/,
    );
});

test("result aggregation rejects non-numeric process exit evidence", async () => {
    assert.ok(resultApi, "the public verification result algebra must be available");

    const request = await requestForResults();

    assert.throws(
        () =>
            resultApi.aggregateVerificationResult(request, [
                {
                    checkId: "tests",
                    status: "failed",
                    exitCode: Number.NaN,
                    termination: "none",
                },
            ]),
        /safe integer exit code/,
    );
});
