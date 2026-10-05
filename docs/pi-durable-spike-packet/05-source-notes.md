# 05 — Pi Durable Source Notes

Inspect current source before implementation. Pi Durable is experimental and may have changed since this packet was written.

Repository:

- https://github.com/earendil-works/pi

Important paths:

```text
packages/durable/README.md
packages/durable/docs/spec.md
packages/durable/src/harness/scheduler.ts
packages/durable/src/harness/types.ts
packages/durable/src/harness/harness.ts
packages/durable/src/harness/tool.ts
packages/durable/src/harness/task-graph.ts
packages/durable/test/examples/13-recovery.ts
packages/durable/test/examples/24-child-tasks.ts
```

Chord:

```text
packages/chord/README.md
packages/chord/src/
```

## Preferred host: Pi Pocket

Repository:

- https://github.com/TannerMidd/pi-pocket

Inspect at minimum:

```text
README.md
src/server/app.ts
src/server/projection.ts
src/server/docs.ts
src/server/extensions/
AGENTS.md
package.json
```

Pi Pocket already constructs its own Pi Durable registry, installs Durable coding tools/extensions, opens a Pi Durable Harness over SQLite, subscribes to committed state, and resumes unfinished work. Use those existing seams rather than creating a second harness beside it.

Pi Pocket does **not** mean vanilla Pi extensions are automatically loaded. Its application extensions are Pi Durable extensions registered into its own registry. It may reuse vanilla Pi packages for model/settings/auth utilities, but the Durable extension runtime remains separate.

Record the exact Pi Pocket commit SHA and package versions used by the spike. Treat the project as a convenient reference shell, not as a stable API we are committing to.

## Known facts to verify against current source

### Atomic session commit

Pi Durable's core specification states that one Session commit is atomic across record/document writes and that visible progress is only published after durable commit.

This is central to the hypothesis that workflow state + semantic entry + child task creation can sometimes be coordinated in one transaction.

### Tasks

Pi Tasks are durable state machines with persisted checkpoints and ownership.

On reopen, previously running tasks are reconciled back into schedulable state while preserving checkpoints.

Tasks can own child Tasks and Conversations.

### Waiting

Pi supports Tasks entering a durable `waiting` state on other Tasks.

This is expected to be the primitive beneath `step.do()` child work and parent joins.

### `runtime.sleep()`

Current source uses an in-process timer tied to the active task invocation:

```text
scheduler.ts -> #sleep(...)
```

The recovery example explicitly checkpoints before sleeping and relies on task re-entry after reopening.

Do not assume this alone implements Cloudflare-style durable sleep. Persist an absolute wake deadline in our adapter and prove crash behavior.

### Tools and replay

Pi tool registrations currently support:

```ts
replay?: "safe" | "unsafe"
```

with default `unsafe`.

This is agent/tool-level recovery behavior. Do not automatically promote it into the workflow authoring API.

### Task graph

Pi exposes a structural Task graph suitable for low-level runtime drill-down.

Our workflow visualizer should project this into workflow/step/attempt concepts rather than expose raw Pi tasks as the primary UX.

### Extensions

Pi Durable's extension API is distinct from the vanilla Pi Coding Agent extension API.

Do not assume arbitrary existing Pi extensions can be installed unchanged.

The spike only needs enough extension/tool/agent behavior to prove our workflow-owned agent model.

### Storage ownership

Pi Durable storage is designed around one process owning a storage instance/session at a time rather than multiple processes concurrently mutating the same storage.

Document whether our likely architecture naturally maps one workflow/session to one owner, or whether we expect multiple independent workers to operate against the same workflow state.

This may become a larger architectural constraint than any individual API gap.

## Implementation guidance

Prefer using Pi's public package APIs.

If a required behavior appears impossible through the public API:

1. document the missing primitive;
2. inspect whether it already exists internally;
3. prototype the smallest possible patch only if necessary;
4. clearly separate adapter code from Pi source modifications;
5. include every required patch in the final report.

A spike that only works by deeply modifying Pi is evidence against adopting Pi unless the changes are likely to be upstreamable and small.
