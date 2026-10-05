# Operations, Sleeps, Waits, and Events

## 1. Durable operations

A durable operation has:

- a stable author-owned logical ID;
- one or more attempts;
- durable started/completed/failed or equivalent outcome records;
- a replayable result when completed.

Blank or invalid IDs MUST reject before semantic durable state is written.

## 2. Operation attempts

Attempt identity MUST be distinct from the root logical operation ID.

Example:

```text
operation: send-invoice
attempt 1: started -> unknown
attempt 2: reconciled -> completed
```

The runtime MUST preserve the fact that attempt 1 became unknown.

It MUST NOT rewrite history to pretend attempt 2 was the original attempt.

## 3. Reconciliation

Reconciliation is preferred over blind repetition when an effect may have escaped.

A reconciler MAY:

- inspect external state;
- prove the original action completed;
- prove it did not occur;
- repair ambiguous state;
- return a canonical result.

The runtime SHOULD make reconciliation easy enough that authors are not pushed toward blind retry.

## 4. Sleep

A durable sleep MUST survive restart.

A sleep is identified by logical wait ID plus a due time.

Requirements:

- multiple sleeps MAY coexist;
- each sleep becomes eligible once;
- restart after the deadline MUST make it immediately eligible;
- repeated timer ticks MUST NOT append duplicate semantic completion/eligibility.

Timers themselves are not durable authority.

## 5. Timed wait

A timed event wait has:

- wait ID;
- event type;
- optional deadline.

Timeout and event acceptance MUST resolve the same logical wait exactly once.

A repeated timer callback MUST NOT create duplicate timeout outcomes.

## 6. Event wait

Baseline event matching is:

```text
run identity + event type
```

Matching MUST NOT depend on an arbitrary non-durable callback predicate.

If richer matching is needed, the matching key must itself be durable.

## 7. Active-wait ambiguity

If the event API matches only by event type, the runtime MUST NOT silently choose among multiple active same-type waits.

Preferred V1 behavior:

- reject registration of a second active same-type wait; and
- fail closed if historical/corrupt state nevertheless contains ambiguity.

"Newest wait wins" or "first wait wins" is not acceptable unless that ordering is an explicit durable contract.

## 8. Event identity

Incoming events SHOULD have an author/caller-supplied event ID.

Duplicate event IDs MUST be idempotent.

A repeated event ID MUST NOT deliver twice.

## 9. Event acceptance durability

If event delivery is reported as accepted, that acceptance MUST be durable before the call returns success.

A caller retry after a crash MUST be able to distinguish:

- already accepted;
- already buffered;
- not recorded;
- run terminal;
- ambiguous target.

## 10. Buffering

If no active matching wait exists, the runtime MAY durably buffer an event.

If buffering is supported:

- buffered events MUST survive restart;
- a later matching wait MUST consume the event at most once;
- if multiple buffered events are allowed, consumption ordering MUST be deterministic from durable history.

A sensible baseline is oldest durable event first.

## 11. Admission during terminality

Events sent to a terminal or terminal-transitioning run MUST NOT create new workflow work.

Terminality wins over duplicate reporting or matching.

## 12. Discovery and timers

Runtime discovery/timer failures that are operational/transient SHOULD retain a retry trigger.

A transient scheduling failure MUST NOT permanently lose an otherwise valid due wait.

This retry mechanism is runtime plumbing, not semantic workflow state.
