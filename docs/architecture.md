# Architecture

pi-schematic is a Pi extension. It registers tools and hooks into the agent lifecycle, and keeps session state in one `SchematicState` instance.

## Lifecycle hooks

| Hook | Role |
|---|---|
| `before_agent_start` | Resolves deferred readonly frontmatter, refreshes Model Groups, then writes schematic's prompt sections, including a per-run current-date anchor (see **Prompt sections** and **Date anchor** under Behavioral notes) |
| `context` | Advisory watchdog reminders when context is elevated; a handoff nudge before every LLM call while a requested handoff is pending; readonly toggle nudges |
| `input` | Resolves model-selection frontmatter during idle input; blocks it during streaming; queues readonly resolution |
| `tool_call` | Refuses every `handoff` call after the first in a message of only `handoff` calls, `handoff` calls that share an assistant message with other tool calls (the other calls go to their own handlers), and `handoff` calls after a failed cut in the same run (an error result, the call does not run), before any readonly check; readonly then blocks write/edit/powershell/unguarded bash and blocks handoff unless a requested bypass is active |
| `session_start` | Reconstructs notebook pages/epoch/watermark from the active branch, rehydrates readonly state; loads and validates Model Groups, registers group autocomplete, reports config issues, and resets session state on `/new` |
| `session_tree` | Invalidates branch-local handoff work (a handoff staged on the abandoned branch is dropped), reconstructs notebook pages/epoch/watermark from the newly active branch, rehydrates readonly state, refreshes indicators |
| `message_end` | Records which `handoff` calls of an assistant message to refuse (every one when other tool calls share the message, all but the first otherwise), for `tool_call` |
| `turn_end` | Returns a staged handoff as one boundary of drafts and asks Pi to continue the run (see **Handoff**); also updates TUI indicators (context %, notebook count, topic, readonly) |
| `turn_start` | Confirms the staged handoff's cut on the branch and finalizes it (request, topic, notebook, readonly nudge), or fails it; a cut without its successor also aborts the run |
| `agent_end` | Records last context usage percent |
| `agent_settled` | Resolves a staged handoff first (confirms the cut, or fails it: a missing cut keeps the request pending, a cut without its successor clears it), re-arms a readonly nudge that a lost-successor abort spent, then counts one handoff enforcement attempt per settled run in which the eligible handoff nudge was sent and cancels a required handoff after `MAX_HANDOFF_ATTEMPTS`; clears the failed-cut refusal |

## State

```typescript
interface SchematicState {
  notebookPages: Map<string, string>
  activeNotebookTopic: string | null
  activeNotebookTopicSource: "human" | "agent" | null
  pendingTopicBoundaryHint: { from, to } | null
  readonlyEnabled: boolean
  modelGroups: {
    groups: ResolvedModelGroup[]
    validation: ModelGroupsBootValidation | null
  }
  epoch: number
  discardEpochWatermark: number
  lastContextPercent: number | null
  stagedHandoff: StagedHandoff | null
  handoffFailedInRun: boolean
  handoffRefusals: Map<string, string>
  pendingRequestedHandoff: { toolCalled, enforcementAttempts, eligibleNudgeDelivered, nextInstruction } | null
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  childSessionEpoch: number
}
```

## Behavioral notes

**Spawn** — Without a Model Group, the child inherits the parent's public model and explicit/default thinking level. An exact known group randomly selects a registry-resolved, authenticated entry. An entry-specific thinking level overrides explicit/inherited thinking and is clamped for the selected model. An unknown group uses the parent model and the explicit or inherited thinking level. The fallback shows in the spawn tool's TUI display, which renders `<group>? fallback → <provider>/<model> • <thinking>`, and in the result's details as `route.status: "unknown-fallback"`; the result text the model receives carries no marker.

