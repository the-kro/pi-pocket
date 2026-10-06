# 02 — Workflow Runtime Contract

This file is normative for the generic workflow kernel.

Nothing agent-specific belongs here.

## Run identity and admission

Every production workflow run must have a caller-reserved `runId`.

Convenience random IDs may exist for tests or interactive experimentation, but the production API is based on explicit run identity.

Example:

```ts
await workflows.start(startWork, input, {
    runId: "start-work:workspace-123:request-456",
});
```

Admission persists:

```ts
type WorkflowAdmission = {
    runId: string;
    workflowId: string;
    workflowVersion: number;
    input: JsonValue;
    inputDigest: string;
};
```

Concurrent admission using the same `runId` must:

- create at most one root Task;
- return the existing matching run when identity matches;
- reject if the same `runId` is reused for conflicting input or definition identity.

Input equality must use a canonical durable encoding/digest.

## Definition compatibility

A workflow definition has:

```ts
type WorkflowDefinition<I, O> = {
    id: string;
    version: number;
    run(context: WorkflowContext<I>): Promise<O>;
};
```

V0 compatibility identity is:

```text
workflow ID + explicit version
```

Source hashing is not required.

Authors must increment `version` when replay semantics change incompatibly.

On reconstruction:

```text
durable definition version != registered version
    -> refuse automatic execution
```

No migration mechanism exists in v0.

The run remains durable and inspectable.

## Author-facing API

Representative API:

```ts
const workflow = defineWorkflow({
    id: "start-work-v0",
    version: 1,

    async run({ input, step, signal }) {
        // ordinary TypeScript
    },
});
```

Core engine:

```ts
interface WorkflowEngine {
    start<I, O>(
        definition: WorkflowDefinition<I, O>,
        input: I,
        options: { runId: string },
    ): Promise<WorkflowHandle<O>>;

    inspect(runId: string): Promise<WorkflowInspection>;

    sendEvent(runId: string, event: WorkflowEvent): Promise<EventDeliveryResult>;

    stop(runId: string, reason?: string): Promise<void>;

    wait<O>(runId: string): Promise<O>;
}
```

Core step API:

```ts
interface WorkflowStep {
    do<T>(
        id: string,
        callback: (ctx: StepExecution) => Promise<T> | T,
        options?: StepDoOptions<T>,
    ): Promise<T>;

    sleep(id: string, duration: Duration): Promise<void>;

    sleepUntil(id: string, at: number | Date): Promise<void>;

    waitForEvent<T>(
        id: string,
        type: string,
        options?: {
            timeout?: Duration;
        },
    ): Promise<{
        eventId: string;
        payload: T;
    }>;
}
```

No v0:

```text
step.runWorkflow
step.fragment
step.compensate
step.breakpoint
step.budget
```

# `step.do`

`step.do` represents a durable logical operation.

Example:

```ts
const result = await step.do(
    "deploy",
    async ({ attempt, idempotencyKey, signal }) => {
        return deploy({
            idempotencyKey,
            signal,
        });
    },
    {
        retries: 2,
        interrupted: "reconcile",
        reconcile: async (context) => {
            const deployment = await lookupDeployment(context.idempotencyKey);

            if (deployment) {
                return recovery.completed(deployment);
            }

            return recovery.retry();
        },
    },
);
```

## Durable operation state

Checkpoint state distinguishes:

```text
absent
running
completed
failed
```

On normal execution:

```text
absent
  ↓ durable commit
running attempt N
  ↓ external/body work
completed | failed
```

If process death occurs while durable state is `running`, re-entry interprets it as an interrupted/unknown attempt.

The durable historical record is not rewritten.

## Attempt identity

The root operation ID is stable:

```text
deploy
```

Attempts are distinct:

```text
deploy / attempt 1
deploy / attempt 2
```

Retrying must create a new attempt number.

The runtime must preserve that an earlier attempt became unknown or failed.

## Completed replay

If an operation is durably completed:

```ts
await step.do("deploy", callback);
```

returns the durable result.

`callback` must not execute again.

## Known failure

A callback exception is a known failure if the runtime knows the callback itself failed before reporting success.

Known failures may participate in configured retry policy.

V0 supports:

```ts
{
  retries?: number;
}
```

`retries` means additional attempts after known failures.

It does not authorize repeating an unknown operation.

## NonRetryableError

V0 should expose:

```ts
class NonRetryableError extends Error {}
```

A known `NonRetryableError` bypasses configured known-failure retries.

## Interrupted policy

```ts
type InterruptedPolicy = "fail" | "reconcile" | "retry";
```

### fail

Return/surface an `UnknownOperationError`.

Never execute the body again.

### reconcile

Invoke only the reconciler.

The original callback is not invoked unless the reconciler explicitly authorizes another attempt.

### retry

Explicitly begin another attempt.

This is an author decision acknowledging duplicate-effect risk.

## Reconciliation result

V0 reconciliation result:

```ts
type RecoveryResult<T> =
    { status: "completed"; result: T } | { status: "retry" } | { status: "unknown" };
```

Helper API may be:

