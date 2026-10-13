# pi-pocket — AI Context Map

> **Stack:** raw-http | none | unknown | typescript
> **Monorepo:**

> 5 routes (5 inferred) | 0 models | 0 components | 84 lib files | 62 env vars | 1 middleware | 60% test coverage
> **Token savings:** this file is ~5,800 tokens. Without it, AI exploration would cost ~41,900 tokens. **Saves ~36,000 tokens per conversation.**
> **Last scanned:** 2026-10-13 20:34 — re-run after significant changes

---

# Routes

- `ALL` `/never` [auth] `[inferred]` ✓
- `ALL` `/hang` [auth] `[inferred]` ✓
- `ALL` `/two` [auth] `[inferred]` ✓
- `ALL` `/join/` [auth] `[inferred]`
- `ALL` `/share` [cache] `[inferred]`

---

# Libraries

- `packages/workflow-runtime/interpreter.ts`
  - function workflow: (name, run, O>, options) => WorkflowDefinition<I, O>
  - class NonRetryableError
  - class WorkflowEngine
  - type StepExecution
  - type StepRecovery
  - type WorkflowDoOptions
  - _...6 more_
- `packages/workflow-runtime/invocation.ts` — class InvocationCoordinator
- `packages/workflow-runtime/timer-host.ts` — class WorkflowTimerHost, type WorkflowTimerOptions
- `src/launcher/access.ts`
  - function isAccessMode: (value) => value is AccessMode
  - function lanAddresses: () => string[]
  - function tailscaleAddress: () => string | undefined
  - function bindHost: (mode) => string
  - function findCloudflared: (dataDir) => string | undefined
  - function cloudflaredSource: () => void
  - _...6 more_
- `src/launcher/options.ts`
  - function parseArgs: (argv) => Options
  - function fail: (message) => never
  - interface Options
- `src/launcher/term.ts`
  - function visibleLength: (text) => number
  - function columns: () => number
  - function cut: (text, width) => string
  - function onKeys: (next) => KeyListener | undefined
  - function restoreTerminal: () => void
  - function choose: (title, choices, initial) => Promise<number | undefined>
  - _...12 more_
- `src/server/alerts.ts` — class Alerts
- `src/server/app.ts`
  - class PocketApp
  - interface OpenOptions
  - type AccessInfo
  - const MAX_PEEKS
- `src/server/attribution.ts` — class Attribution, type Missing
- `src/server/auth.ts`
  - function parseCookies: (header) => Record<string, string>
  - function origin: (request) => string
  - function quickTunnelHost: (request) => string | undefined
  - function setAuthCookie: (request, response, token) => void
  - function clearAuthCookie: (response) => void
  - class Auth
  - _...2 more_
- `src/server/browser.ts`
  - class Browsers
  - interface BrowsersOptions
  - type OpenOptions
- `src/server/changes.ts`
  - function parseStatus: (output) => void
  - function parseNumstat: (output) => Map<string,
  - function changesIn: (cwd, entries, onlyHere) => Promise<Changes>
  - function diffOf: (cwd, path, onlyHere) => Promise<string>
  - function revertFile: (cwd, path, onlyHere) => Promise<ChangeKind>
  - type ChangeKind
  - _...2 more_
- `src/server/collab.ts`
  - function addActivity: (chat, who, "id" | "name">, text, now) => void
  - class Collab
  - const REACTIONS
- `src/server/commands.ts`
  - class Commands
  - interface SubmitRequest
  - type Attachment
- `src/server/config.ts`
  - function dataDir: () => string
  - class ConfigStore
  - interface User
  - interface ModelChoice
  - type Role
  - type ApprovalRule
  - _...1 more_
- `src/server/errors.ts`
  - function optionalText: (value, name) => string | undefined
  - function describe: (error) => string
  - class HttpError
- `src/server/export.ts`
  - function fence: (text, language) => string
  - function transcriptMarkdown: (input) => string
  - type ExportInput
- `src/server/files.ts`
  - function listFiles: (cwd, max) => Promise<FileList>
  - function viewFile: (file) => Promise<FileView>
  - function mentionedPaths: (text) => void
  - class FileLists
  - type FileList
  - type FileListing
  - _...2 more_
- `src/server/git.ts`
  - function git: (cwd, args, options) => Promise<string>
  - class GitError
  - type GitOptions
