# Architecture

pi-schematic is a Pi extension. It registers tools and hooks into the agent lifecycle, and keeps session state in one `SchematicState` instance.

## Lifecycle hooks

| Hook | Role |
|---|---|
| `before_agent_start` | Refreshes Model Groups, resolves deferred readonly frontmatter, then injects the context-management primer, a per-run current-date anchor, names-only group guidance, and live notebook index |
| `context` | Advisory watchdog reminders when context is elevated; readonly toggle nudges |
| `input` | Resolves model-selection frontmatter during idle input; blocks it during streaming; queues readonly resolution |
| `tool_call` | Readonly blocks write/edit/unguarded bash; blocks handoff unless a requested bypass is active |
| `session_start` | Reconstructs notebook pages/epoch/watermark from the active branch, rehydrates readonly state, and recovers an absent successor handoff message; loads and validates Model Groups, registers group autocomplete, reports config issues, and resets session state on `/new` |
| `session_tree` | Invalidates branch-local handoff work, reconstructs notebook pages/epoch/watermark from the newly active branch, rehydrates readonly state, recovers a successor only when no newer user turn exists and no session-tree descendant owned by that cut proves delivery, refreshes indicators |
| `turn_end` | Updates TUI indicators (context %, notebook count, topic, readonly) |
| `agent_end` | Records last context usage percent |
| `agent_settled` | Counts handoff enforcement attempts per settled run and cancels a required handoff after MAX_HANDOFF_ATTEMPTS. Recovery in index.ts clears the recovery latch and, when no queued messages remain, resends an absent successor handoff message. |
| `session_before_compact` | Emits a fixed continuation frame plus a per-cut identity marker as the compaction summary; the successor's next instruction + context arrive as one real user message after compaction |

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
  pendingHandoff: { generation } | null
  pendingHandoffDelivery: { generation, payload, recoveryKey } | null
  recoveryRequestedMessage: { handoffEntryId, recoveryKey, message } | null
  pendingRequestedHandoff: { nextInstruction, toolCalled, enforcementAttempts } | null
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  childSessionEpoch: number
}
```

## Behavioral notes

**Spawn** — Without a Model Group, the child inherits the parent's public model and explicit/default thinking level. An exact known group randomly selects a registry-resolved, authenticated entry; an entry-specific thinking level overrides explicit/inherited thinking and is clamped for the selected model. An unknown group reports fallback and uses the parent model/thinking. A known empty group or one with no usable authenticated entries fails before child-session creation. The selected public model enters a child-owned runtime. Children also inherit cwd and active registered tools executable in that session, retain child-local notebook tools, cannot spawn or handoff, and inherit readonly posture.

**Model Groups** — `/model-groups` manages versioned global and trusted-project JSON configuration. Project groups shadow same-named global groups. Configuration is loaded and validated against Pi's model registry into the `modelGroups` snapshot; only names are injected into the agent prompt. Routing uses the parent registry only to select configured/authenticated entries—the registry/auth objects are not passed into the child runtime.

**Date anchor** — `before_agent_start` inserts a `## Current date` block into the system prompt directly after the context-management primer and before the per-run topic, Model Groups and notebook sections (`time/format.ts`: ISO date, weekday, IANA zone, UTC offset, plus a resolve-relative-references directive). It is rebuilt once per agent run — when the user submits a prompt — and stays fixed for the whole run, so it is never per-turn. While the host zone stays fixed, the block is byte-stable within a calendar day, so the provider-cached prefix changes at most once daily; the UTC offset can also change once on a DST transition day, so it changes at most twice that day. The handler returns the whole prompt, so each date change misses the prefix cache for history after it; placement after the primer keeps only base prompt + primer cached. A run that crosses midnight keeps the prior day's anchor until the next prompt rebuilds it. Every field — date, weekday, and offset — comes from one `Intl.DateTimeFormat` call for the rendered zone, so the anchor never mixes a host-local day with another zone's offset; `formatCurrentDate(date, zone?)` accepts an explicit zone, which is what makes DST and day-boundary behaviour testable. Any zone Intl cannot render — a host with a bogus `TZ`, or an explicit argument — falls back to `UTC` rather than rendering `undefined` or throwing out of the hook; zone aliases (`US/Eastern`) are kept verbatim. `time/format.ts` is the single source of truth for the anchor text.

**Notebook** — Agent-curated named pages **scoped to the active session branch**, not a long-lived memory product. Stored as session custom entries so pages survive handoff and resume of the same work stream; `/new` (fresh session) clears them with the conversation. The visible pages and the committed generation epoch follow the branch the user navigated to: `/tree` reconstruction rehydrates from the newly active branch, so branches diverge without cross-contamination and returning to an earlier branch restores its state; writes land on the current branch's generation. Discard is transactional — survivors are staged at the next epoch and committed only on successful handoff compaction — and the epoch high-water mark is derived from the branch during reconstruction, so a failed attempt can never resurrect staged pages after a restart. Active topic (`notebook_topic_set` or `/notebook <topic>`) frames spawn-vs-handoff preference; human-set topics are authoritative. Topic clears after a successful handoff. The interactive `/notebook` list pipes the selected page into an external pager (`$PI_PAGER`, else `$PAGER`, else an installed `less` except on Windows) while Pi's TUI is suspended; with no pager or a `cat` or `more` pager it shows a truncated inline preview, and either way the user returns to the list.

