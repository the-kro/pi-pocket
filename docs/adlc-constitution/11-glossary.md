# Glossary

## Run

One durable execution of a workflow definition.

## Durable history

The authoritative persisted semantic record from which a run can be reconstructed.

## Projection

A derived view/index calculated from durable history.

## Operation

A named durable unit of work.

## Attempt

One execution/reconciliation/retry instance of an operation.

## Unknown outcome

Work is known to have started but no terminal outcome can be proven.

## Reconciliation

Explicit logic that determines or repairs the outcome of previously ambiguous work.

## Wait

A durable suspension point.

## Event

An external signal delivered to a workflow run.

## Terminal outcome

Completed, failed, or stopped.

## Actor / Agent

A child execution entity, typically model-backed, that can receive tasks/turns.

## Role

A stable named specialization of an agent with persona and policy intent.

## Conversation / Thread

A durable logical sequence of turns with one actor.

## Turn

One logical request/result exchange within a conversation.

## Reservation

Durable evidence that the system intends to execute a specific logical side-effecting turn before external delivery.

## Authority fingerprint

A durable/reproducible representation of the resolved execution authority used to detect drift on continuation.

## Hard policy floor

Non-bypassable deployment-level restrictions.

## Per-call narrowing

Additional restrictions applied for one invocation.

## Verify

Objective execution of configured checks against a specific artifact revision.

## Review

A structured judgment of an artifact/result.

## TaskReview

A bounded acceptance review for a work task, with requirement/correctness/verification lenses.

## Review gate

A durable TaskReview conversation/protocol bound to one task or final acceptance scope.

## Artifact revision

Immutable identity/fingerprint of the exact state being verified/reviewed.

## Soft attempt window

A bounded group of repair cycles that escalates to a resumable intervention rather than terminal failure.

## Grant

A durable external decision authorizing a specific pending intervention/recovery action.

## Compensation

Durable domain behavior that reverses/mitigates a completed forward effect.

## Quiescence

Open durable work is temporarily unable to execute because a required runtime capability is unavailable; it is not terminal.

## Cleanup

Runtime resource disposal; distinct from compensation.
