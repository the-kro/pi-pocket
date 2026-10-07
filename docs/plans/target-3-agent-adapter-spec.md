# Target 3 — native agent adapter: Spec Contract

Status: portability refinement independently reviewed READY. Execution requires separate authorization.
Fresh reviewer `8edad509-8274-4453-8967-dd6d3ba4053a` reviewed the complete revised documentation;
this verdict is document readiness, not implementation or live-provider acceptance.
Implementation is not authorized by this document-writing attempt. No live provider acceptance has
been demonstrated. Companion: [implementation plan](target-3-agent-adapter-plan.md).

## 1. Approval and authority

Latest scope question, recorded verbatim:

> With that distinction clarified, confirm the previously presented Target 3 scope for plan authorship: separate native AgentRunner, explicit profiles and execution-enforced narrowing (delegation off in v0), exact durable thread/turn/results and structured output, continuation/cancellation/observable cleanup, and an evidence-backed recovery guard before uncertain native work can dispatch. The plan must include requirement → installed-API gap → smallest adapter → acceptance-test traceability; no speculative machinery, no blind resend, no duplicate scheduler. Preserve Targets1/2; exclude Verify/Review/StartWork/UI and upgrades. Live provider acceptance is explicitly gated on credentials/spend authorization. We will write and independently review docs only, not implement Target3 or repair the planner framework. Do you confirm?

Exact answer:

> Confirmed — finish the spec and plan with that traceability

This supersedes tentative approval only as confirmation of the stated scope. The earlier requirement
to prove adapter necessity remains binding. In particular, startup preflight is a proposed mechanism,
not a mechanism literally named by the original packet. Preventing unknown resend is essential to the
crash contract, **not** merely to a happy-path one-shot conversation. Eager preflight is the selected,
smallest source-supported mechanism; a comprehensive lazy effect fence is not logically impossible,
but is not proved here and is not the selected implementation.

The user subsequently approved the portable-host refinement and documentation changes:

> APPROVED - Let's make the changes needed to the spec/plan.

