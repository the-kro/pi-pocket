/**
 * Optional Git-backed workspace snapshot adapter. Git and filesystem capabilities, execution context,
 * and the workspace root are supplied by the host; no Pocket settings or ambient working directory
 * are consulted.
 *
 * The content identity covers committed tree entries, the stage-0 index, and tracked plus
 * non-ignored untracked working-tree bytes, executable modes, and symlink targets. Raw regular-file
 * content is hashed with Git filters disabled, so repository clean filters are never executed by a
 * snapshot. Git repository `.gitignore` and `.git/info/exclude` rules omit ignored untracked files;
 * system/global Git config and global excludes are disabled. `excludePaths` adds literal
 * workspace-relative path prefixes.
 * Tracked ignored files remain included. Submodules, merge-conflict/intent-to-add/sparse index
 * states, assume-unchanged/skip-worktree entries, replacement-character paths, non-root workspaces,
 * and any file/list/output over configured bounds fail closed. This revision is content identity only:
 * matching snapshots do not attest quiescence or rule out a change-and-restore race; hosts must also
 * supply the required cross-restart `WorkspaceSafetyAdapter` for admission and promotion.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { FileSystem, Shell } from "@earendil-works/pi-durable/env";
import type { WorkspaceAdapter, WorkspaceRevision } from "./types.ts";

const CLEAN_GIT_ENV =
    "env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR -u GIT_OBJECT_DIRECTORY " +
    "-u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_NAMESPACE -u GIT_CEILING_DIRECTORIES " +
    "-u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS ";

export interface GitWorkspaceAdapterOptions {
    fileSystem: FileSystem;
    shell: Shell;
    context: Context;
    workspaceRoot: string;
    maxGitOutputBytes?: number;
    maxWorkspaceFiles?: number;
    maxSnapshotBytes?: number;
    maxSnapshotDurationMs?: number;
    excludePaths?: string[];
}

export class WorkspaceSnapshotError extends Error {
    readonly code = "workspace_snapshot_failed";

    constructor(message: string) {
        super(message);
        this.name = "WorkspaceSnapshotError";
    }
}

/** Create a snapshot adapter using only injected public capabilities and an explicit workspace root. */
export function createGitWorkspaceAdapter(
    adapterOptions: GitWorkspaceAdapterOptions,
): WorkspaceAdapter {
    return {
        async snapshot(): Promise<WorkspaceRevision> {
            const maxSnapshotDurationMs = adapterOptions.maxSnapshotDurationMs ?? 300_000;

            if (!Number.isSafeInteger(maxSnapshotDurationMs) || maxSnapshotDurationMs <= 0) {
                throw new WorkspaceSnapshotError(
                    "Workspace snapshot duration ceiling must be positive and finite",
                );
            }

            const controller = new AbortController();
            const context = withAbortSignal(controller.signal, adapterOptions.context);
            const options = { ...adapterOptions, context };
            const timeoutError = new WorkspaceSnapshotError(
                "Workspace snapshot duration ceiling exceeded",
            );

            let rejectTimeout: (reason: unknown) => void = () => {};

            const timeoutPromise = new Promise<never>((_resolve, reject) => {
                rejectTimeout = reject;
            });
            const timeoutHandle = setTimeout(() => {
                controller.abort(timeoutError);
                rejectTimeout(timeoutError);
            }, maxSnapshotDurationMs);

            try {
                return await Promise.race([
                    (async (): Promise<WorkspaceRevision> => {
                        const maxOutputBytes = options.maxGitOutputBytes ?? 16 * 1024 * 1024;
                        const maxWorkspaceFiles = options.maxWorkspaceFiles ?? 100_000;
                        const maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
                        const exclusions = normalizeExclusions(options.excludePaths ?? []);

                        if (!Number.isSafeInteger(maxWorkspaceFiles) || maxWorkspaceFiles <= 0) {
                            throw new WorkspaceSnapshotError(
                                "Workspace file-count ceiling must be positive and finite",
                            );
                        }

                        if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes <= 0) {
                            throw new WorkspaceSnapshotError(
                                "Workspace snapshot byte ceiling must be positive and finite",
                            );
                        }

                        const canonicalRoot = await options.fileSystem.canonicalPath(
                            options.workspaceRoot,
                            options.context,
                        );

                        if (!canonicalRoot.ok) {
                            throw new WorkspaceSnapshotError(
                                "Cannot resolve the explicit workspace root",
                            );
                        }

                        const prefix = await runGit(
                            options,
                            canonicalRoot.value,
                            "git rev-parse --show-prefix",
                            maxOutputBytes,
                        );

                        if (prefix !== "\n" && prefix !== "") {
                            throw new WorkspaceSnapshotError(
                                "Workspace root must be the Git repository root",
                            );
                        }

                        const headOutput = await runGit(
                            options,
                            canonicalRoot.value,
                            "git ls-tree -r -z --full-tree HEAD",
                            maxOutputBytes,
                        );
                        const headEntries = parseTreeEntries(headOutput).filter(
                            (entry) => !isExcluded(entry.path, exclusions),
                        );
                        const indexOutput = await runGit(
                            options,
                            canonicalRoot.value,
                            "git ls-files --stage -z",
                            maxOutputBytes,
                        );
                        const indexEntries = parseIndexEntries(indexOutput).filter(
                            (entry) => !isExcluded(entry.path, exclusions),
                        );
                        const indexFlags = await runGit(
                            options,
                            canonicalRoot.value,
                            "git ls-files -v -z",
                            maxOutputBytes,
                        );

                        rejectHiddenIndexFlags(indexFlags);
                        const untrackedOutput = await runGit(
                            options,
                            canonicalRoot.value,
                            "git -c core.excludesFile= ls-files --others --exclude-standard -z",
                            maxOutputBytes,
                        );
                        const untrackedPaths = nulPaths(untrackedOutput).filter(
                            (path) => !isExcluded(path, exclusions),
                        );
                        const trackedPaths = new Set([
                            ...headEntries.map((entry) => entry.path),
                            ...indexEntries.map((entry) => entry.path),
                        ]);
                        const workspacePaths = new Set([...trackedPaths, ...untrackedPaths]);

                        if (workspacePaths.size > maxWorkspaceFiles) {
                            throw new WorkspaceSnapshotError(
                                "Workspace exceeds the configured file-count ceiling",
                            );
                        }

                        let snapshotBytes = 0;
                        const worktreeState: WorkspacePathState[] = [];

                        for (const path of sortPaths([...workspacePaths])) {
                            const absolutePath = await options.fileSystem.joinPath(
                                [canonicalRoot.value, ...path.split("/")],
                                options.context,
                            );

                            if (!absolutePath.ok) {
                                throw new WorkspaceSnapshotError(
                                    "Cannot resolve an untracked workspace path",
                                );
                            }

                            const info = await options.fileSystem.fileInfo(
                                absolutePath.value,
                                options.context,
                            );

                            if (!info.ok) {
                                if (
                                    trackedPaths.has(path) &&
                                    (info.error.code === "not_found" ||
                                        info.error.code === "not_directory")
                                ) {
                                    worktreeState.push({ path, kind: "missing" });
                                    continue;
                                }

                                throw new WorkspaceSnapshotError(
                                    "Unsupported or unavailable untracked workspace path",
                                );
                            }

                            if (info.value.kind === "directory") {
                                if (!trackedPaths.has(path)) {
                                    throw new WorkspaceSnapshotError(
                                        "Git returned an unsupported untracked directory",
                                    );
                                }

                                await assertWithinWorkspace(
                                    options,
                                    canonicalRoot.value,
                                    path,
                                    true,
                                );
                                worktreeState.push({ path, kind: "directory" });
                                continue;
                            }

                            if (info.value.kind !== "file" && info.value.kind !== "symlink") {
                                throw new WorkspaceSnapshotError("Unsupported workspace file type");
                            }

                            if (!Number.isSafeInteger(info.value.size) || info.value.size < 0) {
                                throw new WorkspaceSnapshotError(
                                    "Workspace file size is not identifiable",
                                );
                            }

                            if (info.value.size > maxSnapshotBytes - snapshotBytes) {
                                throw new WorkspaceSnapshotError(
                                    "Workspace contents exceed the snapshot byte ceiling",
                                );
                            }

                            snapshotBytes += info.value.size;
                            let contentDigest: string;
                            let mode: string;

                            if (info.value.kind === "symlink") {
                                await assertWithinWorkspace(
                                    options,
                                    canonicalRoot.value,
                                    path,
                                    false,
                                );
                                const targetOutput = await runShell(
                                    options,
                                    canonicalRoot.value,
                                    `readlink ${shellQuote(absolutePath.value)}`,
                                    maxOutputBytes,
                                    [0],
                                );

                                if (
                                    !targetOutput.output.endsWith("\n") ||
                                    targetOutput.output.includes("\ufffd")
                                ) {
                                    throw new WorkspaceSnapshotError(
                                        "Unsupported or undecodable workspace symlink target",
                                    );
                                }

                                const target = targetOutput.output.slice(0, -1);

                                if (Buffer.byteLength(target, "utf8") !== info.value.size) {
                                    throw new WorkspaceSnapshotError(
                                        "Cannot identify the complete symlink target",
                                    );
                                }

                                contentDigest = sha256(target);
                                mode = "120000";
                            } else {
                                await assertWithinWorkspace(
                                    options,
                                    canonicalRoot.value,
                                    path,
                                    true,
                                );
                                const hashAndMode = await runGit(
                                    options,
                                    canonicalRoot.value,
                                    `git hash-object --no-filters -- ${shellQuote(absolutePath.value)} && { printf 'mode:'; if test -x ${shellQuote(absolutePath.value)}; then printf 100755; else printf 100644; fi; }`,
                                    maxOutputBytes,
                                );
                                const match = /^([a-f0-9]{40,64})\nmode:(100644|100755)$/.exec(
                                    hashAndMode,
                                );

                                if (!match) {
                                    throw new WorkspaceSnapshotError(
                                        "Git returned an invalid file identity",
                                    );
                                }

                                contentDigest = match[1]!;
                                mode = match[2]!;
                            }

                            worktreeState.push({
                                path,
                                kind: info.value.kind,
                                size: info.value.size,
                                mode,
                                contentDigest,
                            });
                        }

                        const workspaceId = sha256(
                            JSON.stringify([options.fileSystem.id, canonicalRoot.value]),
                        );
                        const digest = sha256(
                            JSON.stringify({
                                workspaceId,
                                headEntries,
                                indexEntries,
                                worktreeState,
                                exclusions,
                            }),
                        );

                        return {
                            workspaceId,
                            digest,
                            algorithm: "sha256",
                            coverage: "git-head-index-worktree-v1",
                        };
                    })(),
                    timeoutPromise,
                ]);
            } catch (error) {
                if (controller.signal.aborted) {
                    throw timeoutError;
                }

                throw error;
            } finally {
                clearTimeout(timeoutHandle);
            }
        },
    };
}

