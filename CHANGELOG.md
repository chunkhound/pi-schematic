# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-21

### Added

- **Model Groups manager** — added `/model-groups` with durable project/global JSON persistence, boot validation, CRUD TUI flows, per-model thinking levels, and operator notifications for invalid configs or unavailable model refs.
- **Model Groups spawn routing** — `spawn` can route children through an optional exact Model Group name with names-only prompt guidance, `#group` autocomplete sugar that shows model/thinking details, authenticated random entry selection, thinking inheritance/clamping, and routed/fallback result identity lines.
- **Frontmatter-driven model selection** — skills and prompts can declare `model`, `model-group`, and `thinking` frontmatter to control model routing and reasoning level per invocation. Resolved during idle input and visibly blocked while streaming; an explicit `model` overrides `model-group`; multi-slash model IDs are supported; invalid values block command expansion with operator notifications, and invalid thinking warns while a valid model still applies.
- **Handoff `discardPages`** — the handoff tool accepts `discardPages` to prune stale notebook pages, staged transactionally via a sequential epoch and committed only after compaction succeeds; interrupted or failed discards retain pages. Notebook rehydration is branch-scoped with generation markers and an epoch watermark, ignores future-format entries, and handoff now verifies notebook completeness first and reports completion truthfully after the discard commit.

### Changed

- **Model Groups editing** — searchable complete-result and ten-visible-row add-model pickers, plus a prompt-free inline group-name editor.
- **Spawn lifecycle** — migrated child spawning to Pi's public selected-model and child-owned runtime APIs, added `max` thinking support, and disposed every created child session exactly once across completion, failure, abort, and reset races. Pi 0.84.1 and Node 22.19.0 are now the documented minimums; parent-only transient provider/auth state fails explicitly without model fallback.

### Fixed

- **Model Groups add-model navigation** — now uses Pi's key matcher for Escape/left-arrow handling and filters provider/model choices to authenticated models.

## [0.4.0] - 2026-07-22

### Breaking Changes

- **Ledger renamed to notebook** — tools are now `notebook_write`, `notebook_read`, and `notebook_index`; `/ledger` is `/notebook`. Legacy `ledger-entry` session data still rehydrates so existing sessions keep their pages.
- **Handoff briefs no longer embed notebook bodies** — referenced pages are fetched on demand via `notebook_read`. The brief carries only the task and primer; the notebook remains the long-term grounding store.
- **Handoff eligibility gate** — handoff rejects empty briefs, sessions under ~30k tokens, or missing usage data so compaction cannot run without a real brief and a meaningful context load.
- **Human-set notebook topics are authoritative** — the agent cannot override a topic the user set via `/notebook` or the topic UI.

### Added

- **Readonly mode** — `/readonly`, Ctrl+Shift+R, and `--readonly` toggle a session-persisted read-only posture. Write/edit are blocked; bash is classified and limited (allowlist / temp-only writes), with OS sandboxing on macOS (`sandbox-exec`) and Linux (`bwrap`) when available. Spawned children inherit the posture (no write/edit; guarded bash). Status shows 🔒 with gentle nudges. Handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary; readonly resumes after compaction.
- **Notebook topics** — `notebook_topic_set` and `/notebook <topic>` set the active semantic frame (🧭 in the status bar). Topics clear after handoff so the next context assigns a fresh one. Topic-change boundary hints integrate with the watchdog.
- **Readonly frontmatter on skills and prompts** — `readonly: true` defers enabling readonly when that skill or prompt is invoked.

### Changed

- **Spawn tool inheritance** — child agents inherit active registered parent tools executable in the child session, including MCP/extension tools, while still excluding spawn and handoff and keeping child-local notebook tools.
- **Topic- and readonly-aware watchdog** — band-throttled primacy-zone nudges with copy that reflects the active topic and readonly state; warning widget at ≥70% context; malformed context percentages render as `ctx --%`.
- **Handoff lifecycle status** — richer TUI status (requested / required / in progress), generation guards, and rejection of overlapping handoff attempts.
- **Notebook overlay and indicators** — interactive `/notebook` overlay (renamed from `/ledger`) with subject-oriented page semantics; empty notebook count stays dim/discoverable rather than hidden without cue.

### Fixed

- **TUI-safe diagnostics** — removed stderr/console logging that corrupted pi's ANSI TUI rendering from the extension host process.
- **Headless UI guards** — `ui.notify` and readonly toggle no-op cleanly when no UI is attached instead of throwing.
- **Rehydration null-safety** — notebook and readonly session resume no longer crash on missing or partial persisted state.