```ts
recovery.completed(value);
recovery.retry();
recovery.unknown();
```

Meaning:

- `completed`: the reconciler proved or repaired the original effect; persist the canonical result without repeating the body.
- `retry`: another attempt is appropriate; start a new attempt.
- `unknown`: the outcome cannot be proven; surface `UnknownOperationError`.

V0 does not include runtime-owned polling recovery.

A future `pending/checkAgainIn` result may add that behavior if real consumers need it.

## Idempotency key

Each operation receives a stable key derived from:

```text
runId + logical operationId
```

The same logical operation receives the same key across process restart.

Attempt-specific identity is available separately.

# Durable sleep

```ts
await step.sleep("retry-delay", "30s");
```

persists an absolute deadline exactly once.

Replay does not recompute `now + duration` after restart.

Instead:

```text
first execution:
  duration -> absolute dueAt -> persist

replay:
  reuse persisted dueAt
```

The workflow Task parks nonresident using external waiting.

The host timer adapter:

- observes parked workflow Tasks;
- arms process-local timers;
- rescans parked Tasks on host startup;
- wakes overdue tasks immediately;
- uses idempotent wake request IDs;
- does not become execution authority.

Timer callbacks may repeat.

Semantic sleep resolution must still occur at most once.

# Event wait

Example:

```ts
const guidance = await step.waitForEvent<ContinueEvent>("await-guidance-1", "workflow.continue");
```

V0 event identity:

```ts
type WorkflowEvent = {
    id: string;
    type: string;
    payload: JsonValue;
};
```

Event IDs are caller supplied.

## Delivery

`sendEvent` atomically performs:

```text
validate run
validate event ID
persist event/mailbox state
append semantic event
wake Task if needed
```

The call must not report accepted/buffered success until durable persistence succeeds.

## Duplicate IDs

Repeated identical event ID + content:

```text
idempotent duplicate
```

Repeated event ID with conflicting type/payload:

```text
fail closed
```

## Buffering

If an event arrives before a matching wait, v0 buffers it durably.

A later matching wait consumes the oldest matching durable event.

The event is consumed at most once.

## Active wait ambiguity

V0 matching is:

```text
runId + event type
```

Therefore only one active wait for a given event type is allowed in one run.

Registration of a second active same-type wait must fail.

If reconstructed history somehow contains ambiguous active waits, delivery must fail closed.

Future targeted wait IDs can relax this constraint.

## Timeouts

`waitForEvent` may specify a timeout.

Event acceptance and timeout compete to resolve the same logical wait.

Exactly one becomes authoritative.

Repeated timers must not produce duplicate timeout semantics.

# Stop and cancellation

Stop is a terminal operation.

The required semantic ordering is:

```text
durably establish stopped
        ↓
prevent admission of new workflow work
        ↓
propagate cancellation to owned Pi Tasks /
Conversations / Generations
        ↓
clean up remaining run resources
```

Pi native ownership/cancellation should perform child propagation.

Our workflow layer owns the semantic stopped transition.

A stopped run must not resume after host restart.

If cleanup of an owned resource fails:

- terminal stopped state remains authoritative;
- cleanup responsibility remains identifiable;
- the system must not pretend successful cleanup occurred.

V0 should rely on Pi ownership behavior where possible rather than maintaining a parallel custom child registry.

# Terminal transition barrier

Before any new semantic operation, wait, sleep, or event admission:

```text
if terminal transition has begun
    reject
```

Competing:

```text
completed
failed
stopped
```

outcomes must not all be able to commit.

The Pi adapter should centralize this rule rather than duplicating it through primitives.

# Semantic journal

The journal is immutable historical evidence.

It is not required to reconstruct the Pi scheduler because Pi Task state already performs that role.

Initial event vocabulary should remain small.

## Workflow

```text
workflow.started
workflow.completed
workflow.failed
workflow.stopped
```

## Operations

```text
operation.started
operation.completed
operation.failed
operation.interrupted
operation.reconciled
operation.retry_started
```

## Waits

```text
wait.registered
wait.resolved
wait.timed_out
```

## External events

```text
event.received
event.buffered
event.accepted
```

## Agent work

```text
agent.thread_started
agent.turn_reserved
agent.turn_completed
agent.turn_unknown
```

Agent event vocabulary may evolve during the agent-adapter implementation if Pi's native durable records make some events redundant.

Do not log a second semantic fact merely because another layer already has an authoritative durable fact, unless the semantic event materially improves audit/observability.

# Inspection

V0 inspection should answer:

```ts
type WorkflowInspection = {
    runId: string;
    workflowId: string;
    workflowVersion: number;

    status: "running" | "waiting" | "completed" | "failed" | "stopped" | "incompatible";

    current?: {
        operationId?: string;
        waitId?: string;
        kind?: string;
    };

    operations: Record<
        string,
        {
            status: "running" | "unknown" | "completed" | "failed";

            latestAttempt: number;
            error?: string;
        }
    >;
};
```

Inspection does not need to expose every journal event.

Detailed timeline UI can read semantic entries separately.
