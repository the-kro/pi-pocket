# Platform-Independent Conformance Test Matrix

This document describes behavioral evidence a candidate runtime should provide.

The exact test framework is implementation-specific.

## A. Durable run / operation core

- same explicit run ID concurrently started -> one durable run;
- conflicting same run ID -> fail closed;
- completed operation replays without callback;
- started/no-terminal operation -> unknown;
- `fail` unknown policy does not call original body;
- `reconcile` calls reconciler only;
- explicit `retry` creates a distinct attempt;
- definition fingerprint mismatch blocks automatic resume;
- stop persists before cleanup;
- stopped run does not resurrect after cold restart.

## B. Waits and events

- two concurrent sleeps complete independently;
- overdue sleep is eligible immediately after restart;
- multiple timed waits time out independently;
- duplicate timer processing creates no duplicate semantic outcome;
- duplicate incoming event ID does not deliver twice;
- buffered event survives restart;
- multiple buffered events consume in deterministic durable order;
- second active same-type wait rejects if event API is type-only;
- malformed ambiguous same-type history fails closed;
- terminal run rejects new event admission.

## C. Runtime lifecycle

- provider/capability removal quiesces open run without terminal fact;
- equivalent provider re-registration resumes once;
- old run-scoped effects disposed before resumed work;
- failed disposal retains ownership and can be retried;
- successful sibling cleanup is not repeated;
- definition mismatch still blocks after provider re-registration.

## D. Roles / policy

- prohibited tool absent from model-visible catalog;
- direct execution of prohibited tool also denied;
- later local tool registration cannot bypass hard guard;
- allowed Role can execute permitted tool;
- no-delegation Role cannot create a child through model path;
- trusted host child creation remains independently testable;
- Role/call narrowing cannot broaden deployment floor;
- unsupported required policy dimension fails closed;
- concurrent Roles do not leak policy/persona/tool state.

## E. Continuable conversations

- deterministic child identity for same parent/Role/thread;
- exact parent ownership required for follow-up;
- reservation persists before delivery;
- accepted is distinct from completed;
- completed turn replays after full restart without redispatch;
- two queued/follow-up turns correlate correctly;
- stale earlier result cannot satisfy later turn;
- delivery/result ambiguity returns typed unknown;
- unknown does not auto-resend;
- explicit retry has distinct turn ID + durable retry link;
- retry-of-retry remains acyclic and reconstructable;
- terminal retry can resolve prior ambiguity;
- unreadable persistence is not treated as absent;
- conflicting reservation/request/result authority fails closed;
- successful result is durable before native turn conclusion;
- disposal failure retains exact cleanup ownership.

## F. Structured results

- invalid structured submission rejected before durable result;
- exactly one result accepted per logical turn;
- duplicate/conflicting result fails closed;
- result bound to exact revision/gate/turn;
- cold replay returns result with zero actor redispatch;
- prose output alone never becomes authoritative structured result.

## G. Verification

- passed and failed checks represented as data;
- aggregate status matches per-check status;
- timeout cannot become pass after graceful zero exit;
- external cancellation cannot become pass after graceful zero exit;
- evidence bounds are byte-correct/Unicode-safe;
- stale verification revision rejected after artifact changes.

## H. TaskReview

- APPROVED cannot contain blocking findings;
- non-approved verdict requires material blocker where applicable;
- finding lens must be enabled;
- artifact and verification revision must match;
- reviewer has inspection authority but no mutation/delegation;
- fresh reviewer per task gate;
- same reviewer continues within repair cycle;
- stale earlier-turn result rejected;
- review change forces re-verification before re-review;
- BLOCKED and ORACLE_REQUIRED create resumable non-terminal waits.

## I. Start-work integration

- plan file mutation after admission does not change admitted plan;
- clean-workspace admission;
- external drift detected;
- each task receives independent implementer;
- same task retains implementer for repair;
- task review gate retains reviewer across repairs;
- task A reviewer cannot satisfy task B;
- final reviewer separate from task reviewer;
- task advancement only after matching Verify + TaskReview;
- workspace mutation during review invalidates approval;
- attempt-window exhaustion survives restart;
- exactly one grant opens exactly one new window;
- final Verify + final TaskReview required for completion;
- final review mutation invalidates final approval;
- stop before cleanup and cold non-resurrection;
- hostile foreign reviewer result attempts produce zero foreign result/turn conclusion.

## J. Compensation

- rollback eligibility co-located/durable with forward effect;
- effective stack reconstructs after crash;
- completed compensations skipped;
- unknown compensation not blindly retried;
- Saga failure stops/escalates;
- best-effort continues and reports residual failures.

## K. Crash-window methodology

For high-risk protocols, inject crash/restart at:

```text
before durable reservation
after reservation / before delivery
after delivery / before result
after domain result / before actor/native acknowledgement
after event acceptance / before workflow-side decision record
after stop persistence / before cleanup
during cleanup failure
```

Cold tests should tear down the complete runtime/host and remount from the same durable history rather than merely clearing one in-memory map.

## L. Evidence rule

Green unit tests are not sufficient when the guarantee is specifically about persistence/restart or cross-component authority.

Test at the seam where the guarantee can actually fail.