## [0.3.0] - 2026-05-23

### Added

- **Interactive `/ledger` TUI overlay** — replaced the static notification popup with a full interactive overlay. Use arrow keys to navigate entries, press Enter to preview a selected entry body (truncated at 500 chars with `...`), and Escape to close. Empty state shows a discoverability hint.
- **Visual handoff indicator** — when `/handoff` is invoked, a live `🤝 Handoff in progress` badge appears in the TUI status bar. Clears automatically when compaction completes, or when the agent finishes a turn without calling the handoff tool.
- **Ledger tool TUI renderers** — `ledger_add` calls now render inline with a styled preview (`✓ Saved "entry-name": first line...`) in the conversation. Shows the full entry body when expanded.
- **Write-lock reentrancy detection** — nested calls to `saveLedgerEntry` now throw an explicit error instead of silently corrupting the serialization chain.

### Changed

- **Frame-based spawn scheduler** — replaced the microtask-per-event render model with a scheduler that batches expensive component work at ~30 FPS. High-frequency streaming events (50–100+/sec) accumulate state cheaply per-event; layout, cache invalidation, and TUI invalidates are deferred to the next frame tick. Eliminates UI jank during bursty LLM streaming in child sessions.
- **ESM module type** — added `"type": "module"` to `package.json` for compatibility with strict ESM projects.

### Fixed

- **Stray ANSI reset codes in spawn shell** — `truncateToWidth` no longer injects escape sequences that break background color styling in collapsed spawn renderer borders and padding.

## [0.2.0] - 2026-05-21

### Added

- **Microtask event batching** — rapid child session events are coalesced into a single parent invalidate per microtask boundary, preventing UI jank during bursty tool execution.
- **Epoch-based invalidation** — the spawn renderer uses epoch counters rather than pointer comparison to detect stale sessions, making ownership checks reliable across session resets.

## [0.1.0] - 2026-05-21

### Added

#### Context Management System Prompt

- **Automatic system-prompt injection** — the LLM receives a context management primer at session start, teaching it how and when to use spawn, ledger, and handoff. No configuration needed.
- **Live ledger listing in system prompt** — each session start injects the current ledger entries (name + first-line preview) so the agent always knows what stored knowledge is available without fetching blindly.

#### Spawn — Isolate Subtasks in Clean Child Contexts

- **`spawn` tool** — delegate isolated work to an in-memory child agent with its own clean context. The child inherits the parent's model, thinking level, working directory, and built-in tools. Only the condensed result is returned — no context pollution in the parent.
- **Parallel execution** — siblings run concurrently; the parent orchestrates and merges results. Tested for independent concurrent spawns producing correct results.
- **Child tool inheritance** — children receive ledger tools (add/get/list) and the parent's built-in tools, but never the spawn or handoff tools, preventing recursive nesting.
- **Ledger-aware child prompts** — child sessions are told what ledger entries exist so they can fetch knowledge on demand without the parent pre-loading bodies.
- **Child output truncation** — child results are limited to 2000 lines / 50KB to prevent runaway output from overwhelming the parent. Truncated results include an advisory message.
- **Explicit model-required error** — spawn fails immediately with a clear message when no model is configured, rather than with a cryptic runtime error.
- **No grandchildren** — children cannot spawn further children, preventing explosive branching.
- **Session lifecycle management** — children are properly cleaned up on completion, error, or parent session reset. Aborted children produce explicit `aborted` outcomes.
- **Signal-based cancellation** — spawn respects AbortSignal, allowing the parent to cancel a running child mid-flight.

#### Ledger — Sparse Continuity Cache

- **`ledger_add` tool** — save a named, compact continuity entry. Same-name writes overwrite (refinement). Writes are serialized via a process-local lock, preventing race conditions.
- **`ledger_get` tool** — retrieve a full entry body by name. Returns the current entry listing alongside the body. Reports "not found" gracefully with the complete entry list.
- **`ledger_list` tool** — list all entries with name and first-line preview. Returns empty-state placeholder when no entries exist.
- **Persistence across sessions** — ledger entries survive context resets, handoffs, and session restarts. On session start, the extension scans the session history newest-to-oldest and rehydrates the in-memory ledger from the latest epoch.
- **Ledger entry persistence via custom entries** — each `ledger_add` appends a versioned custom entry that survives compaction and session archival.
- **Epoch-based staleness** — child ledger tools reject access with a clear "invalidated by reset" error when the parent session has been reset, preventing stale writes.

