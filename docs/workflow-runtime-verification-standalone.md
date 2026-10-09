# Standalone verification with the workflow runtime

The verification module is an application-level helper over the public Pi Durable execution
capabilities. It has no Pocket server, extension-loader, or UI dependency. In this repository, import
its supported surface from `packages/workflow-runtime/index.ts`; consumers may re-export that barrel
from their own package entry point. Do not couple applications to private `verification/*` internals.

The integration test `test/workflow-verification-host.test.ts` is a small programmatic consumer: it
opens a real Git worktree using `NodeExecutionEnv`, injects a durable host-safety attestation, runs a
bounded check, kills the host process after the verification result is committed, and reopens the
same durable store. Recovery returns the literal result without dispatching the check again.

## Host lifecycle

1. Construct host resources and a cross-restart `WorkspaceSafetyAdapter`. Its quiescence proof must
   come from host-owned durable or external evidence and remain authoritative across process death
   and all verification IDs. A process-local lock, matching snapshots, or a fresh ID is not enough.
2. Define workflow definitions and install their Task extensions in the Pi Durable registry **before**
   opening the Harness.
3. Open the Harness, construct `WorkflowEngine`, register the already-defined workflows, and call
   `engine.open(context)` before admitting new work. This restores/reconciles durable work using the
   same runtime path used by other hosts.
4. Start a new workflow only after recovery is open. A workflow invokes `verify()` with its durable
   `WorkflowContext`, an immutable `VerificationRequest`, and injected adapters. Use stable workflow
   and verification IDs across recovery.
5. For an operator stop, call `engine.stop(runId, reason, context)` and observe the stopped/wait
   outcome. Do not convert a selected workflow stop into a normal `VerificationResult`.
6. On orderly shutdown, close the engine, close the Harness, then clean up host-owned execution
   resources. A process crash cannot run cleanup; keep workspace safety unknown until the host
   independently proves quiescence.

## Example adapter and workflow composition

The import specifier below is illustrative. In this repository, use the public barrel at
`../packages/workflow-runtime/index.ts` (relative to a consumer in `docs/`) or the package entry point
that your application exposes.

```ts
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    createGitWorkspaceAdapter,
    defineWorkflow,
    validateVerificationManifest,
    verify,
    WorkflowEngine,
    WorkflowRuntimeTask,
    type VerificationAdapters,
    type VerificationManifest,
    type VerificationRequest,
    type VerificationResult,
    type WorkflowContext,
    type WorkspaceSafetyAdapter,
} from "@your-application/workflow-runtime";

const context = BACKGROUND_CONTEXT; // A TUI/host may supply its own Chord Context.
const userSelectedWorkspace = applicationWorkspaceRoot();
const databasePath = applicationWorkflowDatabasePath();
const hostVerificationCeilings = applicationVerificationCeilings;
const hostManifest = applicationVerificationManifest;
const workflowInput = { verificationId: "verify-release-42", manifest: hostManifest };
const runId = `verification:${workflowInput.verificationId}`;
const workspaceRoot = resolve(userSelectedWorkspace);
const execution = new NodeExecutionEnv({ cwd: workspaceRoot });

const workspace = createGitWorkspaceAdapter({
    fileSystem: execution,
    shell: execution,
    context,
    workspaceRoot,
});

// Implement this with the host's durable gate/quiescence evidence. Fail closed if it is missing,
// stale, uncertain, or invalidated; never infer quiescence from matching snapshots alone.
const safety: WorkspaceSafetyAdapter = hostOwnedWorkspaceSafetyAdapter;

const adapters: VerificationAdapters = {
    workspace,
    safety,
    shell: execution,
    context,
    async environmentForPolicy(policyId, check, hostContext) {
        // Resolve only the declared host policy. Do not serialize environment values or expose
        // secrets to trusted commands/results unless the host has an approved policy for doing so.
        return await hostEnvironmentPolicies.resolve(policyId, check, hostContext);
    },
};

const workflow = defineWorkflow({
    id: "application.verify",
    version: 1,
    async run(workflowContext: WorkflowContext<JsonValue>) {
        const input = workflowContext.input as {
            readonly verificationId: string;
            readonly manifest: VerificationManifest;
        };
        const subjectRevision = await workspace.snapshot();
        const manifest = await validateVerificationManifest(input.manifest, {
            workspaceRoot,
            ceilings: hostVerificationCeilings,
            fileSystem: execution,
            context,
        });
        const request: VerificationRequest = {
            verificationId: input.verificationId,
            workspaceId: subjectRevision.workspaceId,
            subjectRevision,
            manifest,
            runner: { id: "application-verifier", version: "1" },
        };
        const result = await verify(workflowContext, request, adapters);

        // Workflow results must be JSON values. Keep the durable result bounded and do not attach
        // raw output, environment values, spill paths, or other host-private data.
        return result as unknown as JsonValue;
    },
});

const registry = createRegistry();
registry.install(
    defineExtension({ name: "application.workflow-runtime", tasks: [WorkflowRuntimeTask] }),
);

// Create all definitions/extensions before Harness.open. Register the definition with the engine
// before engine.open so persisted runs can be resumed by the same handler.
const storage = await openNodeSqliteStorage(databasePath);
const harness = await Harness.open(storage, { models: createModels(), registry }, context);
const engine = new WorkflowEngine(harness);
engine.register(workflow);
await engine.open(context);

try {
    const handle = await engine.start(workflow, workflowInput, { runId }, context);
    const result = await engine.wait(handle.runId, context);
    consumeVerificationResult(result as VerificationResult);
} finally {
    await engine.close();
    await harness.close(context);
    await execution.cleanup(context);
}
```

In a long-lived host, call `engine.open()` once during startup, then wait on the existing stable
`runId` for recovered work. Admit new runs only after recovery has completed. The workflow's request
binding is keyed by `verificationId`; changing the subject revision, command, cwd, environment-policy
identity, runner version, or bounds under that ID fails closed before command dispatch. A new ID is a
distinct logical verification, not a safety override.

The example returns the `VerificationResult` itself. The request is bound to the deterministic
workspace revision, and a passing result additionally requires a valid final snapshot and a
quiescence attestation at promotion. The Git adapter identifies supported committed/index/worktree
content but does not make the workspace immutable, sandbox commands, stop external writers, or prove
that no change-and-restore race occurred. Commands are trusted manifest input. Keep secrets out of
command environments and durable output according to host policy.

## TUI and other host use

A TUI is one host of the same runtime, not another verification mode. Its event handler may collect a
manifest and call the same `engine.start`; the workflow calls the same exported `verify()` with the
same injected workspace, safety, Shell, environment-policy, and Context capabilities. The UI can
observe the workflow through the normal runtime inspection/wait APIs and request a stop through
`engine.stop`. It must not run checks in a second scheduler or bypass recovery.

Other applications use the same sequence. Their differences belong in injected resources: storage,
Chord `Context`, execution environment, workspace implementation, safety evidence, and environment
policy. The helper itself does not read Pocket settings, use a Pocket Git module, or depend on a
server loader. `NodeExecutionEnv.cleanup()` remains the host's responsibility; the verifier does not
own or silently discard host cleanup/quiescence obligations.