A known empty group, or one with no usable authenticated entries, fails before child-session creation. The selected public model enters a child-owned runtime. Children also inherit cwd and active registered tools executable in that session, retain child-local notebook tools, cannot spawn or handoff, and inherit readonly posture.

Only a failure before the child session exists throws: model or route resolution, constraint validation, or the session factory rejecting. Once the session exists, a failure returns as an error result carrying the child's usage, zero when nothing ran, unless the thrown value cannot be turned into text (see the limitations below). This includes Pi's prompt pre-checks and a reset invalidation. A throw before the session exists carries no usage.

A child run that Pi resolves with stop reason `error` or `aborted` also returns an error result with the child's usage. `details.outcome` stays `error` or `aborted`. When the parent aborted, the outcome is `aborted` and the text reads `Child agent aborted: ` followed by the parent signal's reason, whatever stop reason the child ended with. A prompt failure thrown under an aborted parent signal also reads as aborted, unless a reset made the run stale; a reset gives `error`. Without a parent abort, stop reason `error` reads `Child agent failed: ` and Pi's `errorMessage`, or `no error message` when Pi set none. Stop reason `aborted` reads `Child agent aborted: ` and Pi's `errorMessage`, or `Child agent aborted.` when Pi set none. The child's last partial output follows after a blank line, if any.

An error result from a thrown failure shows the error's own message, or its text form when the thrown value is not an `Error`; an `Error` with an empty message shows its name. A reset reads `Spawn invalidated by reset.` A failure to dispose the child after a run that returned normally (a success, or an `error` or `aborted` completion) becomes the error result, with the dispose error's message as its text. After a thrown failure with a UI, the dispose failure goes to an error notice and the result keeps the primary error. After a thrown failure without a UI, or when that notice itself throws, the result text names both failures. A child abort that rejects goes to an error notice when there is a UI. Before the prompt, the abort error is the result text; during a reset, the text is `Spawn invalidated by reset; child abort failed.` A rejection from the parent-signal listener is not part of the result.

The UI shows an aborted result as aborted although it carries `isError`. Once `details.outcome` is final, the renderer prefers it over the child's stop reasons. The collapsed view of a retained child shows the child's stats, or `stats unavailable` when `statsUnavailable` is set, once the final details arrive; the running update carries no stats. The static result view shows no stats.

The result text is cut at the first 2000 lines, then at 51,200 bytes (50 KiB) on a UTF-8 character boundary. The marker writes the size as `50 KiB (51200 bytes)`, the form notebook uses, and advises spawning a new child with a narrower request. Error results are cut to the same limits with the same marker.

The spawn result returns the child's token and cost usage. It counts toward the parent's session totals and footer, not its context size. The usage is one sum over the child session's entries, built the way Pi sums its own session usage. If the entries cannot be read or summed, the spawn keeps the child's text, reports zero usage, omits `details.stats` and sets `statsUnavailable`; the underlying error is not part of the result. `details.stats` and `statsUnavailable` are never both set.

Spawn limitations:

- Usage values outside Pi's types are summed as Pi sums them. An unreadable or unsummable entry list counts the child as zero usage and sets `statsUnavailable`.
- A dispose failure after a run that returned normally (a success, or an `error` or `aborted` completion) replaces the result with the dispose error.
- A parent abort after the child's final answer returns the answer behind the abort line.
- A prompt failure under an aborted parent signal reads as aborted.
- Error texts show only the error's own message, except two combined texts: `Spawn invalidated by reset; child abort failed.` and, without a UI or when the cleanup notice throws, `Spawn failed and cleanup failed: <primary>; <cleanup>`.
- A thrown value that cannot be turned into text makes the spawn reject instead of resolving.
- A child abort that rejects after the prompt started is reported only as a notice, and only when there is a UI. Pi's own abort does not reject, so only another session implementation reaches this.

