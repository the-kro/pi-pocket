# 01 — Architecture

## Guiding principles

### Ordinary TypeScript owns orchestration

Branching, loops, helper functions, conditions, and ordinary concurrency remain TypeScript.

The durability layer adds durable semantics around selected operations. It must not become a second control-flow language.

### Unknown is first-class

```text
durably started
+
no provable terminal outcome
=
UNKNOWN
```

Unknown must not automatically become failure or retry.

### Reconciliation before blind repetition

When an operation may have created an external effect, recovery should first attempt to determine what happened.

Retry is an explicit decision with duplicate-effect risk.

### Authors own durable logical root IDs

Stable semantic identity must be explicit.

Examples:

```text
implement
verify-1
review-1
repair-2
await-guidance-1
```

The runtime must not derive logical identity from call order, source line number, mutable array position, or a random ID minted only after work begins.

### Derived duplication is allowed; authoritative duplication is not

It is acceptable to maintain:

```text
checkpoint
semantic journal
inspection projection
```

provided each has a distinct authority.

## Architecture

```text
                    Application Workflows
                 start-work-v0, future ADLC
                          │
                          ▼
              ┌────────────────────────┐
              │   Workflow API         │
              │ workflow / step / run  │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │ Workflow Interpreter   │
              │ replay + step semantics│
              └───────────┬────────────┘
                          │
               ┌──────────┴──────────┐
               ▼                     ▼
      Invocation Coordinator    Transition Writer
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
               Pi Task       Semantic       Inspection /
               checkpoint     Journal        ingress doc
                    │
                    ▼
             Pi Durable Harness
         tasks / ownership / scheduler
          cancellation / dependency waits
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    Agent Adapter          Timer Host
    Conversation /         external wake
    Generation Tasks
```

The architecture has four major custom responsibilities:

1. workflow semantics;
2. Pi adaptation;
3. semantic history/read model;
4. agent-domain adaptation.

Pi owns generic durable execution.

## Pi primitive mapping

| Requirement | Pi Durable responsibility | Our responsibility |
|---|---|---|
| durable execution | Task/checkpoint | logical workflow semantics |
| restart | scheduler + Task recovery | workflow-function replay |
| completed work | persisted Task/checkpoint | step result memoization |
| Task ownership | native ownership | semantic child/thread IDs |
| cancellation | native propagation | workflow stop semantics |
| child join | Task dependency/wait | child semantic interpretation |
| agent execution | Conversation/Generation Tasks | thread/turn protocol |
| atomicity | Pi transactions | transition meaning |
| external wait | external-wake patch | event/timer semantics |
| scheduler | Pi | none |
| semantic audit | Entries | vocabulary + emission |
| inspection | snapshots/docs | workflow projection |

The production runtime must resist taking ownership of responsibilities in the middle column.

## External-wake dependency

V0 accepts the tested Pi Durable external-wake patch as a substrate dependency.

The patch provides:

```text
Task -> waiting { external: true }
```

and transactional wake via `tx.wakeTask(taskId, requestId)` with:

- persistent nonresident waiting;
- fresh invocation after wake;
- idempotent wake request IDs;
- concurrent wake safety;
- abort precedence;
- hard-restart recovery;
- no storage schema migration.

This patch remains isolated from workflow semantics.

If upstream Pi eventually provides an equivalent primitive, the adapter should move to the upstream implementation.

No additional Pi scheduler patch is justified by the current v0 design.

## State authority

### Execution authority

The live Pi Task checkpoint is authoritative for unfinished workflow execution.

It contains enough durable state to determine completed operations, current attempts, interrupted attempts, durable waits, child references needed for execution, and replay through named operation records.

The invocation-local replay map is only a cache.

### Terminal authority

The terminal Pi Task outcome is authoritative for the workflow's final execution result:

```text
completed
failed
stopped/aborted
```

Exactly one terminal outcome may become authoritative.

### Historical authority

Immutable semantic workflow entries are the historical/audit authority.

They describe what happened. They do not schedule work.

### Event ingress authority

A durable workflow ingress/mailbox record is authoritative for:

- runId -> Pi Task mapping;
- definition identity/version;
- input/admission identity;
- external event IDs;
- buffered event payloads;
- event consumption state.

External callers must be able to atomically:

```text
persist event
+
wake task
```

without requiring a live workflow invocation.

### Inspection authority

Inspection state is a derived/materialized projection.

It may include workflow status, active operation/wait, operation summaries, recent failures, and terminal result metadata.

It must not become execution authority.

All projection writes should occur through the centralized transition layer.

## Transition writer

The production runtime retains the central concept proven in the spike:

```text
semantic decision
    ↓
Transition Writer
    ├─ update latest Pi checkpoint
    ├─ update materialized projection
    ├─ append semantic journal entries
    └─ return next Pi Task state
```

The transition writer must merge against the latest transactional checkpoint rather than the invocation's original snapshot.

Special external-ingress transactions may use the same persistence layer without requiring a live invocation.

Do not create a general-purpose state-machine DSL around this.

## Invocation coordinator

Concurrent `step.do` effects may be admitted during one workflow invocation.

Before the workflow can durably park or terminally complete, all admitted sibling effects must settle.

The invocation coordinator owns a state machine conceptually equivalent to:

```text
OPEN
  ↓ suspension requested
QUIESCING
  ↓ same-turn admission window closes
DRAINING
  ↓ admitted effects settle
PARKED
```

This protects ordinary `Promise.all` patterns from parking the parent while already-admitted effects remain active.

V0 does not promise general durable semantics for `Promise.race`, `Promise.any`, or multiple simultaneous suspending operations.

Only one suspending operation may win per invocation.

## Proposed production module boundaries

Logical modules:

```text
workflow/
  api
  definition
  runtime
  interpreter
  invocation
  transitions
  operations
  waits
  events
  journal
  projection
  pi-adapter
  timer-host

agents/
  profile
  runner
  conversation
  structured-result

verification/
  verify
  command-runner

review/
  schema
  reviewer

workflows/
  start-work-v0
```

These are conceptual boundaries. They do not all need independent packages.

Prefer one production workflow-runtime package initially.

Extract separate reusable packages only after real consumers justify them.

## Cordis decision

Cordis is not part of v0.

This is not a rejection of Cordis. It is a scope decision.

Pi already provides much of the lifecycle behavior that previously motivated custom DSH/Cordis integration:

- durable ownership;
- cancellation propagation;
- Task lifetime;
- child relationships;
- scheduler/restart.

For v0, ordinary constructor/module composition is sufficient for:

```text
WorkflowRuntime
AgentRunner
Verifier
Reviewer
TimerHost
Journal
```

Reconsider Cordis when at least one concrete need appears for:

- dynamic capability registration/unregistration;
- scoped service contributions from multiple independent plugins;
- hot provider replacement while durable runs remain open;
- generation-based unload/quiescence;
- dependency graphs where manual composition becomes significant;
- multiple products contributing behavior to a shared runtime lifecycle.

If Cordis is later adopted, it must remain composition/lifecycle infrastructure, not execution durability authority.
