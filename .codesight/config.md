# Config

## Environment Variables

- `AUTHORITY_WORKER_DB` **required** — test/workflow-agent-authority.test.ts
- `AUTHORITY_WORKER_EFFECTS` **required** — test/workflow-agent-authority.test.ts
- `AUTHORITY_WORKER_MODE` **required** — test/workflow-agent-authority.test.ts
- `HOME` **required** — test/app.test.ts
- `HTTP_PROXY` (has default) — src/server/net.ts
- `HTTPS_PROXY` (has default) — src/server/net.ts
- `NO_COLOR` **required** — src/launcher/term.ts
- `PATH` (has default) — src/launcher/access.ts
- `PI_AGENT_BOUNDARY` **required** — test/fixtures/workflow-agent-crash-worker.ts
- `PI_AGENT_DB` **required** — test/fixtures/workflow-agent-crash-worker.ts
- `PI_AGENT_MARKERS` **required** — test/fixtures/workflow-agent-crash-worker.ts
- `PI_AGENT_MODE` **required** — test/fixtures/workflow-agent-crash-worker.ts
- `PI_CODING_AGENT_DIR` **required** — test/app.test.ts
- `PI_CORE_MODE` **required** — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_CORE_OPERATION_ID` (has default) — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_CORE_POLICY` (has default) — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_CORE_RECOVERY_RESULT` (has default) — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_CORE_SCENARIO` (has default) — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_DB_PATH` **required** — test/fixtures/external-wake-crash-worker.ts
- `PI_EFFECT_LOG` **required** — test/fixtures/workflow-interpreter-crash-worker.ts
- `PI_EVENT_ID` (has default) — test/fixtures/external-wake-crash-worker.ts
- `PI_EVENT_VALUE` (has default) — test/fixtures/external-wake-crash-worker.ts
- `PI_MARKER_PATH` **required** — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_MODE` **required** — test/fixtures/external-wake-crash-worker.ts
- `PI_NOW` **required** — test/fixtures/workflow-interpreter-crash-worker.ts
- `PI_POCKET_ACCESS` **required** — src/launcher/options.ts
- `PI_POCKET_BROWSER_ARGS` **required** — src/server/browser.ts
- `PI_POCKET_DIR` (has default) — src/launcher/options.ts
- `PI_POCKET_GUARD` **required** — src/server/lancet.ts
- `PI_POCKET_HOST` (has default) — src/launcher/options.ts
- `PI_POCKET_LANCET_DIR` **required** — src/server/lancet.ts
- `PI_POCKET_LAUNCHER` **required** — src/server/main.ts
- `PI_POCKET_PORT` (has default) — src/launcher/options.ts
- `PI_POCKET_SUPERVISED` **required** — src/server/main.ts
- `PI_RECOVERY_LOG` (has default) — test/fixtures/workflow-runtime-core-crash-worker.ts
- `PI_REVIEW_DB` **required** — test/workflow-agent-recovery.test.ts
- `PI_REVIEW_MARKERS` **required** — test/workflow-agent-recovery.test.ts
- `PI_REVIEW_MODE` **required** — test/workflow-agent-recovery.test.ts
- `PI_REVIEW_RECOVERY_EFFECTS` **required** — test/fixtures/workflow-review-crash-worker.ts
- `PI_REVIEW_RECOVERY_SCENARIO` (has default) — test/fixtures/workflow-review-crash-worker.ts
- `PI_REVIEW_RECOVERY_WORKSPACE` **required** — test/fixtures/workflow-review-crash-worker.ts
- `PI_TASK_ID` **required** — test/fixtures/external-wake-crash-worker.ts
- `PI_VERIFY_BOUNDARY` (has default) — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_DB` **required** — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_HOST_COMMAND` **required** — test/fixtures/workflow-verification-host-worker.ts
- `PI_VERIFY_HOST_DB` **required** — test/fixtures/workflow-verification-host-worker.ts
- `PI_VERIFY_HOST_MARKERS` **required** — test/fixtures/workflow-verification-host-worker.ts
- `PI_VERIFY_HOST_MODE` **required** — test/fixtures/workflow-verification-host-worker.ts
- `PI_VERIFY_HOST_SAFETY` **required** — test/fixtures/workflow-verification-host-worker.ts
- `PI_VERIFY_HOST_WORKTREE` **required** — test/fixtures/workflow-verification-host-worker.ts
- `PI_VERIFY_ID` (has default) — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_MARKERS` **required** — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_MODE` **required** — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_ROOT` **required** — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_RUN_ID` (has default) — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_SAFETY` **required** — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_SCENARIO` (has default) — test/fixtures/workflow-verification-crash-worker.ts
- `PI_VERIFY_VARIANT` (has default) — test/fixtures/workflow-verification-crash-worker.ts
- `PI_WAKE_AT` **required** — test/fixtures/workflow-interpreter-crash-worker.ts
- `PI_WORKFLOW_ID` **required** — test/fixtures/workflow-interpreter-crash-worker.ts
- `USERPROFILE` **required** — test/app.test.ts
- `VERIFICATION_MARKER` **required** — test/workflow-verification.test.ts

## Config Files

- `tsconfig.json`
