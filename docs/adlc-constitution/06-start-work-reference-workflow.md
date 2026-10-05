# Reference Workflow: Start Work

This document is a behavioral reference workflow, not a required API.

It is useful as an integration benchmark because it exercises most runtime and agent semantics together.

## 1. Input

Accept exactly one source of plan content:

```text
planText
or
planFile
```

If a file path is supplied, read and freeze its content at admission.

The workflow executes a specific admitted plan revision, not "whatever is currently at this path."

## 2. Admission freeze

Before execution, normalize and durably bind:

- plan text;
- plan digest/revision;
- source descriptor;
- task identities;
- verification manifest;
- execution policy values that must not drift during the run.

A later mutation of the source plan file MUST NOT silently change the running plan.

## 3. Trusted invocation

A production admission SHOULD bind to trusted invocation provenance.

If an approval step exists, the approver must be shown the exact bounded immutable command/verification manifest being authorized.

Hidden commands must not be authorized merely through a digest the user cannot inspect.

## 4. Workspace authority

For a source-code workflow, bind the run to a canonical workspace.

A safe baseline:

- require a clean initial workspace;
- allow one active workflow owner per workspace;
- derive a workspace revision/fingerprint;
- detect external drift;
- fail closed or ask for explicit drift acceptance.

If authoritative workspace enumeration is truncated, reject rather than silently hash incomplete state.

## 5. Tasks

The plan is decomposed into independently implementable tasks.

Each task has a stable bounded task ID.

The final/global verification section is plan-level metadata and MUST NOT accidentally become part of the last task body.

## 6. Implementation actor

Each task gets a fresh independent implementer conversation.

Within the same task, reuse the same implementer for:

- initial implementation;
- verification repairs;
- TaskReview repairs;
- final remediation relevant to that task.

Different tasks MUST receive distinct actor identity/context.

## 7. Task cycle

For each task:

```text
implement
    ↓
snapshot revision
    ↓
targeted Verify
    ↓
TaskReview
```

If verification fails:

```text
same implementer repairs using verification evidence
    ↓
snapshot
    ↓
Verify again
```

If TaskReview returns CHANGES_REQUIRED:

```text
same implementer repairs using review findings
    ↓
snapshot
    ↓
Verify again
    ↓
same TaskReview gate/reviewer continues
```

Verification MUST rerun after every artifact-changing repair before re-review.

## 8. Revision binding

Every Verify and TaskReview pass is bound to the exact workspace/artifact revision.

Immediately after an APPROVED review, take/compare a fresh revision before recording approval.

If the artifact changed during review, that approval is stale and MUST NOT certify the new state.

## 9. Reviewer gate

Use one reviewer conversation/gate per task.

Use a separate reviewer conversation/gate for the cumulative final review.

Task A's reviewer MUST NOT be Task B's reviewer.

Task-level and final-gate authority MUST not cross.

## 10. Soft attempt windows

Each task may have a configured repair/review window.

After the window is exhausted, enter a durable resumable intervention.

The intervention may authorize a new window.

Window counters and accepted grants MUST survive restart.

## 11. Actor/reviewer recovery

Typed recovery states can include:

- owner unavailable;
- actor accepted but incomplete;
- actor unknown;
- reviewer request persistence unknown;
- reviewer accepted but incomplete;
- reviewer delivery/result unknown;
- reviewer not completed.

Every recurring intervention occurrence MUST have a fresh durable wait identity.

A consumed grant MUST NOT accidentally authorize a later occurrence.

## 12. Guidance

Operator guidance that authorizes a retry/repair MUST be durably associated with that exact decision and MUST survive cold replay.

Guidance admitted by the public boundary must be representable by the durable decision format without later rejection.

## 13. BLOCKED

`BLOCKED` creates a resumable workflow boundary.

It MUST NOT:

- mark the run failed merely for being blocked;
- use terminal `stopped`;
- lose its wait identity across restart.

## 14. ORACLE_REQUIRED

`ORACLE_REQUIRED` similarly creates a durable architectural/product decision boundary.

Resuming after restart with an exact grant should continue the same run.

## 15. Final gate

After all tasks:

```text
cumulative Verify
    ↓
cumulative TaskReview
```

Completion requires both to match the final artifact revision.

If final verification or final review requests changes, route the exact triggering evidence back to an appropriate retained implementer and then repeat the necessary verification/review sequence.

## 16. Completion

Before terminal completion:

- re-snapshot/revalidate the workspace revision;
- ensure final verification matches;
- ensure final review matches;
- ensure no unresolved intervention/actor/reviewer recovery remains.

Then record workflow completion.

## 17. Stop

Stop must:

```text
persist stopped
    ↓
prevent further admission
    ↓
dispose owned implementer/reviewer conversations
    ↓
release workspace ownership
```

A cold restart MUST never resurrect the stopped run.

## 18. Required isolation tests

At minimum prove:

- task actors do not share child identity;
- task reviewer gates do not share authority;
- final reviewer cannot satisfy task review;
- foreign reviewer result submission fails;
- implementers cannot access reviewer-only result capabilities;
- concurrent runs do not cross result/owner authority.