#### Handoff — Deliberate Context Compaction

- **`handoff` tool** — triggers a deliberate compaction that replaces noisy context with a clean restart. The agent drafts a handoff brief preserving knowledge still missing from the ledger, then the session restarts with the brief at the top of context.
- **`/handoff` command** — user-facing shortcut that asks the agent to draft a handoff brief from a user direction, capture reusable state to the ledger, and call the handoff tool — all in one turn.
- **Rich compaction summary** — the handoff brief includes inlined ledger entries referenced in the task text (up to 3 entries, 4000 chars total), and a structured handoff primer explaining the continuation contract.
- **Clean slot handoff** — compaction replaces all pre-handoff messages with just the handoff summary. Full history remains in the session file for later reference.
- **Post-handoff auto-resume** — the agent receives a "Proceed." message after compaction completes, keeping momentum without manual re-prompt.
- **Enforcement tracking** — the `/handoff` command tracks whether the agent actually called the tool, preventing the command from being silently ignored. The watchdog cleans up stale enforcement state.

#### Primacy-Zone Watchdog

- **Advisory context-usage reminders** — a `context` hook injects a watchdog message before each LLM call when context usage exceeds 30%, 50%, or 70%. The message is advisory only — the agent decides whether to act.
- **Tiered nudge messages** — at 30-50% the agent is reminded of the primacy-zone heuristic; at 50-70% it's advised to consider handoff soon; at 70%+ it's warned that automatic compaction may trigger soon.
- **Hidden from user** — watchdog messages use a `custom` role with `display: false`, so they inform the LLM without cluttering the visible conversation.
- **`agent_end` tracking** — the watchdog records the latest context usage percent after each agent run, available for diagnostic use.

#### TUI and Status Indicators

- **Context usage in status bar** — a live `ctx 65%` indicator in the TUI status bar, color-coded: green (<30%), yellow (30-50%), orange (50-70%), red (≥70%).
- **Ledger count indicator** — a 📒 `N` badge in the status bar showing the number of ledger entries, hidden when the ledger is empty.
- **`/ledger` command** — shows all ledger entries with name, line count, and first-line preview in a TUI notification overlay.
- **Live spawn rendering** — child agent sessions render inside the parent's TUI with:
  - **Collapsed view**: model name, thinking level, real-time "last action" summary (thinking, tool execution, or assistant text preview), 5-line preview of last assistant output, and token/cost statistics.
  - **Expanded view**: full chat history with 4-space indent, streaming assistant messages, and tool execution components.
  - **Ownership lifecycle**: session ownership transfers from state to the renderer on first render, with proper cleanup on dispose, reset, or reattachment.
- **Render caching** — rendered output is cached by width/expanded/showImages, avoiding unnecessary re-renders when inputs haven't changed.
- **Graceful degradation** — the spawn renderer recovers from malformed events, missing tool definitions, subscribe failures, and null results without crashing the parent TUI.

#### Extension Wiring and Lifecycle

- **Single state object** — all primitives read/write through a single `AgenticodingState` instance, shared across extension hooks, tool executions, and the TUI renderer.
- **Session lifecycle hooks**:
  - `before_agent_start` — injects context primer and ledger listing.
  - `context` — injects watchdog reminders before LLM calls.
  - `session_start` — rehydrates ledger on continuation; resets state on `/new`.
  - `turn_end` — updates TUI indicators.
  - `agent_end` — records context usage and manages handoff enforcement.
  - `session_before_compact` — consumes pending handoff task as the compaction summary.
- **One-line install** — install via `pi install npm:pi-agenticoding` and disable platform compaction in settings.
- **Comprehensive test suite** — 50+ tests covering spawn execution and rendering (concurrency, cancellation, truncation, stale detection, ownership lifecycle, microtask batching), ledger tools (add/get/list, staleness, rehydration, empty states, prompt hints), handoff (tool, command, compaction), watchdog (nudge injection, enforcement), and extension lifecycle.
- **MIT licensed** — open-source permissive license.

[Unreleased]: https://github.com/agenticoding/pi-agenticoding/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/agenticoding/pi-agenticoding/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/agenticoding/pi-agenticoding/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/agenticoding/pi-agenticoding/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/agenticoding/pi-agenticoding/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/agenticoding/pi-agenticoding/releases/tag/v0.1.0
