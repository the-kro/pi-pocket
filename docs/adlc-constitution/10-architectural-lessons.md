# Architectural Lessons

This document is intentionally non-normative.

It captures design heuristics that survived repeated implementation and adversarial review.

## 1. Delete machinery before adding abstraction

Before inventing a new workflow subsystem, ask whether the host language/runtime already owns:

- branching;
- loops;
- dependency injection;
- provider lifecycle;
- child transport;
- cancellation;
- tool execution;
- context propagation.

Keep only the semantics that must be durable/domain-specific.

## 2. Ordinary language is the orchestration language

Do not invent a workflow DSL for normal control flow.

A durability API should look like durable islands inside ordinary code.

## 3. Helpers add semantics, not prettier syntax

A helper earns itself when it owns something like:

- durable replay;
- identity;
- unknown-outcome handling;
- revision binding;
- authority;
- compensation;
- structured validation.

A helper that only shortens normal language syntax probably should not exist.

## 4. One authoritative graph per dependency type

Do not maintain two independent sources for the same truth.

Examples:

- capability/lifecycle dependency graph;
- workflow work/result dependency graph;
- Role authority hierarchy.

Derived indexes are fine.

Competing mutable authorities are not.

## 5. Derived duplication is good; authoritative duplication is bad

It is fine to derive:

```text
Role policy
 -> tool visibility filter
 -> execution guard
```

because both are compiled from one source.

It is dangerous to let both be independently editable policy authorities.

## 6. Unknown is a real execution state

One of the most important rules:

> Started without provable terminal outcome is unknown.

Do not map unknown to failure or retry for convenience.

## 7. Reconciliation beats blind repetition

When effects can escape the runtime, design the API around reconciliation first.

Retry should be an explicit risk-bearing choice.

## 8. Persist semantic intent before external work

For side-effecting work:

```text
reserve logical operation
    ↓
external delivery/effect
```

is easier to recover than "send first, record later."

## 9. Absence is not unreadability

Persistence errors must not be collapsed into "record missing."

This distinction prevents a surprising number of duplicate/wrong-binding bugs.

## 10. Durable correlation should be exact

Avoid "latest", "most recent", or insertion-order selection when multiple causal histories are possible.

Use explicit logical identity.

## 11. Durable root IDs belong to authors/protocol owners

Runtime-generated descendants are useful.

Runtime-generated roots based on incidental execution position are dangerous.

## 12. Ambient execution identity is ergonomic, not authority

Async-local/current-run context is useful.

It should answer:

```text
where am I executing?
```

It should not answer:

```text
what durable operation is this?
```

That identity remains explicit.

## 13. Capability scope is not execution scope

The lifetime/visibility of dependencies and the durable location of work are distinct.

Conflating them creates cold-resume and provider-reload bugs.

## 14. Hard policy floor and decision policy are different

Hard safety constraints cannot be overridden by an "allow" decision.

A higher-level decision-policy service should be introduced only when real consumers require shared decisions inside the hard envelope.

## 15. Visibility is not enforcement

Removing a dangerous tool from a model catalog is good UX.

It is not sufficient security/authority enforcement.

## 16. Roles are specialization, not transport

A Role should not recreate:

- child runtime;
- provider registry;
- cancellation;
- session/conversation transport.

Use the underlying actor runtime; add stable identity and policy intent.

## 17. Reviewer and repairer should be separate

The agent that changed the artifact should not be the only agent deciding whether the change is acceptable.

## 18. Verification and review answer different questions

Verification:

```text
did configured checks pass?
```

Review:

```text
is this artifact acceptable and are the checks sufficient?
```

Keep both.

## 19. A review loop belongs to the workflow

A generic Review primitive should not become a mini workflow engine.

When repair requires re-verification, ordinary orchestration should own:

```text
review -> repair -> verify -> review
```

## 20. Continue actors within bounded semantic scope

Continuation is valuable within one coherent task/gate.

Fresh actors are valuable across independent tasks/gates.

This gives continuity without allowing context to become global hidden state.

## 21. Compensation is not cleanup

Resource disposal manages runtime lifetime.

Compensation reverses domain effects.

They have different failure semantics and must not share one abstraction merely because both happen "at the end."

## 22. Co-locate compensation intent with the forward effect

Registering compensation later creates a crash hole between forward completion and rollback registration.

## 23. Progressive enhancement beats mandatory representation

A workflow can later be projected as:

- DAG;
- state machine;
- timeline;
- UI graph.

Do not require authors to encode those representations if ordinary durable code is enough.

## 24. Architectural truths should become executable

If a sentence matters enough to put in the contract, write a hostile test for it.

Examples:

- stopped run never resurrects;
- stale revision never approves;
- foreign reviewer never concludes a turn;
- unreadable persistence is not absence.

## 25. Test the actual failure seam

A process-local simulation does not prove a cold-restart guarantee.

A mock event does not prove cross-ledger authority.

Use full teardown/remount where the contract is about persistence.

## 26. Front-load adversarial matrices for coupled protocols

Protocols crossing:

- durable identity;
- actor delivery;
- policy;
- cleanup;
- restart;
- structured result;

have combinatorial failure surfaces.

Write the hostile state/crash matrix before implementation to reduce repeated review-discovery loops.

## 27. Lifecycle cleanup failure is still ownership

Do not remove a child/resource from the owner's registry before disposal succeeds.

## 28. Soft escalation is better than arbitrary hard retry caps

A fixed "N attempts then fail" often turns useful convergence into a false terminal failure.

Prefer:

```text
N attempts
 -> durable intervention
 -> explicit grant for another window
```

## 29. Child workflows need semantic justification

Do not introduce nested workflows merely for code reuse.

A child workflow earns itself when it needs independent:

- run identity;
- history;
- cancellation;
- signals/events;
- version/fingerprint;
- addressability;
- resumability.

## 30. Generic durable frameworks should be extracted late

Do not create a generic durable namespace, artifact system, policy engine, or schema framework from the first consumer.

Let multiple production consumers prove the common seam first.
