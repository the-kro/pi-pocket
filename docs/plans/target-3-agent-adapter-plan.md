# Target 3 — executable native agent-adapter plan

Status: portability revision independently reviewed READY; not implementation/live acceptance.
Execution requires separate authorization. Fresh review details are recorded below.
Contract: [target-3-agent-adapter-spec.md](target-3-agent-adapter-spec.md), requirements A1–A9,
evidence E1–E9. Confirmed answer: “Confirmed — finish the spec and plan with that traceability”.
The full exact scope question/answer and tentative-approval qualification are recorded in that contract.
Previous explicit scope approval is preserved. The subsequent portability refinement and docs-only
repair were approved with the exact answer:

> APPROVED - Let's make the changes needed to the spec/plan.

This revision records that refinement; its fresh READY is document review only, not authorization to implement.

## Boundaries and prerequisites

This is direct salvage after orchestration failure, explicitly authorized for docs only. The companion
contract and canonical portability policy were reconciled in the same documentation revision;
[the architecture rule](../pi-durable-production-runtime-v0/01-architecture.md#host-portability-and-earned-integration-seams)
guides this plan and future runtime plans. Do not run planner/workflow
launchers, implement source, repair planner framework, install/upgrade, restart, commit or make live calls.

Future implementation must preserve current Targets 1/2 in `packages/workflow-runtime/core/index.ts`.
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
with concrete evidence; no silent fallback to upgrades/core patches or weaker contracts.

Future baseline commands from repository root:

```text
npm run check
npm run lint
npm test
```

Use focused `node --test test/<named-file>.test.ts` runs below first. After future source edits, apply
repository formatting and rerun checks; inspect the formatting diff to avoid unrelated edits. For a
live Pocket host, server changes require a later operator restart, never during a tool call. This docs
attempt does not perform that restart. No web changes are planned.

## Repository anchors and proposed files

Current anchors:

- `core/index.ts`: StepExecution (attempt/idempotencyKey/signal only), WorkflowContext,
  InvocationEffects.track/closeAdmission/drain, makeWorkflowStep, createWorkflowTask phases.run,
  chooseTerminalInTransaction, createWorkflowRuntimeKernel, WorkflowEngine.open/inspect/stop/close.
- `core/run-control.ts`: RunControl / observeStopCall / StopFailures; preserve terminal arbitration.
- `core/identity.ts`: canonicalInput / idempotencyKey; reuse canonical encoding, not call-order IDs.
- `packages/workflow-runtime/index.ts`: root exports and shared workflowRuntimeKernel.
- `src/server/app.ts:333–420`: loader.loadAll, Harness.open, #recover, subscriptions, engine.open.
  `PocketApp.close` remains the lifecycle authority; preserve current engine-before-Harness close.
- `src/server/extensions/workflows.ts`: required native definition registration. Existing upstream
  `src/server/reload.ts` is optional host DX; this branch adds workflows ORDER/REQUIRED/TITLES
  entries only. No loader changes are planned or authorized. Do not use optional Guard/plan extension
  as the deployment floor.
- `test/workflow-runtime-core.test.ts:122,192`: child-process spawn and SIGKILL pattern;
  `test/fixtures/workflow-runtime-core-crash-worker.ts`: reusable storage-boundary worker pattern.
- `test/workflow-runtime-app.test.ts`, `workflow-runtime-integration.test.ts`,
  `workflow-test-support.ts`, `helpers.ts`: current host and scripted-model fixture seams.

New cohesive modules under `packages/workflow-runtime/agents/`: profile.ts (effective authority),
records.ts (identity/semantic correlation), recovery.ts (preflight and dispatch composition),
structured-result.ts (one result tool), runner.ts (native Task and workflow binding). No module is
mandatory merely to meet a file count: keep cohesive helpers together. Root public adapter exports
are additive. Agent code must not import PocketHost, PocketApp, UI, settings paths, reload notifications
or server extension implementations. Standard Extension tasks/tools/sections/hooks/wraps are the
first choice; external helpers earn their existence only through the evidenced API gaps below.

New tests: `test/workflow-agent-{host,turn,recovery,authority,result,cleanup}.test.ts`,
`test/fixtures/workflow-agent-crash-worker.ts`; actual Pocket lifecycle coverage also belongs in
`test/workflow-runtime-app.test.ts`. All match the existing `npm test` glob.

New stored kinds are specified once in the contract: native `pocket.workflow-runtime.agent-runner`
v1 and session doc family `pocket.workflow-runtime.agent-thread` v1. Preserve existing
`pocket.workflow-runtime.{task,run,event}`. Absent agent records require no migration; unsupported
agent versions fail closed and remain inspectable. Agent-enabled workflows opt in additively; generic
workflows retain their existing context and startup behavior.

## Ordered implementation tasks

### T1 — Prove the portable per-Harness factory and fail-closed host seam

**Blocked by:** none (independent spec/plan review approval is the execution prerequisite).
**Requirements/evidence:** A1,A5,A6,A9; E3–E5,E9. The semantic no-unknown-resend requirement
has an evidenced eager-preflight adaptation; Models runtime gate mechanics remain unproven until
this task passes. E9 maps host bootstrap to the portable helper, not an app.ts inspection algorithm.
**Targets:** agents/recovery.ts and profile.ts plus one cohesive runtime factory module if necessary;
core createWorkflowRuntimeKernel/WorkflowContext/createWorkflowTask binding seam; root exports;
`workflow-agent-host.test.ts`. Names/interfaces below are proposed, not shipped; finalize in this proof.

1. At the adapter host boundary, RED: an agent-enabled engine must refuse timers/resume/dispatch
   before recovery readiness; a generic Target 1/2 kernel still opens unchanged. Use real installed
   Harness and a scripted dispatch marker. Assert no marker even if a hook throws normally.
2. Expand with one per-Harness `createWorkflowAgentRuntime({harnessOptions: baseOptions,
agentConfig, timerOptions})`, returning a standard extension, composed options, attach/open/close,
   a public profile surface and existing workflow-engine operations (expose the existing engine if
   sufficient, rather than a large forwarding interface). Compose WorkflowEngine, not a second
   scheduler/provider/registry or generic PocketHost lifecycle framework. Immutable configuration and
   per-host closures replace mutable global adapter state. Register definitions before Harness.open;
   attach borrows the Harness and completes finite idempotent non-progress preflight while paused.
   open checks readiness before any opened flag/timers/resume/activation; it opens the existing
   engine last, after caller-owned recovery/listeners. close releases owned listeners/timers, never
   silently closes the borrowed Harness; prove shared concurrent close semantics where appropriate.
   Core receives a bounded current-runtime agent-turn binding, not agent-specific step.do behavior
   or exposed raw TaskRuntime. Preserve StepExecution/generic callers; no broad extraction.
3. Implement the smallest non-progress preflight using public Harness inspection/commit/submission
   status/Tx reads and abortTask. Include persisted unknown-before-abort ordering immediately;
   T3 adds the full crash matrix. Calling submit/wait/waitForTask/waitForIdle is forbidden during this
   phase because it may enable scheduling. This chosen eager preflight is the minimal evidenced
   mechanism for A5's semantic no-unknown-resend requirement, not a universally necessary order
   for every possible runtime. A comprehensive lazy effect fence is unproven and deferred, not an
   alternative accepted implementation here. Standard Extension has no startup hook; throwing
   hooks are swallowed, Generation requests redispatch and native built-in Task names are reserved.
   Scheduler.open performs recovery reconciliation but does not enable phase execution; do not
   claim it performs no writes.
4. RED/GREEN local feasibility probes at the public Models composition boundary: deny native
   streamSimple and completeSimple before the underlying provider marker on revoked/changed
   authority; allow matching authorized call. Persist ProviderDoc/session-to-thread association before
   delivery. Check typed installed Models methods and bound-this behavior; gate inside or before all
   native paths, including completeSimple if it internally invokes streamSimple. Await admission
   before forwarding while preserving event-stream semantics, abort signals and native transport.
   Compose the public HarnessOptions.models instance, delegating auth/catalog/routing/transport to
   the injected Models. An awaited request transformHeaders callback is an optional local proof
   candidate, not a required method or permission to rebuild streams. Prove physical-route/virtual
   model version identity or restrict supported configurations; do not promise instant physical
   retry/cancellation revocation. Native assistant errors from gate rejection cannot overwrite semantic
   denial/unknown. No private APIs, required prototype monkey-patching or custom transport.
5. Positively check deferred fetch/cancel signatures and correlation. An uncorrelatable delivery path
   must remain fenced for adapter work; cleanup cancellation must remain available. Do not claim a
   sessionId accompanies fetchDeferred without evidence. Verify exact collision-free ProviderDoc
   sessionId mapping; that mapping is correlation, never a provider-delivery receipt. Unknown
   adapter identity is fail-closed, not a route to ordinary ungated Models. Non-adapter requests
   remain unaffected.
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
see one public typed admission seam covering both actual native request paths, no swallowed-hook
substitute, no reliance on undocumented StepExecution.runtime and unchanged generic host behavior.
**Stop/fallback:** if public Models composition cannot fail closed or cannot correlate an enabled
entrypoint, record exact signature/path and BLOCK that entrypoint (or Target 3 if baseline generation
is affected). No core patch, upgrade, widened scope or optimistic dispatch. This is a feasibility gate,
not a choice to abandon A6.

### T2 — Native one-shot tracer and exact workflow-owned continuation identity

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

### T3 — Complete-host no-resend recovery and exact native result reconciliation

**Blocked by:** T2.
**Requirements/evidence:** A3–A6,A9; E2–E5.
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
   immutable-intent conflicts never inherit another request's result.
4. RED/GREEN persisted request checkpoint just before dispatch, dispatch before response, response
   before classify commit, later provider round after tools, uncertain unsafe tool execute. On reopen
   semantic unknown commits before abort marking; dispatch counter never increases. Kill again
   between unknown commit and abort; repeated preflight reapplies fencing. Assert native aborted
   settlement cannot overwrite semantic unknown with failed/completed/ordinary aborted.
5. Positively test queued/not-started generation prepare with no prior unsafe effect can initiate;
   exact settled result can replay. Prepare alone is not proof if earlier tool/provider rounds remain
   uncertain. Inspect task descendants and compactions as well as runner checkpoints.
6. RED/GREEN generation poll and compaction summarize uncertainty. Fence unsupported deferred
   recovery; enable it only on positive evidence of safe fetch and exact admission correlation.
   Prove compaction uses the gate's completeSimple path. Native known-error retries/new rounds
   remain authorized only after current authority recheck; crash ambiguity is not retry permission.
7. Test standalone adapter host rejects all progress-enabling paths until preflight succeeds, including
   accidental early native waits. Incomplete/malformed/unsupported version identity stays durable
   and visible rather than adopting an unproved submission or automatically creating replacement work.

**Verification:** `node --test test/workflow-agent-recovery.test.ts`; baseline commands. Attach boundary,
settlement/result IDs and before/after marker totals for each crash. Core crash tests remain regressions,
not proof of agent behavior. No live network needed.
**Boundary:** no startup polling service, delivery lease, scheduler patch, generic retry chain or blind
request replay. Startup fence solves installed no-resend gap, not arbitrary distributed exactly-once.

### T4 — Prove monotonic authority at actual execute and every new provider round

**Blocked by:** T2.
**Requirements/evidence:** A2,A3,A6,A9; E5,E6.
**Targets:** agents/profile.ts, final guarded tool registration/composition in runner.ts/recovery.ts;
public env adapters; `workflow-agent-authority.test.ts`.

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
   upstream hot-reload coverage): changed implementation/version,
   instructions, tool selection, capability floor, model behavior or schema must block execution and
   provider admission. Test two Harness lifetimes independently; no leaked global permissions.
   The dispatch gate reads current registry/config manifest and persisted state on executions/rounds,
   not captured permission snapshots or Pocket reload notifications. Static hosts need no watcher.

