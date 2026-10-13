# Target 5 — Review implementation plan

**Plan format:** crywolf-start-work/v1

**Status:** Original plan independently reviewed **APPROVED** (TaskReviewer run `9fd4fea0-e888-4cc6-89f1-d12be4c469ad`); owner approved implementation under this existing plan. The owner has now authorized an in-place Target 3/Target 5 amendment for runtime-resolved reviewer identity and fresh-thread admission; the original READY review does not cover this amendment.

**Contract:** [04 — Verification and Review](../pi-durable-production-runtime-v0/04-verification-review.md),
Target 5 in [07 — Productionization](../pi-durable-production-runtime-v0/07-productionization.md),
and the Review section of [06 — V0 Conformance](../pi-durable-production-runtime-v0/06-conformance.md).
The consumer lifecycle is constrained by [05 — Start Work v0](../pi-durable-production-runtime-v0/05-start-work-v0.md).

## Goal and scope

Deliver a small, host-independent application-level Review protocol that accepts only a structured,
revision-bound reviewer decision from an independent reviewer conversation. It must preserve the
reviewer's conversation across passes in one gate, reject stale or mismatched evidence, and make a
`BLOCKED` verdict usable by a workflow's existing durable wait/event primitives.

Target 5 delivers Review, not the Start Work lifecycle. The workflow caller owns repair, fresh
verification, continuation ordering, waiting, and completion. Review does not run a second scheduler
or an `untilApproved()` loop.

### In scope

- A public Review request/result contract and bounded `ReviewDecision` validation.
- A portable `review(...)` helper using the existing workflow context, Target 3 agent-turn adapter,
  and Target 4 verification/workspace adapters.
- A fresh reviewer conversation per gate, with later passes using the same reviewer thread and a new
  logical turn ID. The implementer and reviewer must remain separate conversations.
- Actual execution-time read-only enforcement through the Target 3 capability guard, including safe
  ToolTask recovery/replay. A prompt or hidden tool list is not enforcement.
- Exact binding to the successful verification result, workspace revision, review scope, reviewer
  profile/authority, and logical turn; fresh workspace/safety checks before admission and decision
  promotion.
- Offline direct, recovery, portable-host, repair-continuation, and `BLOCKED` wait acceptance.
- A public package export and standalone host guidance, including the equivalent TUI lifecycle.

### Out of scope

- Implementing or duplicating Target 3's generic authority enforcement or schema-bound result tool.
- Start Work admission, implementer orchestration, repair loops, or final workflow completion.
- A new scheduler, registry, cancellation tree, generic result/schema service, role framework,
  guidance framework, `ORACLE_REQUIRED`, or historical TaskReview protocol.
- Arbitrary shell access or a claim that shell commands are sandboxed/read-only. Optional read-only
  analysis is allowed only where a concrete audited capability proves it safe; it is not required for
  v0 Review.
- Pocket UI, Pocket-specific review policy, Pocket loader/hot-reload dependencies, stored document
  kind changes, migrations, Pi Durable core patches/upgrades, live provider calls, or provider spend.

## Recommendation and decision record

The author and Oracle recommend keeping Target 5 narrow and making the missing Target 3 capabilities
hard prerequisites rather than reimplementing them inside Review. This follows the existing target
sequence and avoids treating prompt instructions as a security boundary. Target 4's verifier is
reused for evidence identity, but its completed-result replay is historical evidence—not a fresh
workspace check.

No additional product decision is open under this scope. If implementation ownership is changed so
Target 5 absorbs Target 3 authority or structured-result work, stop and obtain explicit scope approval
before adding that work here.

## Repository and feasibility evidence

- Target 5 requires an independent read-only reviewer, structured verdicts, same-reviewer
  continuation, and revision binding (`04-verification-review.md`, `07-productionization.md`).
  `06-conformance.md` requires verdict invariants, stale-revision rejection, and a nonterminal durable
  wait for `BLOCKED`.
- Target 4's `packages/workflow-runtime/verification/` implementation and focused/recovery/host
  tests are present. `VerificationResult` carries `verificationId`, `requestDigest`, `workspaceId`,
  `subjectRevision`, `status`, and check evidence. The verifier uses `step.do` for exact replay and
  injected workspace/safety adapters.
- A replayed completed `verify(...)` result does not re-snapshot the current workspace. Review must
  compare the exact verification result with a fresh workspace snapshot at admission and again before
  promoting a decision. Matching snapshots alone are not cross-restart quiescence evidence; retain the
  Target 4 host-owned `WorkspaceSafetyAdapter` assumption.
