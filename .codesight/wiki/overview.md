# pi-pocket — Overview

> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.

**pi-pocket** is a typescript project built with raw-http, organized as a monorepo.

## Scale

5 API routes · 119 library files · 2 middleware layers · 64 environment variables

## Subsystems

- **[Browser.test](./browser.test.md)** — 3 routes — touches: auth
- **[Signin](./signin.md)** — 1 routes — touches: auth
- **[Sw](./sw.md)** — 1 routes — touches: cache

**Libraries:** 119 files — see [libraries.md](./libraries.md)

## High-Impact Files

Changes to these files have the widest blast radius across the codebase:

- `web/ui.js` — imported by **31** files
- `src/server/docs.ts` — imported by **29** files
- `src/server/errors.ts` — imported by **26** files
- `src/server/app.ts` — imported by **25** files
- `web/store.js` — imported by **25** files
- `src/server/config.ts` — imported by **20** files

## Required Environment Variables

- `AUTHORITY_WORKER_DB` — `test/workflow-agent-authority.test.ts`
- `AUTHORITY_WORKER_EFFECTS` — `test/workflow-agent-authority.test.ts`
- `AUTHORITY_WORKER_MODE` — `test/workflow-agent-authority.test.ts`
- `HOME` — `test/app.test.ts`
- `NO_COLOR` — `src/launcher/term.ts`
- `PI_AGENT_BOUNDARY` — `test/fixtures/workflow-agent-crash-worker.ts`
- `PI_AGENT_DB` — `test/fixtures/workflow-agent-crash-worker.ts`
- `PI_AGENT_MARKERS` — `test/fixtures/workflow-agent-crash-worker.ts`
- `PI_AGENT_MODE` — `test/fixtures/workflow-agent-crash-worker.ts`
- `PI_CODING_AGENT_DIR` — `test/app.test.ts`
- `PI_CORE_MODE` — `test/fixtures/workflow-runtime-core-crash-worker.ts`
- `PI_DB_PATH` — `test/fixtures/external-wake-crash-worker.ts`
- _...31 more_

---
_Back to [index.md](./index.md) · Generated 2026-10-12_