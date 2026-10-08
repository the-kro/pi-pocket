# Target 3 — native agent adapter: Spec Contract

Status: portability refinement independently reviewed READY. This is document readiness, not implementation or live-provider acceptance.
Implementation is authorized only through the user's later direct-salvage instruction; no durable workflow receipt is claimed. Target 3 acceptance remains pending, and no live-provider acceptance has been demonstrated. Companion: [implementation plan](target-3-agent-adapter-plan.md).

## 1. Approval and authority

Latest scope question, recorded verbatim:

> With that distinction clarified, confirm the previously presented Target 3 scope for plan authorship: separate native AgentRunner, explicit profiles and execution-enforced narrowing (delegation off in v0), exact durable thread/turn/results and structured output, continuation/cancellation/observable cleanup, and an evidence-backed recovery guard before uncertain native work can dispatch. The plan must include requirement → installed-API gap → smallest adapter → acceptance-test traceability; no speculative machinery, no blind resend, no duplicate scheduler. Preserve Targets1/2; exclude Verify/Review/StartWork/UI and upgrades. Live provider acceptance is explicitly gated on credentials/spend authorization. We will write and independently review docs only, not implement Target3 or repair the planner framework. Do you confirm?

Exact answer:

> Confirmed — finish the spec and plan with that traceability

This was the original scope approval. Its no-blind-provider-resend and per-round Models-gate clauses are superseded by the approved revision below. The earlier requirement to prove adapter necessity remains historical context; startup preflight remains a selected host-lifecycle mechanism, not a mechanism literally named by the original packet.

### Approved semantic revision

The user later approved relaxing the provider no-blind-resend requirement to match standard Pi Durable recovery behavior:

> I think we should relax the spec requirement as you suggested. it aligns with standard pi-durable behavior.

Effective contract:

- A provider request whose delivery or response is uncertain after a crash may be issued again when Pi Durable resumes its native generation, compaction, or deferred-poll task. Do not promise exactly-once provider calls, duplicate-charge prevention, or identical output after recovery.
- Continue replaying an exactly saved completed result without another provider request.
- Keep exact workflow/run/thread/turn ownership and immutable-intent checks at adapter turn admission. Recovery preflight must also verify the workflow owner/run is still active, un-aborted and non-terminal before native provider work resumes; preserve a closed thread. Keep separate no-automatic-replay protection for uncertain native tool execution and terminal/stop authority.
- Do not require a per-provider-call Models identity/admission gate or an upstream identity seam. Use the host's standard Models behavior for provider requests; ProviderDoc remains conversation correlation, not proof of delivery or caller authority.
- Keep adapter preflight-before-progress, enforced by controlled `openHost`, and the existing offline-only acceptance boundary. No live provider calls or spend are authorized by this revision.

This is a deliberate weaker provider-recovery guarantee, not an authorization/security feature. Any future exactly-once or per-round provider-authority requirement needs a new user-approved contract and a suitable public, host-independent API.

The user previously approved the portable-host refinement and documentation changes:

> APPROVED - Let's make the changes needed to the spec/plan.

