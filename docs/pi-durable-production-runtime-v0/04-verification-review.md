# 04 — Verification and Review

Verification and Review are reusable application-level protocols built on the workflow runtime.

They are not workflow-kernel policy and must not become separate orchestration engines.

# Verification

API:

```ts
type VerificationManifest = {
  checks: VerificationCheck[];
};

type VerificationResult = {
  subjectRevision: string;

  status:
    | "passed"
    | "failed"
    | "interrupted";

  checks: CheckResult[];
};
```

Each result is bound to an immutable workspace/artifact revision.

Expected check failure is data. It is not necessarily an exception.

## Verification checks

V0 coding checks may include:

```text
tests
typecheck
lint
build
custom command
```

The workflow supplies the manifest.

The runtime does not embed repository-specific commands.

## Verification replay

A verification result for:

```text
revision A
```

must not certify:

```text
revision B
```

After any repair:

```text
snapshot new revision
→ new Verify logical operation
```

# Review

Review is independent judgment.

Reviewer and implementer must be distinct agent conversations.

V0 review verdicts:

```text
APPROVED
CHANGES_REQUIRED
BLOCKED
```

## APPROVED

No material blocking issue exists within the configured review scope.

## CHANGES_REQUIRED

Contains concrete bounded findings requiring artifact changes.

## BLOCKED

The reviewer cannot responsibly decide or proceed without external information/action.

`BLOCKED` is not terminal workflow failure.

`ORACLE_REQUIRED` and the full historical TaskReview protocol are deferred.

## Reviewer capabilities

Reviewer capabilities are read-only.

The reviewer may:

- read files;
- search;
- navigate symbols;
- inspect verification evidence;
- optionally run explicitly approved read-only analysis.

The reviewer must not:

- edit code;
- mutate the artifact;
- delegate if delegation is disabled;
- submit results for another review gate.

Enforcement occurs at capability execution, not only prompt construction.

## Reviewer continuity

The first production slice has one review gate.

At gate start:

```text
fresh reviewer conversation
```

If review returns `CHANGES_REQUIRED`:

```text
same implementer repairs
        ↓
Verify again
        ↓
same reviewer conversation continues
```

This preserves reviewer context within one acceptance gate.

Future independent tasks receive independent reviewer conversations.

# Workspace revision

The coding workflow requires an application-level:

```ts
WorkspaceAdapter.snapshot(): Promise<WorkspaceRevision>
```

The revision must deterministically identify the artifact state being verified/reviewed.

The exact implementation is outside the durable kernel.

V0 may use Git workspace state if appropriate.

The important contract is:

```text
Verify revision == Review revision == completion revision
```

An approval for a stale revision is invalid.
