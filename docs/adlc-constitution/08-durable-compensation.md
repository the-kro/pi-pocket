# Durable Compensation Contract

## 1. Compensation is domain behavior

Compensation undoes or mitigates externally meaningful effects.

It is not runtime resource disposal.

Examples:

- cancel a created reservation;
- refund a charge;
- delete/revert a created external artifact;
- release a business lock.

## 2. Co-locate forward and rollback intent

If a forward operation is compensatable, its rollback/compensation declaration SHOULD be durably associated with the forward operation.

Avoid:

```text
forward completes
crash
later code registers compensation
```

because the rollback relationship can be lost.

## 3. Durable forward output

Compensation should receive the durable forward result/output needed to perform rollback.

It SHOULD NOT depend on mutable closure state that may not exist after restart.

## 4. Compensation stack is derived

Do not use a mutable in-memory stack as durable authority.

For Saga semantics, derive the effective stack from durable completed forward effects, typically in reverse completion order.

## 5. Modes

Support explicit semantics such as:

```text
none
saga
best-effort
```

### Saga / fail-fast

- compensate eligible effects in reverse order;
- if a compensation fails/blocks, stop the rollback chain and escalate.

### Best effort

- continue attempting remaining compensations;
- report residual failures.

## 6. Compensation uses durable operation semantics

A compensation attempt itself is a durable side-effecting operation.

Therefore it has the same unknown-outcome problem as forward work.

If compensation started but completion is missing:

```text
unknown
```

Do not blindly repeat.

## 7. Reconciliation

Unknown compensation SHOULD support reconciliation.

Examples:

- query whether refund already exists;
- query whether resource is already deleted;
- query external idempotency key.

## 8. Crash matrix

| Case | Required behavior |
|---|---|
| forward outcome unknown | reconcile forward before deciding compensation eligibility |
| forward completed, later failure | derive eligible compensation |
| crash before rollback starts | reconstruct same compensation stack |
| compensation starts, completion missing | mark outcome unknown; reconcile/retry by explicit policy |
| external rollback happened but durable completion missing | do not blindly duplicate |
| restart mid-chain | skip durably completed compensations; continue remaining |
| Saga compensation failure | stop/escalate |
| best-effort compensation failure | continue and report residual failures |

## 9. Stop semantics

Stopping a workflow MUST NOT implicitly mean "run all compensations" unless the workflow/product explicitly chooses that semantic.

Stop and compensate are separate decisions.

## 10. Terminology

Do not call this ACID or transactional unless the underlying external system actually supplies those guarantees.

This is a durable compensation protocol.