Apply [Host portability and earned integration seams](../pi-durable-production-runtime-v0/01-architecture.md#host-portability-and-earned-integration-seams):
Pocket is only one host; standard extensions/configuration come first; any extra helper must earn
its existence through a concrete API gap and be callable by TUI/programmatic hosts. Hot reload is
optional DX. At that time this changed the integration design, not the durable safety requirements; the later approved provider-retry exception above supersedes that statement only for ambiguous provider requests.

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

**A4 — Durable turn protocol and exact saved-result replay.** Distinguish `completed`, `accepted-incomplete`,
`not-completed`, `unknown`, `authority-drift`. Native settlement remains execution evidence, not a
license to reinterpret an uncertain tool effect as ordinary failed/aborted. Persist canonical intent/digest,
runner/native submission/request references and exact result association. Recovery validates each located
native input's actual `UserEntry` content against immutable turn intent and any persisted submission ID
against the located submission before allowing native provider progress. Completed replay returns
the saved exact result without submit, wait, or provider dispatch. A settled exact native answer may
repair a missing adapter/workflow receipt without dispatch. Never use newest message or mutable
current-turn state as proof. Unknown tool execution and unsupported identity remain durable and are not
automatically replayed. A runner failure is `not-completed` only when the exact request has no persisted
native submission and the reserved thread is still ready; retry then requires a new logical turn ID.
Once a native submission exists, ordinary runner failure is `unknown` and fences the thread rather
than inferring that provider work did not start. Provider requests are different: an interrupted native
generation, compaction, or deferred-poll task may issue another provider request on standard Pi Durable recovery. The adapter
makes no exactly-once, duplicate-charge, or identical-output guarantee for that boundary. Explicit
user-initiated retries still require new logical turn IDs; generalized retry chains and operator
reconciliation machinery remain deferred.

**A5 — Controlled startup and native provider retry semantics.** The portable runtime owns the
Harness open and recovery boundary; it does not rely on undocumented global startup hooks or a
caller-documented order. Hosts call `openHost(storage, context, prepare)`, which keeps the raw Harness,
composed options and progress-capable methods private until successful startup. `prepare` receives
only bounded read/inspection, scoped document recovery writes, commit-listener/disposer registration,
and queued conversation-cancellation capabilities. `prepare` and post-recovery callbacks are awaited;
commit listeners must remain synchronous, nonthrowing/nonblocking, and avoid Session API reentry.
`prepare` runs before adapter preflight so listeners and host recovery are ready; registered
`onAfterAdapterRecovery` callbacks then run after adapter
preflight and before TimerHost initialization, compatible workflow activation, final pre-resume
checks and the controlled progress transition. Startup setup is sealed immediately before that
transition. Early engine access and retained setup calls reject. On failure, acquired listeners are
disposed, the privately owned Harness is closed using cancellation-independent cleanup context, and
primary plus cleanup errors are preserved; partial `Harness.open` cleanup diagnostics emitted through
`onReport` are collected without dropping the host callback. A rejection before Harness construction
leaves supplied storage untouched for its caller to close; once construction has begun, Harness owns
its partial-cleanup attempt. On success the Harness and setup disposer transfer to the caller while
runtime close remains resource-only. The public `Conversation.abort()` resumes the whole
scheduler, so a queued cancellation can allow other ordinary work/provider spend during that
controlled transition; no cancellation-priority or no-extra-spend guarantee is claimed.

This ordering protects adapter identity, exact-result reconciliation, stop/ownership state and tool
execution; it is not a provider no-resend guarantee. Interrupted native generation, compaction and
deferred-poll work may resume according to Pi Durable semantics and may issue another provider
request even when prior delivery is uncertain. Persist and replay an exact completed result when one
is available. Continue to durably fence uncertain native tool execution before abort/cleanup; native
abort settlement must not overwrite that tool-unknown state. When an active Generation checkpoint
references tool Task IDs, resolve those records through public `getTask`, including terminal
outcomes; a missing, mismatched, failed or aborted tool outcome is not proof of no side effect and
must fence the turn before provider progress. Inspect owned generation and tool work, not only runner
Tasks, but do not block provider replay solely because delivery is uncertain.

**A6 — Authority at logical turn and tool execution boundaries.** Check current workflow/run/thread
ownership, immutable intent and profile authority when admitting a new logical turn or continuation;
check live persisted authority again at actual tool execution, including replay and nested paths. Do
not require a per-provider-round Models gate. Native generation, compaction and deferred provider
requests use the host's normal Models behavior, including its ordinary recovery semantics. A profile,
model route, or registry change after turn admission is not guaranteed to revoke an in-flight native
provider phase; document and accept that limitation rather than pretending a session ID is trusted
caller identity. Use standard HarnessOptions composition to preserve host settings, ordinary traffic
and callbacks. Guarded tools/result definitions use standard extensions; environment narrowing is
defense in depth, not a replacement for execute guards. No special PocketHost lifecycle framework,
custom transport, or provider-dispatch identity seam is required. Allow native cancellation after stop;
turn/task admission remains closed for new logical work.

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
Register agent workflow definitions before `openHost`; one portable per-Harness runtime factory
composes the existing engine, extension definitions and public Harness options internally. The public
runtime exposes `openHost`, bounded `register`, ready-only engine access and resource-only `close`;
it exposes no raw composed options, attach/open split or second runtime/legacy path. `openHost` owns
Harness acquisition and closes it on failed startup; after success the host receives Harness and a
setup disposer. Pocket supplies dependencies and calls this interface; it must not implement agent
policy. A public standalone consumer must use the identical interface/order without Pocket imports
or its loader; document how a Pi Durable TUI uses it without building a new TUI. Static registration
and reopen are baseline acceptance; hot reload is optional, never the source of authority truth. No
loader modifications are planned. Standalone hosts use the same controlled startup lifecycle, turn
admission and tool-execution safeguards as Pocket, while provider retries follow native Pi Durable
semantics. Old runs without agent records stay compatible; no speculative backfill or mutation of
existing stored kinds.
Unknown or unsupported agent record versions remain durable/inspectable and cannot auto-dispatch.
Real-provider smoke acceptance is gated separately; scripted native acceptance is not live acceptance.

Out of scope: Verify, Review policy/verdicts/revision binding, StartWork, UI, migrations, generalized
roles/delegation/retry chains, optional policy services, planner repair, installations/upgrades,
commits and restarts. Provider replay only follows existing Pi Durable recovery; no new generic retry
framework is authorized.

## 3. Installed evidence and smallest adaptations

Evidence root **D** = `node_modules/@earendil-works/pi-durable/dist/`; **AI** =
`node_modules/@earendil-works/pi-ai/dist/`. File/symbol anchors refer to the installed artifacts read
for this plan. Implementation imports remain public; reading internals is evidence, not permission to
import them. Package metadata confirms 1.0.2 and export surface in `D/index.d.ts`.

| ID / requirement | Installed reality / precise source anchor                                                                                                                                                                                                                                                                                                         | Smallest adaptation                                                                                                                                                                                                                                                                                                                                               | Acceptance                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| E1 / A1,A3       | `D/session/transaction.js:112–151`, `#stageConversation`: task-owned cross-conversation edge. `D/types.d.ts`, TaskRuntime.commit/conversation and Tx.createTask/createConversation.                                                                                                                                                               | Atomic logical mapping + native conversation creation, owner = workflow Task; per-turn owned runner Task with native joins. No registry of children beyond exact references needed for correlation/cleanup.                                                                                                                                                       | T2 identity/continuation; T6 owner cleanup.                                               |
| E2 / A3,A4       | `D/harness/submissions.js:118–127`, admitSubmission: requestId compares type only, not immutable content or provider delivery. submit and wait call resume (`:33`, `:49`).                                                                                                                                                                        | Persist canonical payload and authority identity before submit; reserve deterministic tuple-derived request identity; non-progress lookup by request repairs mapping gap.                                                                                                                                                                                         | T2 conflicting/concurrent intent; T3 submit/receipt gaps.                                 |
| E3 / A4,A5       | `D/harness/generation.js:91–128`, request; `:293`, streamResponse→models.streamSimple: resumed request calls provider without a delivery marker. `D/harness/scheduler.js:80–110`, open changes running→pending; resume enables scheduling.                                                                                                        | Attach/preflight before progress to reconcile exact completed answers and protect adapter/tool state; allow uncertain native provider work to resume under core semantics. No provider no-resend guarantee or substrate patch.                                                                                                                                    | T3 exact saved-answer replay; ambiguous provider crash may add a dispatch marker.         |
| E4 / A5,A6       | `D/harness/scheduler.js:959–973`, hooks.each reports/swallow errors unless aborted. `D/harness/harness.js:159–174`: submission/status/abortTask versus waits enabling progress.                                                                                                                                                                   | Use public inspection/Tx reads/commit/abortTask for controlled startup ordering and tool-state recovery. Do not use swallowed hooks as an enforcement boundary; no per-call Models dispatch gate is required.                                                                                                                                                     | T1 controlled preflight-before-progress; T3 provider retry and tool-fence cases.          |
| E5 / A4,A6       | `D/harness/generation.js:133–142`, poll→fetchDeferred; `D/harness/compaction.js:101–129`, summarize→completeSimple; `D/harness/provider.js`, ProviderDoc/ensureProviderSessionId; `AI/models.d.ts:180–184`, public model methods.                                                                                                                 | Use ProviderDoc only to correlate a native conversation. Let generation, compaction and deferred requests use host Models and standard recovery semantics; keep separate tool-execution fencing. No trusted Models identity seam or session-ID dispatch gate.                                                                                                     | T3 exact result replay vs possible provider reissue; T4 turn/tool authority.              |
| E6 / A2          | `D/harness/agent.js:125–211`, resolveAgent/selectExtensions: missing names omitted, same name last wins, selected wraps applied. `D/harness/tool.js:66–82`, safe replay runs execute without beforeTool. `src/server/extensions/codemode.ts:294`, nested tool.execute.                                                                            | Audited explicit effective manifest + implementation versions; final guarded execution boundary that trusted wraps cannot strip. Recheck live manifest/persisted authority in execute. Public env FS/Shell narrowing is defense in depth.                                                                                                                         | T4 direct, replay, nested, missing/replaced/ambiguous definitions and hot reload.         |
| E7 / A7          | `D/harness/types.d.ts:292–304`, ConversationStreamOptions has no durable schema responseFormat. `D/harness/generation.js:469–499`, finishToolRound terminates only if every slot requests it; done answer is assistant entry.                                                                                                                     | Schema-bound result tool, candidate commit with exact identities; promote only exact candidate/tool/native settlement. No newest-message/prose shortcut.                                                                                                                                                                                                          | T5 sole direct valid result; malformed/stale/mixed/nested; crash before/after settlement. |
| E8 / A8          | `D/harness/scheduler.js`, #ownedLive, #belowCancelled, abortConversation: ordinary traversal excludes background; successful terminal waits descendants, terminal owner does not cascade. No public delete/dispose in `D/index.d.ts` / harness types. Core WorkflowInspection.cleanup is pending/native-settled, not proof of successful cleanup. | Close admission transactionally; native abort/idle plus actual outcome inspection; retain references/error for idempotent retry of cleanup. Delegation stays off rather than reuse background subagents.                                                                                                                                                          | T6 stop ordering, idle admission, cleanup failure/kill/reopen.                            |
| E9 / A5,A9       | `src/server/app.ts:333–420`: extensions→Harness.open→#recover→spend/subscriptions→WorkflowEngine.open. Core `WorkflowEngine.open`: TimerHost.open→harness.resume→activation. `packages/workflow-runtime/index.ts` exports core/shared kernel.                                                                                                     | Portable factory returns extension, bounded registration, ready-only engine access, `openHost` and `close`; its restricted setup facade supports caller recovery/listeners without raw Harness or progress methods. Pocket supplies dependencies/calls it; runtime closes Harness on failed startup and successful host owns Harness/disposer. No loader changes. | T7 real Pocket lifecycle and standalone-host preflight, Targets1/2 regression.            |

## 4. Minimal durable vocabulary and seam

### Portable composition interface (implemented; Target 3 acceptance pending review)

One factory, `createWorkflowAgentRuntime({harnessOptions, agentConfig, timerOptions})`, returns a
standard extension, bounded workflow registration, ready-only engine access, controlled `openHost`
and resource-only `close`. Composed options remain private. The small setup facade exposes only
read/inspection, scans, scoped document updates, commit subscriptions with disposer ownership, queued
conversation cancellations and registered post-adapter-recovery callbacks; it never exposes the raw
Harness, Tx, generic commit, wait, resume, submit or abort handles. No plugin lifecycle framework or
forwarding facade for every Harness API is added.

```ts
const runtime = createWorkflowAgentRuntime({ harnessOptions: baseOptions, agentConfig });
registry.install(runtime.extension); // before openHost; no duplicate singleton Task definition
runtime.register(workflow); // definitions needed to activate persisted runs are supplied up front

const host = await runtime.openHost(storage, context, async (setup) => {
    setup.subscribeCommits(onCommit); // installed before adapter recovery
    setup.onAfterAdapterRecovery(async (recovered) => {
        await recoverHostDocuments(recovered); // only through scoped document writes
        recovered.requestConversationAbort(conversationId); // queued until controlled progress
    });
    return hostPreparationResult;
});

try {
    const engine = runtime.engine; // unavailable until successful controlled startup
    await runHost(runtime, host.harness, engine, host.prepared);
} finally {
    await host.dispose(); // successful setup listener ownership transfers to the caller
    await runtime.close(); // releases runtime-owned timers/admission, not the Harness
    await host.harness.close(cleanupContext);
}
```

`openHost` privately acquires the Harness, runs bounded preparation, performs adapter preflight,
then invokes registered post-recovery setup before TimerHost initialization, compatible activation,
final pre-resume checks, and the controlled progress transition. The setup facade seals immediately
before progress. On startup failure, setup disposers run and runtime closes the privately acquired
Harness with cancellation-independent cleanup context; the primary error remains first/cause if
cleanup also fails. On success, Harness and disposer ownership transfer to the caller. Public
`Conversation.abort()` resumes the whole scheduler, so queued startup cancellation may allow ordinary
work/provider spend during that transition; this lifecycle does not promise cancellation priority.

Harness acquisition failure and factory-owned partial allocation release their respective resources;
cleanup must not mask the original startup error. Preserve live settings, now, onReport, default env
and existing conversationCreated callbacks through private option composition. Chain creation
callbacks within native transaction restrictions. Preserve non-adapter default extension selection:
installing result tools must not expose them to ordinary chats. The factory accepts existing host
Models/env/config; no Pocket path discovery. Replace, rather than duplicate, current singleton
workflow registration for an agent-enabled host; existing generic runtime consumers/stored kinds
remain compatible, without a new legacy execution path. Hot-reload notifications are not required to
recompute actual registry/config fingerprints.

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

Startup ordering, turn admission and tool-execution authority are separate obligations. Adapter
preflight must complete before timer initialization or any other progress-enabled path. Repeat
recovery after TimerHost initialization and immediately before the controlled Harness progress transition; a stop/terminal
selection during the asynchronous timer scan must fence pending work before scheduling resumes. For every active runner, match Task owner and `workflowTaskId` to the durable thread owner and
exact turn identity. Account for every adapter-correlated active native task; if no exact active
runner owns it, fence/abort it rather than letting scheduler recovery run it unobserved. A closed
thread must stay closed through recovery and native abort settlement. New logical turns must match
their workflow owner and immutable intent; actual tool execution must recheck current authority. A
per-call Models seam is not part of the revised contract. Standard provider requests—including an
ambiguous deferred poll—may be repeated by native recovery, so unsupported Models identity/session
correlation is not a blocker and must not be replaced with a Pocket-only patch or an untrusted
caller-supplied identity.

## 5. Acceptance and review boundary

The plan's T1–T8 map every mechanism to requirements/evidence and a failing acceptance test. Use
real installed native tasks/storage and scripted external Models/tools, plus complete-process SIGKILL
with persisted dispatch counters. Existing generic core crash tests are fixture evidence, not agent
acceptance. Include exact native answer committed before runner/workflow receipt, and candidate
committed before tool/native settlement; exercise actual Pocket startup, not only independent Harness.

Essential baseline: revised A1–A9, including controlled preflight-before-progress, exact saved-result replay, workflow-turn ownership, actual tool enforcement, structured exact correlation, native-owned lifetime and retained cleanup. Provider requests may be repeated after ambiguous recovery under native Pi Durable semantics; no exactly-once provider guarantee is claimed. Deferred/poll requests follow that same native behavior. Still deferred: authority migration, generalized result frameworks, child registries, native deletion, retry/Review policy and live-provider acceptance without approval. Unsupported identities and uncertain tool executions remain inspectable and fenced.

Independent document review must verify normative→gap→adapter→test traceability, safe versus
uncertain phase classification, native ownership, current-runtime binding, stop ordering, migration
compatibility, portable per-Harness composition and borrowed-Harness failure cleanup. Verify static
standalone acceptance and the identical documented TUI sequence, thin Pocket integration, no loader
changes or parallel legacy runtime, option/callback preservation and credential/spend gating. Approval of these docs does not prove
live acceptance and does not repair or authorize any planner machinery.