async function runGit(
    options: GitWorkspaceAdapterOptions,
    cwd: string,
    command: string,
    maxOutputBytes: number,
): Promise<string> {
    return (await runShell(options, cwd, `${CLEAN_GIT_ENV}${command}`, maxOutputBytes, [0])).output;
}

async function runShell(
    options: GitWorkspaceAdapterOptions,
    cwd: string,
    command: string,
    maxOutputBytes: number,
    acceptedExitCodes: number[],
): Promise<{ output: string; exitCode: number }> {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
        throw new WorkspaceSnapshotError(
            "Workspace command output ceiling must be positive and finite",
        );
    }

    let output = "";
    let outputBytes = 0;
    const result = await options.shell.exec(
        command,
        {
            cwd,
            env: {
                GIT_CONFIG_GLOBAL: "",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_OPTIONAL_LOCKS: "0",
                GIT_TERMINAL_PROMPT: "0",
            },
            timeout: 30,
            onOutput(text) {
                const bytes = Buffer.from(text, "utf8");
                const remaining = Math.max(0, maxOutputBytes - outputBytes);

                if (remaining > 0) {
                    output += bytes.subarray(0, remaining).toString("utf8");
                }

                outputBytes += bytes.byteLength;
            },
        },
        options.context,
    );

    if (
        !result.ok ||
        !acceptedExitCodes.includes(result.value.exitCode) ||
        outputBytes > maxOutputBytes
    ) {
        throw new WorkspaceSnapshotError("Workspace command failed or exceeded its output ceiling");
    }

    return { output, exitCode: result.value.exitCode };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