- `src/server/goals.ts`
  - class Goals
  - const GOALS_EXTENSION
  - const GOAL_PREFIX
- `src/server/host.ts`
  - class Approvals
  - interface ApprovalRequest
  - interface PocketHost
  - type ApprovalAnswer
  - type ExtensionModule
- `src/server/http.ts` — function createHandler: (options) => void
- `src/server/lancet.ts`
  - class LancetGuard
  - interface GuardStatus
  - interface ToolJudgement
  - type GateDecision
- `src/server/lock.ts` — function takeLock: (lockFile) => void
- `src/server/models.ts`
  - function modelList: (models) => ModelSummary[]
  - function resolveModel: (models, spec) => ModelRef
  - function agentInfo: (models, agent, defaultCwd) => void
- `src/server/net.ts` — function configureHttp: (idleTimeoutMs, httpProxy?) => void
- `src/server/omarchy.ts`
  - function parseColors: (toml) => Record<string, string>
  - function wallpaperFile: (home) => void
  - function desktopTheme: (home) => void
  - type DesktopTheme
- `src/server/paths.ts`
  - function expandHome: (path) => string
  - function homePath: (path) => string
  - function displayPath: (path, cwd) => string
- `src/server/projection.ts`
  - function projectEntry: (entry, full) => ClientEntry | undefined
  - function projectLive: (live) => ClientLive
  - function usageCost: (usage) => number
  - function projectStats: (usage, entries) => ClientStats
  - function plainText: (markdown) => string
  - function snippet: (text, max) => string
  - _...9 more_
- `src/server/prompts.ts`
  - function loadPromptTemplates: (cwd, agentDir, paths) => PromptTemplate[]
  - function parseArguments: (text) => string[]
  - function fillTemplate: (content, args) => string
  - function expandPromptTemplate: (text, templates) => string | undefined
  - function loadSkillCommands: (cwd, agentDir, paths) => SkillCommand[]
  - function expandSkillCommand: (text, skills) => string | undefined
  - _...2 more_
- `src/server/providers.ts` — class Providers
- `src/server/push.ts`
  - function generateVapidKeys: () => VapidKeys
  - function encryptPayload: (plaintext, keys, options) => Buffer
  - function vapidAuthorization: (endpoint, vapid, subject, now) => void
  - function sendPush: (subscription, message, vapid, options) => Promise<number>
  - function validateSubscription: (subscription) => PushSubscriptionJson
  - class PushStore
  - _...9 more_
- `src/server/reload.ts`
  - function prepareDropInFolder: (directory, appModules) => void
  - function watchTree: (directory, onChange) => void
  - class ExtensionLoader
  - interface ExtensionInfo
  - type ModuleSource
- `src/server/requests.ts`
  - function requestPerson: (requestId) => void
  - function clientKey
  - function ownRequest
  - function requestFor
- `src/server/resend.ts`
  - function userContent: (model) => void
  - function resendRequest
  - function resendContent
  - type Resend
  - const ResendTask
- `src/server/room.ts`
  - class Room
  - interface Client
  - type PeekSummary
  - type TypingPlace
  - type Person
  - const ROOM_DOCS
- `src/server/running.ts`
  - function runningNow: (app, user) => Promise<RunningSession[]>
  - type RunningTask
  - type RunningSession
- `src/server/schedules.ts`
  - class Schedules
  - type ScheduleRequest
  - const SCHEDULED_PREFIX
  - const SCHEDULES_EXTENSION
- `src/server/shell.ts` — class Shell, type ShellInput
- `src/server/spend.ts`
  - function dollars
  - class Spend
  - type SpendSummary
- `src/server/titles.ts`
  - function wantsTitle: (text) => boolean
  - function titleModel: (models, current) => Model<Api>
  - function cleanTitle: (reply) => string | undefined
  - function writeTitle: (app, id, text, provisional) => Promise<void>
  - const TITLE_PROMPT
- `src/server/transcripts.ts` — class Transcripts
- `src/server/when.ts`
  - function knownZone: (zone) => boolean
  - function zonedMoment: (year, month, day, hour, minute, zone) => number
  - function nextClockTime: (after, at, days, zone) => number
  - function nextRepeat: (repeat, after, zone) => number
  - function parseWhen: (text, now, zone) => When &
  - function describeRepeat: (repeat) => string
  - _...4 more_