Apply [Host portability and earned integration seams](../pi-durable-production-runtime-v0/01-architecture.md#host-portability-and-earned-integration-seams):
Pocket is only one host; standard extensions/configuration come first; any extra helper must earn
its existence through a concrete API gap and be callable by TUI/programmatic hosts. Hot reload is
optional DX. This approval changes the integration design, not the durable safety requirements.

Normative intent comes from `docs/pi-durable-production-runtime-v0/`:

- `README.md`, “Product goal” / “Core principle”: no duplicate completed/uncertain work; workflow owns lifecycle.
- `01-architecture.md`, “Unknown is first-class”, “Pi primitive mapping”, “State authority”: Pi owns scheduling; adapter owns semantic identity.
- `02-workflow-runtime-contract.md`, “Stop and cancellation”, “Terminal transition barrier”, “Semantic journal”: selected stopped before cleanup; retained responsibility.
- `03-agent-runtime.md`, “Authority”, “Conversation identity”, “Authority fingerprint”, “Agent turn protocol”, “Completed replay”, “Unknown turns”, “Structured results”, “Conversation disposal”, “V0 scope”: agent requirements below.
- `06-conformance.md`, “Agent integration” / “Crash testing methodology”: complete-host kill/reopen acceptance.
- `07-productionization.md`, “Target 3” / “Required source/API feasibility review before coding”: smallest evidenced adaptation.

Current Targets 1/2 are `packages/workflow-runtime/core/index.ts`, not the historical Target 1
implementation evidence or a sibling checkout. Preserve their stored kinds, generic operation/wait
semantics, root exports, timer lifecycle, terminal arbitration, and regression coverage.

## 2. Scope and public behavior

The following requirement IDs are the acceptance authority for this target.

**A1 — Native ownership and execution.** A separate registered native `AgentRunner` Task performs
bounded cognitive work using native Conversations, Generation/Tool Tasks, Models, joins and aborts.
Workflow-owned continuable threads belong to the long-lived workflow Task, not a per-turn runner.
No second scheduler, provider transport, cancellation tree, role framework or custom child registry.
Host-independent modules must not import PocketApp, UI, or server extension implementations.

**A2 — Explicit authority.** Profiles have stable id/version, instructions content and explicit version,
model route/thinking behavior, effective tools/capabilities and optional result schema identity.
Effective authority is deployment floor ∩ profile ∩ per-call narrowing; calls cannot widen it.
Delegation is off in v0. A read-only test profile cannot mutate even when requested adversarially:
no arbitrary shell, browser, opaque codemode, or subagent access. Tool execute must revalidate
arguments and current persisted authority/admission/manifest identity on every path, including safe
native replay and any permitted nested call. Prompt/tool visibility and optional Guard/plan mode are
not the boundary. Trusted host extensions are not an untrusted-code sandbox.

**A3 — Exact continuation identity.** Caller-owned `runId`, `threadId`, `turnId` are nonempty logical
IDs. Persist collision-safe tuple mapping to native conversation and exact turn intent before delivery.
Same identity/content is idempotent, conflicting payload/profile/schema/authority reuse rejects;
concurrent admission produces one thread/turn. Separate profile threads have separate identity.
Concurrent calls must never ambiguously associate an answer with a turn. Use native admission only
when exact correlation is proved; otherwise fail closed, without inventing an adapter queue. Later
turns continue the same conversation with exact fingerprint match.
Missing, ambiguous or replaced definitions fail closed; no v0 authority migration.

**A4 — Durable turn protocol and exact replay.** Distinguish `completed`, `accepted-incomplete`,
`not-completed`, `unknown`, `authority-drift`. Native settlement remains execution evidence, not a
license to reinterpret semantic unknown as ordinary failed/aborted. Persist canonical intent/digest,
runner/native submission/request references and exact result association. Completed replay returns
the saved exact result without submit, wait, or provider dispatch. A settled exact native answer may
repair a missing adapter/workflow receipt without dispatch. Never use newest message or mutable
current-turn state as proof. Unknown is durable and is never automatically resent; automatic generic
step retries must not redeliver it. Explicit future retries require new logical IDs; general retry chains
and operator reconciliation machinery remain deferred.

**A5 — Recovery safety and selected preflight.** Uncertain effects must not resume before their durable
classification can prevent blind resend. The selected implementation is a finite, idempotent preflight
in an exported portable runtime helper, not Pocket recovery code or a resident scheduler. Every
adapter host calls its attach/recovery operation after Harness.open and before any resume, submission,
native waits, timer opening, workflow activation or other progress-enabled path. The standard
Extension API has no global startup interception point; workflow replay alone runs too late. The
safety invariant is required; this ordering is the chosen evidenced mechanism, not the only conceivable
mechanism. A persisted native `request`
checkpoint cannot prove non-delivery: before-dispatch, after-dispatch and response-before-commit
crashes are all uncertain. Persist semantic unknown first, then mark uncertain native work aborted;
repeat the fence idempotently after a crash between those operations. Native abort settlement must
not overwrite unknown. Inspect owned generation, tool and compaction work, not only runner Tasks.
A queued input or genuinely not-started phase may progress if exact positive evidence proves no
unsafe effect occurred; an exact completed settlement replays. Do not blanket-deny proven safe
cases. Recovery of a tool-result candidate before native settlement is allowed only if no new model
call is required. Deferred polling, compaction summarization and unsafe tool execution are fenced
unless positive safe-recovery evidence exists. No assumptions that polling is harmless.

**A6 — Authority before each new provider round.** Recheck live persisted admission and current
fingerprint before provider dispatch, not only at initial admission/continuation or prompt preparation.
Reopening or hot reload cannot let an old phase snapshot execute newly prohibited work. A public
Models-bound admission composition is a recommended smallest seam, subject to the plan's local
feasibility proof; ordinary hook exceptions are not a fail-closed gate. Cover both generation
streamSimple and compaction completeSimple, and positively correlate supported deferred entrypoints
or fence them. Use public HarnessOptions.models/env composition with injected host dependencies,
not Pocket model/settings policy. Delegate auth/catalog/routing/transport to the host's Models and
preserve ordinary conversation behavior, callbacks and live settings. Guarded tools/result definitions
use standard extensions; environment narrowing is defense in depth, not a replacement for execute
guards. Model dispatch/session/route correlation remains a proof gate. No special PocketHost lifecycle
framework is authorized. Do not rebuild transport. Allow native cancellation even while new delivery
is closed.

**A7 — Structured success.** When a turn requires a schema, prose cannot complete it successfully.
Use one schema-bound public result tool, not a generic result framework or Review verdict protocol.
Accept a direct native tool round containing exactly that sole result call. Reject missing/invalid,
mixed/multiple result calls, nested codemode, stale and cross-turn identities. Revalidate in execute.
Atomically persist a candidate with exact run/thread/turn/request/submission/assistantEntry/callId/
ToolTask/schema identity and payload. Same-call replay is idempotent; different-call reuse conflicts.
`terminate: true` is a native control hint, not success: promotion requires candidate plus exact native
submission settlement/answer correlation and matching completed tool evidence. A candidate alone,
partial response, failed tool or mismatched native answer cannot yield structured success.

**A8 — Terminality and observable cleanup.** Selected stop/terminality closes adapter admission first,
then native cancellation/cleanup runs. Stop reaches owned generation and tools; continuations reject.
Close idle thread admission too: terminal native owner existence does not itself do that. Keep selected
workflow outcome authoritative, retain conversation/task references and bounded diagnostics on
failure, expose pending/succeeded/failed cleanup evidence. Native idle/terminal alone does not prove
cleanup success; inspect task outcomes. Reopen resumes unfinished cleanup idempotently without
resurrecting stopped work. Native public APIs provide abort/idle, not delete/dispose; retained storage
is acceptable. Do not claim a deleted conversation or a sandbox.

**A9 — Host compatibility and acceptance.** Use installed `@earendil-works/pi-durable` 1.0.2 public
exports only; no sibling-source aliases, upgrades or additional substrate patch are authorized.
Register agent definitions before Harness.open; one portable per-Harness runtime factory composes
the existing engine, extension definitions and public Harness options. No mutable global adapter
registry or second runtime/legacy path. Its attach operation borrows the caller-owned Harness;
close releases only runtime-owned timers/listeners/admission. The caller closes the Harness on
normal shutdown and attach/open failure. Check readiness before arming timers/resuming work.
Pocket supplies dependencies and calls this interface; it must not implement agent policy. A public
standalone consumer must use the identical interface/order without Pocket imports or its loader;
document how a Pi Durable TUI uses it without building a new TUI. Static registration and reopen
are baseline acceptance; hot reload is optional, never the source of authority truth. No loader
modifications are planned. Standalone hosts obey the same recovery/dispatch gate as Pocket. Old runs
without agent records stay compatible; no speculative backfill or mutation of existing stored kinds.
Unknown or unsupported agent record versions remain durable/inspectable and cannot auto-dispatch.
Real-provider smoke acceptance is gated separately; scripted native acceptance is not live acceptance.

Out of scope: Verify, Review policy/verdicts/revision binding, StartWork, UI, migrations, generalized
roles/delegation/retries, optional policy services, planner repair, installations/upgrades, commits,
restarts and implementation during this authorship attempt.

## 3. Installed evidence and smallest adaptations

Evidence root **D** = `node_modules/@earendil-works/pi-durable/dist/`; **AI** =
`node_modules/@earendil-works/pi-ai/dist/`. File/symbol anchors refer to the installed artifacts read
for this plan. Implementation imports remain public; reading internals is evidence, not permission to
import them. Package metadata confirms 1.0.2 and export surface in `D/index.d.ts`.

| ID / requirement | Installed reality / precise source anchor                                                                                                                                                                                                                                                                                                         | Smallest adaptation                                                                                                                                                                                                                                            | Acceptance                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| E1 / A1,A3       | `D/session/transaction.js:112–151`, `#stageConversation`: task-owned cross-conversation edge. `D/types.d.ts`, TaskRuntime.commit/conversation and Tx.createTask/createConversation.                                                                                                                                                               | Atomic logical mapping + native conversation creation, owner = workflow Task; per-turn owned runner Task with native joins. No registry of children beyond exact references needed for correlation/cleanup.                                                    | T2 identity/continuation; T6 owner cleanup.                                               |
| E2 / A3,A4       | `D/harness/submissions.js:118–127`, admitSubmission: requestId compares type only, not immutable content or provider delivery. submit and wait call resume (`:33`, `:49`).                                                                                                                                                                        | Persist canonical payload and authority identity before submit; reserve deterministic tuple-derived request identity; non-progress lookup by request repairs mapping gap.                                                                                      | T2 conflicting/concurrent intent; T3 submit/receipt gaps.                                 |
| E3 / A4,A5       | `D/harness/generation.js:91–128`, request; `:293`, streamResponse→models.streamSimple: resumed request calls provider without delivery marker. `D/harness/scheduler.js:80–110`, open changes running→pending; resume enables scheduling.                                                                                                          | Mandatory startup preflight classifies exact evidence, saves unknown, abort-marks uncertain native work before enabling scheduling. Repeat after crash. No native core patch evidenced.                                                                        | T3 SIGKILL before/after dispatch; unknown persists despite native abort.                  |
| E4 / A5,A6       | `D/harness/scheduler.js:959–973`, hooks.each reports/swallow errors unless aborted. `D/harness/harness.js:159–174`: submission/status/abortTask versus waits enabling progress.                                                                                                                                                                   | Use public inspection/Tx reads/commit/abortTask for startup; do not use throwing beforeRequest as fence or generic step.do reconciliation as sole defense. Distinct dispatch gate for runtime drift.                                                           | T1 fail-closed composition; T3 no dispatch before preflight.                              |
| E5 / A5,A6       | `D/harness/generation.js:133–142`, poll→fetchDeferred; `D/harness/compaction.js:101–129`, summarize→completeSimple; `D/harness/provider.js`, ProviderDoc/ensureProviderSessionId; `AI/models.d.ts:180–184`, public model methods.                                                                                                                 | Correlate registered adapter conversations via persisted ProviderDoc session identity. Validate Models admission composition locally for new rounds, including completeSimple. Unsupported deferred correlation or uncertain provider phases fence explicitly. | T1 entrypoint proof; T3 unsafe poll/compaction vs proven safe phase; T4 reload drift.     |
| E6 / A2          | `D/harness/agent.js:125–211`, resolveAgent/selectExtensions: missing names omitted, same name last wins, selected wraps applied. `D/harness/tool.js:66–82`, safe replay runs execute without beforeTool. `src/server/extensions/codemode.ts:294`, nested tool.execute.                                                                            | Audited explicit effective manifest + implementation versions; final guarded execution boundary that trusted wraps cannot strip. Recheck live manifest/persisted authority in execute. Public env FS/Shell narrowing is defense in depth.                      | T4 direct, replay, nested, missing/replaced/ambiguous definitions and hot reload.         |
| E7 / A7          | `D/harness/types.d.ts:292–304`, ConversationStreamOptions has no durable schema responseFormat. `D/harness/generation.js:469–499`, finishToolRound terminates only if every slot requests it; done answer is assistant entry.                                                                                                                     | Schema-bound result tool, candidate commit with exact identities; promote only exact candidate/tool/native settlement. No newest-message/prose shortcut.                                                                                                       | T5 sole direct valid result; malformed/stale/mixed/nested; crash before/after settlement. |
| E8 / A8          | `D/harness/scheduler.js`, #ownedLive, #belowCancelled, abortConversation: ordinary traversal excludes background; successful terminal waits descendants, terminal owner does not cascade. No public delete/dispose in `D/index.d.ts` / harness types. Core WorkflowInspection.cleanup is pending/native-settled, not proof of successful cleanup. | Close admission transactionally; native abort/idle plus actual outcome inspection; retain references/error for idempotent retry of cleanup. Delegation stays off rather than reuse background subagents.                                                       | T6 stop ordering, idle admission, cleanup failure/kill/reopen.                            |
| E9 / A5,A9       | `src/server/app.ts:333–420`: extensions→Harness.open→#recover→spend/subscriptions→WorkflowEngine.open. Core `WorkflowEngine.open`: TimerHost.open→harness.resume→activation. `packages/workflow-runtime/index.ts` exports core/shared kernel.                                                                                                     | Portable factory returns extension/options and attach/open/close; Pocket only supplies dependencies/calls it. All hosts attach before progress. Replace singleton registration, preserve options, close borrowed Harness on failure. No loader changes.        | T7 real Pocket lifecycle and standalone-host preflight, Targets1/2 regression.            |

## 4. Minimal durable vocabulary and seam

### Portable composition interface (proposed, not shipped)

One factory, provisionally `createWorkflowAgentRuntime({harnessOptions, agentConfig, timerOptions})`,
returns a standard extension, composed public Harness options and bounded attach/open/close
operations alongside the existing engine's workflow registration/inspection interface. Final names
are proved in T1; do not add a plugin lifecycle framework or forwarding facade for every Harness API.

```ts
const runtime = createWorkflowAgentRuntime({ harnessOptions: baseOptions, agentConfig });
registry.install(runtime.extension); // before Harness.open; no duplicate singleton Task definition
let harness: Harness | undefined;
const failures: unknown[] = [];
try {
    harness = await Harness.open(storage, runtime.options, context);
    await runtime.attach(harness, context); // finite recovery; no scheduling/timers/native waits
    // Host-specific setup/listeners, whether Pocket, a TUI or programmatic.
    await runtime.open(context); // existing engine starts timers/resumes last
    // Host operation uses the same runtime; no Pocket imports required.
} catch (error) {
    failures.push(error); // primary startup/operation failure is always first
} finally {
    try {
        await runtime.close(); // borrowed Harness is not closed here
    } catch (error) {
        failures.push(error);
    }
    if (harness !== undefined) {
        try {
            await harness.close(cleanupContext); // caller owns Harness, even on partial startup
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

`cleanupContext` must remain usable if the operation context was cancelled. Harness acquisition
failure and factory-owned partial allocation must release their respective resources; cleanup must
not mask the original startup error: rethrow a sole failure unchanged; for multiple failures retain
all diagnostics and the primary failure as the aggregate cause/first entry. Test cancelled operation
contexts plus simultaneous attach/open and runtime/Harness cleanup failures. Configure/create does
not arm resources requiring a Harness.
The composed options preserve registry, live settings, now, onReport, default env and existing
conversationCreated callbacks. Chain creation callbacks within native transaction restrictions.
Preserve non-adapter default extension selection: installing result tools must not expose them to
ordinary chats. The factory accepts existing host Models/env/config; no Pocket path discovery.
Replace, rather than duplicate, current singleton workflow registration for an agent-enabled host;
existing generic runtime consumers/stored kinds remain compatible, without a new legacy execution
path. Hot-reload notifications are not required to recompute actual registry/config fingerprints.

### Durable records and invocation binding

Proposed implementation layout is modest: `packages/workflow-runtime/agents/{profile,records,recovery,
structured-result,runner}.ts`. Merge cohesive helpers rather than adding policy engines/abstract factories.
Core binding is `context.agent.turn(...)` (or an equivalently bounded name finalized in T1); it closes
only over the **current** WorkflowRuntime/TaskRuntime and invocation admission/drain. Raw runtime
is not exposed. `StepExecution` currently contains only attempt/key/signal; it must not be treated as
having an undocumented runtime. Generic `step.do` remains generic.

Specify new stored identities once in the implementation, with no renaming of old identities:

- Native Task kind `pocket.workflow-runtime.agent-runner`, version 1.
- Doc family `pocket.workflow-runtime.agent-thread`, version 1, session scope, family=true.
  Address uses collision-safe canonical logical tuple; native conversation ID is a reference, not the
  logical address. Session-scoped state has no conversation-fork copy protocol.

One thread record holds logical/native ownership, immutable authority diagnostic inputs/fingerprint,
admission state, exact turn references/results/candidates and cleanup responsibility. Turns include
canonical intent/digest, protocol status, request/submission/runner IDs, exact outcome references and
schema identity if needed. Candidate payload and all correlation IDs commit atomically. Identity
reservation and native conversation/runner creation commit atomically where public Tx supports it;
submission and its receipt are separate public boundaries, explicitly reconciled by persisted requestId.
Initialize ProviderDoc/session mapping before progress; missing mapping is not permission to dispatch.
Persist only data needed for replay, correlation and observable cleanup; no parallel native task state
machine. Use native Entries/results as proof where sufficient, with adapter records for semantic
unknown, authority, logical identity and schema candidate not provided natively. Agent audit events
may use the packet's vocabulary only when they add a distinct semantic fact, not duplicate native facts.

Fingerprint inputs are canonical data: profile id/version, instruction version/content, effective
capabilities and tool schemas, explicit tool/section/extension implementation versions and selection/
wrap order, delegation=false, model route and thinking/behavioral settings, result schema id/version/
content. Store inputs for drift diagnosis. Name/schema equality alone is not code identity; explicit
versions require deployment discipline. Current manifest must be rechecked despite cached snapshots.

Startup recovery and runtime dispatch admission are separate obligations. The former already has
positive source evidence and public non-progress APIs. The latter Models seam is a recommendation,
not a proven implementation. T1 must prove typed public composition, unambiguous session mapping,
fail-closed behavior and no ungated entrypoint before any agent-enabled host progresses. Failure is
BLOCKED with concrete unsupported API/entrypoint evidence, not authorization for a core patch,
upgrade, custom provider transport or hook-only substitute.

## 5. Acceptance and review boundary

The plan's T1–T8 map every mechanism to requirements/evidence and a failing acceptance test. Use
real installed native tasks/storage and scripted external Models/tools, plus complete-process SIGKILL
with persisted dispatch counters. Existing generic core crash tests are fixture evidence, not agent
acceptance. Include exact native answer committed before runner/workflow receipt, and candidate
committed before tool/native settlement; exercise actual Pocket startup, not only independent Harness.

Essential baseline: A1–A9 including evidenced startup no-resend fence, actual tool enforcement,
structured exact correlation, native-owned lifetime and retained cleanup. Optional/unproven/deferred:
Models gate mechanics until T1 proves them; deferred/poll recovery until safe correlation is proven;
authority migration, result frameworks, child registries, native deletion, retries/Review policy and live
provider acceptance without approval. Unsupported work fails closed without silently expanding scope.

Independent document review must verify normative→gap→adapter→test traceability, safe versus
uncertain phase classification, native ownership, current-runtime binding, stop ordering, migration
compatibility, portable per-Harness composition and borrowed-Harness failure cleanup. Verify static
standalone acceptance and the identical documented TUI sequence, thin Pocket integration, no loader
changes or parallel legacy runtime, option/callback preservation and credential/spend gating. Approval of these docs does not prove
live acceptance and does not repair or authorize any planner machinery.
