# Standalone Review host lifecycle

`packages/workflow-runtime/index.ts` is the public root for the portable workflow runtime. It exports
`createWorkflowAgentRuntime`, the host/runtime types, `defineWorkflow` and `WorkflowContext`, plus
`review`, `ReviewRequest`, `ReviewResult`, and the Review result binding. Consumers should import from
that root rather than from `agents/host.ts` or `review/review.ts`.

The host supplies Pi Durable's `Models`, `Registry`, `Storage`, configured agent profiles, and the
workspace/safety adapters. Review uses the same public workflow and agent runtime whether the host is
a programmatic process or a TUI. Pocket's server loader, settings, and hot reload are not part of this
lifecycle.

## Bootstrap and run

Install application extensions and the runtime extension, and register workflow definitions before
calling `openHost`. Use that controlled startup method as the only point where the runtime attaches to
the Harness and starts recovery:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
    createWorkflowAgentRuntime,
    defineWorkflow,
    review,
} from "../packages/workflow-runtime/index.ts";

const models = createModels();
const registry = createRegistry();
const runtime = createWorkflowAgentRuntime({
    harnessOptions: { models, registry },
    agentConfig: {
        profiles: [reviewerProfile],
        authority: hostReadOnlyAuthority,
        review: {
            profileAllowlist: [reviewerProfile.id],
            authority: reviewReadOnlyAuthority,
        },
    },
});

registry.install(readOnlyReviewTools);
registry.install(runtime.extension);
runtime.register(reviewWorkflow);

const storage = await openNodeSqliteStorage(databasePath);
const host = await runtime.openHost(storage, BACKGROUND_CONTEXT, (setup) => {
    setup.subscribeCommits(onCommit);
    setup.onAfterAdapterRecovery(async (recovered) => {
        await restoreHostViews(await recovered.inspect());
    });
    setup.onCleanup(unsubscribeFromHostEvents);

    return hostPreparation;
});

try {
    // Start, wait, and send durable workflow events only after openHost resolves.
    await runtime.engine.start(reviewWorkflow, reviewInput, { runId }, BACKGROUND_CONTEXT);
    const result = await runtime.engine.wait(runId, BACKGROUND_CONTEXT);
    consumeReviewResult(result);
} finally {
    await host.dispose();
    await runtime.close();
    await host.harness.close(BACKGROUND_CONTEXT);
}
```

The example's import from `../packages/workflow-runtime/index.ts` is the repository source entrypoint;
replace it with the installed package's root specifier when consuming a packaged build. Do not import
private implementation files. The offline acceptance test, `test/workflow-review-host.test.ts`, uses
only this root entrypoint and public Pi Durable/Pi AI APIs.

`openHost` calls the supplied preparation function while the Harness is available but workflow progress
is still paused. Register `onAfterAdapterRecovery` there for host state that depends on recovered agent
state. That callback runs after adapter recovery and before the workflow engine opens. `openHost` only
returns after startup and recovery complete; do not start or schedule work before it resolves. The
preparation object is scoped to startup: use its cleanup registration for resources that must be
released with the host, and do not retain setup operations for later calls.

Review itself is the same `review(context, request, adapters)` operation in either host. Supply the
successful revision-bound `VerificationResult`, runtime-resolved reviewer identity, and injected
workspace and safety adapters; install any read-only reviewer tools through the normal Pi Durable
registry. Do not add a Pocket-only review scheduler or call a provider directly.

## TUI lifecycle

A TUI host follows the same order:

1. Build the configured `Models` and `Registry`; install application/tool extensions and configure the
   reviewer profile, result binding, read-only authority ceiling, and Review allowlist.
2. Create `WorkflowAgentRuntime`, install `runtime.extension`, and register workflow definitions.
3. Open the durable `Storage` and call `runtime.openHost(storage, context, prepare)`.
4. Register commit/UI subscriptions during `prepare`; use `onAfterAdapterRecovery` to refresh views
   from recovered state. Keep workflow controls disabled until `openHost` resolves.
5. Route Review, waits, and events through the same workflow engine and `review()` contract used by
   programmatic hosts.
6. On shutdown, dispose host setup, close the runtime, then close the Harness.

The UI may display progress or offer controls, but it does not own another scheduler, recovery path,
reviewer conversation, or verdict format. Pocket hot reload is optional and is not required for this
portable lifecycle.

## Ownership and startup failure

The host owns the Harness attachment and the runtime owns the workflow engine. A successful
`openHost` returns both the prepared value and the attached Harness; `host.dispose()` releases setup
resources, `runtime.close()` closes the workflow runtime, and `host.harness.close(context)` closes the
Harness and its storage. Keep this order and close each resource once.

If startup fails after Harness acquisition, `openHost` unwinds resources it acquired and reports
cleanup failures with the startup failure; Harness acquisition also reports partial-open cleanup
failures. Setup cleanup handlers run in reverse registration order. A failure before Harness
acquisition leaves the supplied storage with its caller (for example, startup rejected before the
Harness could acquire it). Do not blindly close storage again in every `openHost` catch path: the
Harness may already have performed partial-acquisition cleanup. Close storage directly only when the
caller knows acquisition never began; otherwise preserve the original/aggregate startup error and let
the owner that acquired the resource close it.
