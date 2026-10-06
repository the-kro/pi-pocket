# 03 — Agent Runtime

Agent integration is a separate layer above generic workflow durability.

Do not embed agent-specific behavior directly into `step.do`.

Conceptual component:

```text
AgentRunner
```

using native Pi Durable:

```text
Conversation
    ↓
Generation Task
    ↓
Tool Tasks
```

The workflow owns the AgentRunner invocation through Pi Task ownership.

## Do not recreate DSH Roles/Subagent architecture

The Pi implementation should preserve the semantic lessons from Roles without reproducing its implementation model.

V0 uses explicit profiles rather than a generalized Role framework.

Example:

```ts
type AgentProfile = {
  id: "implementer" | "reviewer" | "plan-writer";
  version: number;

  instructions: string;

  modelRoute: string;

  capabilities: AgentCapabilities;

  structuredResult?: Schema;
};
```

Profiles express intent.

They must not implement their own:

- conversation transport;
- task scheduler;
- cancellation tree;
- provider runtime.

## Authority

V0 authority is monotonic narrowing:

```text
hard runtime/deployment floor
        ↓
AgentProfile
        ↓
per-call narrowing
```

Tool visibility is not sufficient enforcement.

The actual tool execution boundary must enforce effective capabilities.

Reviewer profile must be unable to mutate the workspace even if a prompt attempts to request mutation.

## Conversation identity

A continuable workflow-owned conversation uses:

```text
threadId
turnId
```

Both are author/protocol-owned logical IDs.

Example:

```text
thread:
  task-1/implementer

turns:
  task-1/implement
  task-1/repair-verification-1
  task-1/repair-review-1
```

Native Pi identifiers are implementation detail.

A deterministic/collision-safe mapping connects the logical thread to the native Conversation.

## Authority fingerprint

When a continuable conversation is created, persist or reproduce an authority fingerprint based on behaviorally relevant configuration.

At minimum:

```text
profile id/version
instructions version
effective tool/capability authority
delegation setting
model route if continuation semantics depend on it
```

Before a later turn is delivered, recompute the authority fingerprint.

V0 baseline:

```text
exact match required
```

Drift fails closed.

No authority migration protocol exists in v0.

## Agent turn protocol

A side-effecting logical turn must establish durable intent before model/provider delivery where Pi does not already provide equivalent durable request identity.

The adapter must distinguish:

```text
completed
accepted-incomplete
not-completed
unknown
authority-drift
```

It must not collapse unknown into ordinary failure.

## Completed replay

A durably completed agent turn must return the existing result after restart.

It must not dispatch the semantic turn again.

This is one of the required cold-restart acceptance tests.

## Unknown turns

If Pi proves a Generation/turn completed, return that result.

If Pi proves it never began, it may be safely initiated.

If delivery/execution may have occurred but the exact result is not provable:

```text
unknown
```

Do not resend automatically.

Explicit retry, if later needed, uses a new logical `turnId` with durable `retryOf`.

Full retry-chain machinery is NEXT rather than required for the first implementation turn unless the source feasibility review shows it is already nearly free through Pi primitives.

## Structured results

When the workflow requires structured data, prose is not authoritative.

A structured turn is completed only when a schema-valid result is durably associated with the exact logical turn.

For v0 this applies at minimum to Review.

Example:

```ts
type ReviewResult =
  | {
      verdict: "APPROVED";
      summary: string;
    }
  | {
      verdict: "CHANGES_REQUIRED";
      summary: string;
      findings: Finding[];
    }
  | {
      verdict: "BLOCKED";
      summary: string;
      reason: string;
    };
```

Pi-native structured output should be used if it provides the required exact correlation and durability.

Otherwise implement the smallest adapter necessary.

Do not create a generic structured-result framework before more than one concrete consumer proves the abstraction.

## Conversation disposal

Workflow-owned conversations are Pi-owned descendants where possible.

On workflow stop or terminal cleanup:

```text
close admission
cancel/dispose native child execution
preserve terminal workflow state
```

If native disposal can fail after semantic workflow completion, the implementation must make that failure observable and retain recoverable ownership rather than silently forgetting the child.

Do not build a custom child registry until Pi's actual lifecycle behavior demonstrates that one is required.

## V0 scope

Required now:

- stable agent-profile identity;
- explicit instructions/persona version;
- explicit capability/tool authority;
- hard execution enforcement;
- one-shot agent execution;
- continuable agent conversation;
- stable logical thread/turn identity;
- structured result durability;
- exact result correlation;
- cold replay without redispatching completed turns;
- cancellation propagation;
- safe handling of interrupted/unknown externally meaningful work.

Deferred:

- role groups;
- generic dynamic policy service;
- skill composition framework;
- general delegation policy language;
- generalized retry chain unless source review proves it nearly free;
- child workflows as agent abstractions.
