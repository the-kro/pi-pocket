# Pi Durable workflow feasibility ledgers

This is a running evidence log for the interpreter feasibility spike. It supplements the scope, crash matrix, and decision rubric in this packet. Preserve the separate Pi Durable external-wake patch while the spike runs.

## Patch ledger

| Area | Paths / size | Purpose | Verification |
|---|---|---|---|
| External wait/wake primitive (pre-existing spike work) | Pi Durable: `packages/durable/src/types.ts`, `src/session/transaction.ts`, `src/harness/types.ts`, `src/harness/scheduler.ts`, `src/harness/task-graph.ts`; README/spec; external-wake harness test + fixture. Current tracked source/docs diff: +119/−13 across 7 files; the two new tests are 495 LOC total. | Atomically persist an idempotent external wake request; let externally waiting tasks be made runnable after restart. | Prior focused/full-source evidence and independent review are recorded in the session handoff; preserve all files and existing untracked state. |
| Imperative interpreter tracer bullet | Pi Durable test-only prototype: `packages/durable/test/workflow-spike/interpreter.ts`, `test/workflow-interpreter.test.ts`, and `test/fixtures/workflow-interpreter-crash-worker.ts`. | One durable Workflow Task replays named steps; `step.do` memoizes results, retries known failures, and offers explicit uncertain-effect recovery with a stable workflow/step idempotency key and invocation abort signal. Sleep/event waits are nonresident; serial child workflows join through owned Tasks. | Focused SQLite suite passes: 19 tests, including real Pi Durable generation via deterministic faux provider plus owned-agent abort, child Task join/ownership and collision-free nested child IDs, explicit compensation, 16 send-vs-park race iterations, concurrent-step drain tests, timer rearming with the sleeper on a later cursor page, and SIGKILL recovery with effect-present/effect-absent branches. |

The prototype is intentionally outside Pi Durable's shipped `src/` and outside Pi Pocket's product source. It is feasibility evidence, not a production-ready API or a dependency change.

## Friction ledger

| Friction | Evidence / impact | Disposition |
|---|---|---|
| Pi Pocket consumes Pi Durable 1.0.2 while the wake primitive is an uncommitted source-repository patch. | Direct host integration would first require linking or changing package resolution in the running Pi Pocket workspace; server changes also require a restart. | Keep the interpreter experiment in the Pi Durable source test harness until it proves useful. No Pi Pocket product source has been changed and the running server remains untouched. |
| Standalone Pi Durable build typecheck cannot resolve generated workspace declarations for `@earendil-works/chord` (69 diagnostics, starting with missing `packages/chord/dist/index.d.ts`). | The focused Vitest source config resolves source directly and runs the new tracer bullet. This is a build-order/config prerequisite, not yet a workflow architectural problem. | Do not upgrade dependencies or broaden the spike to repair monorepo builds. Revisit only if a build path is needed for a production-readiness claim. |
| Existing full-suite limitations remain. | The full source suite previously had an unrelated missing generated Bedrock model-data file; Pi Pocket's existing full suite has a `/private/var` vs `/var` assertion mismatch. | Keep these separate from interpreter results; do not alter unrelated fixtures or tests. |
| Retaining a document-draft proxy past its transaction caused `Cannot use a settled overlay` when the workflow resumed. | The waiter stored the selected event object from `tx.doc()` and read it after `runtime.commit()` completed. The focused event tests reproduced it; the stack pointed to the post-commit read. | Copy the selected JSON event inside the transaction before carrying it across the boundary. Both event tests now pass. Prevention: transaction-scoped draft values must be detached before use after commit. |

## Semantic and crash evidence

