# Libraries

> **Navigation aid.** Library inventory extracted via AST. Read the source files listed here before modifying exported functions.

**119 library files** across 4 modules

## Server (57 files)

- `src/server/projection.ts` — projectEntry, projectLive, usageCost, projectStats, plainText, snippet, …
- `src/server/push.ts` — generateVapidKeys, encryptPayload, vapidAuthorization, sendPush, validateSubscription, PushStore, …
- `src/server/when.ts` — knownZone, zonedMoment, nextClockTime, nextRepeat, parseWhen, describeRepeat, …
- `src/server/auth.ts` — parseCookies, origin, quickTunnelHost, setAuthCookie, clearAuthCookie, Auth, …
- `src/server/changes.ts` — parseStatus, parseNumstat, changesIn, diffOf, revertFile, ChangeKind, …
- `src/server/files.ts` — listFiles, viewFile, mentionedPaths, FileLists, FileList, FileListing, …
- `src/server/http/io.ts` — send, json, readBody, readJson, escapeHtml, conversationId, …
- `src/server/prompts.ts` — loadPromptTemplates, parseArguments, fillTemplate, expandPromptTemplate, loadSkillCommands, expandSkillCommand, …
- `src/server/browser/page.ts` — wait, BrowserPage, BrowserState, LogEntry, Frame, Target, …
- `src/server/config.ts` — dataDir, ConfigStore, User, ModelChoice, Role, ApprovalRule, …
- `src/server/http/assets.ts` — sniffImage, serveApp, serveFile, serveImage, WEB, VENDOR, …
- `src/server/worktrees.ts` — inRepository, createWorktree, inWorktree, sourceFolders, removeWorktree, discardWorktree, …
- `src/server/browser/viewport.ts` — viewportFrom, presetOf, clamp, ViewportPreset, Viewport, VIEWPORTS
- `src/server/room.ts` — Room, Client, PeekSummary, TypingPlace, Person, ROOM_DOCS
- `src/server/host.ts` — Approvals, ApprovalRequest, PocketHost, ApprovalAnswer, ExtensionModule
- `src/server/reload.ts` — prepareDropInFolder, watchTree, ExtensionLoader, ExtensionInfo, ModuleSource
- `src/server/resend.ts` — userContent, resendRequest, resendContent, Resend, ResendTask
- `src/server/titles.ts` — wantsTitle, titleModel, cleanTitle, writeTitle, TITLE_PROMPT
- `src/server/app.ts` — PocketApp, OpenOptions, AccessInfo, MAX_PEEKS
- `src/server/browser/cdp.ts` — BrowserError, Connection, Chromium, Json
- `src/server/lancet.ts` — LancetGuard, GuardStatus, ToolJudgement, GateDecision
- `src/server/omarchy.ts` — parseColors, wallpaperFile, desktopTheme, DesktopTheme
- `src/server/requests.ts` — requestPerson, clientKey, ownRequest, requestFor
- `src/server/schedules.ts` — Schedules, ScheduleRequest, SCHEDULED_PREFIX, SCHEDULES_EXTENSION
- `src/server/browser/discovery.ts` — snapOf, profileFolder, findBrowser
- _…and 32 more files_

## Web (39 files)

- `web/ui.js` — Thumb, markdown, Markdown, openFile, copyText, formatTokens, …
- `web/store.js` — uid, sessionUnread, markChatRead, typing, api, notify, …
- `web/theme.js` — setPrefs, togglePin, paletteOf, themeVars, apply, chooseTheme, …
- `web/peeks.js` — markSeen, peekTiles, peeksWanted, togglePeeks, PeeksButton, PeekHost, …
- `web/browser.js` — setBrowserOpen, openInBrowser, reportNavigation, displayUrl, browserAvailable, toggleBrowser, …
- `web/commands.js` — loadTemplates, parseCommand, parseTemplate, suggestCommands, planAvailable, schedulesAvailable
- `web/sessions.js` — workspaceOrder, setArchived, SessionList, Rail, ResizeHandle, Drawer
- `web/chat.js` — PeopleButton, TypingLine, jumpToEntry, ChatSheet, PeoplePanel
- `web/files.js` — loadFiles, mentionAt, mentionText, suggestFiles
- `web/avatar.js` — personColor, initials, Avatar
- `web/history.js` — sentHistory, remember, searchHistory
- `web/notify.js` — registerWorker, updateBadge, NotificationsSheet
- `web/sheets/viewers.js` — ArtifactsSheet, ArtifactViewer, ImageViewer
- `web/browser-panel.js` — BrowserPanel, BrowserButton
- `web/share.js` — takeShare, ShareSheet
- `web/sheets/people.js` — InviteSheet, PeopleSheet
- `web/sheets/providers.js` — ProvidersSheet, AuthDialog
- `web/calls.js` — describeCall
- `web/composer.js` — Composer
- `web/home.js` — Splash
- `web/launcher.js` — Launcher
- `web/sheets/appearance.js` — AppearanceSheet
- `web/sheets/changes.js` — ChangesSheet
- `web/sheets/extensions.js` — ExtensionsSheet
- `web/sheets/file.js` — FileSheet
- _…and 14 more files_

