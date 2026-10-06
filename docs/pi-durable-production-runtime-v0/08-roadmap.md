# 08 — Roadmap and Explicitly Deferred Scope

This file exists partly to prevent scope creep.

# V0 partial / deferred contracts

## Roles / policy

Use explicit agent profiles.

Do not build a generalized Role framework.

Required now:

- stable agent-profile identity;
- explicit instructions/persona version;
- explicit capability/tool authority;
- hard execution enforcement;
- no reviewer mutation authority;
- no reviewer delegation unless explicitly allowed;
- authority fingerprint for continuation.

Deferred:

- role groups;
- generic dynamic policy service;
- skill composition framework;
- general delegation policy language.

## Intervention

Required now:

- durable nonterminal wait for operator guidance;
- unique logical wait identity;
- replay-safe consumption.

Deferred:

- generalized grants;
- arbitrary intervention schemas;
- soft-window authorization framework;
- Oracle protocol.

## Review

Required now:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
```

Deferred:

```text
ORACLE_REQUIRED
```

and the full historical TaskReview protocol.

# Immediate evolution after v0

After Start Work v0 is actually used successfully:

- multiple plan tasks;
- fresh implementer per independent task;
- fresh reviewer gate per task;
- cumulative final Verify/Review;
- Plan Writer;
- richer intervention;
- soft attempt windows;
- Unblocker escalation.

# Later

- child workflows where independent lifecycle is actually required;
- workflow fragments for reusable inline orchestration;
- Watchdog;
- Agent Observer;
- observational memory;
- CI Healer;
- retrospective agent;
- budgets/breakpoints;
- compensation where business agents require it.

# Explicitly not v0

- Watchdog;
- Agent Observer;
- observational memory;
- durable compensation;
- generic policy service;
- generalized Cordis lifecycle integration;
- provider disappearance/re-registration protocol;
- distributed activation fencing;
- workflow migrations;
- workflow DAG/AST extraction;
- global workflow event bus;
- generic artifact framework;
- generic durable schema framework;
- budgets;
- breakpoints;
- retrospective agents;
- CI Healer;
- automatic compensation-on-stop.

# Future Cordis decision checkpoint

Reconsider Cordis only when concrete requirements appear for:

- dynamic capability registration/unregistration;
- scoped service contributions from multiple independent plugins;
- hot provider replacement while durable runs remain open;
- generation-based unload/quiescence;
- dependency graphs where manual composition becomes significant;
- multiple products contributing behavior to a shared runtime lifecycle.

If those needs emerge, evaluate Cordis specifically for composition/lifecycle.

Do not let Cordis become execution durability authority.
