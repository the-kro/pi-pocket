# 05 — Start Work v0

This is the first actual product workflow.

It is deliberately narrower than the full historical Start Work design.

## Input

The first application workflow accepts an already-admitted single-task plan.

It does not initially contain Plan Writer.

Example input:

```ts
type StartWorkV0Input = {
    workspaceId: string;

    plan: {
        revision: string;
        text: string;

        task: {
            id: string;
            instructions: string;
        };
    };

    verification: VerificationManifest;
};
```

Input is frozen at run admission.

A later modification of the source file from which the plan originated does not change the running workflow.

## Lifecycle

```text
1. Validate/freeze admission
2. Snapshot initial workspace
3. Start implementer thread
4. Implement task
5. Snapshot workspace revision
6. Verify exact revision

if Verify fails:
    continue same implementer with verification evidence
    snapshot
    Verify again

7. Start reviewer gate
8. Review exact verified revision

if CHANGES_REQUIRED:
    continue same implementer with findings
    snapshot
    Verify
    continue same reviewer
    Review again

if BLOCKED:
    park durably for operator guidance
    continue appropriate actor
    resume normal Verify/Review path

if APPROVED:
    snapshot workspace again
    ensure revision still matches reviewed revision
    complete
```

## Implementer conversation

The task receives one implementer conversation:

```text
threadId = task/<taskId>/implementer
```

The same implementer is reused for:

- initial implementation;
- verification repair;
- review repair;
- operator-guided repair for the same task.

This preserves useful bounded context.

A later independent task gets a new implementer thread.

## Review gate identity

Review gate:

```text
gateId = task/<taskId>/review
```

Reviewer thread:

```text
threadId = task/<taskId>/reviewer
```

Every review pass uses a fresh logical turn ID:

```text
task/<taskId>/review/1
task/<taskId>/review/2
...
```

A result for review turn 1 cannot satisfy turn 2.

## BLOCKED / guidance

V0 implements a minimal durable operator boundary rather than the full historical grant framework.

Example:

```text
waitId = task/<taskId>/blocked/<occurrence>
event type = workflow.guidance
```

Guidance includes:

```ts
type WorkflowGuidanceEvent = {
    guidance: string;
};
```

Each new blocked occurrence receives a new logical wait ID.

Consumed guidance cannot accidentally satisfy a later blocked occurrence.

No generic grant/permission framework is introduced yet.

## Repair loop

The workflow itself owns:

```text
implement
→ verify
→ review
→ repair
→ verify
→ review
```

Verify and Review must not contain their own orchestration engines.

V0 does not introduce a universal `untilApproved()` runtime primitive.

A small application helper may later factor duplicated Start Work code without changing semantics.

## Completion criteria

Start Work v0 may terminally complete only when all are true:

1. latest verification passed;
2. verification subject revision matches latest review subject revision;
3. reviewer returned `APPROVED`;
4. a fresh workspace snapshot still matches that revision;
5. no unresolved blocked wait exists;
6. no required agent turn is unknown;
7. no terminal transition is already in progress.

Completion records the workflow result and semantic `workflow.completed` atomically with the Pi Task terminal transition where supported.

## Failure semantics

Workflow failure represents an actual terminal failure, not:

- ordinary verification failure;
- `CHANGES_REQUIRED`;
- `BLOCKED`;
- an unresolved intervention merely awaiting input.

Examples that may terminally fail:

- invalid admitted input;
- incompatible workflow version;
- durable corruption;
- unrecoverable workflow runtime fault;
- explicit product-defined abandonment;
- an unhandled `UnknownOperationError`.

Application code may catch an unknown operation and convert it into a durable operator intervention instead of terminal failure.

## First product milestone

A real coding task runs end-to-end:

```text
implement
→ verify
→ review
→ repair if necessary
→ complete
```

through a complete process kill/restart.

This is the first product milestone.
