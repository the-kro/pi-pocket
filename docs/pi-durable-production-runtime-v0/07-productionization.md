# 07 — Productionization

The spike is feasibility evidence, not the production package.

The implementation agent should review each component independently.

## Likely promotable concepts

- external-wake patch;
- Transition Writer;
- Invocation Coordinator;
- stable operation record model;
- event mailbox logic;
- host timer adapter;
- child Pi Task ownership patterns;
- crash-test fixtures/patterns.

## Likely rewrite/cleanup areas

- global workflow-definition registry;
- spike-specific storage names;
- test-specific generic types;
- inspection schema;
- package/module boundaries;
- error/public API naming;
- production registration/bootstrap;
- diagnostic/error reporting policy.

No production component should be copied merely to preserve spike LOC.

# Implementation sequence

## Target 1 — Production runtime core

Implement:

```text
workflow
start/run admission
definition compatibility
step.do
unknown/reconcile/retry
semantic journal
inspection
terminality
stop
```

Acceptance:

- core crash matrix green;
- no agent integration yet.

## Target 2 — Nonresident waits

Implement/promote:

```text
sleep
sleepUntil
waitForEvent
mailbox
timer host
external wake
```

Acceptance:

- workflow has no resident invocation while parked;
- offline event and timer recovery proven.

This may be implemented together with Target 1 if the existing spike code makes separation artificial.

## Target 3 — Pi agent adapter

Implement:

```text
explicit AgentProfile
workflow-owned Conversation
one-shot turn
continuable turn
structured result
authority fingerprint
completed replay
unknown turn handling
cancellation
```

Acceptance:

- real Pi agent conversation runs inside a durable workflow;
- kill/reopen does not duplicate completed model work.

## Target 4 — Verify

Implement:

```text
workspace revision
verification manifest
bounded command evidence
durable verification result
revision binding
```

Acceptance:

- passed/failed checks represented correctly;
- stale results cannot certify new revision.

## Target 5 — Review

Implement:

```text
independent reviewer
read-only capability profile
structured verdict
reviewer continuation
revision binding
```

Acceptance:

- implementer and reviewer are isolated;
- repair forces Verify before Review.

## Target 6 — Start Work v0

Implement the one-task integration workflow.

Acceptance:

A real coding task can be run end-to-end:

```text
implement
→ verify
→ review
→ repair if necessary
→ complete
```

through a complete process kill/restart.

This is the first product milestone.

# Required source/API feasibility review before coding

Before implementation begins, the Pi Durable agent must review this packet against the exact current Pi Durable source and report only concrete mismatches.

Specifically verify:

1. whether caller-reserved run admission can be atomically mapped to root Task creation;
2. whether Task ownership/abort semantics satisfy the required stop-before-cleanup ordering or require adapter logic;
3. whether terminal Tasks retain enough outcome information for the proposed inspection model;
4. whether Conversation/Generation APIs expose sufficient durable request/result identity for the agent turn contract;
5. whether deterministic workflow-owned Conversation identity can be implemented without a new Pi core patch;
6. whether structured agent results can be bound to exact logical turns using existing Pi primitives;
7. whether child cancellation/disposal failure semantics require custom ownership bookkeeping;
8. whether atomic semantic Entry + Task checkpoint/projection transitions match the assumptions above;
9. whether the existing external-wake patch remains sufficient for sleep/event waiting;
10. whether any requirement unexpectedly requires another Pi core change.

The agent must not redesign the product merely because Pi exposes a different low-level API.

For each mismatch report:

```text
SPEC REQUIREMENT
PI REALITY
SMALLEST ADAPTER
CORE PATCH REQUIRED? yes/no
RECOMMENDATION
```

Only concrete substrate conflicts should trigger specification revision.

# Definition of success

This architecture is successful when the workflow system stops being primarily an architecture project and becomes infrastructure used to build software.

The decisive milestone is not API completeness.

It is:

> A real coding task runs through a durable implement → verify → independent review → repair → completion cycle, survives complete process death, does not repeat completed/uncertain work incorrectly, and is understandable through its semantic history and inspection state.
