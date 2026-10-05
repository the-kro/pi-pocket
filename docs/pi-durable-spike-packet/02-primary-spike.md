# 02 — Primary Spike

## Overview

## Host/setup

Start from **TannerMidd/pi-pocket** rather than building a standalone Pi Durable shell unless a concrete Pi Pocket limitation blocks the spike.

Before implementing workflow behavior:

1. clone/fork Pi Pocket and record the exact commit SHA;
2. keep its pinned Pi Durable / Pi AI / Chord versions unchanged during the spike;
3. verify the unmodified app can run one ordinary agent session and resume unfinished work after a server restart;
4. add our workflow runtime as an isolated server-side module plus the thinnest Pi Pocket integration needed to start/inspect a workflow.

Do not restructure Pi Pocket broadly. Do not make its multiplayer, artifacts, guard, or other product features prerequisites for the workflow spike.

### Minimal UI boundary

The browser is a development/debugging aid, not a feature target. Reuse the existing transcript/tool UI. If cheap, expose only:

```text
workflow id + status
current step
step statuses
attempt/retry/recovery state
last semantic workflow events
```

A raw or developer-oriented panel is sufficient. A graphical workflow visualizer is explicitly out of scope. Automated tests remain the source of truth for durability semantics.

Implement one deliberately small workflow that crosses every important durability boundary.

The point is not business realism. The point is to force the adapter to solve the hard runtime seams.

## Target workflow

Pseudo-code:

```ts
export const spikeWorkflow = workflow(async ({ input, step }) => {
  const plan = await step.do("plan", () =>
    agents.run("planner", { request: input.request })
  );

  const implementation = await step.do(
    "implement",
    { retries: 3 },
    () => agents.run("implementer", { plan }),
  );

  await step.sleep("5s");

  const approval = await step.waitForEvent("approval", {
    type: "approved",
    timeout: "1h",
  });

  const deployment = await step.do(
    "deploy",
    { retries: 2 },
    recoverable({
      execute: deploy,
      recover: recoverDeployment,
    }),
    {
      rollback: rollbackDeployment,
    },
  );

  return {
    plan,
    implementation,
    approval,
    deployment,
  };
});
```

Argument ordering/options may be adjusted to match our existing workflow API. Do not redesign the public API merely to fit Pi.

---

# Spike A — Cloudflare-style interpreter over Pi Tasks

## Goal

Prove that imperative workflow source can execute over Pi Durable without leaking Pi's phase/checkpoint API.

## Required behavior

On first execution:

```text
step.do("plan")
→ create durable child work
→ wait
→ return result when complete

step.do("implement")
→ create durable child work
→ wait
→ return result
...
```

On re-entry after restart:

```text
step.do("plan")
→ logical step already completed
→ return persisted result immediately

step.do("implement")
→ logical step exists/running/completed
→ attach to existing durable execution
→ do not create a duplicate
```

The interpreter may use an internal control-flow mechanism such as a private `SuspendWorkflow` exception/sentinel to unwind the JS workflow function after durably parking the parent task.

Do not expose that mechanism to workflow authors.

## Must test

- sequential `step.do()` calls;
- helper function wrapping `step.do()`;
- `try/finally` behavior during suspension/re-entry;
- normal thrown error;
- `NonRetryableError`;
- `RetryAfterError`;
- duplicate logical step name detection or explicitly defined semantics;
- workflow return value durability.

## Important unknown

Determine whether replaying/re-entering arbitrary JS workflow functions creates surprising behavior around local side effects outside `step.*` calls.

Document the rule authors must follow. Likely rule:

> Workflow code outside durable primitives must be deterministic and free of externally visible side effects because the function may be re-entered.

If this becomes excessively restrictive or fragile, record it as a major concern.

---

# Spike B — Durable sleep

## Goal

Implement Cloudflare-style `step.sleep()` semantics rather than simply forwarding to Pi's invocation-local `runtime.sleep()`.

## Known Pi behavior to account for

Pi's current `runtime.sleep(until)` uses an in-process timer tied to the active task invocation. Its example checkpoints durable state before sleeping; reopening the harness re-runs from the saved checkpoint.

Therefore the adapter must persist the sleep deadline itself.

## Required semantics

```ts
await step.sleep("30m");
```

must mean:

```text
persist logical sleep step + wakeAt
↓
wait until wakeAt while process is alive
↓
if process dies, wakeAt remains durable
↓
reopen
↓
if wakeAt is future → wait remaining time
if wakeAt passed → continue immediately
↓
mark sleep step complete exactly once
```

Test both `step.sleep()` and `step.sleepUntil()` if trivial once the primitive exists.

---

# Spike C — External event wait

## Goal

Prove `step.waitForEvent()` can be implemented without polling and without keeping an invocation alive.

Example:

```ts
const approval = await step.waitForEvent("approval", {
  type: "approved",
  timeout: "1h",
});
```

## Required semantics

The workflow must durably enter a waiting state.

An external caller must be able to send:

```ts
await runtime.sendEvent(workflowId, {
  type: "approved",
  payload: { by: "test" },
});
```

The event must:

- be durably admitted;
- wake the correct waiter;
- be consumed at most once by that wait;
- survive either side restarting;
- work if the event arrives immediately before or immediately after the workflow reaches the wait;
- support timeout without a resident polling loop.

## Architectural constraint

Prefer a durable waiter/task + event admission mechanism over a `watchDoc()` callback that must remain alive indefinitely.