**Model Groups** — `/model-groups` manages versioned global and trusted-project JSON configuration. Project groups shadow same-named global groups. Configuration is loaded and validated against Pi's model registry into the `modelGroups` snapshot; only group names and their effective modalities reach the agent prompt (see **Prompt sections**). Routing uses the parent registry only to select configured/authenticated entries—the registry/auth objects are not passed into the child runtime.

**Prompt sections** — Schematic adds its prompt content as named Pi prompt sections rather than as a replacement system prompt. The `schematic` section holds the static context-management primer. `schematic_date` holds the current-date anchor (see **Date anchor**). `schematic_topic` frames the active notebook topic, or asks for one when none is set. `schematic_model_groups` lists group names and effective modalities when groups exist. `schematic_notebook` lists notebook pages when the notebook has any. Each section's text lives with its domain module; `index.ts` registers the sections in prompt order. When an earlier extension has already replaced the system prompt (a forced prompt, in Pi's terms), schematic still writes its sections, so the transcript stays current, and also appends them to that prompt, tagged the way Pi renders them, because Pi leaves sections out of the request for a replaced prompt. The primer stays in its own section, so a topic, Model Groups, or notebook change does not re-send it. A run whose system prompt another extension replaces loses that benefit.

**Date anchor** — The `schematic_date` prompt section holds a `## Current date` block (`time/format.ts`: ISO date, weekday, IANA zone, UTC offset, plus a resolve-relative-references directive). `index.ts` registers it directly after the `schematic` primer section and before the topic, Model Groups and notebook sections. It is rendered once per user prompt, in `before_agent_start`, and stays fixed for the whole run, so it is never per-turn. While the host zone stays fixed, the block is byte-stable within a calendar day; the UTC offset can also change once on a DST transition day. When the date is unchanged since the previous prompt, Pi adds no update for `schematic_date`. When it has changed, Pi appends a section-update message for `schematic_date` and leaves the leading system message unchanged. A run that crosses midnight keeps the prior day's anchor until the next prompt renders it again. Every field — date, weekday, and offset — comes from one `Intl.DateTimeFormat` call for the rendered zone, so the anchor never mixes a host-local day with another zone's offset; `formatCurrentDate(date, zone?)` accepts an explicit zone, which is what makes DST and day-boundary behaviour testable. Any zone Intl cannot render — a host with a bogus `TZ`, or an explicit argument — falls back to `UTC` rather than rendering `undefined` or throwing out of the hook; zone aliases (`US/Eastern`) are kept verbatim. `time/format.ts` is the single source of truth for the anchor text.

**Notebook** — Agent-curated named pages **scoped to the active session branch**, not a long-lived memory product. Stored as session custom entries so pages survive handoff and resume of the same work stream; `/new` (fresh session) clears them with the conversation. The visible pages and the committed generation epoch follow the branch the user navigated to: `/tree` reconstruction rehydrates from the newly active branch, so branches diverge without cross-contamination and returning to an earlier branch restores its state; writes land on the current branch's generation. Discard is transactional — survivors and both generation markers are written in the handoff's boundary pass together with the cut, and a declined boundary, or one that another extension drops whole, writes nothing; if another extension drops only the cut and keeps the notebook drafts, the discard markers persist and the notebook is rebuilt from them; if it keeps the cut and drops the notebook drafts, the pages stay, the completion notice counts them as kept, and a session with a UI also shows a warning naming them — and the epoch high-water mark is derived from the branch during reconstruction, so a failed attempt can never resurrect discarded pages after a restart. Active topic (`notebook_topic_set` or `/notebook <topic>`) frames spawn-vs-handoff preference; human-set topics are authoritative. Topic clears after a successful handoff. The interactive `/notebook` list pipes the selected page into an external pager (`$PI_PAGER`, else `$PAGER`, else an installed `less` except on Windows) while Pi's TUI is suspended; with no pager or a `cat` or `more` pager it shows a truncated inline preview, and either way the user returns to the list.

