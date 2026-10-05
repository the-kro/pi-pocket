# Verification, Review, and TaskReview

## 1. Separation of responsibilities

Keep these concepts separate:

```text
Verifier = objective/programmatic evidence
Reviewer = judgment of an artifact/result
Repairer = changes the artifact
Workflow = owns the repair/verify/review loop
```

A reviewer SHOULD NOT be the repairer.

A verifier SHOULD NOT own agent-repair loops.

## 2. Verification

Verification is one bounded pass over an explicit subject revision.

Examples:

- tests;
- typecheck;
- build;
- lint;
- static checks;
- custom validators.

The verifier MUST accept caller-selected checks rather than embedding repository semantics in the durable kernel.

## 3. Verification result

A verification result MUST include:

- `subjectRevision`;
- per-check status;
- aggregate status;
- bounded evidence;
- duration/exit/interruption metadata where relevant.

The aggregate result MUST be consistent with the per-check results.

Expected check failures are data, not necessarily workflow exceptions.

## 4. Timeout and cancellation

Timeout and external cancellation are distinct from normal success.

If a process receives cancellation/timeout and later exits zero, it MUST NOT be reported as a normal pass.

Evidence truncation SHOULD be byte-bounded and Unicode-safe.

## 5. Verification replay

A completed verification pass for revision X MAY replay only for revision X and the same logical verification operation.

After any repair/change, use a fresh logical verification cycle.

Stale verification MUST NOT approve a newer artifact revision.

## 6. Generic one-pass Review

Generic Review is a one-pass protocol:

```text
artifact + revision + reviewer authority
    -> structured verdict
```

A higher-level `untilApproved` helper MAY exist for closed review/revise protocols, but it is not the foundation of TaskReview.

## 7. TaskReview verdicts

TaskReview uses:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
ORACLE_REQUIRED
```

Suggested semantics:

- `APPROVED`: artifact meets the bounded acceptance gate;
- `CHANGES_REQUIRED`: concrete task-local material blockers exist;
- `BLOCKED`: acceptance cannot proceed without external information/action;
- `ORACLE_REQUIRED`: architectural/product decision exceeds TaskReview authority.

## 8. TaskReview lenses

Default TaskReview lenses:

```text
requirement
correctness
verification
```

A finding MUST belong to an enabled lens.

An out-of-scope lens is a validation error.

## 9. Blocking finding standard

A blocking finding must be task-local and evidence-backed.

A material blocker is one of:

- unmet explicit requirement;
- plausible correctness/security/safety/data-loss/regression failure;
- missing or insufficient verification that blocks acceptance.

A finding SHOULD provide:

- lens;
- classification/severity;
- origin;
- evidence;
- practical failure;
- bounded remediation;
- verification method;
- stable identity/fingerprint.

## 10. Out of scope for TaskReview

Unless directly acceptance-blocking, exclude:

- style-only concerns;
- vague code smell;
- speculative risk;
- alternate architecture preference;
- broad hardening;
- docs polish;
- unrelated preexisting issues.

Architectural decisions belong to an Oracle/architect role, not TaskReview.

## 11. Advisories

An APPROVED verdict MAY carry a small bounded number of optional-hardening advisories.

Non-approved verdicts SHOULD contain blocking findings only.

Advisories MUST NOT reopen an approved TaskReview gate.

## 12. TaskReview schema invariants

The domain validator MUST reject semantically invalid combinations, such as:

- APPROVED with blocking findings;
- CHANGES_REQUIRED with no blocking finding;
- findings outside selected lenses;
- mismatched artifact/verification revision;
- invalid/empty summary where summary is required.

Schema validation and semantic validation are both required.

## 13. Reviewer authority

TaskReviewer authority should be inspection-only.

Typical capabilities:

- read;
- search/grep;
- file discovery/listing;
- read-only language/navigation tools;
- optionally bounded read-only command execution if product requirements justify it.

TaskReviewer MUST NOT mutate the artifact, repair code, or delegate when the product contract forbids it.

Enforce this at capability execution, not by prompt alone.

## 14. Reviewer continuity

For a task gate:

```text
fresh reviewer at gate start
    ↓
review
    ↓
repair by implementer
    ↓
reverify
    ↓
same reviewer continues
```

This lets the reviewer retain its own prior feedback.

A new task/gate gets a fresh reviewer.

Standalone TaskReview MAY remain one-shot.

## 15. Durable review request/result

A continuable review gate SHOULD have:

- stable gate ID;
- operation/turn ID per review pass;
- exact subject revision;
- durable request identity;
- durable structured result;
- exact correlation between request, actor turn, and result.

A stale result MUST NOT satisfy a later operation/revision.

## 16. Review unknown outcomes

Unknown reviewer delivery/result state must be typed.

Recovery actions may include:

```text
re-observe same operation
retry unknown with explicit duplicate-risk authorization
continue reviewer with guidance on a fresh operation
```

Each recovery action needs a durable logical identity.

## 17. Outer orchestration

The desired task loop is:

```text
implement
    ↓
Verify
    ↓
TaskReview
    ├─ APPROVED -> advance
    ├─ CHANGES_REQUIRED -> same implementer repairs -> Verify again -> same reviewer gate
    ├─ BLOCKED -> durable resumable intervention
    └─ ORACLE_REQUIRED -> durable architectural/product intervention
```

The outer workflow owns the loop.

## 18. Attempt windows

Do not hard-fail merely because a fixed review/repair count was reached.

Use a soft attempt window:

```text
N repair cycles
    ↓
durable escalation/wait
    ↓
authorized new window
```

Restart MUST preserve the exhausted window state.

A grant opens exactly the intended next window and MUST NOT be reusable for later windows.

`stopped` is not the representation of "waiting for permission to continue".
