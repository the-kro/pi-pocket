# Pi Durable Production Workflow Runtime v0

**Status:** Proposed production architecture

**Purpose:** Define the smallest production-quality durable workflow and agent runtime needed to power a usable coding-agent workflow, while preserving the platform-independent correctness contract established during the DSH work.

## Decision

Pi Durable is the provisional execution substrate for the next production implementation.

The production model is:

```text
Pi Durable
    = durable execution authority

Our workflow runtime
    = workflow semantics

Immutable semantic entries
    = historical / audit authority

Derived projections
    = inspection / observability
```

We explicitly do **not** reproduce the DSH architecture on top of Pi.

The useful architectural lesson retained from DSH is its semantic-history model, not its execution machinery.

## Host portability

Pi Pocket is one UI/host, not a runtime dependency. The same extensions and configured runtime
must work in a Pi Durable TUI or programmatic host. Prefer standard extensions/public Harness
configuration; any extra helper must earn its existence and be portable. Future specs/plans must
follow [Host portability and earned integration seams](01-architecture.md#host-portability-and-earned-integration-seams).
Hot reload is optional DX, not an execution prerequisite.

## Product goal

Runtime v0 succeeds when it can reliably execute a real coding-agent workflow shaped approximately as:

```text
admitted task
    ↓
implementer agent
    ↓
workspace revision
    ↓
Verify
    ↓
independent Reviewer
    ↓
approved ───────────────→ complete
    │
    ├─ changes required
    │       ↓
    │   same implementer repairs
    │       ↓
    │   Verify
    │       ↓
    │   same reviewer continues
    │
    └─ blocked
            ↓
       durable wait for guidance
            ↓
         continue
```

This workflow must survive complete process termination and reopening without:

- repeating completed operations;
- inventing outcomes;
- losing waits;
- blindly repeating uncertain external effects;
- losing agent/conversation ownership;
- accepting stale verification or review results;
- resurrecting a stopped workflow.

The first production slice is deliberately **one implementation task**.

## Core principle

> Workflow owns lifecycle; agents perform bounded cognitive work.

Agents do not decide durable lifecycle. The workflow decides what executes, when retries or reconciliation occur, when verification and review happen, when intervention is required, and when the run is complete.

## Reading order

1. `01-architecture.md`
2. `02-workflow-runtime-contract.md`
3. `03-agent-runtime.md`
4. `04-verification-review.md`
5. `05-start-work-v0.md`
6. `06-conformance.md`
7. `07-productionization.md`
8. `08-roadmap.md`

The platform-independent handoff packet remains the long-term semantic source. This packet defines what we are actually building on Pi now.