- Workflow source is invoked from its beginning. `step.do("plan", ...)` commits its `running` record and then its result before the next operation; a later invocation returns the stored result without calling the callback again.
- `step.sleepUntil("pause", deadline)` stores an absolute deadline, changes the parent Workflow Task to an external wait, and throws an internal suspension signal. The invocation ends instead of waiting for the deadline in memory.
- The test closes and reopens the SQLite-backed Harness before and after the deadline. Before the deadline the task remains parked; after it, the timer service wakes it and the re-entered workflow completes.
- `finally` executes when suspension unwinds the JavaScript stack. The current test observes one `finally` execution at the first suspension and another on final completion. This is a semantic caveat: `finally` is not deferred until workflow completion, and irreversible cleanup must not be placed there without an explicit compensation/idempotency policy.
- Event delivery appends the mailbox item, semantic journal receipt, and idempotent task wake in one transaction. Event waits atomically inspect/consume the mailbox or commit an external wait, so an event arriving before or after the park commit is not lost.
- The event-before-wait test delivers while a `step.do` callback is holding the workflow invocation; the event is consumed when execution reaches the wait. The offline test closes the Harness, reopens SQLite, then delivers the event and verifies replay. Repeated delivery with the same ID returns false and is consumed once.
- The event suite also runs 16 alternating send-vs-park cases (event sent as the workflow reaches the wait or after the external park is visible). Each verifies one consumption, same-ID duplicate idempotency, and rejection of same-ID/different-payload reuse. This is bounded race stress, not a concurrency proof.
- Parallel `step.do` operations are tracked and joined before a sibling can park the workflow, before failure is committed, and before successful completion. A callback cannot invoke another workflow step; one suspending operation is allowed per invocation. Tests hold a sibling effect while another branch suspends or fails and verify the parent has not parked/settled early.
- On engine reopen, the timer rearm scan filters to waiting Workflow Tasks and walks every cursor page. A test parks 257 earlier matching event-waiting workflows, then a sleeping workflow, closes/reopens SQLite, and verifies the sleeper on the later cursor page is scheduled.
- Child workflow IDs encode each step-ID segment before appending it to the parent ID. A red/green regression test verifies a slash-containing sibling step (`a/b`) does not collide with nested child steps (`a`, then `b`).

- Crash matrix: after a completed `plan` step and while parked, SIGKILL/reopen re-enters after the saved checkpoint and logs exactly one `plan` and one `finish`. During `step.do`, the worker records an external effect, is SIGKILLed before returning, then a fresh process's recovery callback reconciles the stable key and returns the saved result without repeating the effect. A second kill before the effect is recorded makes recovery choose `retry`, after which attempt 2 creates exactly one effect. The first uncertain-effect assertion was run RED and observed `EFFECT:missing-key` on re-entry; the recovery implementation then made the test pass.
- The agent probe uses the real Pi Durable conversation submission/generation/task path with a deterministic faux provider, and supplies the step's stable idempotency key as the submission request ID. The step receives the TaskRuntime invocation signal; the agent conversation is task-owned, and an abort test confirms the waiter and generation task both settle. No live model/network call was made.
- Child composition atomically creates the child Workflow Task, child state document, and parent's child-wait checkpoint in one transaction. TaskGraph confirms the child is owned by the waiting parent; the parent returns the memoized child result after wake/replay.
- Compensation is explicit user code: a named `release-reservation` `step.do` runs after a failed charge and is memoized. There is no automatic saga/compensation API. `finally` still runs during suspension unwind, so it must not be treated as a completion-only hook.

## Review and verification

- Pre-refactor independent read-only review of the interpreter, workflow tests, and scheduler timer-rearm loop returned READY. It confirmed the `a/b` sibling child ID is `.../a%2Fb`, distinct from the nested `a` then `b` ID `.../a/b`; it found no concrete defect. Earlier review cycles found and drove regressions for suspension admission, owned-agent abort propagation, timer cursor pagination, and child-ID collisions.
- Pre-refactor verification: Biome clean on the three prototype files; strict targeted TypeScript check clean; Pi Durable source suite 44 files, 883 passed, 1 skipped (the provider-session-cache e2e requiring missing generated Bedrock model data was excluded); `git diff --check` clean. The two focused files contain 19 workflow tests and 8 external-wake tests (27 total).
- Pre-refactor footprint in Pi Durable: tracked source/docs diff +119/−13 across seven files (the external-wake behavior itself changes five source files by +85/−8); external-wake test and fixture are 495 LOC. The test-only workflow interpreter is 1,070 LOC, its test file 1,015 LOC, and crash worker 111 LOC. These counts overlap with test infrastructure only where noted; no dependencies were changed. Pi Pocket has no tracked product-source changes and the server was not restarted. Existing untracked state was preserved.

## Architectural cleanup and frozen comparison evidence

The bounded refactor is complete. It adds no workflow features and changes no demonstrated workflow semantics. All original workflow/external-wake tests and crash fixtures remain byte-identical. No Pi Durable core source, dependencies, Pi Pocket product source, or running-server configuration changed; no server restart or commit was performed.

### Measured implementation footprint

