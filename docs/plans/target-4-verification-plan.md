# Target 4 — Verify implementation plan

**Plan format:** crywolf-start-work/v1

**Status:** Approved for implementation after independent plan review (TaskReviewer run
`a6920f96-31db-4cee-8edf-8cac3a826db5`) and the user's explicit execution request.

**Contract:** [04 — Verification and Review](../pi-durable-production-runtime-v0/04-verification-review.md),
Target 4 in [07 — Productionization](../pi-durable-production-runtime-v0/07-productionization.md), and
[06 — V0 Conformance](../pi-durable-production-runtime-v0/06-conformance.md#verification).

The user confirmed the shared understanding after Oracle consultation. The author's and Oracle's
recommendations matched: include narrow reusable Node/Git adapters over public Pi Durable execution
capabilities, and never automatically repeat a command whose outcome is uncertain after process
death. This plan does not authorize implementation, live-provider calls, spend, dependency changes,
server restart, or changes to Pi Durable.

## Goal and scope

Deliver the reusable application-level Verify protocol: a workflow-supplied manifest runs bounded
checks against a deterministically identified workspace revision and returns a durable
`VerificationResult` whose status cannot certify a different or uncertain subject.

Target 4 is Verify only. It does not implement Review, Start Work, a new TUI, a UI, repository-specific
check manifests, generic artifact/schema frameworks, a second scheduler, or a command sandbox.

The verification policy and public module must be host-independent. Pi Pocket is one host, not a
runtime dependency. Any application built on public Pi Durable APIs must use the same public runtime
and verifier sequence; standalone programmatic, TUI, Pocket, and other applications are host
examples, not separate execution modes. Host-specific resources are injected. Pocket composition
remains thin. Do not import `PocketApp`, `PocketHost`, `src/server/git.ts`, Pocket settings, or the
extension loader into `packages/workflow-runtime/verification/`.

**Compatibility policy:** Do not add legacy/fallback execution paths, compatibility shims, or dual
verifier APIs to preserve superseded or unshipped shapes. Breaking changes to the Target 4
application-level verification API are acceptable; use one canonical path and update in-scope callers,
tests, and documentation together. This does not authorize changes to persisted document kinds,
their scope/history/fork settings, or unrelated Targets 1/2 semantics. Do not add host-specific
fallbacks; if a public Pi Durable API gap would require changing core/runtime constraints, stop and
report it rather than importing private APIs.

## Confirmed behavior

- A caller supplies the check manifest and a stable logical `verificationId`; the verifier embeds no
  repository-specific test/typecheck/lint/build commands.
- A deterministic working-tree revision is bound to the result. Git HEAD alone is insufficient.
  Snapshot coverage and unsupported states are explicit. A changed or unavailable revision cannot
  produce a passing result.
- Each check has a stable ID. Checks run serially under host-enforced finite time, output, and
  manifest-size bounds. The result records bounded evidence and truncation/termination information.
- A conclusive zero exit is a pass; a nonzero exit is failed-check data, not an exception that retries
  the operation. An uncertain or timed-out check is interrupted. Checks not reached after an
  interruption are recorded as not run. An empty manifest is rejected rather than treated as a pass.
- Aggregate `passed` requires every required check to pass and the subject revision to remain valid.
  Any uncertain required check yields `interrupted`, retaining known failures as evidence; otherwise
  any failed check yields `failed`.
- Exact completed checks/results replay without another command. If restart finds a command attempt
  without a durable result, the same logical verification is reconciled to `interrupted` and that
  command is not dispatched again. A new verification ID, after a fresh snapshot, is required to run
  again (the revision may be unchanged).
- Workflow stop remains authoritative; it is not converted to a normal verification result. Timeout,
  cancellation races, stale inputs, and workspace drift must never become success.
- Do not claim immutable workspace execution from matching pre/post snapshots alone. Before command
  dispatch and before passing promotion, a required injected `WorkspaceSafetyAdapter` must attest that
  the target workspace is quiescent and under the host's declared single-writer/stability condition.
  That assurance must remain valid across complete host death/reopen and all verification IDs;
  process-local flags, a fresh ID, or matching snapshots alone are insufficient. The host owns
  durable or external evidence and must fail closed when it cannot establish quiescence. If safety
  assurance is absent or unknown before dispatch, do not dispatch and record `interrupted`; if it
  fails after checks, do not pass. The verifier does not add a generic lock/quarantine service or
  promise to stop external writers or prove that change-and-restore did not occur.

## Repository and installed-API facts

- `docs/pi-durable-production-runtime-v0/04-verification-review.md` defines the
  `VerificationManifest`, `VerificationResult.subjectRevision`, and `passed | failed | interrupted`
  statuses. It says the workflow supplies checks and expected check failure is data.
- `docs/pi-durable-production-runtime-v0/06-conformance.md` requires failure-as-data, correct
  aggregation, cancellation/timeout never passing, stale-revision rejection, and exact-revision
  replay. `05-start-work-v0.md` requires a fresh Verify after repair and binds Review to the latest
  verified revision; this plan does not implement that workflow.
- There is no Target 4 plan or verifier implementation yet. No `verification/` module exists under
  `packages/workflow-runtime/`.
- `WorkflowContext` exposes immutable workflow input, `step`, and an `AbortSignal`. `step.do` stores
  JSON results and replays a completed operation without invoking its callback. The current core
  verifies retry/interruption-policy compatibility but does not compare a completed callback's
  request payload. Target 4 must therefore persist and compare its own request binding before any
  command replay/admission.
- `step.do` supports `interrupted: "reconcile"`. A reconstructed running operation can be reconciled
  into a durable JSON result without re-running its callback. Use that for uncertain checks; do not
  add core retry policy or another recovery loop.
- Installed `@earendil-works/pi-durable` is 1.0.2. Its public `@earendil-works/pi-durable/env`
  exports `ExecutionEnv`, `FileSystem`, `Shell`, `ShellExecOptions`, `ShellExecResult`, and
  `ExecutionError`; `@earendil-works/pi-durable/env/node` exports `NodeExecutionEnv`. `Shell.exec`
  accepts explicit cwd/env/timeout and an output callback, returning expected execution failures as
  data. The callback receives raw unbounded chunks, so the verifier must bound what it retains and
  keep draining output. Use public exports only; do not depend on package `dist` internals.
- `@earendil-works/chord/context` publicly exports `withAbortSignal`. Compose the workflow signal
  with a host-supplied execution context so shell cancellation reaches the command without dropping
  the host context. The host owns the injected `ExecutionEnv` and its cleanup. Public Pi Durable 1.0.2
  APIs do not provide durable process identity/discovery or prove descendant quiescence after host
  death; cancellation and cleanup alone are not cross-restart quiescence evidence. The verifier must
  rely on `WorkspaceSafetyAdapter` for fail-closed admission and promotion, not infer safety from a
  shell result or matching snapshots.
- Tests use Node's test runner. Existing workflow crash fixtures demonstrate the complete-process
  kill/reopen pattern. Use isolated durable storage and an external fixture marker for command
  dispatch counts; an in-memory counter is not crash evidence.

## Requirements and evidence traceability

| Requirement                               | Contract/evidence                                                            | Primary acceptance                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 — Deterministic subject revision       | 04 “Workspace revision”; 06 Verification                                     | Dirty/staged/untracked/deleted/symlink changes alter the revision as specified; unsupported inputs fail closed.                                                               |
| V2 — Frozen manifest and request identity | 04 “Verification checks”; runtime `step.do` replay behavior                  | Same ID with changed revision, manifest, bounds, environment policy, or runner identity rejects before dispatch, including completed replay.                                  |
| V3 — Bounded checks and evidence          | 07 Target 4; public `Shell` API                                              | Nonzero exit is data; output is bounded/truncated; timeout/cancel races never pass; all check outcomes aggregate deterministically.                                           |
| V4 — Durable exact result/recovery        | 01 “Unknown is first-class”; 02 workflow operation contract; 06 Verification | Completed exact result replays after complete restart without another command. An uncertain started command becomes `interrupted` without a second dispatch.                  |
| V5 — Revision binding                     | 04 “Verification replay”; 05 lifecycle; 06 Verification                      | A result for revision A cannot certify revision B; drift at final promotion prevents pass.                                                                                    |
| V6 — Portable host use                    | 01 “Host portability and earned integration seams”; 06 Host portability      | The same public helper works in any Pi Durable application; standalone programmatic and TUI examples use injected host resources, with no Pocket import or loader dependency. |
| V7 — Safe stop/cleanup ownership          | 02 terminality; public Shell/ExecutionEnv lifecycle                          | Selected stop stays stopped; command cancellation/cleanup is observed, and unresolved process/workspace responsibility is not reported as success.                            |

### Installed gaps and smallest adaptation

| Gap                                                                                         | Smallest adaptation                                                                                                                                                                     | Boundary                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `step.do` does not compare completed callback inputs                                        | A pure durable request-binding operation keyed by caller-owned `verificationId`; compare its saved JSON binding with the current canonical request before entering any check operation. | No core change and no random/call-order identity.                          |
| A started shell command has no durable completion receipt until its callback result commits | One durable `step.do` per stable check ID with reconciliation to an `interrupted` check result; a separate pure aggregation operation stores the final result.                          | Never infer command completion from partial output or re-run unknown work. |
| Shell output callback is raw/unbounded and command policy is not verifier policy            | An injected adapter applies host ceilings, captures only bounded bytes, records truncation, drains remaining output, and classifies expected exit/timeout errors as data.               | Reuse public Shell; do not build a process framework or promise a sandbox. |
| No revision implementation exists in the runtime package                                    | A small injected `WorkspaceAdapter.snapshot()` seam plus an optional reusable Node/Git adapter with explicit supported-state rules.                                                     | Do not use Pocket's Git module or treat HEAD as the worktree revision.     |
| `WorkflowContext` has an AbortSignal while Shell takes Chord `Context`                      | Compose via public `withAbortSignal` over a host-provided Context.                                                                                                                      | Keep cancellation and resource ownership host-independent.                 |

## Ordered implementation tasks

Each changed behavior starts with a public-seam failing test, an observed intended RED, the smallest
GREEN change, then bounded refactoring. Existing green core tests are regression evidence, not new
Target 4 RED evidence. Record the exact RED/GREEN commands and outcomes per task. Do not add a new
stored document kind: the durable workflow operation result is the authority for the saved
`VerificationResult`; the existing run projection remains derived. No existing stored kind, scope,
history, or fork setting changes.

## Task T1 — Freeze request identity and prove the workspace revision seam

**Depends on:** none

**Requirements:** V1, V2, V5

**Files:**

- Create: packages/workflow-runtime/verification/types.ts
- Create: packages/workflow-runtime/verification/manifest.ts
- Create: packages/workflow-runtime/verification/workspace.ts
- Create: test/workflow-verification.test.ts

**Acceptance:** Deliver the following behaviors through the public seams:

**Verification:**

- Required: node --test test/workflow-verification.test.ts
- Required: npm run check
- Required: npm run lint

1. Define the small public `VerificationCheck`, `VerificationManifest`, `WorkspaceRevision`,
   `WorkspaceAdapter`, `WorkspaceSafetyAdapter`, `CheckResult`, and `VerificationResult` contracts.
   Keep `VerificationResult` compatible with the Target 4 status and subject-revision contract; add
   only the identity/evidence fields required to reject stale or mismatched replay.
2. Validate a non-empty manifest with unique stable check IDs, an explicit bounded command string,
   cwd/environment policy, finite per-check and aggregate timeout/output/check-count ceilings, and
   deterministic ordering. A manifest may request lower bounds, never widen host ceilings. Reject
   duplicate IDs, invalid paths/policy, oversized manifests, and empty checks. Commands are trusted
   manifest input, not parsed into a sandbox policy.
3. Compute a canonical manifest/request binding over workspace identity, caller-owned verification
   ID, subject revision, check IDs/order/commands, effective cwd and environment-policy identity,
   runner implementation/version, bounds, and result policy. Do not serialize environment secrets.
   Changed binding under the same logical ID is a non-retryable conflict.
4. `WorkspaceAdapter.snapshot()` returns a deterministic content identity, not only HEAD, mtime, or
   a random token. The optional Git adapter covers the supported index/worktree state (including
   tracked content, staged/unstaged changes, deletions, untracked files, file modes and symlink
   targets); supported submodule state and explicit generated/ignored exclusions are documented.
   Unsupported or over-bound repository states fail closed rather than silently disappearing.
5. Tests use temporary repositories to prove same state gives the same identity and each supported
   mutation changes it. Include staged and unstaged edits, untracked/deleted files, rename/path
   normalization, mode/symlink cases, configured exclusions, unsupported submodules/path encodings,
   and Git command failure. Test that a HEAD-only snapshot would incorrectly miss at least one case.
6. Define `WorkspaceSafetyAdapter` as a required host-injected admission/promotion capability. Its
   quiescence assurance must be authoritative across host restart and verification IDs; missing or
   unknown assurance fails closed, and snapshots alone do not prove the absence of a
   change-and-restore race. T1 documents this contract and the stable-subject assumption; it does not
   implement check orchestration or produce an interrupted `VerificationResult`.
7. Prove Git and filesystem access use injected public capabilities and explicit workspace/cwd; no
   reads of Pocket settings or fixed paths.

**Stop condition:** If public host APIs cannot identify the files/metadata required by the supported
revision contract, stop with the exact missing capability and fail-closed states. No Pi Durable patch,
package upgrade, or Pocket-only fallback is authorized.

## Task T2 — Execute bounded checks and define status algebra

**Depends on:** T1

**Requirements:** V3, V7

**Files:**

- Create: packages/workflow-runtime/verification/command.ts
- Create: packages/workflow-runtime/verification/result.ts
- Modify: test/workflow-verification.test.ts

**Acceptance:** Deliver the following behaviors through the public seams:

**Verification:**

- Required: node --test test/workflow-verification.test.ts
- Required: npm run check
- Required: npm run lint

1. Implement a small command adapter over injected public `Shell`/`ExecutionEnv`. Use
   `Shell.exec(command, { cwd, env, timeout, onOutput }, context)` and `withAbortSignal`; use
   `NodeExecutionEnv` only through its public `/env/node` export. The environment and adapter are
   host-owned; the verifier does not create a Pocket-specific process manager.
2. Execute checks serially. Capture no more than the configured byte cap per check and for the
   overall result, preserve valid text boundaries, report `truncated` and a bounded observed-output
   indicator, and continue draining after the retained evidence limit. Never persist a spill file or
   unbounded stdout/stderr as the result. Bound total verification duration and count.
3. Classify outcomes: exit code zero with no timeout/drift is `passed`; nonzero is `failed` data;
   a known spawn/configuration failure is failed evidence; timeout or an outcome that cannot be
   proven is `interrupted`. A selected workflow stop propagates through the runtime and cannot be
   converted to ordinary success or failure data. A timed-out command never passes even if a
   late/partial output looks successful.
4. Continue after known failed checks to collect bounded evidence. Once a required check is
   interrupted, mark later checks `not-run`; aggregate status is `interrupted`, retaining preceding
   known failures. Otherwise any failed check yields `failed`; only all conclusive passes yield
   `passed`. Invalid `not-run` without an earlier interrupt is rejected.
5. Output truncation alone does not change a conclusive exit status; it is visible in evidence.
   Commands are trusted host-supplied verification actions, not sandboxed. Do not add output-pattern
   policy, arbitrary environment forwarding, an allowlist service, or a secret-redaction framework.
   Do not persist environment values; document that hosts must not expose secrets to commands or
   durable output unless they have their own approved policy.
6. Tests prove nonzero-exit-as-data, command-start failure, output above limits, multibyte truncation,
   timeout/zero-exit races, process cancellation, result-size ceilings, and deterministic aggregation.
   Assert external command markers and exact bounded result values, not implementation helpers.
7. Prove command cancellation settles or retains explicit cleanup/quiescence responsibility. If
   public Shell cannot prove a command and its possible descendants are quiescent after timeout,
   abort, or host death, the host-owned `WorkspaceSafetyAdapter` must keep the workspace unsafe across
   restart and verification IDs; the verifier must refuse new command admission until the host
   independently establishes quiescence. Test that refusal. Do not add a second cancellation tree,
   generic quarantine service, or silently claim cleanup.

## Task T3 — Persist request binding, per-check outcomes, and exact recovery

**Depends on:** T1, T2

**Requirements:** V2, V4, V5, V7

**Files:**

- Create: packages/workflow-runtime/verification/verify.ts
- Create: test/workflow-verification-recovery.test.ts
- Create: test/fixtures/workflow-verification-crash-worker.ts

**Acceptance:** Deliver the following behaviors through the public seams:

**Verification:**

- Required: node --test test/workflow-verification-recovery.test.ts
- Required: npm run check
- Required: npm run lint

1. Export a narrow `verify(context, request, adapters)`-style helper that uses the current
   `WorkflowContext.step.do`, `WorkflowContext.signal`, and injected adapters. Do not change
   `WorkflowContext`, `WorkflowEngine`, or Targets 1/2. Keep the implementation host-independent.
2. Before check admission, persist a pure request-binding operation keyed by caller-owned
   `verificationId`. On every invocation, compare the durable binding with the current workspace,
   subject revision, manifest digest, command/environment policy, runner version and bounds. A
   changed binding rejects before any command dispatch, even if a prior result operation is complete.
   Do not use a closure, current mutable workspace, random ID, or operation call order as identity.
3. Persist each check as a stable logical `step.do` operation keyed by `(verificationId, checkId)`.
   Encode the tuple collision-safely (or constrain and validate both IDs); do not concatenate
   caller-provided IDs with an ambiguous delimiter. Completed check evidence is reused exactly. A
   changed check under the same verification ID is rejected by the binding check. Use
   `interrupted: "reconcile"` for a reconstructed running check; reconciliation records an
   `interrupted` result and never calls the shell adapter.
4. Persist the final `VerificationResult` as a bounded JSON operation result after revalidating the
   subject revision and host-owned workspace-safety assurance. A mismatch, failed snapshot, or
   unavailable/unsafe assurance yields `interrupted`, never `passed`. A pure aggregate operation can
   replay without command dispatch. No new durable doc/entry kind, custom scheduler, retry service,
   or per-check timer loop is introduced.
5. Full-process kill/reopen tests use the same durable store and a separate durable fixture marker.
   Cover: before first check admission; after durable start before spawn; after command effect before
   result commit; between completed checks; after all check results before aggregate commit; after
   aggregate commit before workflow continuation; and during interruption reconciliation. At the
   public verifier seam, also prove that a changed or failed post-check snapshot yields
   `interrupted` and cannot persist a passing result.
6. Expected recovery: no started attempt means the not-yet-started check may run; an exact completed
   check/result replays without a new marker; a started check without a durable result resolves to
   `interrupted` without another marker; not-yet-started later checks are not run after an uncertain
   check. A fresh verification ID is a distinct logical operation, not an escape from workspace
   safety: after a crash with possible surviving command work, the host-owned safety adapter must
   still reject admission across restart and IDs until quiescence is independently established. Use
   a complete-process restart test and assert the new command marker does not increase while safety
   is unknown.
7. Reopen with changed revision, manifest, command, cwd, environment-policy ID, runner version, or
   bound fails closed before dispatch. A result for revision A cannot certify B even when the same
   `step.do` operation is completed. A changed ID may run only as a distinct operation.
8. Stop during a command remains selected through restart and schedules no later checks. Assert the
   shell receives cancellation, cleanup status is observable, and stopped work is never resurrected.

Use a fresh process and independent dispatch markers; clearing in-memory state is not restart
acceptance. Exact completed check/result replay must preserve the literal JSON result and not dispatch
again.

## Task T4 — Export and prove the portable host path

**Depends on:** T3

**Requirements:** V4, V6, V7

**Files:**

- Modify: packages/workflow-runtime/index.ts
- Create: test/workflow-verification-host.test.ts
- Create: docs/workflow-runtime-verification-standalone.md

**Acceptance:** Deliver the following behaviors through the public seams:

**Verification:**

- Required: node --test test/workflow-verification-host.test.ts
- Required: node --test test/workflow-verification.test.ts test/workflow-verification-recovery.test.ts test/workflow-verification-host.test.ts
- Required: npm run check
- Required: npm run lint
- Required: npm test
- Required: npm run format:check

1. An executable programmatic consumer representing a generic Pi Durable application imports only
   public Pi Durable, workflow-runtime, and verification exports; it has no `src/server` or Pocket
   imports. Install definitions/extensions before Harness open; use the same recovery, resume, stop,
   and close ownership order as the supported workflow host. Inject `WorkspaceAdapter`,
   `WorkspaceSafetyAdapter`, `Shell`, and execution `Context` explicitly. The documented sequence is
   usable by any Pi Durable application, not only Pocket or the fixture consumer.
2. Run a real temporary Git worktree through `NodeExecutionEnv` and the same public verifier used by
   fixture tests. Prove working-tree revision, bounded evidence, exact check result and no duplicate
   command after complete host restart. Keep tests offline and provider-free.
3. Document the same registration, adapter injection, open/recovery, execution, and shutdown
   sequence for any Pi Durable application, using a TUI as one concrete example. Do not build a TUI,
   rely on Pocket's loader/hot reload, or imply unrelated plugin APIs are equivalent. Host-specific
   resources differ only at the injected seams; the public verifier sequence does not fork by host.
4. Do not add Pocket-specific composition, agent policy, verification algorithms, or Git state
   authority to `src/server/app.ts`. The same exported helper and injected adapters are available to
   Pocket and every other Pi Durable host; prove the generic runtime path is host-independent.
5. Use only Pi Durable 1.0.2 public exports; no package changes, substrate patches, migrations, or
   new stored kinds. Do not add a legacy verifier path or compatibility shim; breaking changes to the
   Target 4 application-level API are acceptable. Preserve Target 1/2 and Target 3 behavior outside
   this feature's scope.
6. Run the focused suites and full repository checks. Inspect the diff for accidental Pocket imports,
   legacy/dual verifier paths, unbounded output, shell work outside the injected cwd, changed stored
   kinds, and unrelated format edits. No server restart is needed because no server files are in
   scope.

## Dependency and acceptance map

```text
T1 revision + immutable request contract
 └─→ T2 bounded runner + result algebra
      └─→ T3 durable binding/recovery
           └─→ T4 public export + portable host acceptance
```

Target 4 relies on the existing generic workflow runtime, not AgentRunner, structured agent results,
Review, or Start Work. At this plan revision, the Target 3 host/recovery extraction is committed as
`77b7ba7` (`refactor(workflow-runtime): separate host from recovery`); the Target 3 plan's older
"remains uncommitted" status note is stale. Before execution, verify the actual base revision contains
the portable host/recovery API and offline lifecycle tests; use source and test evidence, not stale
status prose. Target 4 does not depend on Target 3 agent policy or live-provider acceptance. No live
provider credentials or spend are needed.

| Contract acceptance                                       | Required evidence                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Failed checks are data and status aggregation is correct  | Direct result tests for all-passed, failed, interrupted, not-run, empty and mixed cases.                        |
| Timeout/cancellation cannot become success                | Timeout/zero-exit race, workflow stop, process kill and post-stop reopen tests.                                 |
| Stale result cannot certify a different revision          | Same-ID changed-revision rejection, pre/post drift and completed-operation replay mismatch.                     |
| Completed verification replays only for the exact request | Full process kill after durable result; literal saved JSON replay and unchanged command marker.                 |
| Uncertain command is not blindly repeated                 | Full process kill after dispatch/before result; interrupted receipt and unchanged second-dispatch count.        |
| Host portability                                          | Public-export generic Pi Durable consumer with no Pocket imports; host-neutral instructions with a TUI example. |

## Execution gates and non-goals

- The pre-implementation baseline was run at HEAD `77b7ba7`. `npm run check` and `npm run lint`
  passed. `npm test` did not pass consistently: one run failed the browser test
  `"Pi uses the browser tool, and people watch and use the same page in the panel"` at
  `test/browser.test.ts:659` (`204 !== 200`); one run failed
  `test/workflow-runtime-event.test.ts:248`, although that file passed when run alone (7/7); and a
  later run was cancelled after `test/workflow-agent-recovery.test.ts` remained pending for about
  592 seconds. These observations are baseline evidence, not a blanket waiver.
- The owner authorized treating the known browser failure as a baseline exception if it still fails
  with the same test, assertion, and values after Target 4. Record it as an exception, not as a green
  full-suite run. Other baseline anomalies are not automatically waived: verify their exact failure
  against the baseline and report them separately; do not repair unrelated failures without approval.
- `npm test` remains required at T4. The sole authorized exception is the exact unchanged browser
  failure above. Every other test must pass; any other failure, including the observed
  `workflow-runtime-event.test.ts` anomaly, remains blocking unless separately authorized. Any new or
  changed failure also blocks completion. If the full suite hangs or is cancelled, report it as
  unavailable rather than successful.
- For each task, write the failing public-seam test first, observe intended RED, implement the minimal
  GREEN change, format, and run the focused suite before proceeding.
- No user-facing UI or Start Work workflow is part of Target 4. No live-provider or spend acceptance
  is needed. No installation, upgrade, or restart is authorized.
- If public Shell or host lifecycle cannot provide bounded execution, cancellation/quiescence, or
  portable context propagation, stop with exact API evidence. Do not add private imports, a second
  process scheduler, an untrusted shell sandbox, a Pocket-only implementation, or a Pi Durable patch.
- A passing result certifies only the documented subject-revision and host-stability contract. It does
  not certify arbitrary external dependencies, secret-free output, or an immutable execution
  environment beyond the adapter's declared and tested capability.
