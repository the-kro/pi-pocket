# 01 — Scope and Constraints

## Goals

Prove or disprove the feasibility of using Pi Durable as the execution substrate beneath our existing Cloudflare-style workflow API.

The spike should answer these questions:

1. Can an imperative workflow function be safely re-entered while completed steps return memoized durable results?
2. Can `step.do()` map naturally to Pi Durable Tasks without exposing Pi phases/checkpoints to workflow authors?
3. Can `step.sleep()` behave as a truly durable sleep across process death?
4. Can `step.waitForEvent()` suspend without polling or holding a process invocation open?
5. Can externally uncertain operations use a `recoverable()` abstraction cleanly?
6. Can retries, `NonRetryableError`, and `RetryAfterError` remain clean and predictable?
7. Can rollback/compensation survive crashes and preserve deterministic reverse ordering?
8. Can workflow state, semantic journal entries, and child task creation be committed consistently enough to avoid reconciliation races?
9. Can Pi's durable Conversations be used for workflow-owned agent execution without making the workflow API Pi-specific?
10. Can workflow state be exposed clearly enough for debugging/review without requiring authors to understand Pi's lower-level Task graph?

## Non-goals

Do **not** build:

- the full ADLC;
- production UI or a polished workflow visualizer;
- production multi-tenant storage;
- every Cloudflare Workflows feature;
- every existing Convex workflow feature;
- a full vanilla-Pi-extension compatibility layer;
- a generalized distributed scheduler;
- a production deployment topology;
- broad performance benchmarking;
- a second implementation of the spike against DSH;
- access to or modification of the existing DSH plugin/workflow monorepo.

Avoid polishing anything that does not answer a decision question. The comparison to DSH happens after the Pi spike using our existing DSH baseline, not by rebuilding both sides during this packet.

## Spike host

Prefer **TannerMidd/pi-pocket** as the host application. It already opens a Pi Durable `Harness`, owns a Durable extension registry, uses SQLite, resumes unfinished work after restart, and projects committed state to a web UI.

Constraints:

- keep the workflow interpreter/runtime in an isolated module with no dependency on Pi Pocket UI/multiplayer concepts;
- Pi Pocket-specific integration should be thin (registry/install/start endpoints or equivalent);
- reuse its existing model/provider, coding-tool, storage, and restart plumbing rather than rebuilding them;
- do not port vanilla Pi extensions; Pi Pocket runs Pi Durable extensions;
- do not turn workflow UI into a major deliverable; a simple status/debug view is sufficient;
- if supporting Pi Pocket requires significant unrelated application work, switch to the minimal reference surface and report why.

The spike is evaluating **Pi Durable + our workflow layer**, not Pi Pocket as a product.

## Compatibility stance

Use the Cloudflare-style API as the **starting dialect**, not as an immutable specification.

Preserve the clean primitives where possible:

```ts
step.do(...)
step.sleep(...)
step.sleepUntil(...)
step.waitForEvent(...)
step.runWorkflow(...)
```

Extensions we explicitly want to test:

```ts
throw new NonRetryableError(...)
throw new RetryAfterError(...)

recoverable({
  execute,
  recover,
})
```

Do not add recovery callbacks, idempotency configuration, reconciliation logic, or other large mini-framework behavior directly to `step.do()` merely to make the implementation easier.

## Recovery semantics

### Normal step

An ordinary incomplete step may be retried using normal durable-workflow semantics.

A completed step must never execute again; its persisted result is returned.

### `NonRetryableError`

A known live failure that should bypass the remaining retry budget.

### `RetryAfterError`

A known live failure that remains retryable, but not before a requested delay/deadline.

### `recoverable()`

Used only when an interrupted attempt can be reconciled against external reality.

Proposed shape:

```ts
recoverable({
  execute: async (input, ctx) => { ... },
  recover: async (input, ctx) => { ... },
})
```

Proposed recovery outcomes:

```ts
recovery.recovered(value)
recovery.notStarted()
recovery.pending({ checkAgainIn: "30s" })
recovery.unknown()
```

Semantics:

- `recovered(value)` — external operation completed; persist value and complete the step.
- `notStarted()` — recovery can establish that the external operation did not occur; execute it.
- `pending(...)` — operation still exists but has no terminal result; durably wake later and call `recover()` again.
- `unknown()` — reconciliation cannot establish a safe next action; stop automatic recovery and surface the uncertain state.

The runtime, not user code, owns the durable re-entry loop for `pending()`.

## Stable identity

Pi runtime Task IDs are not sufficient as our logical workflow identity.

The adapter must introduce stable logical identities at minimum for:

```text
workflowId
stepId
attemptId
childWorkflowId (if child workflows are included)
```

A workflow function re-entering after a crash must resolve `step.do("implement")` to the same logical step, not create a duplicate because the JS function executed again.

## Semantic journal

Preserve the idea of an append-only semantic workflow journal even if Pi Tasks/Documents are execution truth.

Suggested event vocabulary for the spike:

```text
workflow.started
step.started
step.attempt.started
step.attempt.failed
step.retry.scheduled
step.recovery.started
step.recovery.pending
step.recovery.completed
step.completed
step.rollback.started
step.rollback.completed
workflow.completed
workflow.failed
```

The journal should describe workflow semantics, not mirror every Pi Task transition.

## Human reviewability requirement

Workflow source should be understandable top-to-bottom without mentally simulating Pi task phases.

This is a hard requirement.

Pi `defineTask()` is allowed inside the adapter/runtime, but not as the expected author-facing workflow API.
