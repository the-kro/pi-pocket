# Pi Durable Decision Spike Packet

## Purpose

Determine whether **Pi Durable** is a materially better substrate than our current **DSH + custom workflow runtime** approach for durable ADLC workflows.

This is **not** a migration project and **not** a production implementation. The goal is to answer a small number of architectural questions with executable code and crash/recovery tests.

The decision should be based on the resulting implementation, not on feature lists or architecture docs.

## Current design principle

> Workflow owns lifecycle; agents perform bounded cognitive work.

Our desired author-facing workflow API remains Cloudflare-style and runtime-agnostic. Pi Durable, DSH, Convex, or any future runtime should sit underneath that API rather than leaking runtime-specific mechanics into workflow definitions.

Example target authoring style:

```ts
export const featureWorkflow = workflow(async ({ input, step }) => {
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
  );

  return { implementation, approval, deployment };
});
```

## Preferred spike host

Use **[TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket)** as the preferred application shell for the spike. It is already built directly on Pi Durable and provides SQLite storage, model/provider setup, coding tools, restart/resume behavior, and a usable web surface.

Pi Pocket is a **host for the experiment**, not part of the workflow-runtime abstraction. Keep our workflow code isolated from Pi Pocket-specific multiplayer/UI/domain code so it could be extracted later.

Record the Pi Pocket commit SHA and pinned Pi package versions at the start of the spike and do not upgrade them mid-spike.

UI work is deliberately minimal. Reuse Pi Pocket's existing conversation/tool UI and add only the smallest workflow status/debug projection that materially helps development. Do **not** build a workflow designer or polished visualizer. If Pi Pocket integration itself becomes a substantial source of unrelated work, fall back to the minimal Pi Durable reference TUI/CLI and record that friction in the report.

## Core question

Can we implement the above API over Pi Durable as a **thin, understandable adapter/interpreter**, while preserving:

- durable restart/recovery;
- stable logical workflow/step identity;
- external waits/signals;
- retries and `NonRetryableError` / `RetryAfterError`;
- recoverable uncertain effects;
- compensation/rollback;
- semantic workflow journaling;
- continuable agents/subagents;
- useful workflow observability;
- human-reviewable workflow source code?

If the answer requires building most of a workflow engine again on top of Pi, Pi is probably only a lower-level task kernel and the benefit over DSH is much smaller.

## Packet contents

- `01-scope-and-constraints.md` — what must and must not be built.
- `02-primary-spike.md` — the implementation spike and required runtime behavior.
- `03-crash-recovery-matrix.md` — failure injection scenarios and assertions.
- `04-decision-rubric.md` — how to decide whether Pi Durable is worth adopting.
- `05-source-notes.md` — relevant Pi Durable source/docs to inspect before implementation.

## Deliverables expected from the spike

1. Working prototype code.
2. Automated crash/restart tests for the scenarios in this packet.
3. A short implementation report containing:
   - architecture used;
   - runtime-specific code added;
   - missing Pi primitives or awkward seams discovered;
   - deviations from the target API;
   - any Pi source patches required;
   - approximate runtime-specific LOC by subsystem;
   - implementation-friction notes: major dead ends, redesigns, review-driven rewrites, unclear Pi APIs/docs, and places where source inspection was required to proceed;
   - recommendation: **promising**, **unclear**, or **poor fit**, with evidence.

Do **not** access, modify, or reimplement the existing DSH workflow runtime as part of this packet. This is a Pi-only feasibility spike. DSH is the existing baseline we will compare against afterward using the code produced here, our existing DSH implementation, and the observed implementation/review friction.

Do not recommend replacing DSH merely because the prototype works. Pi should make the path to a usable workflow/agent product materially easier, smaller, or less friction-heavy in the areas that matter to us.