- Current `WorkflowAgentProfile` in `packages/workflow-runtime/agents/profile.ts` contains identity,
  instructions, and model fields, but no enforced capability declaration or result schema. The current
  runner's empty tool configuration is tool-less, not a useful read-only reviewer profile.
- There is no `packages/workflow-runtime/agents/structured-result.ts`, nor are
  `test/workflow-agent-authority.test.ts` and `test/workflow-agent-result.test.ts` present. The current
  agent turn record stores a generic JSON result; this does not prove schema-bound native result
  settlement. The Target 3 plan assigns authority and structured-result work to its Tasks T4 and T5;
  its completion prose is not a substitute for source/test evidence of those capabilities.
- Current agent recovery also fences live tools, including potentially safe read/result tools. The
  Target 3 prerequisite must demonstrate safe guarded read/result-tool recovery while retaining fences
  for uncertain unsafe effects. Otherwise Review cannot use read capabilities across restart.
- Oracle found no demonstrated Pi Durable core blocker for the small adapter. Existing public tool,
  task, transaction, and registry facilities appear sufficient, subject to Target 3 proving the
  execution and recovery guards through public exports. Do not use private APIs or infer feasibility
  from package internals. If the public path proves insufficient, stop with the exact API gap; do not
  patch or upgrade Pi Durable in this plan.

## Hard prerequisites before Review integration

The following are execution gates, not work silently absorbed by Target 5:

1. **Target 3 authority acceptance:** the configured reviewer can use the required audited read,
   search, navigation, and verification-evidence capabilities, while actual tool execution rejects
   workspace mutation and disabled delegation. Task T8 of the existing Target 3 plan must expose a
   runtime-owned resolved reviewer identity and apply the host-configured read-only authority ceiling
   at actual turn admission. Enforcement must survive trusted wrapper ordering, argument
   transformations, registry/config drift, and safe native ToolTask replay/reopen. A hidden tool,
   prompt, or `beforeTool` hook alone is insufficient. Uncertain unsafe tool effects remain fenced.
2. **Target 3 structured-result acceptance:** one exact schema-bound result call is correlated to
   the current native submission/assistant round/call/task/schema and promoted only after native
   settlement. Prose, invalid/mixed calls, stale candidates, or mismatched identity cannot become
   success; exact completed results replay without another model dispatch. Review supplies its own
   small verdict schema to this primitive; it does not create a second result system.
3. **Target 3 thread/recovery acceptance:** the existing workflow-owned conversation and turn
   identity support a distinct reviewer thread, fresh turn IDs, exact result replay, controlled startup,
   and safe guarded read/result-tool recovery. Target 3 Task T8 must atomically reject pre-used history
   for a new Review gate while permitting exact replay of its reserved first turn. Ambiguous provider
   delivery keeps the approved Target 3 semantics: native recovery may repeat provider requests; no
   exactly-once claim is made.
4. **Target 4 public-path acceptance:** Review consumes the exported verifier/workspace contracts
   and passing `VerificationResult`; existing Target 4 tests and the standalone public-export path pass
   on the implementation base. Review does not rerun checks or fork a Pocket-only verifier path.

Before implementation, verify these gates from current source and tests, not status prose. If a gate
is not met, stop Review integration and report the exact missing evidence. Pure Review contract tests
may be developed first, but Target 5 cannot be declared complete until every gate is met.

## Proposed Review contract

The public surface should stay small: one caller-owned request and one durable result. Names may be
adjusted to match existing package conventions, but preserve these semantics:

```ts
type ReviewDecision =
    | { verdict: "APPROVED"; summary: string }
    | { verdict: "CHANGES_REQUIRED"; summary: string; findings: Finding[] }
    | { verdict: "BLOCKED"; summary: string; reason: string };

type ReviewRequest = {
    gateId: string; // stable for one review gate
    threadId: string; // fresh reviewer conversation, reused within the gate
    turnId: string; // new stable logical ID for every pass
    reviewerProfile: string; // configured Target 3 profile, not caller-defined authority
    workspaceRevision: WorkspaceRevision;
    verification: VerificationResult;
    scope: string; // bounded, immutable review scope
};
```

`Finding` is bounded and actionable (at minimum a stable finding ID, concise description/evidence,
and the required artifact change). It is present and non-empty only for `CHANGES_REQUIRED`.
`APPROVED` carries no blocking findings; `BLOCKED` requires a concrete reason and is not a terminal
workflow failure. Invalid structured output, unknown agent execution, and stale evidence are not
converted into `BLOCKED`.

The durable `ReviewResult` wraps the validated decision with the exact `gateId`, `threadId`, `turnId`,
`workspaceId`, subject revision, verification ID/request digest, and canonical Review request digest.
It is historical evidence for that exact pass only. The function must never accept an earlier turn's
result as the result of a later turn.

