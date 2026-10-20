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

**Spawn** — Without a Model Group, the child inherits the parent's public model and explicit/default thinking level. An exact known group randomly selects a registry-resolved, authenticated entry; an entry-specific thinking level overrides explicit/inherited thinking and is clamped for the selected model. An unknown group reports fallback and uses the parent model/thinking. A known empty group or one with no usable authenticated entries fails before child-session creation. The selected public model enters a child-owned runtime. Children also inherit cwd and active registered tools executable in that session, retain child-local notebook tools, cannot spawn or handoff, and inherit readonly posture.

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
| **macOS** | OS sandbox via `sandbox-exec` (Seatbelt) — kernel denies file writes outside the shared temp roots; classifier is secondary |
| **Linux** | OS sandbox via `bwrap` when available — read-only root + writable temp; classifier is secondary. bwrap binds the real host `/tmp`, so sandboxed commands share it with other processes (TOCTOU — see `readonly-bash.ts` Known L2 limitations). Without `bwrap`, classifier only with the same L2 gaps as Windows |
| **Windows** | **No OS / syscall-level sandbox.** `canUseOsSandbox()` is always false. Only the shell-command **classifier** runs — best-effort pattern matching. Known gaps: interpreter one-liners (`node -e`, `python -c`, …), piped indirection (`xargs`, etc.), process substitution (`>(…)`), `mktemp` targets, Git metadata writes (a `git status` index refresh in a repo discovered from an outside cwd, e.g. `git -C <outside> status` — see `readonly-bash.ts` Known L2 limitations). **Not true write protection.** |

Coding-agent guardrail on every OS — not a hardened security boundary. Strongest on macOS/Linux with sandbox binaries present; weakest on Windows. UI-oriented toggle; state rehydrates on resume. A repository's own `.git/config` is trusted input: if it names an executable (`remote.<n>.uploadpack`, `core.pager`, `core.sshCommand`), a write inside the temp roots can plant that config and a later Git command runs it. Executing a program is outside the write contract, so the classifier vets only command-provided `-c`/environment values.

**Heredoc expansion is shell-version dependent** — an unquoted body is expanded by the outer shell, and shells disagree on whether the redirect command's leading assignments are visible yet: bash ≤ 4.0 applies them, bash ≥ 4.1 expands with the parent environment first (manual order: redirections before assignment values). A single model would be unsound on one platform, so the classifier expands under both candidates and blocks if either resolves a write outside the temp roots. The parent candidate models bash ≥ 4.1 for tracked variables: a name only the prefix sets is unset there and expands to empty unless the ambient environment defines it, so non-path uses stay allowed while the resulting outside path still blocks; other names no candidate defines keep failing closed. Shell state seeds `PWD` from the tracked cwd and every directory change refreshes it, so heredoc expansion and data substitutions resolve the same value, and an earlier assignment cannot outlive `cd` and pin expansion to the old directory. Block reasons name the candidate that failed (`parent expansion` / `assignment-prefix expansion`). Quoted bodies (`<<'EOF'`) are unaffected: the consuming shell expands them, so their classification is version-independent.

**Unknown cwd sentinel** — The classifier tracks `cd`/`pushd`/`popd`. A dynamic operand, a dropped variable, or a deferred handler (`trap`, `eval`, `alias`) makes the target unresolvable. The classifier then sets the cwd to `UNKNOWN_CWD` — a path outside every temp root (`readonly-bash-dirchange.ts:22`). Later relative paths stay blocked. Example: `D=$TMPDIR; unset D; cd "$D"; touch f` blocks. A resolvable directory works instead: `cd "$TMPDIR"; touch f` is allowed.

**Shared `/tmp` TOCTOU — decision: keep the host bind.** Linux `bwrap` binds the host `/tmp`, not a private tmpfs (macOS Seatbelt allows it too). A hostile local process can plant a symlink in `/tmp` between classification and execution. The classifier resolves paths only before the command runs. It cannot see the swap. A private tmpfs or per-command subdir was rejected: `os.tmpdir()` normally lives under `/tmp`, so privatizing it hides the canonical `TEMP_WRITE_ROOTS` the classifier just approved (`os-sandbox.ts` `buildWritableBinds`) and breaks legitimate scratch sharing. The sandbox stays a coding-agent guardrail, not a hardened boundary; the residual swap stays a documented L2 gap (see `readonly-bash.ts` Known L2 limitations).

**Fail-closed hint** — Fail-closed blocks end with `FAIL_CLOSED_HINT` (`— fail-closed; retry a simpler form`). The suffix marks a safe over-block on an unprovable input. A proven outside-temp write instead reports a specific reason. Retry a simpler, literal form. Common over-blocks carry a short example: physical `cd` (`cd -P` loses the tracked cwd — later relative writes say `cwd unknown after cd; use cd -L`), group heredocs (`{ cat; bash; } <<EOF` — restructure without the group), and single-quoted `$(...)` (literal text is still scanned — rephrase without it).

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
