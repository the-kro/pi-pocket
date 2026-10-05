# 03 — Crash / Recovery Matrix

The spike is only useful if failure injection is deliberate.

Do not rely solely on graceful `Harness.close()` tests. Use process termination where practical so tests cover abrupt loss of in-memory state.

For every scenario, assert both:

1. eventual workflow state/result;
2. absence of duplicate logical execution where duplication is forbidden.

## Core matrix

| # | Kill point | Expected after restart |
|---|---|---|
| 1 | Before first `step.do()` starts | Workflow starts normally. |
| 2 | After `step.started`, before handler invocation | Same logical step resumes; no duplicate logical step record. |
| 3 | During `plan` agent execution | Existing step/agent execution is recovered or retried according to adapter semantics; no duplicate logical step. |
| 4 | After `plan` completes and result is durable | `plan` handler never runs again; persisted result returned. |
| 5 | During known retryable `implement` failure | Retry budget and attempt number survive restart. |
| 6 | After `RetryAfterError` is persisted but before deadline | No retry before deadline; restart preserves same retry deadline. |
| 7 | During durable `step.sleep()` | Original absolute wake time survives restart. |
| 8 | Restart after sleep deadline already passed | Continue immediately; do not sleep full duration again. |
| 9 | While waiting for external approval | No resident process required; wait survives restart. |
| 10 | Event arrives while workflow process is down | Event is durable and consumed after restart. |
| 11 | Event arrives immediately before waiter becomes durable | Defined behavior; preferably event still satisfies wait if matched by workflow/event scope. |
| 12 | Event sent twice | Wait consumes at most one logical event unless API intentionally allows otherwise. |
| 13 | Deployment starts externally, crash before step result commit | `recover()` runs before another `execute()`. |
| 14 | `recover()` returns `pending()` then process dies | Wake deadline and recovery state survive restart. |
| 15 | `recover()` sees completed deployment | Step completes from recovered result; `execute()` is not called again. |
| 16 | `recover()` returns `notStarted()` | Runtime starts a new execution attempt. |
| 17 | `recover()` returns `unknown()` | Automatic execution stops; workflow exposes uncertain/blocked/failure state. |
| 18 | Crash during `recover()` itself | Recovery can safely be called again; no forward `execute()` starts accidentally. |
| 19 | Two compensable steps complete, later step fails | Rollbacks begin in reverse order. |
| 20 | Crash after rollback B completes, before rollback A starts | B is not rolled back twice; A resumes next. |
| 21 | Crash during rollback handler | Recovery/retry semantics are deterministic and documented. |
| 22 | Parent workflow aborts during child Task | Abort propagates as intended; no orphan live work except explicit background boundaries. |
| 23 | Process dies while parent is waiting on child Task | Parent remains durably waiting and wakes when child settles after restart. |
| 24 | Re-enter workflow function multiple times | Completed `step.do()` calls return stored results; no duplicate child tasks. |

## Stable identity assertions

For every restart scenario, inspect durable state and assert:

```text
same workflowId
same logical stepId
attempt increments only when a new attempt actually begins
same child task reused where appropriate
same external operationId reused by recoverable operation
```

## Journal assertions

The semantic journal must not show impossible transitions such as:

```text
step.completed before step.started
rollback.completed before rollback.started
attempt 3 without attempts 1/2
workflow.completed while a required step is live
```

It should be possible to reconstruct the workflow-level state from the semantic journal for debugging, even if Pi Documents/Tasks remain execution truth.

## At-most-once assertions for completed work

Instrument handlers with counters.

Once the adapter has durably recorded a step result, subsequent workflow re-entry must not increase its execution counter.

Example:

```text
plan.executeCount === 1
```

after any number of process restarts following durable completion.

## Uncertain external effect assertions

The fake deployment provider must store its own state independently from Pi workflow storage.

This is essential: otherwise the test cannot reproduce disagreement between external reality and workflow state.

Required fake-provider features:

```text
start(operationId)
getByOperationId(operationId)
complete(operationId)
countStarts(operationId)
```

Critical assertion:

```text
external start count === 1
```

after the crash-after-start-before-result scenario when `recover()` successfully reconciles the operation.