**Verification:** `node --test test/workflow-agent-authority.test.ts`; baseline commands. Evidence is
sentinel unchanged/zero unauthorized effects on direct, replay and nested paths, plus zero provider
markers after drift. Prompts/tool lists alone are not proof.
**Boundary:** explicit deployment-version discipline is required; no speculative source hashing or
untrusted-extension sandbox. Host operators remain trusted. Unsupported tool mechanisms stay off.

### T5 — Schema-bound sole-result tool with exact native settlement promotion

**Blocked by:** T2.
**Requirements/evidence:** A3–A5,A7; E2,E3,E6,E7.
**Targets:** agents/{structured-result,records,runner,recovery}.ts;
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
   Invalid result is not structured success; no silent resend to repair unknown.
5. SIGKILL after candidate commit before tool settlement, after tool settlement before native answer,
   after native answer before adapter promotion and after promotion before workflow receipt. Safe
   candidate-tool replay must revalidate and be idempotent. Finish only when evidence proves no
   new provider call is required; if a subsequent request may have occurred, preserve unknown and
   fence it. Exact completed replay returns the literal payload with unchanged dispatch counter.

**Verification:** `node --test test/workflow-agent-result.test.ts`; baseline commands. Review the
native settlement reference chain, not merely candidate existence or terminate:true.
**Boundary:** one concrete schema-bound adapter, no generalized result service, verdict policy,
revision binding or provider responseFormat invention.

