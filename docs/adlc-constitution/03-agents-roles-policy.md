# Agents, Roles, Subagents, and Policy

## 1. Agent

An **agent** is a model-backed or programmatic actor with:

- identity;
- instructions/persona;
- tools/capabilities;
- execution authority;
- optional child/delegation capability;
- lifecycle;
- durable lineage when used by durable workflows.

The workflow runtime does not need to own model execution internally, but it MUST be able to reason about the durable consequences of starting and continuing agents.

## 2. Role

A **Role** is a named specialization of an agent.

A Role SHOULD own intent such as:

- stable role ID;
- persona/instructions;
- tool visibility intent;
- tool authority intent;
- delegation intent;
- depth/resource limits;
- provider/model route intent or route key;
- structured-output expectations.

A Role MUST NOT become a second child-agent transport/runtime.

The underlying agent runtime remains responsible for:

- child creation;
- cancellation;
- continuation;
- message transport;
- provider execution;
- child lifecycle.

## 3. Provider/model route is distinct from Role

Role identity and model/provider routing are separate concerns.

Changing provider implementation MUST NOT silently change Role identity.

A Role MAY express a route preference, but the route itself is not the Role.

## 4. Authority hierarchy

Authority is monotonic narrowing.

The behavioral hierarchy is:

```text
hard deployment floor
    ↓
Role specialization
    ↓
per-call narrowing
```

A lower layer MUST NOT broaden an upper-layer restriction.

If the effective authority cannot be enforced, execution MUST fail closed.

## 5. Hard floor vs ordinary defaults

Hard constraints and overrideable defaults are different.

Examples of hard constraints:

- maximum delegation depth;
- prohibited tools;
- prohibited filesystem/network domains;
- no-delegation roles;
- workspace confinement.

Examples of ordinary defaults:

- preferred tools;
- model route;
- timeout;
- persona defaults.

A statically configured Role that exceeds a hard limit SHOULD fail configuration validation rather than be silently clamped.

A dynamic per-call request MAY narrow the resolved authority.

## 6. Visibility is not authority

Tool visibility and tool execution authority are separate.

A hidden tool SHOULD normally be unavailable to the model, but hiding alone MUST NOT be treated as an enforcement boundary.

An authoritative execution guard MUST still deny prohibited execution, including:

- direct host/tool invocation;
- later locally registered tools;
- alternate invocation paths.

Derived duplication is acceptable:

```text
same Role policy intent
  -> catalog restriction
  -> execution guard
```

The duplicated mechanisms are derived from one policy source; they are not competing authority.

## 7. Delegation

Model-driven delegation is an authority-bearing action.

"No delegation" MUST be enforced at the actual child-creation boundary, not only by omitting a prompt/tool description.

Trusted host code MAY have child-creation authority even when the model does not.

These are distinct:

```text
host can create child
model can request child
```

## 8. Role groups

Flat Role groups MAY be used to express delegation targets or shared profiles.

Nested policy languages are not required.

## 9. Skills / optional capabilities

Skills or optional capability bundles MAY be layered on Roles, but they MUST obey the same monotonic authority rules.

A skill MUST NOT widen a hard floor.

## 10. Policy abstraction

Do not require a generic Policy service merely for symmetry.

A dedicated decision-policy abstraction is justified only when multiple real consumers need reusable decisions beyond existing hard enforcement.

Hard authority policy and workflow intervention decisions SHOULD remain conceptually distinct.

An `allow` decision MUST never bypass the hard authority floor.

## 11. Authority snapshot for continuations

A continuable conversation MUST have a durable or reproducible authority snapshot/fingerprint sufficient to detect meaningful drift.

Relevant dimensions can include:

- Role ID;
- resolved tool authority;
- delegation ceiling;
- prompt/persona identity;
- route identity if behaviorally significant;
- hard-policy version.

Before dispatching a later turn, the runtime MUST compare current resolved authority against the conversation's recorded authority according to the chosen compatibility contract.

The conservative baseline is exact equivalence.

Both widening and narrowing MAY require explicit intervention because either can change the meaning of a resumed durable conversation.

## 12. Child isolation

Two independent child actors MUST NOT leak:

- tool sets;
- policy state;
- continuation results;
- parent ownership;
- task/gate authority;
- ambient execution identity.

Concurrent actor runs are a required isolation test.

## 13. Independent actors by task

For work execution, independently implementable tasks SHOULD receive independent implementation actors unless continuity across tasks is an explicit product requirement.

Within one task, continuation of the same implementation actor is desirable for:

- verification repair;
- review repair;
- follow-up guidance.

## 14. Reviewer independence

A reviewer MUST be independent of the implementer.

For TaskReview:

- begin each task/gate with a fresh reviewer conversation;
- within that gate's repair cycle, continue the same reviewer when continuation semantics are safe;
- a new task gets a new reviewer.
