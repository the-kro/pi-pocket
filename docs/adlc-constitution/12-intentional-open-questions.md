# Intentional Open Questions / Non-Requirements

These areas are deliberately not settled by the baseline.

They should not block the first pi-durable prototype unless a concrete use case demands them.

## 1. Cross-process activation ownership

The behavioral baseline requires honest ownership guarantees.

It does not require distributed leases/fencing.

Possible future work:

- leases;
- fencing tokens;
- distributed schedulers;
- persistence-root ownership.

## 2. Workflow migrations

Current baseline:

- definition/fingerprint drift blocks automatic resume.

Future systems may add migrations, but migrations require an explicit durable compatibility model.

Do not silently interpret old durable history under new semantics.

## 3. Child workflows

Not required for code reuse.

Revisit only if a caller needs independent child-run:

- identity;
- history;
- cancellation;
- signals;
- versioning;
- resumability.

## 4. Static DAG / workflow analysis

Not required for runtime correctness.

A DAG can be a derived projection when possible.

Dynamic language control flow remains valid.

## 5. Generic artifact framework

Review needs immutable revision identity.

That does not automatically justify a universal artifact system.

## 6. Generic schema framework

Structured agent results require validation.

That does not require a new schema abstraction if the host/runtime already has one.

## 7. Generic decision Policy service

Hard policy floors are required.

A reusable workflow decision-policy layer should be extracted only after multiple concrete consumers require it.

## 8. Global workflow event bus

Not part of the baseline.

Run-targeted events are sufficient for current workflow semantics.

## 9. Rich event matching

Predicates, broadcast, target-wait IDs, and configurable queue semantics are optional future capabilities.

If added, their matching/ordering must be durable and unambiguous.

## 10. Automatic compensation-on-stop

Not assumed.

Stop and compensation are distinct semantics.

## 11. Backward compatibility / migrations

This behavioral packet does not require legacy code paths, fallback decoders, or compatibility shims.

If a product chooses breaking evolution during prototyping, that is valid.

## 12. Watchdog and agent-observer

Deliberately excluded from this packet because they are specified separately.

Integration must preserve the ownership boundaries defined here:

- observer/watchdog does not become durable workflow authority;
- intervention/recovery actions still use explicit durable workflow semantics.
