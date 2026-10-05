# Durable Workflow Runtime Contract

## 1. Workflow run

A **workflow run** is one durable execution of one workflow definition.

Each run MUST have:

- an explicit durable `runId`;
- a workflow-definition identity;
- a definition fingerprint or equivalent compatibility marker;
- exactly one eventual terminal outcome.

A run is either:

```text
open
terminal:
  completed
  failed
  stopped
```

An implementation MAY expose intermediate in-memory states such as `starting`, `stopping`, or `completing`, but those states MUST NOT become a second durable authority.

## 2. Durable authority

All semantically relevant workflow state MUST be reconstructable from durable records.

Examples include:

- run admission/start;
- operation attempts and outcomes;
- waits;
- event acceptance/buffering;
- terminality;
- explicit recovery/intervention decisions;
- compensation state when compensation is used.

Runtime indexes, caches, timers, registries, projections, and in-memory maps MAY improve execution but MUST be disposable and reconstructable.

A mutable cache MUST NOT be the only evidence that a semantic event occurred.

## 3. Append-only semantic history

The baseline model assumes durable history is logically append-only.

Corrections SHOULD be expressed as later facts/records rather than destructive rewriting.

This does not require a literal event-log implementation. A database implementation MAY normalize records internally, but it MUST preserve equivalent replay semantics and unambiguous causal history.

## 4. Author-owned logical identity

Workflow authors or protocol owners MUST supply stable logical root IDs for durable operations, waits, review gates, conversations, and other replay-sensitive protocols.

The runtime MAY derive deterministic descendant IDs.

The runtime MUST NOT derive durable semantic identity from:

- source-code line number;
- current call order;
- random IDs generated after the durable action begins;
- array position that can change across workflow versions.

## 5. Idempotent run admission

When the caller supplies a run ID:

- two concurrent attempts to start the same logical run MUST create at most one durable run;
- retrying admission after a crash MUST resolve to the already-admitted run if the immutable admission identity matches;
- a conflicting request using the same run ID MUST fail closed.

The exact fields forming admission identity are product-specific.

## 6. Definition compatibility

Automatic reconstruction MUST verify that the current workflow definition is compatible with the durable run.

A definition fingerprint mismatch MUST NOT silently resume using changed semantics.

A mismatch MUST require explicit intervention, migration, or a new run.

## 7. Reconstruction

An open run MUST be reconstructable after process restart.

Reconstruction MUST determine, from durable authority:

- completed operations;
- unknown operations;
- pending waits;
- accepted/buffered events;
- terminality;
- active recovery/intervention boundaries;
- owned child actors when the workflow uses actors;
- compensation state when enabled.

Restart MUST NOT itself imply workflow failure.

## 8. Unknown is first-class

If a durable operation is known to have started but the runtime cannot prove a terminal outcome, its outcome is **unknown**.

The runtime MUST NOT infer:

```text
crash => failed
```

or:

```text
crash => safe to retry
```

Supported policies SHOULD include:

```text
fail
reconcile
retry
```

where:

- `fail` surfaces the unknown without re-executing;
- `reconcile` invokes only an explicit reconciler;
- `retry` starts a distinct attempt and is an explicit author decision.

Retry MUST NOT be described as exactly-once safety.

## 9. Completed operation replay

A durably completed operation MUST replay its durable result without executing the operation body again.

This guarantee applies after warm re-entry and cold restart.

## 10. Terminal transition barrier

Once a run begins a terminal transition, the runtime MUST reject admission of new semantic work for that run, including:

- operations;
- waits;
- sleeps;
- incoming workflow events.

The system MUST NOT allow competing contradictory terminal outcomes.

## 11. Stop

`stop` is a terminal operation.

The durable stopped state MUST be established before child cleanup is considered authoritative.

The intended ordering is:

```text
persist stopped
    ↓
abort active execution
    ↓
clean up owned children/resources
```

A stopped run MUST NOT resurrect after restart.

Closing a UI conversation, disconnecting a client, or restarting the host MUST NOT implicitly stop a durable workflow.

## 12. Cleanup failure

Cleanup failure MUST NOT erase ownership.

If an owned child/resource fails to dispose:

- the owner MUST retain enough authority to retry cleanup;
- the runtime MUST NOT falsely report successful quiescence;
- successfully cleaned siblings SHOULD NOT be redundantly redrained.

## 13. Quiescence vs terminality

Temporary loss of a required runtime capability MAY quiesce an open run without terminally failing it.

If the equivalent capability becomes available again and definition compatibility still holds, the run MAY resume.

A provider/capability reload MUST NOT by itself forge a terminal workflow fact.

## 14. Concurrency

The runtime MUST define its activation-ownership guarantees explicitly.

If it does not provide cross-process fencing/leases, it MUST NOT claim safety under concurrent activation of the same durable history by multiple owners.

Distributed ownership is not required by this baseline.

## 15. Forking

If workflow history can be copied/forked:

- copied history is provenance, not automatically active authority;
- an executable workflow fork MUST mint a new run identity;
- descendants MUST not accidentally share the same active durable run authority.

## 16. Ordinary language owns orchestration

Workflow branching, loops, functions, and concurrency SHOULD use the host programming language.

The durability layer SHOULD provide durable semantics, not replace normal language control flow with a second DSL unless a concrete requirement proves otherwise.