### T6 — Selected terminality closes thread admission before observable native cleanup

**Blocked by:** T2.
**Requirements/evidence:** A1,A4,A8,A9; E1,E8.
**Targets:** agents/{records,runner,recovery}.ts; core chooseTerminalInTransaction/RunControl adapter
binding and inspection; `workflow-agent-cleanup.test.ts`, crash worker.

1. RED/GREEN stop during model stream/tool execution, and stop after a completed turn on an idle
   continuable thread. Transactionally close adapter admission at selected terminality before native
   cleanup can start. Reuse core terminal selection, not a competing terminal authority. Reject new
   turns/tools/provider rounds and propagate native ownership cancellation.
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

### T7 — Thin Pocket composition, exported standalone consumer and static-host acceptance

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
   Pass runtime.options to Harness.open; immediately await runtime.attach(harness, context) before
   #recover/spend/subscriptions or any progress. Pocket owns its recovery and listeners; runtime.open
   resumes through the existing engine last. No loader modification or UI feature is needed.
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
    let harness: Harness | undefined;
    const failures: unknown[] = [];
    try {
        harness = await Harness.open(storage, runtime.options, context);
        await runtime.attach(harness, context); // paused, finite idempotent preflight
        // Caller performs its recovery and installs its listeners here, without progress.
        await runtime.open(context); // readiness checked; existing engine resumes last
        // Caller uses the public workflow/profile surface and runs its host.
    } catch (error) {
        failures.push(error); // retain primary startup/operation failure first
    } finally {
        try {
            await runtime.close(); // releases owned listeners/timers; safe after partial startup
        } catch (error) {
            failures.push(error);
        }
        if (harness !== undefined) {
            try {
                await harness.close(cleanupContext); // valid even if operation context was cancelled
            } catch (error) {
                failures.push(error);
            }
        }
    }
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, "Host operation/cleanup failed", { cause: failures[0] });
    }
    ```

    The executable example also releases caller-owned listeners in its outer cleanup path; resource
    acquisition before Harness.open retains caller ownership if open itself fails. Raw Harness calls
    that bypass the helper/gate are not advertised as safe agent hosting. Generic/non-adapter
    sessions preserve existing models/auth/env and commit coordination.

3. Two open/close cycles with the same durable storage, static profile/config replacement on reopen,
   attach failure, open failure, concurrent close and two separate Harnesses: no readiness, manifest,
   callbacks or result state leaks. Assert caller Harness.close still runs if runtime.close rejects,
   using a valid cancellation-independent cleanup Context. Combine attach/open failure with runtime
   close and/or Harness close failures: retain the original startup failure as cause/first entry and
   all cleanup diagnostics; a sole failure is rethrown unchanged. Cancel the operation context and
   prove cleanup still executes. Apply the same discipline to caller-owned listeners. Test option
   preservation and transaction callback ordering from T1 in actual Pocket composition.
4. STATIC registration/configuration and close/reopen are the correctness baseline. No watcher is
   required for acceptance. Current manifest/config is read on executions/provider rounds; optional
   upstream hot reload exercises the same drift guards, not a Pocket reload-notification dependency.
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
   external dispatch observation method. If markers cannot distinguish resend, do not claim the
   live no-duplicate test passed. Stop when budget is exhausted.
2. Through the native workflow adapter run one one-shot, one same-thread continuation and one
   schema result; kill the complete host after exact native answer before workflow receipt and reopen.
   Return saved result with no additional provider dispatch. Include a bounded authorized uncertain
   dispatch crash if the approved budget/observation method permits; it must fence, not resend.
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
| A4 exact durable replay/unknown     | T3 native-answer gaps and no resend; T5 schema promotion                                                                 | E2,E3,E7               |
| A5 before-progress recovery         | T1 readiness; T3 crash classifications; T7 actual Pocket startup                                                         | E3–E5,E9               |
| A6 per-round runtime authority      | T1 Models entrypoint proof; T4 static-reopen/old-snapshot drift denial (reload optional)                                 | E4–E6                  |
| A7 structured exact correlation     | T5 sole direct result and crash/invalid/stale rejection                                                                  | E7                     |
| A8 selected terminality/cleanup     | T6 selected stop before cleanup, failure retained, no resurrection                                                       | E8                     |
| A9 hosts/compatibility/live gate    | T1 portable factory/options; T7 static standalone/Pocket/TUI sequence, ownership/Targets1/2; T8 authorized live evidence | E9                     |

## Partial-work recovery and blockers

Before resuming implementation, read this plan and the complete contract; inspect existing target files
and durable test evidence. Preserve valid prior implementation rather than rewriting blindly. A task
is complete only with its observed RED/GREEN/regression evidence; a partial file or a committed
candidate is not task completion. Reconcile native records/results by exact identity; never resend to
make a recovery test pass. Re-run a bounded reconciliable step, not an unbounded retry loop.

Material implementation gates still to prove:

- Public Models admission composition preserves typed native event-stream semantics and gates both
  streamSimple/completeSimple with current persisted authority. SessionId mapping and unsupported
  deferred signatures must be proven, not inferred. No implementation proof exists in these docs.
- Current manifests and final execution guards must survive trusted wrapper ordering/hot reload;
  explicit implementation versions depend on deployment discipline, not name/schema equality.
- Candidate-before-settlement recovery must distinguish safe completion from a later uncertain
  provider round; exact identity/outcome inspection is mandatory.
- Native terminal/idle cannot prove cleanup success; test actual descendant failures and retained
  responsibility. Concurrent admission/terminal selection must read latest transactional state.

These are bounded implementation-proof risks, not permission to change confirmed product scope.
If any essential gate cannot be implemented with the installed public APIs, stop BLOCKED with the
exact requirement, API evidence and smallest attempted adaptation. A changed Spec Contract needs
new planning/review, not an improvised decision inside implementation.

## Historical authorship verification and independent-review handoff

Preflight found no `docs/plans/` directory, so there were no existing assigned artifacts to overwrite or
reconcile. The authoritative packet, current core/root exports/Pocket bootstrap, installed 1.0.2
exports and relevant generation/submission/tool/agent/scheduler/provider/compaction sources were
read. The full authored files were reread after writing. Only these changed paths are assigned:

```text
docs/plans/target-3-agent-adapter-spec.md
docs/plans/target-3-agent-adapter-plan.md
```

No source, runtime, planner, dependency or stored-data changes; no tests/live provider calls were run
for prose authorship. Git diff/whitespace commands were **not run**: this attempt has no shell tool
and VCS operations are outside its mutation boundary. Do not report their results as clean. Future
independent review should inspect the exact two-path diff and run `git diff --check` / formatting
checks if authorized; untracked additions require viewing their content as well as git diff. A direct
content grep across both assigned files found no trailing spaces/tabs or merge-conflict markers;
this is a limited text check, not a git diff or formatter result.

## Historical independent review — pre-portability revision only

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

Remaining proof risks: public Models/session correlation and entrypoint gates, callback transaction
ordering, route/version coverage, guarded replay/result settlement, and borrowed-Harness failure
cleanup. The proposed factory/API is not shipped. Implementation proofs remain required; no new
adapter framework or TUI implementation is authorized.

### Fresh portability review

Reviewer `e7d08afd-847d-4071-9140-e979fd3b6fad` identified two document blockers: missing cleanup
Context and cleanup errors masking startup failure. Both examples and T7 acceptance were repaired.
Fresh reviewer `8edad509-8274-4453-8967-dd6d3ba4053a` then read the complete nine-document revision
and source-checked critical installed APIs, returning **READY** with no material findings. This is
planning/document readiness only; no runtime or live-provider acceptance is implied.
