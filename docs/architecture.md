# Architecture

pi-schematic is a Pi extension. It registers tools and hooks into the agent lifecycle, and keeps session state in one `SchematicState` instance.

## Lifecycle hooks

| Hook | Role |
|---|---|
| `before_agent_start` | Refreshes Model Groups, resolves deferred readonly frontmatter, then injects the context-management primer, names-only group guidance, and live notebook index |
| `context` | Advisory watchdog reminders when context is elevated; readonly toggle nudges |
| `input` | Resolves model-selection frontmatter during idle input; blocks it during streaming; queues readonly resolution; `/workflow` marks input handled for the workflow run's duration |
| `tool_call` | Readonly blocks write/edit/unguarded bash; blocks handoff unless a requested bypass is active |
| `session_start` | Reconstructs notebook pages/epoch/watermark from the active branch, rehydrates readonly state, and recovers an absent successor handoff message; loads and validates Model Groups, registers group autocomplete, reports config issues, and resets session state on `/new` |
| `session_shutdown` | Drops the per-session workflow binding (`discardWorkflowRuntime`, called from `workflow/command.ts`). The run releases the process-global reservation in `finally`, not this hook. Resets the error-path child-usage backfill via `abortAndClearChildSessions` (in `state.ts`, called from `resetState`). |
| `session_tree` | Invalidates branch-local handoff work, reconstructs notebook pages/epoch/watermark from the newly active branch, rehydrates readonly state, recovers a successor only when no newer user turn exists and no session-tree descendant owned by that cut proves delivery, refreshes indicators |
| `turn_end` | Updates the footer indicators (context %, notebook count, topic, readonly) |
| `agent_end` | Records last context usage percent; handoff enforcement cleanup |
| `agent_settled` | Clears the recovery latch and, when no queued messages remain, resends an absent successor handoff message |
| `session_before_compact` | Emits a fixed continuation frame plus a per-cut identity marker as the compaction summary; the successor's next instruction + context arrive as one real user message after compaction |

## State

```typescript
interface SchematicState {
  notebookPages: Map<string, string>
  clippedPages: Set<string>
  epoch: number
  activeNotebookTopic: string | null
  activeNotebookTopicSource: "human" | "agent" | null
  pendingTopicBoundaryHint: NotebookTopicBoundaryHint | null
  lastContextPercent: number | null
  pendingHandoff: { generation: number } | null
  handoffGeneration: number
  handoffCompactionGeneration: number | null
  pendingHandoffDelivery: { generation: number; payload: HandoffPayload; recoveryKey: string } | null
  recoveryRequestedMessage: { handoffEntryId: string | null; recoveryKey: string | null; message: string } | null
  pendingNotebookDiscard: { generation: number; nextEpoch: number; deleted: string[] } | null
  discardEpochWatermark: number
  pendingRequestedHandoff: { nextInstruction: string | null; toolCalled: boolean; enforcementAttempts: number } | null
  modelGroups: {
    groups: ResolvedModelGroup[]
    validation: ModelGroupsBootValidation | null
  }
  childSessions: Map<string, AgentSession>
  liveChildSessions: Map<string, AgentSession>
  // NEVER replaced — only .clear(); renderer ownership checks depend on stable identity (state.ts)
  childUsageSink: ((toolCallId: string, provider: string | null, model: string, usage: Usage) => void) | null
  // raised/lowered by the workflow run's suppression unsubscribe; NOT cleared by resetState
  inputSuppressed: boolean
  childSessionEpoch: number
  childAbortPromises: WeakMap<AgentSession, Promise<void>>
  readonlyEnabled: boolean
  readonlyNudgePending: boolean
  frontmatterSkillCache: Map<string, FrontmatterEntry>
  frontmatterPromptCache: Map<string, FrontmatterEntry>
  frontmatterSkillIssues: Map<string, FrontmatterIssue>
  frontmatterPromptIssues: Map<string, FrontmatterIssue>
  // FIFO slash-command intents queued in `input`, drained at before_agent_start
  pendingReadonlyCommands: Array<{ type: "skill" | "command"; name: string }>
  // null (<30), 0 (30-49), 1 (50-69), 2 (70+); null = never nudged
  lastWatchdogBand: number | null
}
```

## Behavioral notes

**Spawn** — Routing rules:
- Without a Model Group, the child inherits the parent's public model and explicit or default thinking level.
- An exact known group selects a registry-resolved, authenticated entry at random. An entry-specific thinking level overrides the explicit or inherited level and is clamped for the selected model.
- An unknown group reports fallback and uses the parent model and thinking.
- A known empty group, or one with no usable authenticated entries, fails before child-session creation.
- The selected public model enters a child-owned runtime.
- Children inherit cwd, the active registered tools they can run in that session, and readonly posture. They keep child-local notebook tools. They cannot spawn or handoff.
- The spawn result carries the child's usage. The parent session total and the workflow cost total therefore price child work.

**Model Groups** — `/model-groups` manages versioned global and trusted-project JSON configuration. Project groups shadow same-named global groups. Configuration is loaded and validated against Pi's model registry into the `modelGroups` snapshot; only names are injected into the agent prompt. Routing uses the parent registry only to select configured/authenticated entries—the registry/auth objects are not passed into the child runtime.