interface WorkspacePathState {
    path: string;
    kind: "missing" | "directory" | "file" | "symlink";
    size?: number;
    mode?: string;
    contentDigest?: string;
}

async function assertWithinWorkspace(
    options: GitWorkspaceAdapterOptions,
    workspaceRoot: string,
    path: string,
    includeFinalComponent: boolean,
): Promise<void> {
    const parts = path.split("/");
    const checkedParts = includeFinalComponent ? parts : parts.slice(0, -1);

    if (checkedParts.length === 0) {
        return;
    }

    const joinedPath = await options.fileSystem.joinPath(
        [workspaceRoot, ...checkedParts],
        options.context,
    );

    if (!joinedPath.ok) {
        throw new WorkspaceSnapshotError("Cannot resolve a workspace path component");
    }

    const canonicalPath = await options.fileSystem.canonicalPath(joinedPath.value, options.context);

    if (!canonicalPath.ok) {
        throw new WorkspaceSnapshotError("Cannot identify a workspace path component");
    }

    const relativePath = relative(workspaceRoot, canonicalPath.value);

    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new WorkspaceSnapshotError("Workspace path resolves outside the explicit root");
    }
}

interface GitTreeEntry {
    path: string;
    mode: string;
    objectId: string;
}

function parseTreeEntries(output: string): GitTreeEntry[] {
    const entries = nulRecords(output).map((record) => {
        const tab = record.indexOf("\t");

        if (tab < 0) {
            throw new WorkspaceSnapshotError("Git returned a malformed committed tree entry");
        }

        const [mode, type, objectId] = record.slice(0, tab).split(" ");
        const path = supportedGitPath(record.slice(tab + 1));

        if (mode === "160000" || type === "commit") {
            throw new WorkspaceSnapshotError(
                "Git submodules are not supported by this revision adapter",
            );
        }

        if (
            (mode !== "100644" && mode !== "100755" && mode !== "120000") ||
            type !== "blob" ||
            !/^[a-f0-9]{40,64}$/.test(objectId ?? "")
        ) {
            throw new WorkspaceSnapshotError(
                "Git tree contains an unsupported file mode or object",
            );
        }

        return { path, mode, objectId: objectId! };
    });

    return sortEntries(entries);
}