Counts are physical lines, including comments/formatting; tests/docs are excluded. Count every implementation file, not just the smaller entrypoint.

| Module in `packages/durable/test/workflow-spike/` | Before LOC | After LOC | Responsibility |
|---|---:|---:|---|
| `interpreter.ts` | 1,070 | 941 | Public spike API, durable model, typed semantic events, atomic transition writer/projector, named primitive semantics, Pi Task binding and engine ingress/inspection |
| `invocation.ts` | 0 | 83 | Internal OPEN/QUIESCING/DRAINING/PARKED coordinator, ALS callback origin, same-turn effect admission, snapshot drains, conflict and committed-park tracking |
| `timer-host.ts` | 0 | 86 | Resident host adapter: subscribe-before-scan, paginated rearm, deadline timers, idempotent Task wake, cleanup and diagnostic policy |
| **Total implementation** | **1,070** | **1,110** | **+40 net (+3.7%); no net LOC reduction** |

Approximate responsibility allocation across the mixed implementation, not measured standalone adapter sizes:

| Responsibility | Approx. LOC |
|---|---:|
| Generic workflow semantics/model/validation/coordinator | 640 |
| Pi-specific Task/transaction/ownership/read adapter glue | 170 |
| Host/timer integration (entire isolated module) | 86 |
| Semantic journal/projection/persistence machinery | 214 |
| **Total** | **1,110** |

The last two categories also contain Pi-bound document/entry/observation calls. For substrate comparison, allow approximately **200–250 LOC of direct Pi coupling** across these categories, rather than presenting the 170-LOC primary adapter estimate as all adoption cost. The isolated timer host is counted separately, not hidden from runtime totals. Generic workflow semantics remain approximately 640 LOC; common journal/read-model storage adds its own retained cost on any substrate.

The external-wake core patch remains **+85/−8 implementation lines across five source modules** (77 net); including README/spec the pre-existing tracked diff remains +119/−13 across seven files. Its two original tests/fixture remain 495 LOC, excluded from implementation counts. A byte comparison against the pre-refactor core/source-doc patch snapshot confirms no changes to this patch.

### Architecture and authority

```text
WorkflowEngine / WorkflowTask
  ├─ named do/sleep/event/child semantics (interpreter-local)
  │    ├─ InvocationCoordinator (invocation.ts)
  │    └─ writeTransition
  │         ├─ projectStep / retained materialized history
  │         ├─ explicit typed workflowEvent envelopes
  │         └─ runtime.commit → latest checkpoint + docs + journal + Pi state
  └─ WorkflowTimerHost (timer-host.ts)
       └─ Task subscription/startup scan → host timer → idempotent wakeTask
```

Eight independently authored Task commit paths converge on **one `runtime.commit` transition writer**; five historical step-projection writers converge on **one projector**. Primitive decisions remain explicit, with custom mailbox/child work performed inside the same transaction. Root/child initialization and external event ingress retain their distinct atomic transactions and authoritative locator/mailbox updates. Standard journal envelope construction is centralized; meanings and append order remain caller-selected, never inferred from a state diff. The relative-sleep temporary Map is gone.

Authority remains: live Pi checkpoint is execution/replay truth; terminal Pi outcome is outcome truth; mailbox and workflow-to-Task locator are authoritative ingress/identity; journal is immutable historical truth; step summaries/currentStep/waitingFor are observational; local steps are a replay cache. Materialized step history is retained after Pi discards terminal checkpoints. `currentStep` is not a unique concurrency cursor.

The timer adapter accepts an optional **`onTimerError` diagnostic policy (must not throw)** and reports to `console.error` by default instead of silently discarding a wake commit failure. This is the only intentional diagnostic surface change; it does not retry, decide an outcome, or append new workflow history. A separate additive test forces a wake after Harness closure and verifies reporting without rearming. None of the original 19 workflow or 8 wake tests changed.

### Refactor friction and verification