The canonical Review request binding includes at least:

- caller-owned gate/thread/turn IDs;
- exact workspace identity and content revision;
- verification ID, request digest, successful status, and matching revision;
- bounded review scope and its digest;
- the complete Target 3 resolver identity: profile/model/effective authority, `policyFingerprint`,
  instructions, exact result schema, and the resolver's composite `fingerprint`. Validate both added
  SHA-256 fields as exact object keys. The request identity is an expected value only and is rechecked
  by Target 3 at turn admission.

Same logical turn with changed input rejects before reviewer dispatch, including on completed replay.
IDs and compound operation keys are validated/encoded collision-safely. No secrets or mutable
workspace contents are serialized into the binding.

## Ordered implementation tasks

Every changed behavior starts with a public-seam failing test, an observed intended RED (not a
syntax/import failure), the smallest GREEN change, and bounded refactoring. Record the exact RED/GREEN
commands and results. Existing Target 3/4 passing tests are regression evidence, not new Target 5 RED
evidence.

## Task T1 — Freeze Review request, verdict, and revision-binding contract

**Depends on:** none

**Requirements:** verdict invariants, exact verification binding, stable logical gate/turn identity, fail-closed stale evidence.

**Files:**

- Create: packages/workflow-runtime/review/types.ts
- Create: packages/workflow-runtime/review/contract.ts
- Create: test/workflow-review.test.ts
- Create: docs/plans/target-5-t1-tdd-evidence.md

**Acceptance:** Freeze the bounded public Review contract with exact verification and revision binding.

**Verification:**

- Required: node --test test/workflow-review.test.ts
- Required: npm run check
- Required: npm run lint

Detailed acceptance from the existing plan:

1. Define bounded public `Finding`, `ReviewDecision`, `ReviewRequest`, and `ReviewResult` types. Keep
   the three contract verdicts exactly `APPROVED`, `CHANGES_REQUIRED`, and `BLOCKED`; do not add
   `ORACLE_REQUIRED` or turn invalid/unknown work into a verdict.
2. Validate non-empty stable IDs, distinct gate/thread/turn roles, bounded scope/result sizes, and
   collision-safe operation identity. `gateId` and reviewer thread stay stable for one gate; every pass
   uses a caller-owned fresh `turnId`.
3. Accept only a `passed` verification result whose workspace ID and subject revision exactly match
   the requested review revision. Bind its `verificationId` and `requestDigest`; a failed/interrupted,
   malformed, stale, or mismatched result rejects before any agent call. Do not run verification
   commands here.
4. Enforce verdict algebra: `APPROVED` has no blocking findings; `CHANGES_REQUIRED` has one or more
   bounded material/actionable findings; `BLOCKED` has a bounded non-empty reason. Reject extra,
   missing, duplicated, or over-bound fields. Use the schema-bound Target 3 result primitive when
   available; do not treat free-form assistant prose as authoritative.
5. Test literal expected identities and result values, including exact `policyFingerprint` and
   composite `fingerprint` values, rejection when either is omitted or malformed, and changed-same-turn
   drift for each. Also test exact-revision matching, invalid verdicts, and stale result/turn confusion
   through the public contract seam.

Original prerequisite context preserved: Target 4 public verification types. This task may proceed while Target 3 integration gates are pending; it does not claim reviewer authority or execution readiness.

**Stop condition:** if the contract cannot be represented within the public Target 3 structured result
limits, report the exact constraint; do not widen a generic result service or add a schema framework.

## Task T2 — Implement the portable durable Review pass

**Depends on:** T1

**Requirements:** completed Target 3 Task T8; independent enforced read-only reviewer; exact durable turn and verdict; same-gate continuation.

**Files:**

- Create: packages/workflow-runtime/review/review.ts
- Modify: packages/workflow-runtime/index.ts
- Modify: test/workflow-review.test.ts

**Acceptance:** Implement the portable durable Review pass with independent read-only reviewer authority and exact decision binding.

**Verification:**

- Required: node --test test/workflow-review.test.ts
- Required: npm run check
- Required: npm run lint

Detailed acceptance from the existing plan:

1. Export one narrow host-independent `review(context, request, adapters)`-style helper. Reuse
   `WorkflowContext`, `context.agent.turn`, the existing schema-bound result primitive, and injected
   Target 4 workspace/safety adapters. Do not create a Harness, call a provider directly, import Pocket,
   or add a scheduler.
