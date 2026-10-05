# 04 — Decision Rubric

## Decision principle

Do not switch from DSH because Pi Durable is novel, elegant, or technically impressive.

The primary decision lens is **implementation and maintenance friction**: does Pi get us to a usable durable workflow/agent product with materially less difficult glue code, fewer architectural dead ends, fewer review-driven rewrites, and a runtime that is easier to understand and extend?

Switch only if Pi materially reduces that friction and/or the amount of generic durability/workflow machinery we must own **without giving up the DSH qualities we care about**.

## Hard feasibility gates

A Pi-backed implementation should be considered a poor fit if any of these fail without patching Pi substantially:

- Cloudflare-style workflow function can be re-entered safely.
- Completed `step.do()` results are reused without re-execution.
- Stable logical step identity works across restart/re-entry.
- Durable sleep works across process death.
- External `waitForEvent()` works without polling/resident invocation.
- Recoverable uncertain effects can durably `pending()` and re-enter recovery.
- Parent/child task waiting survives restart cleanly.
- Semantic workflow state/journal can be maintained without race-prone glue.
- Workflow authors do not need to write Pi-native task phases/checkpoints.

## Strong positive signals for Pi

Pi becomes compelling if the spike shows that most of these fall naturally out of Pi primitives:

- task ownership and structured cancellation;
- durable child task creation/waiting;
- crash recovery;
- agent Conversation ownership;
- retries/checkpoint state;
- task graph inspection;
- atomic coordination of task/document/entry writes;
- task migration/version support.

The ideal result is:

```text
Pi Durable
    +
small workflow interpreter
    +
thin semantic journal/projection
```

not:

```text
Pi Durable
    +
our own scheduler
    +
our own durable timer system
    +
our own signal subsystem
    +
our own task graph
    +
our own recovery engine
    +
our own workflow engine
```

## Strong negative signals for Pi

Record these as significant costs:

- external events require polling;
- durable timers require a substantial side scheduler;
- workflow replay/interpreter requires fragile JS control-flow tricks;
- Pi Task IDs leak into workflow definitions;
- semantic journal and Pi execution state routinely need reconciliation repair;
- child workflow semantics fight Pi ownership rules;
- compensation requires invasive changes to Pi scheduler internals;
- even a minimal workflow status/debug projection requires deep knowledge of Pi implementation internals;
- agent extensions/tools we need require large rewrites;
- one-process-per-storage ownership conflicts with our likely execution topology;
- required source patches would make us maintain a meaningful Pi fork.

## Development-friction evidence

Because friction is a primary reason for considering a substrate change, record the implementation experience as evidence, not anecdote. Include:

- number and nature of major redesign/review cycles;
- places where public APIs were insufficient or misleading;
- how often Pi source archaeology was required;
- whether fixes stayed localized or cascaded across unrelated subsystems;
- whether Pi Pocket made the system faster to inspect/debug or became an additional source of complexity;
- whether an agent implementer could make progress independently or repeatedly needed architectural intervention.

Do not penalize Pi for lacking a polished workflow UI: we have not built that on the DSH side either. UI should only influence the decision insofar as the substrate makes basic observability unusually easy or unusually difficult.

## Implementation-cost evidence

At the end, report approximate runtime-specific LOC by subsystem:

```text
workflow interpreter
stable identity/indexing
step state/result persistence
timers
signals/events
retries/errors
recoverable()
compensation
semantic journal/projection
agent integration
observability adapter
Pi patches/forks
```

Raw LOC is not the decision by itself, but it is useful evidence of how much infrastructure we actually own. Also report qualitative implementation friction: major false starts, places that required Pi source changes or deep source archaeology, repeated review issues, and any subsystem whose correctness was unexpectedly difficult to establish.

We will compare this evidence against the DSH baseline we already have. Do not build a duplicate DSH spike merely to manufacture symmetrical metrics.

## Suggested verdicts

### Promising

Use when:

- all hard gates pass;
- adapter remains relatively thin;
- Pi removes meaningful generic workflow-runtime complexity;
- source remains human-reviewable;
- remaining gaps are localized extensions rather than a second scheduler/runtime.

Recommended next step: review the finished Pi implementation against our existing DSH runtime and our actual experience implementing/reviewing both. If Pi materially reduces friction, proceed to a narrow MVP on Pi before considering migration.

### Unclear

Use when:

- core behavior works;
- one or two important areas require substantial custom machinery;
- topology/extension ecosystem/upgrade risk remains unresolved.

Recommended next step: one narrowly scoped follow-up spike only for the unresolved item(s).

### Poor fit

Use when:

- a hard gate fails;
- Pi requires us to rebuild much of the workflow runtime anyway;
- Pi-native mechanics substantially harm workflow reviewability;
- topology constraints conflict with our likely architecture;
- maintaining required Pi patches/fork outweighs the benefits.

Recommended next step: retain DSH as substrate and selectively borrow Pi ideas/primitives where useful.

## Final comparison questions

The final report should answer these directly:

> Did Pi Durable make this workflow substantially easier to implement correctly, review, debug, and extend than we would expect from our existing DSH workflow work?

> How much Pi-specific code did we have to add before the Cloudflare-style API became genuinely usable?

> If we had to maintain either substrate for three years, does the Pi implementation appear likely to reduce difficult durability/runtime work while preserving our preferred workflow API, semantic observability, and agent architecture?

The agent should answer from the Pi spike evidence. The final substrate choice remains a human decision informed by our existing DSH experience; no fresh DSH implementation is required by this packet.
