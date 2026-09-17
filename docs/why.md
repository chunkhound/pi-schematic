# Why agent-managed context

## The failure mode

[Coding agents degrade as the context grows](https://agenticoding.ai/context-engineering) — often **far from the token limit**. Relevant detail drifts out of the region the model uses well (the practical “primacy zone”: roughly the first ~30% of the window). Quality drops while the session still looks “fine” on a raw token counter.

## What the industry does

Common harnesses (Claude Code, Codex CLI, OpenCode, and peers) shrink long sessions with **auto-compact at a token threshold** and/or a **manual `/compact`** (or equivalent). Under the hood that is almost always a **lossy summarization pass**: prune bulky tool output, then replace earlier turns with a compressed summary (human-readable narrative, structured memory, or an opaque server blob). Some stacks escalate through cheaper structural steps first; the heavy step is still “ask a model to compress history.”

| Approach | How it works | Where it fails |
|---|---|---|
| **Platform auto-compaction** | Runtime fires near a token ceiling (often late, ~80%+ of the window) | Threshold is blunt; the platform does not know task boundaries or what still matters; summary quality is worse once the session is already degraded |
| **User-triggered compaction** | Someone runs `/compact` (optionally with keep/discard focus text) | The context is visible — that is not the bottleneck. The user must **remember to compact proactively**, **steer** what to preserve, and **trust a separate summarization pass** that is lossy by design. That pass is optimized for cost/latency (cheaper/faster model, micro-prune + summarize pipeline, or an opaque provider endpoint) — not for the same deliberate state the working agent would write. Miss the timing or the steer, and hard facts die in the mush |
| **Manual reset** | `/clear` or `/new` plus copy-paste | Lossy, tedious, easy to drop the wrong thing |

All three manage context **around** the model. The agent stays a passive recipient of someone else’s summary.

## The flip

**pi-agenticoding** gives the agent tools to manage its own context: isolate noisy subtasks, keep what still matters, and drop the rest on purpose — instead of hoping the runtime’s compacter guessed right. (If you like systems metaphors: it’s garbage collection for the transcript, with the agent holding the controls.)

| Move | Primitive | Prevents |
|---|---|---|
| **Isolate** | Spawn | Noisy subtasks polluting the parent |
| **Remember** | Notebook | Losing reusable knowledge across deliberate cuts *in the same task* |
| **Compact** | Handoff | Waiting on `/compact`, late auto-summarize, or one mixed summary blob |
| **Guard** | Readonly | Accidental edits during research and planning (write/edit blocked everywhere; bash OS-sandboxed on macOS/Linux — **Windows is classifier-only, not syscall-level**) |

### Notebook is task-scoped shared memory

Standard agent memory systems try to be **long-lived**: they accumulate facts across days and projects, then rot. Stale entries, conflicting truths, and cache invalidation become the product.

The notebook is deliberately the opposite. It is **coupled to the conversation/task**:

- Pages carry memory across **handoff** and resume of *this* work stream
- **`/new` (or a new session) clears everything** with the conversation
- Pages split into two tiers: re-derivable code facts are a discardable cache; user guidance, decisions, design, and task scope are kept and refreshed for the life of the stream

So the agent can keep user guidance, decisions, constraints, and expensive findings **without** building a forever store that needs invalidation: code facts are pruned as they go stale, while non-recoverable knowledge is refreshed for the life of the stream. Handoff still splits concerns three ways: the notebook holds reusable memory *for this task*; the next instruction is carried verbatim, never paraphrased; and `context` holds only remaining situational state (current position, blockers, open questions, failed paths, concrete next step). That beats one summary blob that mixes all three — and beats external memory that outlives the work and goes stale.

## Awareness, not autopilot

Advisory pressure bands (around 30% / 50% / 70% context) and a high-usage TUI warning nudge spawn-vs-handoff judgment. They do not force action — they make degradation visible early enough to choose.

## Cost

Better context control is also cheaper. The reason is mechanical, not metaphorical.

Each model turn re-sends and bills a large **input** block: system instructions, tools, prior messages, and tool results (together, the **prefix**). New **output** is usually much smaller. Interactive coding sessions often sit around **~5:1–20:1** input:output by tokens. Output is often ~**3–6×** more expensive *per token*, but volume wins — **most of the dollar cost is still input**.

Providers can **cache a matching input prefix** so repeated turns pay a discounted rate on that prefix (often ~**10%** of base input). **Output is not cache-discounted.** Those caches go cold quickly — [Anthropic’s default is ~5 minutes](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) of idle time (hits refresh the window; longer TTLs exist with different write pricing). After a pause, the next turn pays to **process the full current prefix again**. Misses only hit the input bill — already the expensive side — and are much heavier than a cached turn (published coding-agent telemetry often puts miss prefill on the order of **~5×** a hit). Fast tool loops keep the cache warm; **human pauses** are when it expires.

Keeping context small for **quality** (primacy / less noise) therefore also cuts cost: you send fewer input tokens every turn, and when a miss happens you re-process a smaller prefix. Roughly: **cost ≈ prefix size × turns × (cached input price or full input price)**.