- The first extraction pass increased source to 1,092 LOC rather than achieving the earlier review's anticipated reduction. Final module extraction/reporting yields 1,110 LOC. Explicit coordinator/event/transition types consume savings from deleted repeated persistence. The meaningful reduction is independently maintained persistence paths, not source size; do not use entrypoint shrinkage as evidence of modest glue.
- Targeted TypeScript initially exposed a generic Task outcome error lacking the workflow error `name`; the internal transition type now explicitly describes the three already-supported outcome forms. No behavior or validation was removed.
- One verification attempt misspelled the existing exclusion as `provider-session-cache.e2e.test.ts`, loading the unrelated missing Bedrock-model-data test. The final command uses the previously documented **`provider-session-cache-e2e.test.ts`** exclusion; no dependency/config/fixture repair was made.
- Timer reporting was tested RED (no callback received) before implementation, then GREEN. A preliminary test invocation incorrectly used assertions rather than boolean predicates with `eventually`; the test setup was corrected before accepting the intended RED. Existing workflow behavior uses authorized green-to-green refactoring, not a claimed new RED/GREEN feature cycle.
- Repository-wide `npm run check` was not run: it begins with `biome --write` over the entire repository and could mutate unrelated pre-existing work. The requested strict targeted TypeScript, scoped read-only Biome and whitespace checks were run instead. No root build/check claim is made.

Final commands (from Pi Durable repository/package roots as indicated):

```sh
# packages/durable: original focused tests plus one additive reporting probe
node ../../node_modules/vitest/dist/cli.js --run --config .vitest-source.config.ts \
  test/workflow-interpreter.test.ts test/harness-external-wake.test.ts test/workflow-timer-host.test.ts
# packages/durable: same source-suite exclusion as before
node ../../node_modules/vitest/dist/cli.js --run --config .vitest-source.config.ts \
  --exclude '**/provider-session-cache-e2e.test.ts'
# repository root: strict/noEmit, source aliases, all spike modules and focused tests/fixtures
node_modules/.bin/tsc -p /tmp/pi-workflow-refactor-tsconfig.json
node_modules/.bin/biome check packages/durable/test/workflow-spike \
  packages/durable/test/workflow-interpreter.test.ts packages/durable/test/workflow-timer-host.test.ts \
  packages/durable/test/fixtures/workflow-interpreter-crash-worker.ts
git diff --check
```

Results: focused **3 files / 28 passed**; source suite **45 files / 884 passed / 1 skipped**; strict targeted TS clean; Biome **6 files clean**. Original four test/fixture hashes match; the original core/source-doc patch remains byte-identical. Untracked implementation whitespace is checked separately because `git diff --check` does not inspect untracked files.

Fresh independent read-only review (`review-code`, run `354209df-6ac8-4905-a74c-192fcc7fb452`) returned **READY, no material findings** over the complete cumulative change against the captured original source. The reviewer independently ran the 28 focused tests, strict targeted TS and scoped Biome, and inspected the broader-suite evidence. No review repairs were needed. Verification logs and original/source preservation snapshots are under `/tmp/pi-parent-*.log`, `/tmp/pi-workflow-*`, and `/tmp/pi-timer-report-red.log`; these are local supporting artifacts, not shipped dependencies. The transient TS config extends root source aliases with strict/noEmit and explicitly includes the spike directory plus workflow/timer/wake tests and crash fixtures.

### Freeze assessment

Accidental complexity is materially reduced in locality and authority, **not LOC**. The remaining runtime is mostly necessary workflow semantics plus retained journal/read-model infrastructure. Pi-specific adoption burden is **moderate**, not demonstrated to be negligible: a small separate core patch, direct adapters, and resident host integration remain. This is representative enough to freeze for architectural comparison with the existing DSH runtime; it does not justify adoption or a migration.

Do not continue implementation from this packet. Further ideas (production registration, richer recovery/error states, broader concurrency/child composition, timer failure retries, alternate read models, finer primitive file splits) remain outside the frozen spike and require separate authorization. All previously recorded semantic/crash limits remain.

## Provisional feasibility verdict: Unclear

- The hard behaviors were demonstrated in an isolated SQLite-backed test harness: replay and memoized results, durable sleep across reopen, event wake, uncertain-effect reconciliation, child ownership/join, and owned-agent abort. Pi primitives provide useful task ownership, atomic transaction, TaskGraph, storage, and cancellation foundations; the remaining core change is localized to a cross-cutting external-wake primitive.
- This does **not** yet demonstrate “modest glue”: after cleanup the test-only runtime is 1,110 LOC across three implementation files (941 in the entrypoint), with generic workflow semantics and Pi-specific costs separated above. It still owns event mailbox/journal semantics, timer rearming, retries/recovery, child orchestration, and workflow projection. The source patch is small in LOC but spans five Pi Durable source modules. No Pi Pocket product integration was attempted.
- Without a direct comparison against the existing DSH implementation, the spike cannot establish that Pi materially reduces three-year maintenance friction. Treat the result as “technically feasible; adoption not justified yet,” and compare the implementation/friction evidence before considering a narrow MVP. Do not start a migration from this spike alone.

