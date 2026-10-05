# Platform-Independent Durable Workflow + Agent Behavioral Contract

## Purpose

This packet captures the platform-independent behavior and architectural lessons learned while designing and hardening a durable agent workflow system.

It is intended as a comparison target for **pi-durable** and any other candidate runtime.

The packet deliberately avoids implementation-specific APIs, storage formats, plugin systems, provider names, and substrate-specific lifecycle mechanics. It specifies **what must be true**, not how a particular runtime achieves it.

## Scope

Included:

- durable workflow execution;
- operation replay and unknown outcomes;
- waits, sleeps, events, stop, restart, and terminality;
- run identity and definition/version drift;
- agents, roles, subagents, authority, delegation, and policy;
- continuable agent conversations;
- structured agent results;
- verification;
- review and TaskReview;
- a reference `start-work` workflow;
- capability/lifecycle/isolation behavior;
- durable compensation;
- crash/restart and conformance expectations;
- architectural lessons and anti-patterns.

Explicitly excluded because they are specified elsewhere:

- Watchdog / useful-progress monitoring;
- agent-observer / observational-memory behavior.

Also not required by this baseline:

- static DAG extraction;
- workflow AST analysis;
- broad UI;
- distributed multi-owner coordination;
- workflow migrations;
- child-workflow execution as a code-reuse primitive.

## Document map

| File | Purpose |
|---|---|
| `01-workflow-runtime-contract.md` | Normative durable workflow semantics |
| `02-operations-waits-events.md` | Detailed operation, sleep, wait, and event behavior |
| `03-agents-roles-policy.md` | Agent/Role/subagent authority and policy contract |
| `04-agent-conversations.md` | Continuable actor conversation and retry/recovery semantics |
| `05-review-verification.md` | Verify, generic Review, TaskReview, structured-result behavior |
| `06-start-work-reference-workflow.md` | Bread-and-butter developer workflow behavior |
| `07-capability-lifecycle-context.md` | Capability isolation, disappearance, cleanup, ambient context |
| `08-durable-compensation.md` | Durable Saga / best-effort compensation semantics |
| `09-conformance-test-matrix.md` | Runtime-neutral hostile test requirements |
| `10-architectural-lessons.md` | Non-normative design lessons and anti-patterns |
| `11-glossary.md` | Shared terminology |
| `12-intentional-open-questions.md` | Explicitly uncommitted future areas |

## Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

A runtime can implement these guarantees with an event log, database rows, journal, object store, or another persistence mechanism. The internal representation is not part of this contract unless explicitly stated.

## Core philosophy

The durable system should make this statement true:

> After a crash, restart, provider reload, or process replacement, the runtime can reconstruct what is known, what is completed, what is pending, and what is unknown without inventing an outcome or silently repeating externally meaningful work.

That principle is more important than API shape.
