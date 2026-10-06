# 06 — V0 Conformance

This file defines the production v0 acceptance matrix.

The long-term platform-independent conformance packet remains the larger source of future tests. Only the subset required by v0 is normative here.

# Runtime core

Must prove:

- concurrent same-run admission creates one run;
- conflicting same-run admission fails closed;
- completed `step.do` replays without callback;
- started/no-terminal operation reconstructs as unknown;
- interrupted `fail` does not invoke original body;
- interrupted `reconcile` invokes reconciler only;
- explicit interrupted retry creates another attempt;
- known failure retries are distinct attempts;
- `NonRetryableError` prevents configured retry;
- definition-version mismatch blocks automatic resume;
- stopped run does not resurrect after complete restart.

# Sleep / events

Must prove:

- two sleeps complete independently;
- sleep parks without resident workflow invocation;
- overdue sleep resumes immediately after reopen;
- repeated timer processing does not duplicate resolution;
- event-before-wait is consumed;
- wait-before-event parks and wakes;
- event delivery while host is offline survives;
- duplicate event ID does not deliver twice;
- conflicting duplicate event fails;
- buffered event survives full restart;
- buffered events consume deterministically;
- second active same-type wait rejects;
- terminal run rejects new events;
- event persist + wake survives crash boundaries.

# Cancellation / terminality

Must prove:

- terminal transition blocks new operations;
- terminal transition blocks new waits;
- stop becomes durable before child cleanup;
- owned Pi work receives cancellation;
- stopped workflow remains stopped after reopen;
- terminal outcome cannot be overwritten by competing failure/stop.

# Agent integration

Before Start Work is considered usable, prove:

- deterministic logical conversation mapping;
- separate implementer/reviewer identity;
- completed agent turn replays after complete restart without redispatch;
- continuation targets the same logical thread;
- stale turn result cannot satisfy later turn;
- authority fingerprint mismatch fails closed;
- reviewer cannot execute prohibited mutation capability;
- workflow cancellation reaches owned agent execution;
- an unknown agent turn is not blindly resent.

# Verification

Must prove:

- failed check is represented as data;
- aggregate status matches check results;
- cancellation/timeout cannot become success;
- stale revision verification is rejected;
- completed verification replays for the exact revision only.

# Review

Must prove:

- APPROVED cannot contain blocking findings;
- CHANGES_REQUIRED contains material findings;
- reviewer is mutation-disabled;
- reviewer is not the implementer;
- same reviewer continues after repair;
- stale review revision cannot approve current workspace;
- BLOCKED produces a nonterminal durable wait.

# Start Work v0

Must prove:

- admitted plan is frozen;
- same implementer used through task repair;
- reviewer is independent;
- repair always forces new Verify before Review;
- approval is invalidated if workspace changes during review;
- completed workflow survives full reopen without re-running completed model work;
- stop during execution does not resurrect actors/workflow;
- blocked workflow survives restart and consumes exact guidance once.

# Crash testing methodology

For every high-risk durable boundary, tests should kill the complete host process/runtime and reopen the same durable storage.

Important windows:

```text
before operation-start commit
after operation-start / before effect
after external effect / before completion commit
after completion commit / before next workflow code
before external wait park
after wait park / before wake
after event persistence / during wake
after stop persistence / during child cancellation
after agent turn dispatch / before result observation
after agent result / before workflow operation completion
```

In-memory map clearing is not sufficient evidence for a cold-restart guarantee.