function parseIndexEntries(output: string): GitTreeEntry[] {
    const seen = new Set<string>();
    const entries = nulRecords(output).map((record) => {
        const tab = record.indexOf("\t");

        if (tab < 0) {
            throw new WorkspaceSnapshotError("Git returned a malformed index entry");
        }

        const [mode, objectId, stage] = record.slice(0, tab).split(" ");
        const path = supportedGitPath(record.slice(tab + 1));

        if (mode === "160000") {
            throw new WorkspaceSnapshotError(
                "Git submodules are not supported by this revision adapter",
            );
        }

        if (
            (mode !== "100644" && mode !== "100755" && mode !== "120000") ||
            stage !== "0" ||
            !/^[a-f0-9]{40,64}$/.test(objectId ?? "") ||
            /^0+$/.test(objectId ?? "") ||
            seen.has(path)
        ) {
            throw new WorkspaceSnapshotError("Git index contains an unsupported entry or conflict");
        }

        seen.add(path);

        return { path, mode, objectId: objectId! };
    });

    return sortEntries(entries);
}

function rejectHiddenIndexFlags(output: string): void {
    for (const record of nulRecords(output)) {
        const separator = record.indexOf(" ");

        if (separator !== 1 || record[0] !== "H") {
            throw new WorkspaceSnapshotError(
                "assume-unchanged or skip-worktree index states are unsupported",
            );
        }

        supportedGitPath(record.slice(separator + 1));
    }
}

function nulPaths(output: string): string[] {
    return sortPaths(nulRecords(output).map((record) => supportedGitPath(record)));
}

function nulRecords(output: string): string[] {
    if (output.length === 0) {
        return [];
    }

    if (!output.endsWith("\0")) {
        throw new WorkspaceSnapshotError("Git returned an incomplete path listing");
    }

    return output.slice(0, -1).split("\0");
}

function supportedGitPath(path: string): string {
    if (
        path.length === 0 ||
        path.includes("\ufffd") ||
        path.includes("\\") ||
        path.startsWith("/") ||
        path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
        throw new WorkspaceSnapshotError("Git returned an unsupported workspace path encoding");
    }

    return path;
}

function normalizeExclusions(paths: string[]): string[] {
    if (!Array.isArray(paths)) {
        throw new WorkspaceSnapshotError("Workspace exclusions must be an explicit path list");
    }

    const normalized = paths.map((path) => {
        if (
            typeof path !== "string" ||
            path.length === 0 ||
            path.startsWith("/") ||
            path.includes("\\") ||
            path.includes("\0") ||
            path.includes("\ufffd")
        ) {
            throw new WorkspaceSnapshotError(
                "Workspace exclusions must be normalized relative paths",
            );
        }

        const parts = path.split("/").filter((part) => part !== "" && part !== ".");

        if (parts.length === 0 || parts.some((part) => part === "..")) {
            throw new WorkspaceSnapshotError(
                "Workspace exclusions may not escape or exclude the root",
            );
        }

        return parts.join("/");
    });

    return sortPaths([...new Set(normalized)]);
}

function isExcluded(path: string, exclusions: string[]): boolean {
    return exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function sortEntries<T extends { path: string }>(entries: T[]): T[] {
    return entries.sort((left, right) => comparePaths(left.path, right.path));
}

function sortPaths(paths: string[]): string[] {
    return paths.sort(comparePaths);
}

function comparePaths(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
