# Target 3 — executable native agent-adapter plan

**Plan format:** crywolf-start-work/v1

Status: Target 3 offline implementation is complete and user-approved after independent review (CodeReviewer READY; Oracle ADVISED with no concrete blocker). The implementation was committed as `2c82c53`; the organization-only host/recovery extraction is complete and remains uncommitted for review. No durable workflow receipt or live-provider acceptance is claimed. The latest full repository run passed 341/342 tests; the sole failure is the known browser test at `test/browser.test.ts:659` (`204 !== 200`).
Contract: [target-3-agent-adapter-spec.md](target-3-agent-adapter-spec.md), requirements A1–A9,
evidence E1–E9. The prior confirmed scope and the latest semantic revision are recorded in that contract.
The full exact scope question/answer and tentative-approval qualification are recorded in that contract.
Previous explicit scope approval is preserved. The subsequent portability refinement and docs-only
repair were approved with the exact answer:

> APPROVED - Let's make the changes needed to the spec/plan.

That portability revision's fresh READY is historical document review, not implementation or live-provider acceptance. The user's later direct-salvage authorization and provider-retry contract revision supersede the old docs-only boundary.

## Boundaries and prerequisites

This implementation was directly salvaged after orchestration failure and user-approved; no durable workflow receipt was created. Commit `2c82c53` records that implementation. The current host/recovery extraction is a separate, uncommitted organizational refactor. The companion contract and canonical portability policy remain the governing constraints;
[the architecture rule](../pi-durable-production-runtime-v0/01-architecture.md#host-portability-and-earned-integration-seams)
guides this plan and future runtime plans. No planner repair, dependency install/upgrade, restart, or live-provider call is authorized by this record.

The implementation preserves current Targets 1/2 in `packages/workflow-runtime/core/index.ts`.
Use installed Durable 1.0.2 public exports; `node_modules/.../dist` internals are inspection evidence,
not import seams. Root `packages/workflow-runtime/index.ts` exports core and shared kernel;
`src/server/extensions/workflows.ts` registers its native Task before Harness.open; Pocket owns its
Harness-bound engine. Historical Target 1 artifacts are not current implementation authority.

Do not add Verify, Review policy/verdicts, StartWork, UI or migrations. A fixture profile called reviewer
proves read-only authority, not Target 5. Delegation stays disabled. No duplicate scheduler, custom
provider transport, role engine or native core patch. No stored-kind rename/scope/history/fork changes.

### Execution discipline

Each task is independently reviewable/verifiable; internal tasks need not have a user-facing demo.
For changed behavior: one public-seam failing test, observed intended RED (not syntax/import error),
minimal GREEN, bounded local refactor, then next test. Use literal independent expected results and
external dispatch counters, not the implementation's identity calculator as its expected-value oracle.
Real native storage/Tasks are collaborators; script Models/provider and dangerous effects at their
external boundary only. Existing green core tests are regression evidence, never the new RED.
Record actual RED/GREEN commands and outcomes per task. A material feasibility failure stops work
with concrete evidence; do not silently change the currently approved contract or fall back to upgrades/core patches.

Future baseline commands from repository root:

```text
npm run check
npm run lint
npm test
```

Use focused `node --test test/<named-file>.test.ts` runs below first. After future source edits, apply
repository formatting and rerun checks; inspect the formatting diff to avoid unrelated edits. For a
live Pocket host, server changes require a later operator restart, never during a tool call. The T3
runtime and this host/recovery extraction do not edit `src/server/**`; no restart is needed or was
performed. No web changes are planned.

## Repository anchors and module layout

Current anchors:

- `core/index.ts`: StepExecution (attempt/idempotencyKey/signal only), WorkflowContext,
  InvocationEffects.track/closeAdmission/drain, makeWorkflowStep, createWorkflowTask phases.run,
  chooseTerminalInTransaction, createWorkflowRuntimeKernel, WorkflowEngine.open/inspect/stop/close.
- `core/run-control.ts`: RunControl / observeStopCall / StopFailures; preserve terminal arbitration.
- `core/identity.ts`: canonicalInput / idempotencyKey; reuse canonical encoding, not call-order IDs.
- `packages/workflow-runtime/index.ts`: root exports and shared workflowRuntimeKernel.
- `src/server/app.ts:333–420`: loader.loadAll, Harness.open, #recover, subscriptions, engine.open.
  `PocketApp.close` remains the lifecycle authority; preserve current engine-before-Harness close.
- `src/server/extensions/workflows.ts`: currently registers the shared workflow Task. T7 will
  replace that registration with the portable runtime extension for an agent-enabled host; the
  extension loader itself remains unchanged. Existing upstream `src/server/reload.ts` is optional
  host DX. Do not use optional Guard/plan extension as the deployment floor.
- `test/workflow-runtime-core.test.ts:122,192`: child-process spawn and SIGKILL pattern;
  `test/fixtures/workflow-runtime-core-crash-worker.ts`: reusable storage-boundary worker pattern.
- `test/workflow-runtime-app.test.ts`, `workflow-runtime-integration.test.ts`,
  `workflow-test-support.ts`, `helpers.ts`: current host and scripted-model fixture seams.

Cohesive modules under `packages/workflow-runtime/agents/`: profile.ts (profile and identity),
records.ts (durable correlation), host.ts (runtime composition and controlled Harness lifecycle),
recovery.ts (paused-start reconciliation), runner.ts (native Task and workflow binding), and
structured-result.ts (one result tool, when implemented). No module is
mandatory merely to meet a file count: keep cohesive helpers together. Root public adapter exports
are additive. Agent code must not import PocketHost, PocketApp, UI, settings paths, reload notifications
or server extension implementations. Standard Extension tasks/tools/sections/hooks/wraps are the
first choice; external helpers earn their existence only through the evidenced API gaps below.

Added tests: `test/workflow-agent-{host,turn,recovery}.test.ts` and
`test/fixtures/workflow-agent-crash-worker.ts`. Planned for T4–T6: authority, result, and cleanup
suites; actual Pocket lifecycle coverage belongs in `test/workflow-runtime-app.test.ts`. All match
the existing `npm test` glob.

The implementation adds the stored kinds specified by the contract: native
`pocket.workflow-runtime.agent-runner` v1 and session doc family
`pocket.workflow-runtime.agent-thread` v1. Preserve existing
`pocket.workflow-runtime.{task,run,event}`. Absent agent records require no migration; unsupported
agent versions fail closed and remain inspectable. Agent-enabled workflows opt in additively; generic
workflows retain their existing context and startup behavior.

## Ordered implementation tasks

## Task T1 — Prove the portable per-Harness controlled startup lifecycle

**Depends on:** none

**Requirements:** A1,A5,A9; E3,E9.

**Files:**

- Create: packages/workflow-runtime/agents/profile.ts
- Create: packages/workflow-runtime/agents/host.ts
- Create: packages/workflow-runtime/agents/recovery.ts
- Modify: packages/workflow-runtime/core/index.ts
- Modify: packages/workflow-runtime/index.ts
- Create: test/workflow-agent-host.test.ts

**Acceptance:** A portable per-Harness runtime must fail closed until controlled `openHost()` startup completes, keep raw Harness/options and progress-capable methods private during setup, preserve native Pi Durable Models behavior for both `streamSimple` and `completeSimple`, preserve generic Target 1/2 behavior, compose host options without losing existing callbacks or non-adapter behavior, and preserve partial-Harness cleanup diagnostics without taking ownership of storage on pre-acquisition rejection.

**Verification:**

- Required: node --test test/workflow-agent-host.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test

**Blocked by:** none (independent spec/plan review approval is the execution prerequisite).
**Requirements/evidence:** A1,A5,A9; E3,E9. Attach-before-progress remains required for adapter recovery and tool-state inspection. Provider generation/compaction/deferred requests use standard Pi Durable recovery semantics; there is no Models runtime gate or public identity-seam proof requirement. E9 maps host bootstrap to the portable helper, not an app.ts inspection algorithm.
**Targets:** agents/host.ts for the portable factory, controlled lifecycle and Harness-option composition;
agents/recovery.ts for paused-start reconciliation; profile.ts for profile/environment identity; core
createWorkflowRuntimeKernel/WorkflowContext/createWorkflowTask binding seam; root exports;
`workflow-agent-host.test.ts`.

1. At the adapter host boundary, RED: engine and progress-capable methods must remain unavailable
   until controlled host startup completes; a generic Target 1/2 kernel still opens unchanged. Use
   the real installed Harness. Do not treat provider dispatch as a separate identity-gated host seam.
2. Expand with one per-Harness `createWorkflowAgentRuntime({harnessOptions: baseOptions,
agentConfig, timerOptions})`, returning a standard extension, bounded `register`, ready-only engine
   access, `openHost` and resource-only `close`. Keep composed options and raw Harness private. The
   restricted setup facade permits read/inspection, scans, scoped document recovery writes, commit
   subscriptions/disposers, queued cancellation requests and `onAfterAdapterRecovery` hooks; it never
   exposes Tx, generic commit, wait, resume, submit or abort handles. `openHost` privately opens the
   Harness; host preparation/listeners run before adapter preflight, registered recovery callbacks run
   after preflight, then TimerHost initializes, compatible workflows activate while paused, final
   checks run, setup seals, and the controlled progress transition occurs. Only then expose Harness
   plus setup disposer. On failure, dispose setup listeners, close the privately acquired Harness
   with independent cleanup context and preserve primary plus cleanup errors. Capture cleanup reports
   emitted by partial `Harness.open` through `onReport` while preserving the host callback. If
   `Harness.open` rejects before constructing a Harness, leave supplied storage untouched for its
   caller to close. Use the existing WorkflowEngine, not a second scheduler/provider/registry or Pocket lifecycle framework. Immutable
   configuration and per-host closures replace mutable global adapter state. Definitions needed for
   persisted activation are registered before openHost. Prove idempotent startup/close semantics.
   Core receives a bounded current-runtime agent-turn binding, not agent-specific step.do behavior
   or exposed raw TaskRuntime. Preserve StepExecution/generic callers; no broad extraction.
3. Implement the smallest non-progress preflight using public Harness inspection, read-only task
   lookup, scoped commits and Tx reads including the exact native `UserEntry`; compare input content
   with immutable intent and any persisted submission ID with its located submission. Persist
   unknown-before-abort ordering for uncertain tool execution; T3 proves these fences in the crash matrix. Calling submit/wait/waitForTask/
   waitForIdle is forbidden during setup/preflight because it may enable scheduling. This protects
   adapter identity/tool state, not a no-resend guarantee for provider requests. Standard Extension
   has no startup hook; throwing hooks are swallowed, Generation requests may be reissued by native
   recovery and native built-in Task names are reserved. Scheduler.open reconciles recovery but does
   not enable phase execution; do not claim it performs no writes.
4. RED/GREEN composition tests prove the runtime preserves the injected public
   HarnessOptions.models instance for both native `streamSimple` and `completeSimple`, including
   adapter and ordinary conversations. Do not wrap, screen, or reject provider requests by session ID.
   Provider retries and current route resolution follow native Pi Durable/host Models behavior; do not
   claim per-round revocation when model/profile configuration changes after turn admission. Keep
   immutable profile/model snapshots for diagnosis and validate them at new logical turn admission.
   No private APIs, prototype monkey-patching, custom transport or upstream seam.
5. Verify deferred fetch/cancel behavior through the installed public Models API. Do not add an
   adapter-specific deferred-delivery fence or infer that sessionId accompanies fetchDeferred.
   ProviderDoc session mapping remains conversation correlation only, not a delivery receipt or
   dispatch authorization. Unsupported adapter identity stays fail-closed at turn/recovery admission;
   ordinary and adapter provider calls otherwise use the host Models behavior.
6. RED/GREEN option composition preserves registry, settings getters, now, onReport and
   conversationCreated. Respect the native callback's stage after built-in document creation:
   table reads there throw ReadAfterWrite. Prove callback chaining does not introduce forbidden
   reads-after-writes; preserve existing supported document initialization and transaction atomicity.
   HarnessOptions.env uses its public target conversationId,
   read and cwd to apply explicit agent configuration; preserve non-adapter default env behavior.
   No Pocket settings dependency and no sandbox claim. Result tools are selected explicitly for
   agent conversations, not autoexposed to default ordinary chat extension selection.
7. Persist readiness only as process-local state derived from completed durable reconciliation;
   after reopen it is closed again. Registry reload invalidates current manifest authority, not the
   startup classification of already completed results. No timers/poll loop/custom scheduler.

**Verification:** `node --test test/workflow-agent-host.test.ts`, then baseline commands. Review must
see controlled startup preflight-before-progress, current workflow-turn owner/intent checks, unchanged native Models
behavior, no swallowed-hook substitute for tool enforcement, no reliance on undocumented
StepExecution.runtime and unchanged generic host behavior.
**Stop/fallback:** unsupported or malformed adapter identity remains fenced at turn/recovery admission.
Provider dispatch itself is not blocked for lack of a Models identity seam; ambiguous provider retries
are an accepted core-runtime behavior under the revised contract. No core patch, upgrade or custom
transport.

## Task T2 — Native one-shot tracer and exact workflow-owned continuation identity

**Depends on:** T1

**Requirements:** A1–A4,A9; E1,E2,E6,E9.

**Files:**

- Create: packages/workflow-runtime/agents/records.ts
- Create: packages/workflow-runtime/agents/runner.ts
- Modify: packages/workflow-runtime/core/index.ts
- Create: test/workflow-agent-turn.test.ts

**Acceptance:** Workflow-owned native turns are idempotent for matching intent, reject conflicting or drifted identities without dispatch, preserve exact native ownership/correlation across continuation, and drain admitted work before workflow terminality.

**Verification:**

- Required: node --test test/workflow-agent-turn.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test

**Blocked by:** T1.
**Requirements/evidence:** A1–A4,A9; E1,E2,E6,E9.
**Targets:** agents/{profile,records,runner}.ts; core current-runtime binding and InvocationEffects;
`workflow-agent-turn.test.ts`.

1. RED at `context.agent.turn({threadId,turnId,profile,...})`: a real workflow returns a scripted native
   answer through an owned AgentRunner, not a callback that independently opens a Harness.
   Bind to current TaskRuntime on every invocation and use existing admission/drain for detached
   and awaited turns. Keep generic `step.do` unchanged.
2. Atomically reserve collision-safe logical thread mapping, native Conversation ownership by the
   long-lived workflow Task, exact immutable intent and per-turn native runner creation using public
   Tx. Runner lives in the owning workflow conversation and uses public runtime conversation/joins/
   outcomes. No assumption that a child Task automatically moves into the new Conversation.
3. Before submit, persist deterministic request identity and canonical payload/authority/schema
   identity. After submit persist exact submission mapping. Reconcile the mapping gap with public
   request lookup rather than repeating blindly. Register ProviderDoc mapping before dispatch.
4. Begin with a minimal audited profile with no workspace mutation/delegation/opaque extensions;
   effective deployment-floor narrowing and final guarded tool admission are closed by default.
   T4 broadens adversarial proof, not permission to deploy an unenforced intermediate profile.
5. Sequential RED/GREEN tests: matching concurrent admission creates one native thread/turn;
   conflicting immutable intent rejects; concurrent different turns retain exact native correlation or
   reject unsafe admission; second turn after completion uses the same conversation; separate profile
   thread has different identity;
   tuple delimiters/prototype-like IDs do not collide. Recompute canonical fingerprint before each
   continuation, rejecting drift without provider dispatch. Persist its diagnostic inputs.
6. Completed adapter replay returns its exact saved result. Terminal/missing owner or stopped run
   rejects new admission, including idle threads. Workflow invocation cannot terminally park while
   an already admitted turn promise remains active. Failures must be observed by terminal drain.

**Verification:** `node --test test/workflow-agent-turn.test.ts`; baseline commands. Inspect native
ownership and literal result/dispatch counts through public APIs, not internal helper tests alone.
**Boundary:** no tool catalog, verdict schema, retry framework or caller migration beyond additive
agent opt-in. Native submission dedupe is never used as proof of equal payload or safe delivery.

## Task T3 — Complete-host recovery and exact native result reconciliation

**Depends on:** T2

**Requirements:** A3–A5,A9; E2,E3,E5.

**Files:**

- Modify: packages/workflow-runtime/agents/records.ts
- Modify: packages/workflow-runtime/agents/recovery.ts
- Modify: packages/workflow-runtime/agents/runner.ts
- Create: test/workflow-agent-recovery.test.ts
- Create: test/fixtures/workflow-agent-crash-worker.ts

**Acceptance:** Complete-process kill/reopen tests replay exact completed results without another provider call, and demonstrate that uncertain native provider work may be reissued under Pi Durable recovery. Before leaving native work resumable, preflight must confirm exact turn/thread identity, native `UserEntry` content against immutable turn intent, any persisted submission ID against the located submission, runner Task `owner` and `workflowTaskId` against the persisted thread owner, a ready thread, and a live/un-aborted workflow Task/run with no stop/terminal selection. Account for every adapter-correlated active native task; fence/abort work with no matching active runner. Repeat preflight after TimerHost initialization and immediately before `Harness.resume()`. Resolve active Generation tool-child references with public `getTask`, including terminal outcomes, and fence missing, mismatched, failed, or aborted effects. Preserve durable fencing for uncertain native tool execution and malformed/unattributable identity; keep a closed thread closed and assert tool-effect markers do not increase when work is fenced.

**Verification:**

- Required: node --test test/workflow-agent-recovery.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test

**Blocked by:** T2.
**Requirements/evidence:** A3–A5,A9; E2–E3,E5.
**Targets:** agents/{records,recovery,runner}.ts; `workflow-agent-recovery.test.ts` and crash worker.

1. Use SQLite in a separate complete host process. Put model/tool dispatch markers in independent
   durable fixture storage, not in-memory counters or the runtime transaction being tested. Parent
   waits for a controlled boundary, SIGKILLs, awaits exit, opens the same store in a fresh process,
   and asserts exact results and cumulative dispatch counts.
2. RED/GREEN exact completed native submission answer committed before runner receipt; also before
   workflow receipt. Reconcile from settled submission and its exact answer reference, save/return
   the exact result, dispatch count unchanged. Do not call submit or wait merely to discover it.
3. RED/GREEN crashes before intent commit, after atomic thread/runner intent commit before submit,
   after native submission commit before adapter submission mapping, and after mapping. Recover
   by exact request lookup and phase evidence. No partial logical mapping after atomic failure;
   immutable-intent conflicts never inherit another request's result. Reopen tests independently tamper
   the located native `UserEntry` payload and persisted `turn.submissionId`; both must fence before
   provider progress and leave dispatch markers unchanged.
4. RED/GREEN persisted provider-generation checkpoints before dispatch, after dispatch/before
   response, and after response/before classify commit, including a later provider round after a
   completed tool round. Reopen through the native scheduler and assert that an uncertain provider
   call may be issued again (a second fixture marker is expected), while an exact completed answer is
   replayed with no additional provider marker. No test should claim exactly-once or identical output.
   Separately crash during uncertain unsafe tool execute: commit semantic tool-unknown before abort,
   keep the tool-effect marker unchanged, repeat the fence idempotently after a kill between commit
   and abort, and assert native abort settlement cannot erase tool-unknown. Also leave an active
   adapter-owned Generation after its runner Task is terminal; startup preflight must discover it through its
   conversation correlation, fence/abort it, and add no provider marker. Also crash after an unsafe
   tool writes its effect marker and its `pi.tool` Task settles failed while a waiting Generation
   still references it; resolve that terminal child with public `getTask` and fence before provider
   progress, without treating `Harness.inspect()`'s live-task list as complete history.
5. Positively test pending/not-started and ambiguous provider generation phases through the standard
   native resume path; a prior provider/tool round does not by itself suppress provider retry. Inspect
   all descendants and preserve the independent fence when an unsafe native tool Task is active or
   unattributable. Exact settled results still replay.
6. RED/GREEN generation poll and compaction summary recovery using native Pi Durable semantics;
   provider fetch/complete calls may repeat after an ambiguous crash. Inject a second poll crash after
   the durable provider-fetch marker and before classification, then verify the poll may be issued
   again. Do not add a session-correlation gate or fence provider work solely because delivery is
   uncertain. Keep unsupported/ambiguous native tool execution fenced and prove compaction uses the
   standard `completeSimple` path.
7. Test standalone adapter host rejects progress-enabling workflow paths until controlled `openHost`
   preflight/startup succeeds, including accidental early native waits. Classify an ordinary runner
   failure with no exact native submission as `not-completed` and require a new logical turn ID; a
   failure after submission must durably fence the thread as `unknown` without dispatching a follow-on
   turn. Incomplete/malformed/unsupported runner/thread identity and inactive/stopped/abort-requested workflow owners must not resume native provider work.
   Re-select stop after adapter preflight and also during TimerHost's asynchronous open scan; the
   final `beforeResume` preflight must fence before the controlled Harness progress transition. Preserve a terminally closed thread
   through both recovery fencing and the native runner abort handler.

**Verification:** `node --test test/workflow-agent-recovery.test.ts`; baseline commands. Controlled startup
boundary, settlement/result IDs and separate provider/tool marker totals for each crash. Core crash tests remain
regressions, not proof of agent behavior. No live network needed.
**Boundary:** no startup polling service, delivery lease, scheduler patch or generalized retry chain.
Native provider replay is allowed but bounded by Pi Durable's existing task lifecycle; no adapter-level
exactly-once provider guarantee is claimed. Tool-effect uncertainty remains separately fenced.

## Task T4 — Prove authority at actual tool execute and logical-turn admission

**Depends on:** T2

**Requirements:** A2,A3,A6,A9; E6.

**Files:**

- Modify: packages/workflow-runtime/agents/profile.ts
- Modify: packages/workflow-runtime/agents/runner.ts
- Modify: packages/workflow-runtime/agents/host.ts
- Modify: packages/workflow-runtime/agents/recovery.ts
- Create: test/workflow-agent-authority.test.ts

**Acceptance:** Current persisted authority and manifest identity are enforced at logical-turn admission and actual tool execution, including replay and nested paths. Revoked or drifted authority produces no unauthorized tool mutation or newly admitted turn. Native provider rounds after admission follow Pi Durable behavior; no per-call provider gate or mid-turn revocation guarantee is required.

**Verification:**

- Required: node --test test/workflow-agent-authority.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test

**Blocked by:** T2.
**Requirements/evidence:** A2,A3,A6,A9; E6.
**Targets:** agents/profile.ts and runner.ts for final tool-execution guards; host.ts for effective
manifest/tool composition; recovery.ts for startup authority reconciliation; public env adapters;
`workflow-agent-authority.test.ts`.

1. RED/GREEN effective floor ∩ profile ∩ call narrowing with explicit audited tools/sections/extensions,
   schema and implementation versions/order. Missing, duplicate-name, unexpectedly replaced or
   wrapper-changed definitions fail closed; silent omission/last-wins must not count as acceptance.
   Persist canonical fingerprint inputs including instructions content, schema and model/thinking
   settings. Name/schema alone cannot attest implementation identity.
2. At actual execute, RED/GREEN current persisted authority, version and admission checks, argument
   validation after any transformations, read-only mutation denial with a filesystem sentinel and
   external effect counter. Wrap only audited definitions and ensure no subsequent trusted wrapper
   strips the final guard; deny opaque compositions that cannot prove it. FS/Shell env narrowing is
   defense in depth, not permission to run arbitrary shell in a read-only profile.
3. Crash into native safe ToolTask execute replay: old beforeTool hooks are bypassed, but the current
   guarded execute still denies revoked authority. Test argument revalidation and stopped admission.
   If testing allowed codemode, use only already-guarded tools; nested mutation fails at execute.
   Baseline read-only profile excludes opaque codemode. Never enable Pocket background subagents.
4. Static configuration replacement/reopen while an old native phase snapshot exists (plus optional
   upstream hot-reload coverage): changed implementation/version, instructions, tool selection,
   capability floor or schema must block new turns and actual tool execution. Model/profile drift is
   checked at new turn admission, not at every provider round of an already admitted turn. Test two
   Harness lifetimes independently; no leaked global permissions or Pocket reload dependency.

**Verification:** `node --test test/workflow-agent-authority.test.ts`; baseline commands. Evidence is
sentinel unchanged/zero unauthorized effects on direct, replay and nested tool paths, plus rejection
of new turns after drift. Do not assert zero provider markers for an already admitted native phase.
Prompts/tool lists alone are not proof.
**Boundary:** explicit deployment-version discipline is required; no speculative source hashing or
untrusted-extension sandbox. Host operators remain trusted. Unsupported tool mechanisms stay off.

## Task T5 — Schema-bound sole-result tool with exact native settlement promotion

**Depends on:** T2

**Requirements:** A3–A5,A7; E2,E3,E6,E7.

**Files:**

- Create: packages/workflow-runtime/agents/structured-result.ts
- Modify: packages/workflow-runtime/agents/records.ts
- Modify: packages/workflow-runtime/agents/runner.ts
- Modify: packages/workflow-runtime/agents/host.ts
- Modify: packages/workflow-runtime/agents/recovery.ts
- Modify: test/fixtures/workflow-agent-crash-worker.ts
- Create: test/workflow-agent-result.test.ts

**Acceptance:** Structured success is promoted only from the exact schema-bound sole result call after matching native submission settlement and completed tool evidence; invalid, mixed, stale, nested, or mismatched results never become success.

**Verification:**

- Required: node --test test/workflow-agent-result.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test

**Blocked by:** T2.
**Requirements/evidence:** A3–A5,A7; E2,E3,E6,E7.
**Targets:** agents/{structured-result,records,runner,host,recovery}.ts;
`workflow-agent-result.test.ts`, crash worker.

1. RED/GREEN a literal simple fixture schema (not ReviewResult) delivered by the sole direct native
   result call. Public defineTool execute validates the current schema, authority/admission and exact
   ToolTask input/assistant call identity. Reject nested invocation by requiring native ToolTask
   identity and the sole matching call in its assistant round; do not trust caller-supplied IDs.
2. In one transaction persist payload and run/thread/turn/request/submission/assistantEntry/callId/
   task/schema references. Same exact call replay returns the same candidate; different-call reuse
   or changed payload conflicts. No candidate accepted by an unrelated current turn.
3. Return native terminate control only as a hint. Promote structured completed result only after
   exact submission done/answer identity matches candidate and the matching tool outcome is proven
   completed. Native Generation finishToolRound checks every slot; absence of promotion never
   falls back to prose or newest message.
4. Sequential RED/GREEN invalid/missing schema, prose-only answer, mixed tool round, multiple
   result calls, stale previous turn, nested codemode and mismatched schema/task/assistant/submission.
   Invalid result is not structured success; do not invent a new logical turn to repair it. An
   interrupted native provider request may still be reissued by Pi Durable.
5. SIGKILL after candidate commit before tool settlement, after tool settlement before native answer,
   after native answer before adapter promotion and after promotion before workflow receipt. Safe
   candidate-tool replay must revalidate and be idempotent. Never promote a candidate without exact
   native settlement; if a resumed provider call returns a conflicting result, preserve the conflict
   rather than accept stale candidate data. Exact completed replay returns the literal payload with
   unchanged provider dispatch count.

**Verification:** `node --test test/workflow-agent-result.test.ts`; baseline commands. Review the
native settlement reference chain, not merely candidate existence or terminate:true.
**Boundary:** one concrete schema-bound adapter, no generalized result service, verdict policy,
revision binding or provider responseFormat invention.

## Task T6 — Selected terminality closes thread admission before observable native cleanup

**Depends on:** T2

**Requirements:** A1,A4,A8,A9; E1,E8.

**Files:**

- Modify: packages/workflow-runtime/agents/records.ts
- Modify: packages/workflow-runtime/agents/runner.ts
- Modify: packages/workflow-runtime/agents/recovery.ts
- Modify: packages/workflow-runtime/core/index.ts
- Modify: test/fixtures/workflow-agent-crash-worker.ts
- Create: test/workflow-agent-cleanup.test.ts

**Acceptance:** Selected terminality closes thread admission before observable native cleanup; stopped outcomes remain authoritative, cleanup failures stay inspectable, and reopen retries cleanup without resurrecting agent work.

**Verification:**

- Required: node --test test/workflow-agent-cleanup.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test

**Blocked by:** T2.
**Requirements/evidence:** A1,A4,A8,A9; E1,E8.
**Targets:** agents/{records,runner,recovery}.ts; core chooseTerminalInTransaction/RunControl adapter
binding and inspection; `workflow-agent-cleanup.test.ts`, crash worker.

1. RED/GREEN stop during model stream/tool execution, and stop after a completed turn on an idle
   continuable thread. Transactionally close adapter admission at selected terminality before native
   cleanup can start. Reuse core terminal selection, not a competing terminal authority. Reject new
   logical turns/tools and propagate native ownership cancellation; an already admitted provider phase
   follows Pi Durable's native cancellation/recovery behavior.
2. Close all referenced thread admissions for completed/failed/stopped workflow outcomes too; normal
   native successful terminal waits descendants rather than automatically cancelling them. Use current
   invocation drain for admitted agent work; no detached/background boundary in v0.
3. Use public native abort and actual descendant outcome inspection for idempotent cleanup. Store
   pending/succeeded/failed evidence with retained native references and bounded diagnostics in the
   thread record. Extend agent inspection additively: generic core pending/native-settled does not
   itself mean cleanup succeeded. Do not claim delete/dispose where native APIs only retain storage.
4. RED/GREEN injected cleanup failure after semantic stop: stopped remains selected, responsibility
   and error remain inspectable. SIGKILL after stop/admission close before cancellation and during
   cleanup; reopen reapplies only unfinished cleanup, never provider/tool/continuation admission.
   Include native failed/faulted/orphaned cleanup outcomes, not only promise resolution or idle.

**Verification:** `node --test test/workflow-agent-cleanup.test.ts`; baseline commands. Inspect selected
stopped before blocked cleanup, external cancellation markers, retained failure references and stable
outcome after reopen. Preserve existing stop/reservation/terminal competition regression tests.
**Boundary:** no custom child registry, new cancellation scheduler or swallowed cleanup errors. Public
abort marking during preflight is allowed; any wait that enables scheduling occurs only after fencing.

## Task T7 — Thin Pocket composition, exported standalone consumer and static-host acceptance

**Depends on:** T3, T4, T5, T6

**Requirements:** A1–A9; E9 plus acceptance from all previous tasks.

**Files:**

- Modify: packages/workflow-runtime/index.ts
- Modify: src/server/extensions/workflows.ts
- Modify: src/server/app.ts
- Modify: test/workflow-runtime-app.test.ts
- Modify: test/workflow-agent-host.test.ts
- Create: docs/workflow-runtime-agent-standalone.md

**Acceptance:** The portable factory is used by both standalone and Pocket hosts with the same lifecycle order, clean borrowed-Harness ownership, unchanged generic/legacy stored data behavior, and no loader changes; all offline agent acceptance tests and repository checks pass.

**Verification:**

- Required: node --test test/workflow-runtime-app.test.ts test/workflow-agent-host.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test
- Required: npm run format:check

**Blocked by:** T3, T4, T5, T6.
**Requirements/evidence:** A1–A9; E9 plus acceptance from all previous tasks.
**Targets:** root adapter exports, `src/server/extensions/workflows.ts`, `src/server/app.ts` Harness
options/startup/close only (no loader changes); exported standalone example/runbook;
`workflow-runtime-app.test.ts` and `workflow-agent-host.test.ts`.

1. RED/GREEN thin Pocket composition: construct the portable factory with explicit dependencies;
   register runtime.extension through the existing workflows extension module **instead of**, not
   alongside, the current singleton workflow task registration. Preserve old stored kinds and generic
   exported consumers; do not introduce a 'legacy' runtime or ambiguous simultaneous singleton/
   per-host definitions in one registry. No agent policy or inspection algorithm belongs in app.ts.
   Use `runtime.openHost(storage, context, prepare)`; never expose composed options or a raw Harness
   during startup. Install listeners and perform bounded recovery through the restricted setup facade;
   use `onAfterAdapterRecovery` for work that follows adapter preflight. The runtime initializes
   timers, activates compatible workflows while paused, runs final checks, seals setup and performs
   the controlled progress transition before returning Harness ownership. No loader modification or
   UI feature is needed.
2. RED/GREEN an executable programmatic consumer using only public Durable and workflow-runtime
   exports, with no Pocket imports. Document the **same exact sequence** for a TUI host supplied with
   extensions/configuration; do not implement a TUI or assert equivalence to unrelated coding-agent
   plugin APIs. Demonstrate the proposed sequence below, with names finalized by T1:

    ```ts
    const runtime = createWorkflowAgentRuntime({
        harnessOptions: baseOptions,
        agentConfig,
        timerOptions,
    });
    registry.install(runtime.extension); // baseOptions.registry is this registry
    runtime.register(workflow); // definitions needed for persisted activation
    const host = await runtime.openHost(storage, context, async (setup) => {
        setup.subscribeCommits(onCommit);
        setup.onAfterAdapterRecovery(async (recovered) => {
            await recoverHostDocuments(recovered); // scoped writes only; no progress handles
        });
        return undefined;
    });
    try {
        await runHost(runtime, host.harness, runtime.engine);
    } finally {
        await host.dispose(); // setup/listener ownership transfers on success
        await runtime.close(); // releases runtime resources, not the Harness
        await host.harness.close(cleanupContext);
    }
    ```

    The executable example releases setup/listener ownership through the returned disposer. If
    `openHost` fails, it disposes acquired listeners and closes its privately acquired Harness; after
    success the caller owns the returned Harness. Raw Harness calls that bypass the setup gate are
    not advertised as safe agent hosting. Generic/non-adapter sessions preserve existing models/auth/
    env and commit coordination.

3. Two open/close cycles with the same durable storage, static profile/config replacement on reopen,
   startup failure, concurrent close and two separate Harnesses: no readiness, manifest, callbacks
   or result state leaks. Assert failed `openHost` closes its private Harness with a valid
   cancellation-independent cleanup Context. Combine setup/adapter/open failure with runtime/Harness
   cleanup failures: retain the original startup failure as cause/first entry and all cleanup
   diagnostics; a sole failure is rethrown unchanged. Cancel the operation context and
   prove cleanup still executes. Apply the same discipline to caller-owned listeners. Test option
   preservation and transaction callback ordering from T1 in actual Pocket composition.
4. STATIC registration/configuration and close/reopen are the correctness baseline. No watcher is
   required for acceptance. Current manifest/config is read at new turn admission and actual tool
   execution; provider rounds already admitted follow native Pi Durable behavior. Optional upstream
   hot reload exercises turn/tool checks, not a Pocket reload-notification dependency.
5. Reopen existing Targets1/2 runs with no agent records: no new doc kind mutation, no implicit
   migration, unchanged sleep/event/timer/core behavior. Unsupported agent versions remain blocked
   but unrelated generic work can run. Root core/shared-kernel exports and existing workflows module
   ordering remain compatible.
6. Run all agent offline acceptance tests as a suite and the complete current repository suite. Review
   packet lists exact crash boundaries/marker counts, unresolved unsupported paths and cleanup
   evidence; missing live authorization is recorded as gated acceptance, not a hidden skipped success.

**Verification:** `node --test test/workflow-runtime-app.test.ts test/workflow-agent-host.test.ts`, then
`npm run check`, `npm run lint`, `npm test`, `npm run format:check`. Inspect diff for unrelated changes,
public-export-only imports and whitespace. Offline Target 3 acceptance requires all applicable native
scripted/crash tests green, not merely type checking or existing core tests.

### T8 — Explicitly gated live native-provider acceptance

**Blocked by:** T7; valid provider credentials; explicit network/spend authorization with bounded
budget and isolated data/workspace. This gate is not a request to obtain credentials now.
**Requirements/evidence:** A4,A5,A7,A9; `07-productionization.md`, Target 3 real Pi conversation.
**Targets:** existing agent integration acceptance fixture/runbook; no new product feature.

1. Before any call record authorized provider/model, credential availability (never secret values),
   maximum spend/calls/tokens/time, isolated temporary workspace/store, cleanup plan and durable
   external dispatch observation method. Report repeated provider requests if recovery produces them;
   do not claim exactly-once or no-duplicate billing. Stop when budget is exhausted.
2. Through the native workflow adapter run one one-shot, one same-thread continuation and one
   schema result; kill the complete host after exact native answer before workflow receipt and reopen.
   Return the saved result with no additional provider dispatch. If separately authorized, include a
   bounded uncertain-generation crash and report whether native recovery reissued the provider call;
   that repeat is accepted behavior, not a failed no-resend test.
3. Record actual model/provider/result identities, observations, marker counts, kill boundary,
   cancellation/cleanup evidence and command outcomes. A gated/unrun test is neither passed nor a
   reason to install/upgrade/restart production. Never spend to repair a planning failure.

**Verification:** authorized fixture invocation and recorded provider dispatch observations, followed
by applicable offline regression. Live acceptance remains GATED until approvals exist and evidence
is produced; document authoring and scripted tests cannot prove it.

## Dependency / traceability check

```text
T1 → T2 → T3 ─┐
         ├→ T4 ├→ T7 → T8 (credential/network/spend gate)
         ├→ T5 ┤
         └→ T6 ┘
```

Only listed edges prevent starting a task. T4/T5/T6 may be independently developed/reviewed after T2;
T7 must reconcile their overlapping integration edits. No broad refactor is needed. If a later mechanical
change cannot keep old callers green, expand compatibility, migrate bounded opt-in callers, then
contract only after all callers move; do not slip a rewrite into an acceptance task.

| Requirement                         | Primary task acceptance                                                                                                  | Installed-gap evidence |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| A1 native separate runner/ownership | T2 native one-shot, continuation; T6 cancellation                                                                        | E1,E8                  |
| A2 explicit enforced narrowing      | T2 closed minimal profile; T4 direct/replay/nested denial                                                                | E6                     |
| A3 logical identity and fingerprint | T2 atomic/concurrent/conflicting thread/turn; T4 drift                                                                   | E1,E2,E6               |
| A4 exact durable replay/unknown     | T3 exact saved-answer replay and provider retry semantics; T5 schema promotion                                           | E2,E3,E7               |
| A5 before-progress recovery         | T1 controlled setup readiness; T3 provider/tool recovery classification; T7 actual Pocket startup                        | E3–E5,E9               |
| A6 turn/tool runtime authority      | T2 owner/intent admission; T4 static-reopen drift denial at new turn and tool execution (reload optional)                | E4,E6                  |
| A7 structured exact correlation     | T5 sole direct result and crash/invalid/stale rejection                                                                  | E7                     |
| A8 selected terminality/cleanup     | T6 selected stop before cleanup, failure retained, no resurrection                                                       | E8                     |
| A9 hosts/compatibility/live gate    | T1 portable factory/options; T7 static standalone/Pocket/TUI sequence, ownership/Targets1/2; T8 authorized live evidence | E9                     |

## Partial-work recovery and blockers

Before resuming implementation, read this plan and the complete contract; inspect existing target files
and durable test evidence. Preserve valid prior implementation rather than rewriting blindly. A task
is complete only with its observed RED/GREEN/regression evidence; a partial file or a committed
candidate is not task completion. Reconcile native records/results by exact identity; test provider
replay only through the native recovery path, not an ad hoc resend. Re-run bounded work, not an
unbounded retry loop.

Material implementation gates still to prove:

- Native provider recovery follows standard Pi Durable behavior for generation, compaction and
  deferred work; tests must allow repeat provider markers after ambiguous crash, but exact saved
  answers replay without a new request. No Models identity seam is required.
- Current manifests and final tool-execution guards must survive trusted wrapper ordering/hot reload;
  explicit implementation versions depend on deployment discipline, not name/schema equality. New
  turns still validate workflow owner, profile and immutable intent.
- Candidate-before-settlement recovery must distinguish saved exact completion from incomplete
  provider work; provider work may resume, while uncertain native tool effects remain fenced.
- Native terminal/idle cannot prove cleanup success; test actual descendant failures and retained
  responsibility. Concurrent admission/terminal selection must read latest transactional state.

If an essential gate cannot be implemented with installed public APIs, stop with the exact evidence.
The approved provider-retry semantics are a user-authorized contract revision, not an improvised
fallback; further material contract changes still require user approval.

## Historical docs-only authorship record (pre-implementation)

The notes below describe the original planning-document authoring attempt only; they are not the
current implementation or verification status, which is summarized at the top of this plan.
Preflight at that time found no `docs/plans/` directory, so there were no existing assigned artifacts to overwrite or
reconcile. The authoritative packet, current core/root exports/Pocket bootstrap, installed 1.0.2
exports and relevant generation/submission/tool/agent/scheduler/provider/compaction sources were
read. The full authored files were reread after writing. Only these changed paths are assigned:

```text
docs/plans/target-3-agent-adapter-spec.md
docs/plans/target-3-agent-adapter-plan.md
```

No source, runtime, planner, dependency or stored-data changes; no tests/live provider calls were run
for that prose-only attempt. Git diff/whitespace commands were **not run** because it had no shell
and VCS operations were outside its mutation boundary; no clean-diff claim was made. The handoff
asked a later independent reviewer to inspect the exact two-path diff and run `git diff --check` /
formatting checks if authorized; untracked additions required content inspection as well as git diff.
A direct content grep across those documents found no trailing spaces/tabs or merge-conflict markers;
that was a limited text check, not a git diff or formatter result.

## Historical independent review — pre-portability revision only

The review language below records the superseded contract, including its no-provider-resend and
per-round Models-gate assumptions; it is historical evidence, not current acceptance.

Final parent verification: focused Prettier formatting/check passed for both documents, `git diff --check`
passed, and explicit content whitespace/conflict checks passed for the untracked additions. No source
implementation tests or live provider calls were run for this documentation-only change.

Before this portability revision, direct read-only reviewer run
`5d2a4f6a-8a10-40de-9dae-f669e21dda0d` returned **READY**,
with no material findings, after reading both complete documents and source-checking the installed
APIs and current Pocket integration. This is document readiness, not implementation or live-provider
acceptance. The failed planning workflows were not resumed or marked successful; this review is
explicitly the user-authorized direct salvage path, not a fabricated workflow approval receipt.

Independent reviewer acceptance: every mechanism has A/E/test traceability; startup necessity is
crash-contract-specific, not a happy-path requirement; runtime drift gate remains a proof gate; no
unknown resend, speculative scheduler/transport or deferred machinery; safe cases are not blanket
blocked; exact structured settlement and native ownership are explicit; current-runtime binding,
Targets1/2 compatibility, standalone/Pocket lifecycle and stop-before-cleanup are preserved; live
acceptance is visibly gated. Return document review findings only, not implementation approval or a
claim that planning proves production acceptance.

## Portability revision verification and handoff

The complete existing plan and contract were read before surgical repair. Existing root exports,
workflows registration, Pocket bootstrap and upstream loader were inspected; public HarnessOptions
anchors were checked. Only `docs/plans/target-3-agent-adapter-plan.md` was edited in this repair.
Earlier authorship/formatting/reviewer evidence above is historical and does not verify this revision.
The parent then reconciled the companion spec, architecture rule, README/Pocket architecture links,
AGENTS reminder, conformance rows and productionization checks. A scan of all 28 Markdown docs
found the ADLC constitution already host-neutral; Pocket map/features documentation intentionally
describes the UI and needs no portability rewrite. The Target 1 historical banner now distinguishes
its original READY/limitations/test snapshot from later waits/events and core wiring in `6a63f6b`;
old historical evidence was not rewritten as current status. No source edits, installs, restarts,
commits, workflow launchers or live calls were made. Historical authorship/formatting evidence does
not verify the new revision; fresh review and final document checks are recorded separately.

Historical portability-review risks included public Models/session correlation and per-round gates;
those are superseded by the user's provider-retry revision. Current proof risks remain callback
transaction ordering, route/version coverage at turn admission, guarded tool/result settlement, and
borrowed-Harness failure cleanup. The proposed factory/API is not shipped. Implementation proofs
remain required; no new adapter framework or TUI implementation is authorized.

### Fresh portability review

Reviewer `e7d08afd-847d-4071-9140-e979fd3b6fad` identified two document blockers: missing cleanup
Context and cleanup errors masking startup failure. Both examples and T7 acceptance were repaired.
Fresh reviewer `8edad509-8274-4453-8967-dd6d3ba4053a` then read the complete nine-document revision
and source-checked critical installed APIs, returning **READY** with no material findings. This is
planning/document readiness only; no runtime or live-provider acceptance is implied.