If Pi lacks enough scheduler primitives and the implementation requires polling or substantial custom scheduling infrastructure, call that out explicitly.

---

# Spike D — Recoverable uncertain effect

## Goal

Implement the proposed `recoverable()` abstraction and prove it survives repeated crashes.

Use a fake deployment provider backed by durable test state so the test can control external reality independently of workflow state.

Example:

```ts
const deploy = recoverable({
  execute: async ({ operationId }) =>
    provider.start({ operationId }),

  recover: async ({ operationId }) => {
    const deployment = await provider.getByOperationId(operationId);

    if (!deployment) {
      return recovery.notStarted();
    }

    if (deployment.status === "running") {
      return recovery.pending({ checkAgainIn: "100ms" });
    }

    if (deployment.status === "complete") {
      return recovery.recovered(deployment);
    }

    return recovery.unknown();
  },
});
```

## Required behavior

Crash after external `start()` succeeds but before workflow persists the result.

After restart:

```text
interrupted deploy attempt detected
↓
recover()
↓
provider says running
↓
persist recovery pending + durable wake time
↓
process may die again
↓
recover() later
↓
provider says complete
↓
recovered(value)
↓
step completes without calling start() again
```

Also test:

- `notStarted()` → execute again;
- `unknown()` → workflow does not blindly retry;
- crash while `recover()` itself is running;
- crash while waiting after `pending()`.

The recovery polling loop must be scheduler-driven durable re-entry, not an in-memory `while` loop.

---

# Spike E — Retries and errors

Implement:

```ts
NonRetryableError
RetryAfterError
```

Required semantics:

```text
ordinary Error
→ persist failed attempt
→ retry according to step retry policy

NonRetryableError
→ persist terminal failure
→ ignore remaining retry budget

RetryAfterError
→ persist failed attempt
→ retry only after requested durable deadline
```

`RetryAfterError` must remain correct across process restart during the delay.

The spike should make explicit the difference between:

- known failed attempts;
- interrupted attempts with uncertain outcome.

---

# Spike F — Rollback / compensation

## Goal

Prove our Cloudflare-compatible rollback semantics can be implemented cleanly over Pi ownership/tasks.

Use at least two completed compensable steps followed by a terminal failure.

Expected ordering:

```text
step A forward complete
step B forward complete
step C fails
↓
rollback B
↓
rollback A
```

Requirements:

- reverse deterministic order;
- rollback result/status durable;
- rollback can have its own retries;
- crash during rollback resumes from the correct compensation;
- already completed rollback must not execute again;
- failure of one rollback has documented semantics;
- semantic journal records rollback lifecycle.

Do not overbuild a generalized Saga library. Implement only enough to determine whether Pi materially helps or hinders the model.

---

# Spike G — Agent task integration

## Goal

Prove that a workflow step can own a Pi durable Conversation/agent execution cleanly.

For the spike, the planner/implementer can use a fake model if needed; a real model is not required for durability tests.

Requirements:

- workflow Step owns or references an agent Conversation;
- Conversation identity survives restart;
- step can wait for its agent result;
- canceling/aborting workflow work propagates appropriately;
- agent task/tool details remain drill-down information rather than polluting top-level workflow semantics.

Stretch only if cheap:

- continuable child agent that accepts a second message after its initial result;
- background subagent boundary.

---

# Spike H — Semantic journal + workflow projection

## Goal

Keep our workflow-level observability independent from Pi's internal Task representation.

Maintain a small durable WorkflowState projection containing at least:

```ts
{
  workflowId,
  status,
  currentStep,
  steps: {
    [stepId]: {
      status,
      attempt,
      result?,
      error?,
      taskId?,
    }
  }
}
```

Also append immutable semantic workflow entries/events.

Where possible, prove a single Pi commit can atomically coordinate the workflow transition pieces that need to agree, such as:

```text
append step.started semantic entry
+
update WorkflowState
+
create child Pi Task
+
park parent WorkflowTask
```

The spike should document precisely which pieces can and cannot be atomic.

---

# Spike I — Minimal workflow visualizer data model

No polished UI required.

Produce a JSON/debug view with two levels:

```text
Workflow View

Plan          ✓
Implement     ● attempt 2/3
Sleep         ○
Approval      ○
Deploy        ○
```

and drill-down data:

```text
Runtime View

WorkflowTask #...
└── StepTask implement #...
    └── Conversation #...
        └── GenerationTask #...
            └── ToolTask #...
```

The purpose is to prove Pi's internal Task graph can be projected into our much simpler workflow model.

---

# DSH comparison is out of scope for this spike

Do **not** implement this workflow against DSH and do not require access to the existing DSH plugin/workflow monorepo.

The purpose of this packet is to produce a concrete Pi implementation that can be compared afterward against our already-existing DSH experience and codebase. The useful comparison artifacts from this spike are:

- how much Pi-specific adapter/interpreter code was required to support the Cloudflare-style workflow surface;
- which capabilities fell naturally out of Pi Durable versus requiring new subsystems;
- how difficult the implementation was to get correct under review;
- how many redesigns or review-driven rewrites were needed;
- whether Pi source or docs were easy enough to reason about without repeated archaeology;
- whether the resulting runtime code is understandable enough to maintain and review;
- whether the finished spike reaches a usable end-to-end state with substantially less friction than our DSH experience.

A later human review can compare that evidence against the existing DSH runtime. A symmetric A/B implementation is not required unless a specific unresolved question later justifies one.
