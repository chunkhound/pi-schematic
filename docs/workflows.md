# Workflow Author Contract

> **Checkpoints:** optional; the full rule lives in [Constraints](#constraints).
>
> **Headless runs:** with no UI the budget dialogs are skipped and explicit `--workflow-cost`/`--workflow-time` flags still apply. Without flags the run starts with no targets (unbounded until it exits or aborts; the host records this decision — see [Targets](#targets-exit-cancellation-salvage)).

`/workflow <workflow> [args]` runs a user-authored synchronous JavaScript file in a codemode sandbox. The file owns control flow and the exit condition. The host supplies the effects.

- The procedure is versioned and repeatable.
- Loops, branches, budget checks, and exit rules are code.
- Cost and time stay bounded by soft targets.
- Shell effects stay out of the model context.

Review is the first use case. Review is not the engine's subject. No engine file names a review.

## Model and invariants

- The workflow is **serial and blocking**. `/workflow` does not return until the workflow exits, is interrupted, or is cancelled.
- The workflow runs on the user-facing conversation. Its model turns are the only model turns. The host suppresses user input for the duration.
- The workflow is **synchronous**. Author code is synchronous; the host compiles each `workflow.*` call into an awaited host call before the sandbox runs the file. The compiler allows `async` only on the workflow arrow and `await` only on a direct `workflow.<member>(...)` call. An author cannot omit an await.
- The workflow owns control flow and the exit condition. The host owns effects, soft targets, and the exit record.
- The workflow cannot create child sessions. Only a model that invokes the **spawn tool** starts a child. Orchestration stays on the user-facing conversation.
- The spawn tool reports child usage on its tool result. Child cost therefore stays in the workflow's summed usage.

## Terms

| Term | Meaning |
|---|---|
| Workflow run | One `/workflow` execution. |
| Effect | One host call that a `workflow.*` handle triggers. |
| Step | One `workflow.run` call. It covers one settled agent run. |
| Settled run | One agent run that reached `agent_settled`, after retries, compaction, and queued continuations. One step can contain many turns and tool calls. |
| Turn | One assistant message inside a settled run. |
| Checkpoint | A safe exit point declared by `workflow.checkpoint`. |
| Target | A soft cost or time limit. |
| Exit record | The single `workflow-exit` entry written at run end. |

## File and entry point

A workflow is one JavaScript file. The host compiles it and runs it as the sandbox script body.

- The file returns `defineWorkflow(fn)`.
- `fn` takes exactly one parameter named `workflow`.
- `fn` may declare `workflow.checkpoint(...)` calls. Without one, the workflow is unbounded — see [Targets](#targets-exit-cancellation-salvage).
- `fn` has no imports, file access, network, or timers.
- Project workflows live in `<cwd>/.pi/workflows`. Global workflows live in `<agent dir>/workflows`: `~/.pi/agent`, or the `PI_CODING_AGENT_DIR` path when set. Name rules: [Command surface](#command-surface).

## Synchronous language

The host inserts the awaits. The author writes plain synchronous code.

```js
// As written.
const review = workflow.run("/review-worktree", { args: load("intent") });
const ok = workflow.shell("npm test").ok;

// As executed.
const review = (await workflow.run("/review-worktree", { args: load("intent") }));
const ok = (await workflow.shell("npm test")).ok;
```

`load("args")` and `load("intent")` read the run's argument remainder from the seed store; both keys hold the same string.

The host runs one effect at a time. The flow is sequential and matches the visible conversation.

`await` suspends for at least one microtask. Each effect therefore yields before the next statement. The flow stays sequential and deterministic, but it is not pure-synchronous execution.

## Accepted control flow

Every synchronous statement is supported, at any depth in `fn`:

`if`/`else`, `while`, `do-while`, `for`, `for-in`, `for-of`, `switch`, labelled statements, `break`/`continue`, `try`/`catch`/`finally`, `throw`, and blocks.

The compiler awaits `workflow.*` in every position, including loop heads and conditions. `for (const x of await workflow.entries())` is valid synchronous iteration. `for await` is rejected.

Statement control flow is the only iteration mechanism. A `workflow.*` call inside a callback (`map`, `filter`, `forEach`) is rejected, because an async callback changes its return contract. A workflow writes the loop instead.

Every loop is bounded by the workflow's own counter or exit condition. The host enforces no iteration cap.

<details>
<summary>Full rejection list (compiler contract)</summary>

The compiler rejects a `workflow` reference that is not a direct member call. It also rejects:

- aliasing, destructuring, dynamic keys, `new`, tagged templates, indirect calls, and reassignment of `workflow`;
- `globalThis` and `global` references anywhere (the sandbox exposes `workflow` on the global object, so these would bypass the rewrite);
- `this`;
- dynamic `import()`;
- any computed member or destructuring key that is not a literal or a constant template string (for example `o[k]`, `o["con" + "structor"]`), because the compiler cannot prove it is not `constructor`;
- member access or destructuring named `constructor` or `__proto__` (dot, string-key, or constant template form), which reaches code generation past the checks;
- `getOwnPropertyDescriptor` and `getOwnPropertyDescriptors` member access, which read a member value by name the same way;
- `async` on anything except the workflow arrow;
- `await` on anything except a direct `workflow.<member>(...)` call;
- `for await`;
- `with`;
- `eval` and `Function`, which could hide a `workflow` call from the checks;
- `Reflect`, which reads a member by a runtime string and reaches `constructor` the same way;
- any binding named `workflow` other than the workflow arrow's parameter;
- `workflow.*` inside nested functions, methods, getters, setters, parameter defaults, class fields, static blocks, and constructors.

Calls reach the host only as `workflow.<member>(...)` or `workflow['<member>'](...)`, optionally with `?.`. A constant template key (`` workflow[`run`](...) ``) is rejected too: the rewrite recognizes only dot and string-literal forms.

The whole file MUST be exactly one top-level `return defineWorkflow(<arrow>)` statement. A bare top-level `workflow.*` call is rejected. It would escape the serial contract.
</details>

## Handles

The workflow sees one namespace, `workflow`. Every member is a function. A snapshot is a call: `const b = workflow.budget();`.

Handles are **two-level only**. A global name has at most one dot. Any `workflow.<member>` form is valid; a deeper name such as `workflow.notebook.read` is invalid. A signature shown as `→ void` resolves to `null` across the JSON round trip. The surface is 15 handles with `WorkflowHandleName` in `workflow/types.ts` as the single source; the run-scoped `workflow_output` tool (`workflow/output.ts`) is not a handle.

| Handle | Signature | Contract |
|---|---|---|
| `workflow.run` | `(prompt, options?) → RunResult` | Run one step from a prompt template or skill. |
| `workflow.handoff` | `(direction) → void` | Run `/handoff <direction>` exactly like the human command. |
| `workflow.classify` | `(request) → ClassifierResult` | Answer typed questions about JSON state with a classifier model. |
| `workflow.shell` | `(command, options?) → ShellResult` | Run a shell command through pi's bash tool. |
| `workflow.state` | `() → StateDigest` | Read a JSON digest of the active conversation. |
| `workflow.entries` | `({ after?, limit? }?) → Entry[]` | Read compact entries after an entry id. Each entry is `{ id, role, type, text, toolNames }`. |
| `workflow.notebookIndex` | `() → Page[]` | List pages as `{ name, preview }`. |
| `workflow.notebookRead` | `(name) → string` | Read one page body. An invalid name or a missing page throws. |
| `workflow.notebookWrite` | `({ name, content }) → void` | Write one page durably. |
| `workflow.notebookTopic` | `() → { topic, source }` | Read the active notebook topic. |
| `workflow.budget` | `() → Budget` | Read `{ cost, costRemaining, timeRemainingMs }` against the targets. A remainder is `null` when no target is set. Both remainders measure to a target, so either can read zero while the run continues to its next checkpoint. Null-check a remainder before any `<= 0` comparison: `null <= 0` is true in JS, so an unset target reads as exhausted. |
| `workflow.readonly` | `(enabled) → { readonly }` | Toggle the readonly posture through the same path as `/readonly`. Return the new value. |
| `workflow.new` | `() → void` | Clear the context and start a new session. |
| `workflow.checkpoint` | `(metadata) → unknown` | Declare a safe exit point. |
| `workflow.exit` | `(metadata) → unknown` | Record the exit and stop the run immediately. Resolves with the metadata argument. |

### workflow.run

`workflow.run` takes a prompt template or a skill. It MUST NOT take an extension command. A command can manage its own turns, so it has no reliable completion signal. The host rejects an `extension` source.

A `/name` prompt always resolves against the command catalogue. A slashless prompt resolves only when it is exactly one token that names a prompt template or skill; a longer slashless prompt is sent verbatim as a plain prompt, so prose like `review the diff` never invokes `/review`.

`options` = `{ args?, input?, model?, thinking?, output? }`. Value rules: [Host gaps](#host-gaps-pi-104).

- `args` appends to the prompt line.
- `input` appends to the message's fenced block, after any buffered previews (text or JSON).
- `model` and `thinking` set the turn's model and thinking level. The host restores the previous values after the run.
- The target's frontmatter also routes model and toggles readonly.
- Frontmatter resolves before `model` and `thinking`. Explicit run options therefore win for the turn. A frontmatter model persists as the post-run session model.
- A blocked frontmatter route rejects the run before any message is sent.

`RunResult` = `{ text, fromEntryId, toEntryId, usage, state, model, output? }`:

- `text` is the assistant's final text.
- `fromEntryId` and `toEntryId` bound the settled run.
- `usage` sums the run's usage entries, including spawned-child usage.
- `state` is the same digest as `workflow.state()`.
- `model` is the concrete model of the run's final assistant turn as `{ provider, model, thinkingLevel? }` (`provider` may be `null`), or null when the branch names none. A group-routed turn reports the chosen member, not the requested group.
- `output` is the validated object from a structured-output run. It is present only when the run requested it.

The host rejects the step when the settled final assistant's `stopReason` is `error` or `aborted`. Retries inside one settle stay in the same step. The host does not parse `text` for findings. A workflow persists findings as a notebook page (`workflow.notebookWrite`) or takes them from a structured-output run, then reads pages with `workflow.notebookRead`. `workflow.entries` reads the conversation entries the model produced.

### Structured output

`options.output` = `{ schema?, instructions? }`. `schema` is a JSON Schema object. Omit `schema` to accept any JSON object.

When `options.output` is set, `workflow.run` either resolves with a defined `output` or rejects. It MUST NOT resolve with an absent `output`.

The host arms one run-scoped tool, `workflow_output`, for that step. The tool is the primer. It states that it is the only way to complete the run, that it MUST be called exactly once as the final action, and that a rejected call MUST be corrected. pi validates the call against `schema` before execution. An invalid submission becomes an error tool result. The model corrects it inside the same step.

A valid call captures the object and ends the agent's follow-up. A settle that produced no call is an unsatisfied contract: the step rejects. Workflow code may catch the error. Otherwise the host aborts the run as `error`.

Without `options.output`, the tool is inactive. After one structured run, pi 1.0.4 exposes no unregister call, so the definition stays registered but inactive (see Host gaps).

### workflow.handoff

`workflow.handoff(direction)` runs `/handoff <direction>` exactly like the human command. The model curates the notebook and calls the handoff tool. The tool compacts.

- The handle consumes one settled run.
- It resolves after compaction completes and the successor run settles. The next `workflow.run` therefore cannot overtake the shifted context.
- Each handoff wait carries its own full 15-minute deadline: the compaction wait first, then the successor-settle wait. A compaction near its own deadline therefore does not starve the settle wait. Nothing else guarantees that the model ever calls the handoff tool. Expiry aborts the run as `error`.

### workflow.classify

`workflow.classify` wraps pi's classifier context with a model selector. `classify` never rejects. It returns a `ClassifierResult` with `stopReason ∈ stop | error | aborted`, an optional `errorMessage`, and an `answers` map keyed by question name.

Each answer mirrors its question's criteria:

- a `choice` answer keys `probabilities` by the criteria labels;
- a `score` answer returns `score`;
- a `bool` answer returns one `probability` number.

A `bool` question named `approve` yields `result.answers.approve.probability`.

<details>
<summary>Classifier types</summary>

```ts
interface ClassifierRequest {
  model: { provider: string; id: string };
  state: Record<string, unknown>;
  questions: Record<string, ClassifierQuestion>;
}
type ClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };
type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };
type ClassifierResult = {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  usage?: Usage;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
};
```
</details>

A workflow MUST check `stopReason` before it reads answers. The host charges classifier usage to the run cost total when the provider returns it. When `usage` is absent, the host cannot charge the call and the total under-counts it.

### workflow.shell

`workflow.shell(command, options?)` runs through pi's bash tool on every platform (bash and Git Bash).

`options` = `{ readonly?, timeout? }`. `timeout` is in seconds.

`ShellResult` = `{ ok, exitCode, output, display, truncated, killed, fullOutputPath?, wallTimeSeconds? }`:

- `ok` mirrors pi's bash-tool result: false when pi flags an error (nonzero exit, abort, timeout, or spawn failure).
- `output` is the programmatic sanitized, truncated text.
- `display` is pi's UI display snapshot.
- `fullOutputPath` is the temp file with the untruncated output. It is present when truncated.
- `wallTimeSeconds` is pi's measured wall time.

pi truncates in pi-style (last lines / 50 KB). It kills the whole process tree on abort or timeout. It reports a signal-killed process as `128 + signal`.

A caught abort, timeout, or spawn failure becomes a failed `ShellResult` (`ok: false`, `exitCode: null`). `killed` is true for an abort or timeout and false for a spawn failure. The workflow then decides what to do. The error message stays visible in `output`.

`options.readonly: true` applies the readonly bash rule to one call. It does not change the run's posture.

### Notebook and state

- Each `notebookWrite` buffers a compact preview. The next `workflow.run` message carries all buffered previews in one fenced block, before its own `options.input`. A run consumes the buffer once; a run with no buffered preview sends none.
- Notebook pages are `custom` entries. They are not in the model context. The host never injects a `custom_message` mid-run.
- `workflow.state()` returns a compact JSON digest: session id and leaf id, message count and context percent, cost and settled-run count, readonly posture, last model response, active tools, and notebook topic.
- The digest crosses into the sandbox as JSON. It never carries the raw transcript.
- A workflow reads the digest to control context growth. Between rounds it calls `workflow.handoff` to compact or `workflow.new` to reset.

## Targets, exit, cancellation, salvage

The workflow owns the exit condition. It marks safe exit points with `workflow.checkpoint(metadata)` and exits terminally with `workflow.exit(metadata)`. Metadata is any JSON value. The host reports the exit and saves it as the `workflow-exit` entry. Domain reasons such as `approved` or `tests-failing` come from the workflow, not the host.

**Numbers.** This page states each author-visible value once. The named code constant owns the value; the engine doc names the constant only.

The host applies two soft targets. The host stops the workflow only at a checkpoint. A workflow without a checkpoint is unbounded: it has no soft stop point.

Each handle is **guarded**, an **inspector**, or terminal. The host checks the targets before every guarded handle; it never checks an inspector, `checkpoint`, or `exit`.

- **Guarded:** `run`, `handoff`, `classify`, `shell`, `entries`, `notebookWrite`, `readonly`, `new`. **Cost** and **time** are checked before each.
- **Inspectors:** `state`, `budget`, `notebookIndex`, `notebookRead`, `notebookTopic`. They stay reachable past a target, so a workflow can observe the crossing and reach its next safe exit point.
- `checkpoint` and `exit` stay reachable too; `exit` is terminal.
- Cost includes classifier usage and spawned children. Cost stays cumulative across `workflow.new`.
- At the soft wall-clock target, the crossing call runs. The next `workflow.checkpoint(...)` stops the run. The check uses the target itself, with no early grace.

**Cooperative deferred stop.** A crossed target does not abort the run. The host records a pending stop and lets the crossing effect run. The workflow continues until its next checkpoint, which stops there and salvages the checkpoint metadata.

- The crossing effect and every effect up to the checkpoint run. The final cost or time therefore overruns the target.
- To bound an unreachable or far-away checkpoint, the host escalates to a hard abort after 16 guarded effects past the pending stop (`MAX_DEFERRED_EFFECTS = 16`). The last checkpoint metadata still salvages.
- A checkpoint that never runs hits the sandbox hard backstop at **twice** the soft time target. The sandbox returns `error.kind: "timeout"`, which the host records as `time-limit` with the last checkpoint salvaged.

A checkpoint-less workflow skips the cost/time dialog: no soft target can stop it. `--workflow-cost` is ignored. A valid `--workflow-time` becomes the sandbox's hard deadline instead of a soft target: exceeding it kills the run and the host records `time-limit`. Without `--workflow-time` the run is unbounded. The normal path stays silent: `∞ unbounded` replaces the checkpoint cell in the live footer, and the overview shows `limits  unbounded — no checkpoint declared`. When the operator supplied an ignored `--workflow-cost`, one warning notice names it, because a flag that cannot act must not look applied. The `workflow-limits` entry is UI/transcript-only, so it never reaches the LLM.

The `--workflow-cost` flag parses USD and the `--workflow-time` flag parses milliseconds: `--workflow-time 30` means 30 ms, not 30 minutes (1 hour is `--workflow-time 3600000`). When either flag parses to a finite positive number, the flags bypass the dialogs and the other target stays unset. A flag that is present but does not parse to a finite positive number cancels the run with a visible error instead of continuing without a target. A time target too large for the sandbox's representation — where twice the target would overrun the timer range — is likewise rejected instead of clamped. A checkpoint-less workflow reaches only the `--workflow-time` check; `--workflow-cost` is ignored (see the checkpoint-less paragraph above). The time dialog uses hours: the time presets are `1 hour`, `4 hours`, and `8 hours`; the custom time input takes hours. Otherwise an interactive session shows the cost and time dialogs, and a headless session runs with no targets. The headless no-target start is recorded as a `workflow-limits` transcript entry so the run never looks silently unbounded.

**Cancellation** aborts the run through the sandbox signal and the active model turn. Cancellation is immediate. It does not defer to the next checkpoint, because a deferred emergency stop would keep a model turn spending.

The stop path depends on the mode:

- **TUI:** Escape or Ctrl+C triggers cancellation through a two-step arm-then-confirm funnel:
  - The first press shows a warning notice and arms that key.
  - A second press of the same key within 500 ms (`CANCEL_CONFIRM_MS`) confirms.
  - A press after the window re-arms.
  - Keys never cross-confirm. One accidental keypress cannot end a long run.
  - Only discrete key presses arm or confirm. Releases and auto-repeats are ignored.
- **RPC and print:** an abort during a model turn stops the run. The host bridges the aborted turn to the sandbox signal, and the run ends as `cancelled`. The abort reaches the run only while a model turn is active.
- **Checkpoint-less with `--workflow-time`:** the sandbox hard deadline kills the run; the host records `time-limit`.
- **No model turn and no hard deadline:** a process signal (SIGINT/SIGTERM) stops pi and with it the run. A pure-shell loop has no in-process cancel hook (see [Host gaps](#host-gaps-pi-104)).

An unhandled handle error and every infrastructure failure are also immediate.

**Salvage.** When a run stops at a checkpoint, or aborts after a checkpoint was reached, the last checkpoint metadata becomes the run's partial result. It enters the `workflow-exit` entry as `partial` and the `workflow-summary` overview as `partial`. `workflow.exit` is terminal and immediate. Its metadata is the final exit record, not a partial. A run that stops before any checkpoint salvages nothing.

Host calls MUST NOT overlap. A second `workflow.*` call while one is running rejects with `workflow calls must not overlap`.

Every finished run writes exactly one `workflow-exit` entry, so no run ends silently. Its `reason` is one of:

- **The workflow's exit reason:** `metadata.reason` when it is a string. Other metadata is recorded as its JSON text. `workflow.exit()` with no metadata records `returned`. Workflow reasons MUST NOT reuse a reserved token.
- **A reserved token:** `cost-limit`, `time-limit`, `cancelled`, or `error`. The host records one when it aborts or stops the run. A checkpoint stop after a crossed target records `cost-limit` or `time-limit`; the run deferred its stop to that checkpoint instead of stopping hard. The UI shows these as `cost target reached` and `time target reached`.
- **`returned`:** the script ended without `workflow.exit` and without an abort.

## Observable surfaces

A finished run writes one `workflow-summary` custom entry. It carries:

- the workflow name, the exit reason, and the error;
- start and end times, and elapsed time;
- a technical breakdown: checkpoints passed, steps, turns, classifier calls, and per-handle invocation counts;
- the total cost and the spend rows by model.

A step is one `workflow.run` call. A turn is one assistant message inside a settled run, so `turns ≥ steps`. A `workflow.handoff` preparation turn is not counted: compaction removes it before the host can observe it. Counts cover effectful handles only. Pure inspectors (`state`, `budget`, `notebookIndex`, `notebookRead`, `notebookTopic`) and the terminal `exit` are never counted; `notebookWrite` is counted.

Each spend row splits its tokens into input and output. The expanded form adds cache tokens and a call count. A run stopped at a checkpoint adds a `stopped at checkpoint <partial>` row when the salvaged payload is non-null. A crossed target adds a `target → final` row with the overrun amount and percent. Cost is the row sum. The overview and the cost target read one projection, so they cannot disagree.

Attribution rules:

- Assistant turns come from the branch by `provider/model`.
- Classifier calls come from the host's own count.
- Spawned children come from a run ledger that the spawn tool feeds with each child's cumulative stats. A still-running or aborted child is attributed to its model, never hidden.
- The only `unattributed` row is genuinely model-less usage (compaction and branch summaries). It carries its tokens.

RPC receives the persistent status lines and the context warning widget through `ctx.ui`. Headless and print runs render nothing and keep pi's defaults. Run end restores the built-in footer.

<details>
<summary>Card and footer layout</summary>

The interactive transcript draws the summary as a bordered card. Collapsed, it shows the reason, time, the checkpoint/step/turn/classify counts, cost, and one line per model with cost and input/output tokens. An unbounded run adds `limits  unbounded — no checkpoint declared`. Expanded, it adds the remaining per-handle activity, cache-token detail, the bounded shell effect log (up to `MAX_EFFECT_ROWS` recent commands; see [workflow-engine.md](workflow-engine.md)), and the start and end timestamps.

While a run is live in the interactive TUI, the workflow replaces the built-in footer with one unified bar in two zones:

- **Run zone:** `🛠️ <name>`, checkpoints as `🚩 <n>` or `∞ unbounded` when no checkpoint is declared, elapsed as `⏱ <m:ss>` (`h:mm:ss` from one hour), cost as `$<n>.<nn>`, each paired with its target when one is set, plus a warning pill `⏸ <reason> — stopping at next checkpoint` while a stop is pending. The `currentEffect` cell (the shell command or the run prompt) also lives here.
- **Conversation zone:** `ctx <n>%`, topic, readonly, notebook count.
- Elision drops one cell at a time, least important first:
  1. conversation cells: notebook, readonly, topic, then `ctx`;
  2. run cells: the `currentEffect` cell, cost, elapsed, then checkpoints;
  3. the run name. With a stop pill on the bar, the name drops out first. Without one, the name shrinks with `…`.
  The stop pill shrinks last.
- A dim second line preserves the built-in cwd/branch, session token/cost totals, and model/context-window detail. The bar shows the run cost (`runSpendRows` in `workflow/spend.ts`); the dim line shows the session cost (`collectUsage` in `usage.ts`, called by `tui.ts`).

</details>

**Shell visibility.** The shell effect has four LLM-invisible surfaces:

1. a live `workflow-activity` widget while the command runs;
2. one `workflow-shell` CustomEntry per shell call, with exit status, duration, and output tail;
3. a `workflow-log` CustomEntry with the workflow script's own `console.log` and `text()` output;
4. the bounded effect log in the expanded `workflow-summary` card.

All four are CustomEntry or UI only. None enter the LLM context. The host keeps a bounded effect log (`MAX_EFFECTS`; see [workflow-engine.md](workflow-engine.md)) for user visibility only. It trims the log to the most recent records. Shell execution MUST NOT be visible to the LLM: no tool rows and no custom messages.

## Command surface

`/workflow` is one command: `/workflow <workflow> [args]`. `<workflow>` is a bare name under the discovery roots, or a path-like name. Extension commands cannot set an `argumentHint` in pi 1.0.4, so the usage lives in the command description.

Name completion is filesystem-backed. The engine stacks a provider over the built-in one, registered on `session_start`.

<details>
<summary>Completion provider behavior</summary>

The provider:

- intercepts the command while it is still typed (`/w` … `/workflo`) and in every full form (`/workflow`, `/workflow:<partial>`, `/workflow <partial>`);
- fuzzy-filters the discovered names;
- replaces the typed token with `/workflow <name> `, so one accept yields a runnable command;
- delegates every other line to the built-in provider;
- delegates a path-like partial to file completion;
- returns no suggestions for a bare partial that matches nothing, instead of falling through to file completion;
- delegates a partial command with no workflows, so the `/workflow` command stays discoverable.

</details>

Precedence has one source: `workflowRoots` in `workflow/file.ts` lists `<cwd>/.pi/workflows`, then `workflows` under the agent dir. A project file shadows a global file with the same name. The `.js` suffix is optional in the argument.

- A bare name resolves to the first root that holds `<name>.js`. A path-like name (absolute, starts with `.`, or contains `/` or `\`) resolves against cwd and skips the roots.
- Completion lists regular `.js` files directly inside each root. A symlinked workflow resolves by name but does not appear in the list.
- A name that does not resolve lists the available names.

## Constraints

- The sandbox cannot run model turns. `workflow.run`, `workflow.handoff`, and `workflow.classify` are host calls.
- The command handler blocks. **Input suppression is the host's job.** Core pi does not block user input while a command handler awaits. The host registers an `input` handler that returns `{ action: "handled" }` for every non-extension source. The workflow's own sends carry `source: "extension"` and must pass. Without this handler, the user can inject messages between turns and break the serial invariant. Registration is necessary but not sufficient in pi 1.0.4 (see Host gaps).
- One `/workflow` runs per process. The command claims a process-global reservation synchronously before any await and releases it in `finally`. A second `/workflow` is rejected with a visible notice. The reservation survives session replacements.
- `/workflow` must start on an idle session. pi runs an extension command even while streaming, so a mid-turn invocation is rejected with a visible notice rather than dispatching its first `workflow.run` into the busy session. The `workflow.run` dispatch requests `deliverAs: "followUp"` while the session is busy; pi ignores it while idle, so a platform busy window the command does not own never throws.
- Workflow code is synchronous; the rule is stated in [Model and invariants](#model-and-invariants).
- `workflow.new` clears the context and starts a new session. After it, the old context and its session manager are invalid. The host rebinds pi, state, dependencies, input suppression, cancellation, and the run-visibility surfaces from the runtime that the replacement session published in `session_start`. A fresh cancellation registration means no armed press carries across the switch. A missing publication fails the workflow explicitly. A cancelled replacement fails the handle without switching. Cost stays cumulative across replacements.
- Checkpoints are optional. Without `workflow.checkpoint(...)`, the workflow is unbounded: the cost/time dialog is skipped, `--workflow-cost` is ignored, and `--workflow-time` becomes the sandbox hard deadline instead of a soft target. Cancellation is immediate and mode-dependent (see [Targets](#targets-exit-cancellation-salvage)). The operator sees `∞ unbounded` in the live footer and `limits  unbounded — no checkpoint declared` in the overview. `workflow.exit` is terminal and is not a checkpoint.
- Structured output changes the declared tool set for one run. The host registers and activates `workflow_output` before dispatch and restores the previous active set in `finally`. The change is transcript-visible and can invalidate the provider's cached prefix. A spawned child never inherits `workflow_output`; the tool is host-owned and run-scoped, so only the parent turn can satisfy the contract.
- The sandbox bounds resources. It is not a security boundary.
- Readonly is the enforced posture, not a model hint:
  - `write` and `edit` tools are blocked;
  - `bash` runs the readonly bash guard. Per-platform enforcement is stated once in [architecture.md](architecture.md) (Readonly);
  - `handoff` requires an explicit `/handoff` invocation or an eligible human topic boundary.
- Host handles are two-level only. Each call is a JSON round-trip.
- Requires pi >= 1.0.4, `@earendil-works/pi-codemode` >= 1.0.4, and Node.js >= 22.19.0.

### Host gaps (pi 1.0.4)

Four guarantees that the design needs are blocked by the pi 1.0.4 extension API. The workflow does not weaken the requirement or invent an API. Until pi exposes the missing surface, these gaps stay open:

- **Initial-session send failures are invisible.** `sendUserMessage` returns `void`. An asynchronous dispatch failure before any assistant entry after an initial `workflow.run` cannot reject the call. The step then waits until the sandbox deadline — indefinitely with no time target. Persisted final assistant errors are rejected at settle. Only replacement-context sends return an awaitable promise that rejects.
- **Input exclusion is not atomic.** The host installs the `input` handler at workflow start. But pi dispatches extension commands before that hook, and `workflow.new` can reinstall suppression only inside the replacement, after the old session starts shutting down. A command submitted in either window can run beside the workflow. A pre-command, atomic admission API is required for an airtight serial invariant.
- **No tool unregister.** `ExtensionAPI` can register and activate a tool but cannot remove it. The run-scoped `workflow_output` tool is therefore deactivated, not unregistered, after a structured run; its definition stays in the registry for the process lifetime.
- **No in-process cancel outside a model turn.** An RPC or print abort reaches the run only while a model turn is active; the host bridges the aborted `turn_end` to the sandbox signal. A checkpoint-less, pure-shell loop has no active turn to abort, so only a process signal (SIGINT/SIGTERM) or a `--workflow-time` hard deadline stops it.

One related surface is intentionally not a gap: `ExtensionCommandContext` has no `executeTool`. Workflow effects therefore cannot run as native tool rows. This is required. A native tool row would enter the LLM context as a tool call and result, and would violate the shell visibility invariant. The host runs effects outside the tool pipeline. It surfaces them through CustomEntry and UI only.

**Strict argument contracts.** The host rejects a malformed argument by name before the effect runs:

- `workflow.entries`: `after` must be an existing entry id, or the call throws. `limit` must be a non-negative integer. It keeps the last `limit` entries.
- `workflow.readonly`: takes a boolean only. Any other value throws and leaves the posture unchanged.
- `workflow.run` options: `model` is `{ provider, id }`. `thinking` is one of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

## Patterns

Composition idioms the handles above do not spell out. Each is illustrative — the contract above stays authoritative. The [`examples/workflows/`](../examples/workflows/) scripts apply them end to end.

**Resolve before spending.** Detect the project's test command once with a structured run, then gate the loop on a green baseline. Nothing downstream runs on an unknown or red command.

```js
workflow.readonly(true);
let cmd = null;
try {
  const detected = workflow.run("Explain how to run the test suite of this project", {
    output: {
      schema: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string" } } },
      instructions: "Return the single command that runs the full test suite from the repo root; do not run it.",
    },
  });
  cmd = typeof detected.output?.command === "string" ? detected.output.command : null;
} catch { return workflow.exit({ reason: "test-command-unknown" }); }
if (!cmd) return workflow.exit({ reason: "test-command-unknown" });
```

**Checkpoint at salvage points.** Place a checkpoint after the gate and at the end of every round. A pending cost or time stop lands there and salvages that metadata.

```js
workflow.checkpoint({ phase: "baseline", cmd });
```

**Reset context between rounds.** A fresh context keeps a repaired-tree review unbiased. `workflow.new` clears the context and replaces the session; cost stays cumulative.

```js
for (let round = 0; round < MAX_ROUNDS; round++) {
  // review → classify → plan → execute → test
  if (round < MAX_ROUNDS - 1) workflow.new();
  workflow.checkpoint({ round });
}
```

**Readonly is posture, not a hint.** Detect in readonly. Drop it before a shell command that may write caches or artifacts.

```js
workflow.readonly(true);   // detect the command, no side effects
// ...structured detection...
workflow.readonly(false);  // the suite may write
const baseline = workflow.shell(cmd);
```

**One writer of posture per turn.** A script sets posture with `workflow.readonly(...)`. A run target's frontmatter `readonly:` and `model-group:` apply at the start of that run's turn and replace the posture for that turn. Explicit `model` and `thinking` run options override for one turn only.

## Example

[`examples/workflows/review.js`](../examples/workflows/review.js) is the example round loop (a template, not a production run). It gates on a green baseline, then runs review → classify → plan → execute → test per round, with a checkpoint at each round end. Replace `<provider>` / `<classifier-model>` with your classifier model.

The workflow owns termination. `review.js` exits on approval, failing tests, budget exhaustion, or its round limit. `/review-worktree` and `/execute` are project prompt templates or skills, not extension commands. The classifier answers the review's own verdict. Findings come from `workflow.entries`, so the workflow controls their shape.

## See also

- [workflow-engine.md](workflow-engine.md) — engine internals
- [README.md](README.md) — docs index
