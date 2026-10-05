# Capability, Lifecycle, and Execution Context Contract

## 1. Runtime capabilities

Workflow code may depend on runtime capabilities such as:

- agents/Roles;
- verification;
- review;
- filesystem/workspace access;
- subprocess execution;
- approvals;
- domain services.

The mechanism that provides them is implementation-specific.

## 2. Registration scope vs execution scope

Capability lifetime/scope and durable execution identity are different concepts.

Do not conflate:

```text
which capabilities are visible/alive?
```

with:

```text
which durable workflow/run/operation is executing?
```

A runtime may use lexical scopes, containers, fibers, plugins, dependency graphs, or other means for capabilities.

Durable execution identity must remain explicit.

## 3. Per-run capability isolation

A workflow run MUST resolve the capability set intended for its registration/configuration scope.

Two isolated registrations/runs MUST NOT accidentally share different provider instances merely because they use the same service/capability name.

## 4. Run-owned effects

Effects/resources created by a run-scoped capability MUST be owned by that run's lifecycle.

On completion, stop, or successful unload, those effects must be disposed.

## 5. Provider/capability disappearance

If a required capability disappears while a durable run is open:

- new dependent work MUST stop/quiesce;
- the workflow MUST NOT fabricate `failed` or `stopped` solely because the provider disappeared;
- existing durable run state remains open and discoverable;
- reappearance of an equivalent compatible capability may resume the run.

## 6. Re-registration

Equivalent capability re-registration should produce one eligible new execution generation.

Old run-scoped effects MUST be disposed before new resumed work uses replacement capability instances.

## 7. Definition compatibility still applies

Capability re-registration MUST NOT bypass workflow-definition fingerprint/version compatibility.

## 8. Cleanup ownership

Do not release an owned disposer/child before disposal succeeds.

Correct ordering:

```text
attempt dispose
    ↓
success
    ↓
release ownership
```

If disposal fails:

```text
retain ownership
allow retry
```

This applies both to agent children and run-scoped capability resources.

## 9. Ambient execution context

An implementation MAY expose ambient execution context for ergonomic nested calls.

Useful fields can include:

- run ID;
- current logical step/operation;
- cancellation signal;
- reconstructed/cold-resume indicator.

Requirements:

- nested async calls see the current context;
- concurrent runs do not leak into one another;
- context restores after success or failure.

Ambient context MUST NOT be the source of durable logical operation identity.

The workflow author still supplies durable IDs.

## 10. Capability access is not authority

Possessing a capability object does not automatically authorize every action.

Authority checks may additionally depend on:

- current actor identity;
- Role;
- workspace;
- parent ownership;
- current gate/operation;
- hard policy floor.

## 11. Lifecycle and durable facts

Runtime lifecycle cleanup records are not substitutes for domain workflow outcomes.

Conversely, domain compensation is not resource cleanup.

Keep:

```text
runtime cleanup
```

and:

```text
durable business/domain compensation
```

separate.
