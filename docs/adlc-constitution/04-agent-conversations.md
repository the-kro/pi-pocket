# Continuable Agent Conversation Contract

## 1. Logical conversation identity

A durable conversation has an author-owned logical `threadId`.

Each logical turn has an author-owned `turnId`.

Native/provider message IDs MAY exist internally but MUST NOT be the workflow's durable semantic identity.

## 2. Parent ownership

A child conversation belongs to an exact parent authority.

Later turns MUST fail closed if the required live/durable parent ownership no longer matches.

A foreign owner MUST NOT be able to continue the child.

## 3. Deterministic child identity

Given the same:

```text
parent identity
Role identity
thread identity
```

the runtime SHOULD derive or recover the same child conversation identity.

Arbitrary concatenation that can collide is not acceptable.

## 4. Reservation before delivery

For a side-effecting continuable turn, the logical turn authority SHOULD be durably reserved before native/provider delivery.

This establishes:

```text
caller intended logical turn X
```

before the external actor may act.

If reservation cannot be durably established, no delivery should occur.

## 5. Acceptance is not completion

Conversation APIs MUST distinguish:

```text
accepted
completed
not completed
unknown
```

An inbox/provider acknowledgement is not equivalent to a completed durable logical turn.

## 6. Durable result correlation

A turn result MUST be correlated to the exact logical turn.

Result folding must not rely on "latest assistant message".

The runtime must distinguish:

- initial turn;
- follow-up turn;
- retry turn;
- earlier completed turn;
- currently active turn.

## 7. No blind resend

If delivery/result status is ambiguous, the runtime MUST NOT automatically resend the same semantic work.

The conversation returns an explicit unknown outcome.

## 8. Retry unknown

Retrying an unknown conversation turn is an explicit authority-bearing decision.

A retry MUST have:

- a new logical turn ID;
- a durable link to the prior unknown turn;
- explicit duplicate-side-effect risk acknowledgment where appropriate.

Example:

```text
turn A -> unknown
turn B retryOf A -> terminal
```

A terminal retry descendant MAY resolve the ambiguity of its ancestor according to protocol rules.

## 9. Retry chains

Retry-of-retry is valid when needed.

The durable retry graph MUST be:

- acyclic;
- uniquely identified;
- strictly validated;
- reconstructable after restart.

The runtime MUST fail closed on malformed or ambiguous retry frontiers.

## 10. Reservation-persistence ambiguity

A reservation write can itself become ambiguous.

If the system can prove the reservation is absent, it MAY reconcile by writing the same reservation ID.

If persistence is unreadable, the runtime MUST NOT treat unreadable as absent.

Absence and unreadability are different states.

## 11. Initial child creation identity

If native child creation can occur on a retry rather than the original initial turn, the durable conversation layer MUST record enough authority to know which logical turn actually created/owns the native initial turn.

It MUST NOT infer this from ordering if ordering is ambiguous.

## 12. Structured turn result

When a domain requires structured output, a completed conversational turn MUST have a schema-validated structured result.

Prompted JSON prose does not satisfy this contract.

A platform can satisfy this via:

- native per-turn structured output;
- a domain-owned structured result submission capability;
- another schema-enforced mechanism.

The important behavior is:

```text
validated structured result
bound to exact logical turn
durably proven before turn is treated as completed
```

## 13. Result durability before conclusion

If a result-submission mechanism concludes/ends the native turn, the durable domain result MUST be proven first.

The order is:

```text
validate authority + schema
    ↓
persist domain result
    ↓
prove exact durable result
    ↓
conclude native turn
```

## 14. Conflicting authority

If durable request/result/reservation records for the same logical operation conflict on identity, the system MUST fail closed as durable corruption.

It MUST NOT filter away conflicting siblings and proceed using one convenient record.

## 15. Cold replay

After restart:

- completed turn results replay without redispatch;
- unresolved reservation/delivery state reconstructs to the same typed outcome;
- authority is revalidated;
- retries preserve linkage;
- a completed retry can resolve prior ambiguity;
- stale earlier-turn results cannot satisfy a later turn.

## 16. Disposal

Conversation disposal:

- closes admission of new turns;
- is idempotent after success;
- shares concurrent disposal attempts;
- propagates cleanup failure;
- retains cleanup ownership after failure so the exact child can be retried.

## 17. Conversation API outcome shape

A platform-neutral result union should distinguish at least:

```text
completed
accepted-incomplete
not-completed
unknown
unauthorized / authority-drift
```

Domain protocols MAY refine reasons.

The union should prevent callers from accidentally treating an unknown as a normal failure.