## Workflow-runtime (20 files)

- `packages/workflow-runtime/core/index.ts` — defineWorkflow, chooseTerminalInTransaction, createWorkflowRuntimeKernel, NonRetryableError, UnknownOperationError, WorkflowEventTimeoutError, …
- `packages/workflow-runtime/agents/profile.ts` — workflowAgentResultSchemaFingerprint, workflowAgentResultExtensionName, resolveWorkflowAgentConfig, resolveWorkflowAgentAuthority, workflowAgentThreadKey, workflowAgentProviderSessionId, …
- `packages/workflow-runtime/interpreter.ts` — workflow, NonRetryableError, WorkflowEngine, StepExecution, StepRecovery, WorkflowDoOptions, …
- `packages/workflow-runtime/agents/runner.ts` — workflowAgentSectionViewsMatch, workflowAgentNativeSelectionMatches, workflowAgentProfileSnapshot, resolveWorkflowAgentReviewProfile, workflowAgentRunnerIntentMatches, createWorkflowAgentTurnBinder, …
- `packages/workflow-runtime/agents/records.ts` — WorkflowAgentAdmissionError, AgentThreadStatus, AgentTurnStatus, AgentTurnResultSchema, AgentStructuredResultCandidate, AgentTurnRecord, …
- `packages/workflow-runtime/agents/host.ts` — createWorkflowAgentRuntime, CreateWorkflowAgentRuntimeOptions, WorkflowAgentDocumentWriter, WorkflowAgentHostSetup, WorkflowAgentHost, WorkflowAgentHostPreparation, …
- `packages/workflow-runtime/review/contract.ts` — createReviewBinding, assertReviewBindingUnchanged, validateReviewDecision, createReviewResult, validateReviewResult, ReviewRequestConflict
- `packages/workflow-runtime/agents/structured-result.ts` — workflowAgentTurnResultSchema, createWorkflowAgentStructuredResultExtensions, createWorkflowAgentResultRegistry, settleWorkflowAgentTurnInTransaction, WorkflowAgentSettlement
- `packages/workflow-runtime/review/review.ts` — createReviewReviewerIdentity, review, ReviewAdmissionError, ReviewAdapters, WORKFLOW_REVIEW_RESULT
- `packages/workflow-runtime/verification/manifest.ts` — validateVerificationManifest, createVerificationBinding, assertVerificationBindingUnchanged, VerificationRequestConflict, ValidateVerificationManifestOptions
- `packages/workflow-runtime/verification/command.ts` — createVerificationCommandAdapter, VerificationCommandAdapterOptions, RunVerificationCheckInput, VerificationCommandAdapter
- `packages/workflow-runtime/agents/recovery.ts` — canRecoverDefinitelyNotSubmittedTurn, recoverAgentRunnerTasks, WorkflowAgentRecoveryAuthorityCheck
- `packages/workflow-runtime/agents/section-registry.ts` — workflowAgentSectionViewName, workflowAgentSectionSourceName, createWorkflowAgentSectionRegistry
- `packages/workflow-runtime/core/identity.ts` — canonicalInput, freezeJson, idempotencyKey
- `packages/workflow-runtime/core/run-control.ts` — observeStopCall, StopFailures, RunControl
- `packages/workflow-runtime/verification/workspace.ts` — createGitWorkspaceAdapter, WorkspaceSnapshotError, GitWorkspaceAdapterOptions
- `packages/workflow-runtime/timer-host.ts` — WorkflowTimerHost, WorkflowTimerOptions
- `packages/workflow-runtime/verification/verify.ts` — verify, VerificationAdapters
- `packages/workflow-runtime/invocation.ts` — InvocationCoordinator
- `packages/workflow-runtime/verification/result.ts` — aggregateVerificationResult

## Launcher (3 files)

- `src/launcher/term.ts` — visibleLength, columns, cut, onKeys, restoreTerminal, choose, …
- `src/launcher/access.ts` — isAccessMode, lanAddresses, tailscaleAddress, bindHost, findCloudflared, cloudflaredSource, …
- `src/launcher/options.ts` — parseArgs, fail, Options

---
_Back to [overview.md](./overview.md)_