2. Before dispatch, resolve the selected profile through the same runtime that will execute
   `context.agent.turn`. Treat `reviewerIdentity` as an expected identity only: compare it exactly with
   the runtime-owned profile/model/authority/instructions/result descriptor and reject mismatches before
   any Review dispatch. Persist/compare a pure durable request binding for the logical gate/turn,
   including the exact verification evidence, revision, scope, complete resolved reviewer identity
   (including `policyFingerprint` and composite `fingerprint`), schema/result policy, and stable IDs.
   Pass that expected identity to Target 3 turn admission for an atomic recheck. Changed input or
   runtime drift rejects before dispatch even if an earlier operation completed.
3. At admission, freshly snapshot the workspace and require it to match the successful verification
   revision. Obtain a fail-closed host safety/quiescence assurance. Do not treat a replayed `verify()`
   result or matching snapshots alone as a current or cross-restart safety check.
4. Start a fresh reviewer conversation for a new gate. Persist a collision-safe reverse reservation
   from `(threadId, resolvedProfileId)` to `gateId`; a different gate cannot reuse that thread, including
   after restart or concurrent admission. Preserve the first `turnId` in the gate reservation and request
   Target 3's atomic fresh-thread admission for that first pass; later passes use the same thread and a
   new `turnId`. The consumer must use a reviewer conversation distinct from the implementer
   conversation. The runtime-resolved profile must be within the host-configured read-only allowlist and
   have the exact Review result binding; actual tool execution remains guarded by Target 3.
5. Deliver only the bounded scope, exact revision, and verification evidence required for this pass.
   Accept only the exact schema-valid structured result correlated by Target 3 to this native turn.
   Prose, an old turn result, a candidate without native settlement, or ambiguous execution is not a
   Review decision.
6. Before promoting a decision as current, freshly snapshot again and obtain the safety adapter's
   promotion assurance. If the revision changed, the workspace identity differs, or safety is absent or
   unknown, do not return an approval for the current revision. Preserve any completed decision only as
   historical evidence for its bound revision; require a fresh snapshot/Verify and new review turn for a
   new revision. Do not invent a `STALE` or `ORACLE_REQUIRED` verdict.
7. Persist the bounded exact `ReviewResult` through existing durable workflow operations. Exact
   completed replay at the same revision returns the literal saved result without another completed
   model dispatch. Replays still perform the current revision/safety checks before treating the result
   as applicable to the current workspace.
8. Verify with an actual reviewer tool execution attempt against a mutation sentinel: mutation is
   denied with no filesystem/effect change. Also prove the audited read capabilities work. Do not claim
   arbitrary shell is read-only.

Original prerequisite context preserved: T1 and all Target 3 authority, structured-result, thread/recovery, and Task T8 profile/fresh-thread gates above. T1 remains independently complete; T2 cannot begin until Target 3 Task T8 is accepted.

**Stop condition:** if public tool execution or native recovery cannot maintain the read-only guard,
stop before accepting reviewer output. Do not substitute prompts, hidden tools, private imports,
custom transports, or blanket permission to resume live tools.

## Task T3 — Prove cold recovery, stale-revision rejection, and continuation

**Depends on:** T2

**Requirements:** exact completed replay, no stale approval, same reviewer continuation, safe unknown handling, durable `BLOCKED` integration.

**Files:**

- Create: test/workflow-review-recovery.test.ts
- Create: test/fixtures/workflow-review-crash-worker.ts

**Acceptance:** Prove cold recovery, stale-revision rejection, same-reviewer continuation, and BLOCKED wait behavior.

**Verification:**

- Required: node --test test/workflow-review-recovery.test.ts
- Required: npm run check
- Required: npm run lint

Detailed acceptance from the existing plan:

1. Use the same durable storage in a fresh process after SIGKILL and independent external model/tool
   effect markers. Clearing in-memory state is not restart evidence.
2. Cover process death before binding, after binding/before native dispatch, after a completed
   schema-result/native settlement before the Review receipt, after Review receipt before workflow
   continuation, and during a later review pass. Exact completed turn/result replay returns the literal
   saved decision and does not add a completed-turn dispatch marker.
3. Preserve Target 3's approved ambiguous-provider behavior: a provider request whose outcome is
   unknown may be reissued by native recovery. Record the observed duplicate marker; never claim
   exactly-once delivery. Unknown/invalid/missing structured output is not `BLOCKED`, `APPROVED`, or an
   automatic retry.
4. Prove a completed decision for revision A cannot approve revision B, including when the Target 4
   verification operation for A replays its old result. Mutate the workspace during review and between
   review completion and promotion; stale or unsafe state cannot produce a current approval. A new
   revision requires a fresh snapshot, a new successful verification ID, and a new reviewer turn.