**Notebook** — Agent-curated named pages, scoped to the active session branch. This is not a long-lived memory product.
- Pages are session custom entries. They survive handoff and resume of the same work stream. `/new` (fresh session) clears them with the conversation.
- The visible pages and the committed generation epoch follow the branch the user navigated to. `/tree` reconstruction rehydrates from the newly active branch. Branches do not share pages, and returning to a branch restores its state. Writes land on the current branch's generation.
- Discard is transactional. Survivors are staged at the next epoch and committed only after a successful handoff compaction. The epoch high-water mark comes from the branch during reconstruction. A failed attempt cannot resurrect staged pages after a restart.
- The active topic (`notebook_topic_set` or `/notebook <topic>`) frames the spawn-or-handoff preference. A human-set topic is authoritative. The topic clears after a successful handoff.

Human topic-boundary cues under readonly that arrive below the context-eligibility threshold queue on the `pendingTopicBoundaryHint` field (`state.ts`) and promote to a handoff bypass once context usage crosses the threshold (resolved in the `before_agent_start` hook, `index.ts`).

**Handoff** — Requires a real instruction and a meaningful context load. It rejects empty instructions, very small sessions, and missing usage.
- The next instruction is extension-carried and delivered verbatim. A human `/handoff` direction wins. Otherwise the model supplies it.
- The preparation is model-owned: `context` plus notebook curation.
- `/handoff <direction>` queues the direction as the instruction. Otherwise the model supplies `nextInstruction` to the handoff tool.
- The instruction never starts in the current context. That context is discarded at compaction.
- After compaction, the successor receives one real user message: `## Next instruction` (verbatim) and `## Context`. The compaction summary is a fixed continuation frame plus an identity marker, which lets Pi report the correct cut.
- A versioned copy of the exact payload is stored in the handoff compaction details. `/tree` and session resume recover it only when no newer user turn exists and no session-tree descendant owned by that cut proves delivery.
- Repeated triggers coalesce through an in-process latch. A settled run clears the latch, so a silently failed send is retried while the successor is absent. A persisted message is never duplicated.
- Readonly is not frozen into the summary. A pending nudge re-announces the ON posture on the first post-handoff turn. A clean OFF-to-OFF handoff stays silent. `tool_call` enforcement stays live.
- Notebook bodies are not inlined into the prompt. The next context fetches pages by name.
- Under readonly, handoff is blocked unless the user runs `/handoff` or crosses an eligible human topic boundary. Readonly can resume after compaction.
- Compaction replaces the prior transcript with the fixed continuation frame. The next turns see a small context again. Providers start a new input prefix for billing and cache, and the dropped history is not in that prefix.
- Spawn runs children in a separate context, so their token use does not permanently inflate the parent. This extension does not configure provider cache TTLs or breakpoints.

**Workflow** — `/workflow <workflow> [args]` runs a user-authored synchronous JavaScript file in a codemode sandbox.
- The script owns control flow and the exit condition.
- The host supplies serial model turns on the user-facing conversation, a guarded shell, and soft cost and time targets. A crossed target stops the run at its next checkpoint.
- Child sessions come only from the model-invoked `spawn` tool. Usage attribution is the **Spawn** note above.
- The serial-run invariant (process-global reservation plus input suppression) is specified once in [workflows.md](workflows.md) (Constraints). `inputSuppressed` (field in `state.ts`) carries it.
- The host installs a run-scoped `childUsageSink` (field in `state.ts`). It attributes each spawned child's cumulative spend to its model on every `message_end` and at settle (`flushChildSpend` in `spawn/index.ts`). Like suppression, it is re-seeded on rebind and not cleared by `resetState`.
- See [workflows.md](workflows.md) for the author contract and [workflow-engine.md](workflow-engine.md) for the engine internals.

**Skill and prompt frontmatter** — Interactive TUI invocations resolve model selection during idle `input`; headless/RPC invocations ignore it. `readonly: true|false` alone is deferred to `before_agent_start`, where complete skill metadata is available.

- `model: <provider>/<model-id>` selects a configured, authenticated model. Only the first slash separates the provider, so model IDs may contain slashes.
- `model-group: <group-name>` routes through a configured Model Group. An explicit `model` takes precedence.
- `thinking: off|minimal|low|medium|high|xhigh|max` is capability-clamped for the selected or current model and overrides group thinking.

A failed model change visibly blocks command expansion and records no success entry. During streaming steer/follow-up, commands with model-selection frontmatter are visibly blocked without model or thinking mutation; commands without it continue. Invalid frontmatter is ignored with a TUI warning.

The interactive `input` hook queues slash-command intents into the FIFO `pendingReadonlyCommands` field (`state.ts`), drained at `before_agent_start` where the frontmatter cache is populated; it skips frontmatter resolution entirely when `inputSuppressed` is set, so a user input dropped by workflow-owned suppression cannot mutate model/readonly state ahead of the drop; the workflow's own extension-sourced sends pass suppression.

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
| `notebook/` | Page store, tools, topic, rehydration |
| `handoff/` | Verbatim next-instruction delivery, model-owned context prep, constant-frame compaction bridge, live readonly nudge |
| `workflow/` | `/workflow` command: workflow compiler, sandbox host, handles, soft cost/time targets, exit record |
| `usage.ts` / `process-state.ts` | Spend attribution shared by the workflow cost total, the run overview, and spawn; module-copy-safe process state |
| `readonly-*.ts` / `os-sandbox.ts` | Readonly posture, bash policy, sandbox |
| `watchdog.ts` / `tui.ts` / `state.ts` | Pressure advisories, status UI, shared state |

## See also

- [README](../README.md) — install and primitives
- [why.md](why.md) — product rationale