**Handoff** — Requires a real instruction and a meaningful context load (rejects empty instructions, very small sessions, or missing usage). Splits the next instruction (extension-carried, delivered verbatim; a human `/handoff` direction wins, otherwise the model supplies it) from preparation (model-owned: `context` plus notebook curation). `/handoff <direction>` queues the direction as the instruction; otherwise the model supplies `nextInstruction` to the handoff tool. The instruction is never started in the current context — that context is discarded at the cut.

The handoff tool only stages the request and ends its batch. At the end of that turn the cut and the successor are written in one `turn_end` pass:

1. a retain-none compaction with the fixed continuation frame and `details.handoffId`;
2. a `pi-schematic-handoff` custom message (`## Next instruction` verbatim + `## Context`);
3. a hidden `pi-schematic-handoff-note` message saying the system prompt is stale until the next run starts; a message typed during the run is a steer and does not refresh it.

The same run continues with the successor turn. If another extension's `turn_end` handler stops the continuation, the cut is persisted and the successor runs on the next prompt; a session with a UI (interactive or RPC) shows a warning, and a print-mode session gets no report. If the run is aborted after the cut, pi still starts the successor turn, so the handoff completes at `turn_start` (a session with a UI shows the completion notice), the successor turn ends with an empty aborted assistant message, and the persisted successor reaches the model on the next prompt. A `handoff` that shares an assistant message with other tool calls is refused and stages nothing; the other calls go to their own handlers, and the refusal tells the model to call `handoff` alone in its next message.

A handoff fails when its cut is missing at the next `turn_start` or when the run settles. Causes include an abort, another extension's `turn_end` replacing the entries, and invalid drafts. A missing cut never starts a run. The failure guidance is a `pi-schematic-handoff-failed` message that starts no run, and an interactive session also shows an error notification. A pending `/handoff` or required-handoff request stays pending, and the watchdog counts the run as one attempt when it sent the eligible handoff nudge, so a later run can retry until `MAX_HANDOFF_ATTEMPTS`; on the attempt that reaches that limit the watchdog cancels the request in the same settle, and the failure message says no required handoff remains pending. If the boundary had been submitted, the notebook is rebuilt from the branch, so a discard that another extension let through still applies. For the rest of that run every further `handoff` call is refused, so a run loses at most one cut; the refusal clears when the run settles or the handoff state is invalidated (`/tree`, `/new`).

A `handoff` call rejected at validation (an empty instruction, a session too small, missing usage) reports its reason only in the tool's error result, which carries the required-handoff guidance while such a request is pending. It queues no follow-up message, so nothing reaches a later successor.

Completion needs the cut, the successor with the same `handoffId` after it, and no later compaction on the branch. Another extension's `turn_end` handler can keep the cut but drop the successor draft. It can also append its own compaction after the cut, so pi projects only that latest compaction and hides the successor and note. Either way the handoff fails, and the context is already cut, so nothing is retried. The `pi-schematic-handoff-failed` message carries the instruction and starts no run. A session with a UI also shows an error notification. At `turn_start` the run is aborted, so the successor turn never reaches the model without its instruction. The pending request is cleared, the topic is cleared and readonly is re-announced as after a completed cut, so a later handoff is accepted. The aborted turn still runs the `context` hook, which spends the readonly nudge, so the nudge is re-armed when the run settles and reaches the next run. Schematic's `turn_end` handler spreads `event.entries` into its result; a handler that returns its own `entries` without them drops the earlier drafts.

Pi does not fire `session_before_compact` or `session_compact` for a handoff cut; other extensions find it as a `compaction` entry whose `details.handoffId` is set. Cuts written before the turn_end boundary carry a versioned payload in their compaction details and sent the successor as a user message after the cut. Schematic no longer reads that payload, so such a cut whose successor was never delivered is not repaired; the user prompts again.