**Handoff** — Requires a real instruction and a meaningful context load (rejects empty instructions, very small sessions, or missing usage). Splits the next instruction (extension-carried, delivered verbatim; a human `/handoff` direction wins, otherwise the model supplies it) from preparation (model-owned: `context` plus notebook curation). `/handoff <direction>` queues the direction as the instruction; otherwise the model supplies `nextInstruction` to the handoff tool. The instruction is never started in the current context — that context is discarded at compaction. After compaction the successor receives one real user message (`## Next instruction` verbatim + `## Context`); the compaction summary itself is a fixed continuation frame plus an identity marker that lets Pi report the correct cut. A versioned copy of the exact payload is stored in the handoff compaction details; `/tree` and session resume recover it only when no newer user turn exists and no session-tree descendant owned by that cut proves delivery. Repeated triggers coalesce through an in-process latch, which a settled run clears so a silently failed send is retried while an absent successor persists — never duplicated once the message is persisted. Readonly is not frozen into the summary: a pending nudge re-announces the ON posture on the first post-handoff turn while a clean OFF-to-OFF handoff stays silent; `tool_call` enforcement stays live. Notebook bodies are not inlined into the prompt; the next context in this work stream fetches pages by name. Under readonly, handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary; readonly can resume after compaction. Compaction replaces the prior transcript with the fixed continuation frame: the next turns see a small context again (quality), and providers start a new input prefix for billing/cache (the dropped history is no longer in that prefix). Spawn runs children in separate context so their token use does not permanently inflate the parent. This extension does not configure provider cache TTLs or breakpoints.

**Skill and prompt frontmatter** — Interactive TUI invocations resolve model selection during idle `input`; headless/RPC invocations ignore it. `readonly: true|false` alone is deferred to `before_agent_start`, where complete skill metadata is available.

- `model: <provider>/<model-id>` selects a configured, authenticated model. Only the first slash separates the provider, so model IDs may contain slashes.
- `model-group: <group-name>` routes through a configured Model Group. An explicit `model` takes precedence.
- `thinking: off|minimal|low|medium|high|xhigh|max` is capability-clamped for the selected or current model and overrides group thinking.

A failed model change visibly blocks command expansion and records no success entry. During streaming steer/follow-up, commands with model-selection frontmatter are visibly blocked without model or thinking mutation; commands without it continue. Invalid frontmatter is ignored with a TUI warning.

**Readonly** — Session-persisted research posture. Toggle via `/readonly`, Ctrl+Shift+R, or `--readonly`. Write/edit always blocked at the tool boundary. Bash uses a two-layer guard:

| Platform | Enforcement |
|---|---|
| **macOS** | OS sandbox via `sandbox-exec` (Seatbelt) — kernel denies file writes outside the OS temp dir; classifier is secondary |
| **Linux** | OS sandbox via `bwrap` when available — read-only root + writable temp; classifier is secondary. Without `bwrap`, classifier only |
| **Windows** | **No OS / syscall-level sandbox.** `canUseOsSandbox()` is always false. Only the shell-command **classifier** runs — best-effort pattern matching. Known gaps: interpreter one-liners (`node -e`, `python -c`, …), piped indirection (`xargs`, etc.). **Not true write protection.** |

Coding-agent guardrail on every OS — not a hardened security boundary. Strongest on macOS/Linux with sandbox binaries present; weakest on Windows. UI-oriented toggle; state rehydrates on resume.

**Watchdog** — Band-throttled advisory reminders as context crosses practical pressure bands; high-usage TUI widget reinforces spawn-vs-handoff guidance (topic- and readonly-aware).

## Package layout (high level)

| Area | Role |
|---|---|
| `index.ts` | Extension entry: tools, hooks, wiring |
| `spawn/` | Child sessions and live TUI rendering |
| `model-groups/` | Persistence, boot validation, CRUD TUI/autocomplete, and spawn routing |
| `notebook/` | Page store, tools, topic, rehydration, external pager |
| `handoff/` | Verbatim next-instruction delivery, model-owned context prep, constant-frame compaction bridge, live readonly nudge |
| `readonly-*.ts` / `os-sandbox.ts` | Readonly posture, bash policy, sandbox |
| `watchdog.ts` / `tui.ts` / `state.ts` | Pressure advisories, status UI, shared state |

## See also

- [README](../README.md) — install and primitives
- [why.md](why.md) — product rationale