- `src/server/workspace.ts` — class Workspace
- `src/server/worktrees.ts`
  - function inRepository: (cwd) => boolean
  - function createWorktree: (cwd, folder, label) => Promise<
  - function inWorktree: (worktree, cwd) => boolean
  - function sourceFolders: (worktree) => Promise<(cwd: string) => string>
  - function removeWorktree: (worktree, force) => Promise<void>
  - function discardWorktree: (worktree) => Promise<void>
  - _...1 more_
- `web/avatar.js`
  - function personColor: (id) => void
  - function initials: (name) => void
  - function Avatar: ({...}, size) => void
- `web/browser-panel.js` — function BrowserPanel: () => void, function BrowserButton: () => void
- `web/browser.js`
  - function setBrowserOpen: (open) => void
  - function openInBrowser: (url) => void
  - function reportNavigation: (result) => void
  - function displayUrl: (url) => void
  - function browserAvailable
  - function toggleBrowser
  - _...1 more_
- `web/calls.js` — function describeCall: (call) => void
- `web/chat.js`
  - function PeopleButton: () => void
  - function TypingLine: ({...}) => void
  - function jumpToEntry: (entryId) => void
  - function ChatSheet: () => void
  - function PeoplePanel: ({...}) => void
- `web/commands.js`
  - function loadTemplates: () => void
  - function parseCommand: (text) => void
  - function parseTemplate: (text) => void
  - function suggestCommands: (text) => void
  - function planAvailable
  - function schedulesAvailable
- `web/composer.js` — function Composer: () => void
- `web/files.js`
  - function loadFiles: ({...}) => void
  - function mentionAt: (text, caret) => void
  - function mentionText: (path) => void
  - function suggestFiles: (query) => void
- `web/history.js`
  - function sentHistory: () => void
  - function remember: (text) => void
  - function searchHistory: (query, limit) => void
- `web/home.js` — function Splash: () => void
- `web/launcher.js` — function Launcher: ({...}) => void
- `web/notify.js`
  - function registerWorker: () => void
  - function updateBadge: (state) => void
  - function NotificationsSheet: () => void
- `web/peeks.js`
  - function markSeen: (id) => void
  - function peekTiles: (state) => void
  - function peeksWanted: (state) => void
  - function togglePeeks: () => void
  - function PeeksButton: () => void
  - function PeekHost: ({...}, tiles, replaced }) => void
  - _...2 more_
- `web/sessions.js`
  - function workspaceOrder: (state) => void
  - function setArchived: (ids, archived, {...}) => void
  - function SessionList: ({...}) => void
  - function Rail: () => void
  - function ResizeHandle: () => void
  - function Drawer: () => void
- `web/share.js` — function takeShare: (id) => void, function ShareSheet: ({...}) => void
- `web/sheets/appearance.js` — function AppearanceSheet: () => void
- `web/sheets/changes.js` — function ChangesSheet: () => void
- `web/sheets/extensions.js` — function ExtensionsSheet: () => void
- `web/sheets/file.js` — function FileSheet: ({...}, line }) => void
- `web/sheets/find.js` — function FindSheet: ({...}) => void
- `web/sheets/folder.js` — function CwdSheet: ({...}) => void
- `web/sheets/menu.js` — function MenuSheet: () => void
- `web/sheets/message.js` — function MessageSheet: ({...}) => void
- `web/sheets/model.js` — function ModelPicker: () => void
- `web/sheets/people.js` — function InviteSheet: ({...}) => void, function PeopleSheet: () => void
- `web/sheets/providers.js` — function ProvidersSheet: () => void, function AuthDialog: () => void
- `web/sheets/running.js` — function RunningSheet: () => void
- `web/sheets/schedules.js` — function SchedulesSheet: () => void
- `web/sheets/shortcuts.js` — function ShortcutsSheet: () => void
- `web/sheets/spend.js` — function SpendSheet: () => void
- `web/sheets/text.js` — function TextSheet: ({...}, label, hint, initial, placeholder, submit, multiline, button, }) => void
- `web/sheets/viewers.js`
  - function ArtifactsSheet: () => void
  - function ArtifactViewer: ({...}, version }) => void
  - function ImageViewer: ({...}, alt }) => void