Readonly is not frozen into the summary: a pending nudge re-announces the ON posture on the first post-handoff turn while a clean OFF-to-OFF handoff stays silent; `tool_call` enforcement stays live. Under readonly, handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary; readonly can resume after the cut. Notebook bodies are not inlined into the prompt; the next context in this work stream fetches pages by name.

Compaction replaces the prior transcript with the fixed continuation frame: the next turns see a small context again (quality), and providers start a new input prefix for billing/cache (the dropped history is no longer in that prefix). Spawn runs children in separate context so their token use does not permanently inflate the parent. This extension does not configure provider cache TTLs or breakpoints.

**Skill and prompt frontmatter** — Interactive TUI invocations resolve model selection during idle `input`; headless/RPC invocations ignore it. `readonly: true|false` alone is deferred to `before_agent_start`, where complete skill metadata is available.

- `model: <provider>/<model-id>` selects a configured, authenticated model. Only the first slash separates the provider, so model IDs may contain slashes.
- `model-group: <group-name>` routes through a configured Model Group. An explicit `model` takes precedence.
- `thinking: off|minimal|low|medium|high|xhigh|max` is capability-clamped for the selected or current model and overrides group thinking.

A failed model change visibly blocks command expansion and records no success entry. During streaming steer/follow-up, commands with model-selection frontmatter are visibly blocked without model or thinking mutation; commands without it continue. Invalid frontmatter is ignored with a TUI warning.

**Readonly** — Session-persisted research posture. Toggle via `/readonly`, Ctrl+Shift+R, or `--readonly`. Write/edit and powershell always blocked at the tool boundary (powershell is blocked outright; there is no PowerShell command classifier). Bash uses a two-layer guard, and its classifier blocks launching PowerShell or cmd through bash:

| Platform | Enforcement |
|---|---|
| **macOS** | OS sandbox via `sandbox-exec` (Seatbelt) — kernel denies file writes outside the OS temp dir; classifier is secondary |
| **Linux** | OS sandbox via `bwrap` when available — read-only root + writable temp; classifier is secondary. Without `bwrap`, classifier only |
| **Windows** | **No OS / syscall-level sandbox.** `canUseOsSandbox()` is always false. Only the shell-command **classifier** runs — best-effort pattern matching. Known gaps: interpreter one-liners (`node -e`, `python -c`, …), piped indirection (`xargs`, etc.). **Not true write protection.** |

Coding-agent guardrail on every OS — not a hardened security boundary. Strongest on macOS/Linux with sandbox binaries present; weakest on Windows. UI-oriented toggle; state rehydrates on resume.

**Watchdog** — Band-throttled advisory reminders as context crosses practical pressure bands; high-usage TUI widget reinforces spawn-vs-handoff guidance (topic- and readonly-aware). A requested handoff is not advisory: while it is pending, every LLM call carries a handoff nudge, and the watchdog cancels it after `MAX_HANDOFF_ATTEMPTS` settled runs that sent the eligible handoff nudge without a completed handoff.

## Package layout (high level)

| Area | Role |
|---|---|
| `index.ts` | Extension entry: tools, hooks, wiring |
| `prompt-sections.ts` / `system-prompt.ts` | Prompt-section registry, the static context-management primer and the date section |
| `spawn/` | Child sessions and live TUI rendering |
| `model-groups/` | Persistence, boot validation, CRUD TUI/autocomplete, spawn routing, prompt section |
| `notebook/` | Page store, tools, topic, rehydration, external pager, prompt sections |
| `handoff/` | Verbatim next-instruction delivery, model-owned context prep, the turn_end boundary (cut, successor, note), live readonly nudge |
| `readonly-*.ts` / `os-sandbox.ts` | Readonly posture, bash policy, sandbox |
| `watchdog.ts` / `tui.ts` / `state.ts` | Pressure advisories and required-handoff enforcement, status UI, shared state |

## See also

- [README](../README.md) — install and primitives
- [why.md](why.md) — product rationale