## Remaining limits

1. Recovery is opt-in; without a `recover` callback, interrupted `step.do` callbacks are at-least-once. Recovery callbacks can themselves be interrupted and re-run; use a queryable/idempotent external effect, and decide how production callers want recovery-handler failure surfaced.
2. The child probe handles one serial child join; parallel child joins, cancellation/abort precedence during an event wake, and full event/wake commit crash interleavings remain out of scope. Step callbacks cannot invoke nested workflow steps; `sleep`, event, and child operations must be awaited. The external-wake patch's own SIGKILL park/wake rollback tests remain separate evidence.
3. Compensation is explicit and no crash was injected during the compensation effect. The faux provider validates real Pi Durable generation orchestration and cancellation, but not a live provider, billing ambiguity, or request-provider idempotency.

## Authorized Pi Pocket workflow-runtime port

A subsequent explicit task authorized the bounded port below. Statements above that Pi Pocket had no product-source integration describe the earlier frozen-spike snapshot; they remain historical evidence and are superseded for current state by this section. The provisional feasibility verdict remains **Unclear**.

- **Frozen source:** Pi Durable checkout at `cd32f7725fdbddbaecdff5b1e68491563394e0ca`; `packages/workflow-runtime/{interpreter,invocation,timer-host}.ts` are byte-identical to the frozen files under `packages/durable/test/workflow-spike/`. The workflow semantics were not changed. `index.ts` is a re-export surface only.
- **Pocket integration:** `src/server/extensions/workflows.ts` only registers `WorkflowTask`; it adds no tools, handlers, workflow definitions, or UI. The loader marks it required so persisted tasks cannot be disabled out of the registry. `PocketApp` owns one `WorkflowEngine` for its Harness: it opens the timer host after the extension registry/Harness are ready and before resume; shutdown closes the engine before closing the Harness. The Node adapter uses absolute deadlines, bounds each `setTimeout` interval to Node's maximum delay, and cancels timers on close. Extension reload only replaces task registration and does not construct or subscribe another runtime.
- **Reload/restart evidence:** a real SQLite integration test seeds a parked sleep, opens Pocket to re-arm it, reloads the workflow extension twice, and verifies the same engine remains with no new Harness commit subscriptions. It closes the app twice and observes one engine close and no late wake against the closed Harness; a fresh PocketApp/Harness then re-arms the expired timer and completes the workflow. The required-extension test and this lifecycle test were each observed failing before their respective wiring and passing afterward.
- **Installed package boundary:** workflow, timer-host, and SIGKILL recovery tests use Node's built-in test runner and public exports from the installed pnpm-patched `@earendil-works/pi-durable@1.0.2`, including its public SQLite adapter subpath. The crash worker no longer uses `--conditions=source`; no test or runtime file imports from the sibling checkout. The installed package and patch hash were rechecked: `279ffa595e572aba36b64e595382d23697bf97eace611ab8126b26d249b013d3`. The existing external-wake patch was not changed.
- **Verification:** the 19 interpreter tests plus timer-host test pass (**20/20**); workflow extension/app lifecycle tests pass (**2/2**); the changed extension settings/reload test passes (**1/1**). `pnpm run check`, `git diff --check`, and the trailing-whitespace scan of added files pass. Full `pnpm test` reports **76/77**: its sole failure is the already-known macOS `/private/var` vs `/var` path assertion at `test/app.test.ts:865`; all new workflow and existing external-wake tests pass.
- No dependency upgrade, new dependency patch, product tool/route/UI, commit, or server restart was performed. The running server has not loaded the new `app.ts` lifecycle code; the workflow extension module itself has no timer/resource side effects if reloaded. Workflow definitions and user-facing workflow operations remain future work and are intentionally absent. Provider/billing behavior, parallel child joins, additional crash interleavings, and compensation crash recovery remain unprobed as noted above.

Independent read-only review (`review-code`, run `88bbc570-b92d-440e-b18a-93d40d3e9ec3`) returned **READY** with no material correctness, maintainability, scope, or regression findings. The reviewer independently confirmed the frozen-copy/package boundary, lifecycle and extension-reload coverage, and verification evidence. No review repairs were needed.