5. Simulate a `CHANGES_REQUIRED` pass, an implementer repair in the consumer fixture, a fresh
   workspace snapshot and Verify, then a second pass on the same reviewer conversation with a new turn
   ID. The old pass cannot satisfy the new one. This is a bounded protocol consumer test, not the Start
   Work repair loop.
6. Prove read-only authority through actual tool execution and safe native ToolTask replay/reopen:
   read succeeds; mutation/delegation stays denied; effect markers do not increase. A missing,
   changed, or unprovable authority manifest fails closed. Uncertain unsafe tool effects remain fenced.
7. Exercise `BLOCKED` through the existing durable `waitForEvent`/mailbox primitives in a small
   consumer workflow. Persist the exact verdict, park nonterminally under a caller-owned occurrence ID,
   reopen, consume exact guidance once, and follow the normal fresh Verify/Review path. Review itself
   does not own the wait or guidance protocol.
8. Stop during review and reopen: selected stop is not resurrected into a new reviewer turn. Cleanup
   and unknown agent work remain governed by Target 3; Review must not misreport them as a verdict.

Original prerequisite context preserved: T2.

**Stop condition:** if the host cannot provide independent restart-safe effect markers or the
workspace safety adapter cannot re-establish its declared assurance, report the exact unavailable
evidence and do not claim cold-restart safety.

## Task T4 — Export and prove the portable host path

**Depends on:** T3

**Requirements:** public standalone use, shared bootstrap/recovery/ownership order, no Pocket runtime dependency.

**Files:**

- Modify: packages/workflow-runtime/index.ts
- Create: test/workflow-review-host.test.ts
- Create: docs/workflow-runtime-review-standalone.md

**Acceptance:** Export and document the portable standalone host path with end-to-end acceptance.

**Verification:**

- Required: node --test test/workflow-review-host.test.ts
- Required: node --test test/workflow-review.test.ts test/workflow-review-recovery.test.ts test/workflow-review-host.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test
- Required: npm run format:check

Detailed acceptance from the existing plan:

1. A generic programmatic consumer imports only public Pi Durable and `workflow-runtime` exports; it
   has no `src/server`, Pocket settings, loader, or test-fixture imports. It installs extensions and
   registers definitions before controlled `openHost()` startup, performs recovery before progress, and
   uses the same ownership/close order as the supported agent host.
2. Run an offline end-to-end Review consumer with injected workspace, safety, and tool adapters. The
   review protocol is identical for programmatic and TUI hosts; document the TUI registration,
   configuration, open/recovery, execution, and shutdown sequence without building a TUI or relying on
   hot reload.
3. Keep Pocket integration thin and out of `src/server/app.ts` and `src/server/extensions/` for
   Target 5. No new loader behavior, UI, server restart, or Pocket-only authority is needed to prove the
   portable module.
4. Run all Review suites together and the full repository checks. Inspect the diff for Pocket
   imports, private Pi Durable imports, prompt-only security, stale-revision approval paths, duplicate
   schedulers, unbounded result data, new stored kinds, and unrelated formatting changes.

Original prerequisite context preserved: T3.

## Dependency and acceptance map

```text
Target 4 public Verify + workspace/safety adapters ─┐
                                                    ├─→ T1 contract
Target 3 authority + structured-result + recovery ─┘
                                                         ↓
                                                        T2
                                                         ↓
                                                        T3
                                                         ↓
                                                        T4

Target 6 Start Work consumes Review; it owns repair, fresh Verify, BLOCKED orchestration,
and final completion.
```

Only the explicitly listed Target 3 and Target 4 prerequisites gate Review integration. No new Pi
core patch, runtime migration, provider authorization, or Pocket-only capability is implied. If a
later source/API check discovers such a requirement, stop and request review of the contract rather
than silently expanding this plan.

## Baseline and completion rules

- Before implementation, record the current base revision and run `npm run check`, `npm run lint`,
  and `npm test`. Compare failures with current baseline evidence. The Target 4 plan documents a
  historical browser-test anomaly (`test/browser.test.ts:659`, `204 !== 200`), but that is not a blanket
  waiver: only an explicitly authorized exact unchanged failure may be reported as an exception; all
  other failures remain blocking or must be separately dispositioned.
- For each task, write the failing public-seam test first, observe the intended RED, implement the
  smallest GREEN change, format, and run focused tests before proceeding.
- Final acceptance requires all applicable offline Review tests and repository checks above. A
  skipped, timed-out, or unavailable suite is not a pass. No live provider/network/spend acceptance is
  needed for this plan.
- This plan changes no server files, so no Pocket server restart is planned or authorized.