- `web/sheets/worktree.js` — function WorktreeSheet: () => void
- `web/sheets.js` — function Sheets: () => void
- `web/signin.js` — function SignIn: () => void
- `web/store.js`
  - function uid: () => void
  - function sessionUnread: (session, state) => void
  - function markChatRead: () => void
  - function typing: (where) => void
  - function api: (path, body, options) => void
  - function notify: (level, message, action) => void
  - _...22 more_
- `web/theme.js`
  - function setPrefs: (patch) => void
  - function togglePin: (id) => void
  - function paletteOf: (id) => void
  - function themeVars: (palette) => void
  - function apply: () => void
  - function chooseTheme: (id, event) => void
  - _...6 more_
- `web/transcript.js` — function Transcript: () => void
- `web/ui.js`
  - function Thumb: ({...}, alt) => void
  - function markdown: (text, conversationId) => void
  - function Markdown: ({...}, class, cache) => void
  - function openFile: (path) => void
  - function copyText: (text) => void
  - function formatTokens: (count) => void
  - _...28 more_

---

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

---

# Middleware

## auth
- auth — `src/server/auth.ts`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `web/ui.js` — imported by **31** files
- `web/store.js` — imported by **25** files
- `src/server/docs.ts` — imported by **23** files
- `src/server/app.ts` — imported by **20** files
- `src/server/errors.ts` — imported by **17** files
- `src/server/config.ts` — imported by **15** files
- `src/server/projection.ts` — imported by **12** files
- `src/server/http.ts` — imported by **12** files
- `src/server/room.ts` — imported by **6** files
- `src/server/requests.ts` — imported by **6** files
- `web/theme.js` — imported by **6** files
- `packages/workflow-runtime/timer-host.ts` — imported by **5** files
- `src/server/host.ts` — imported by **5** files
- `src/server/entry-format.ts` — imported by **5** files
- `src/server/when.ts` — imported by **5** files
- `web/browser.js` — imported by **5** files
- `web/chat.js` — imported by **5** files
- `web/sessions.js` — imported by **5** files
- `web/avatar.js` — imported by **5** files
- `src/server/browser.ts` — imported by **4** files

## Import Map (who imports what)

- `web/ui.js` ← `web/app.js`, `web/avatar.js`, `web/browser-panel.js`, `web/chat.js`, `web/commands.js` +26 more
- `web/store.js` ← `web/browser-panel.js`, `web/browser.js`, `web/commands.js`, `web/files.js`, `web/home.js` +20 more
- `src/server/docs.ts` ← `src/server/alerts.ts`, `src/server/attribution.ts`, `src/server/goals.ts`, `src/server/running.ts`, `src/server/schedules.ts` +18 more
- `src/server/app.ts` ← `src/server/alerts.ts`, `src/server/attribution.ts`, `src/server/collab.ts`, `src/server/commands.ts`, `src/server/goals.ts` +15 more
- `src/server/errors.ts` ← `src/server/alerts.ts`, `src/server/app.ts`, `src/server/attribution.ts`, `src/server/browser.ts`, `src/server/collab.ts` +12 more
- `src/server/config.ts` ← `src/server/app.ts`, `src/server/auth.ts`, `src/server/collab.ts`, `src/server/commands.ts`, `src/server/main.ts` +10 more
- `src/server/projection.ts` ← `src/server/alerts.ts`, `src/server/app.ts`, `src/server/changes.ts`, `src/server/collab.ts`, `src/server/commands.ts` +7 more
- `src/server/http.ts` ← `src/server/main.ts`, `src/server/main.ts`, `test/app.test.ts`, `test/app.test.ts`, `test/app.test.ts` +7 more
- `src/server/room.ts` ← `src/server/app.ts`, `src/server/attribution.ts`, `src/server/collab.ts`, `test/helpers.ts`, `test/peeks-ui.test.ts` +1 more
- `src/server/requests.ts` ← `src/server/attribution.ts`, `src/server/collab.ts`, `src/server/commands.ts`, `src/server/resend.ts`, `src/server/schedules.ts` +1 more

---

# Test Coverage

> **60%** of routes and models are covered by tests
> 55 test files found

## Covered Routes

- ALL:/never
- ALL:/hang
- ALL:/two

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_