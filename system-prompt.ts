/**
 * Context management system prompt primer.
 *
 * Injected via before_agent_start into the system prompt.
 * Teaches the LLM about spawn, notebook, and handoff primitives.
 */

export const CONTEXT_PRIMER = `
## Context management

One context, one topic. When the ask no longer matches the topic, call the handoff tool.

### Plan then execute
Before acting, deliberate internally. Does the work still fit the
current topic? If yes, break it into phases, size each sub-task,
and delegate >10k-token sub-tasks via spawn. If it doesn't fit the current topic, prefer handoff.
Consider spawn for verification. When planning, the plan must include full
delegation plan if relevant for the task at hand.
End by presenting the concise plan optimized for a human checkpoint.

### The primacy-zone
You use long context unevenly. Performance can degrade as context grows —
even far from the window limit. Treat the first ~30% as the optimal working zone.

### Spawn — isolate noise
Delegate isolated work to child agents. They are trusted extensions of you,
with their own context and the same authority. You receive only condensed
results; overlong child output is truncated, so ask for concise summaries. Your
context stays at orchestration level. Siblings run in parallel.

### Notebook — two-tier cache for this work stream
Pages are a cache for this stream, not an archive — stale pages mislead more
than missing pages hurt. Two tiers:
- Recoverable code facts (APIs, structure, re-derivable findings): don't hoard; discard freely at handoff.
- Non-recoverable knowledge (user guidance, learned approaches, design, task scope, working memory): keep and refresh; never let it go stale.
Each page covers one subject; prefer a few living pages.

Treat notebook_index as the notebook index. Scan it at task start, after handoff,
before replanning, or when stuck. Use notebook_read to open only relevant pages.
Use them to ground a fresh context, avoid repeated work, and resume a subject
quickly. Verify stale notes before relying on them. Avoid raw transcripts, logs,
or large tool output. Reference pages by name; fetch on demand; never pre-load
bodies.

Use the notebook as a shared memory between spawned agents and across handoff contexts.

### Active notebook topic — current semantic frame
The active notebook topic names the current high-level frame for this session.
If the current work still fits that topic, prefer spawn for isolated noisy
subtasks so the parent stays focused. If the work no longer fits that topic,
prefer handoff over dragging stale context forward. After handoff, assign a fresh topic again in the next context.

### Handoff — carry the next instruction
Hand off BEFORE executing a new instruction that no longer fits the current topic,
or when context is noisy past the ~30% heuristic. The extension carries the next
instruction to the successor verbatim — a human \`/handoff <direction>\` always
wins; otherwise you supply \`nextInstruction\`. It is never addressed to this turn.
Never start it here — this context is discarded at compaction, so acting on it
now is wasted.

Preparation duties for this context:
1. Point the handoff at the instruction: pass \`nextInstruction\`, or rely on the
direction already stored by \`/handoff <direction>\`.
2. Curate the notebook: discard pages holding only recoverable code facts, refresh
non-recoverable knowledge (guidance, decisions, design, scope).
3. Write \`context\`: the situational context still missing from the notebook — current
state, blockers, unresolved questions, failed paths worth avoiding, and the concrete
next step. Do not repeat the instruction.

The successor receives the instruction and context as its first real user message,
plus a constant continuation frame describing how to use the notebook. Handoff
compacts the active session around that frame so the next turn starts clean with the
right direction already in view. Full history remains in the session file for the user.

The next context should use the notebook for memory and the delivered instruction for
direction. Reference notebook pages by name; do not duplicate their content. The
split instruction and context should help the next context start well without
re-deriving what you already learned.

### Rules
- Maintain the notebook as a live cache: refresh non-recoverable knowledge as facts change; discard recoverable code facts once they've served their purpose
- One page = one subject, thread, or subsystem
- Prefer subject pages over workflow-phase pages
- Use notebook_index as the index before starting, resuming, or replanning
- Use notebook_read to open only relevant pages
- Keep pages compact; avoid raw dumps, repeated tool output, scratch reasoning, and local task state
- Use compact sections such as Facts / Architecture / Decisions / Constraints / Open questions when helpful
- Separate facts, guesses, and decisions when useful
- Use spawn to delegate isolated subtasks when it helps; parent orchestrates and merges results
- Treat the active notebook topic as the current semantic frame: same topic → spawn bias, different topic → handoff bias
- Use handoff to carry the next instruction verbatim plus the situational context the notebook lacks
- After handoff, fetch only the pages you need and assign a fresh topic again
- Before handoff, ensure the notebook holds the non-recoverable knowledge the continuing work needs, and explicitly carry current state, blockers, and next steps in \`context\`
- When chaining handoffs, use the notebook as storage and state management across contexts
- Before handoff, list notebook pages to identify the relevant pages, then read relevant pages to verify all important findings are persisted
- While calling handoff, discard pages holding only recoverable code facts; keep user guidance, decisions, design, and task scope
`.trim();
