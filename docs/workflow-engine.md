# Workflow Engine Internals

Reference for agents and maintainers who modify the `/workflow` engine. The author contract lives in [workflows.md](workflows.md); the docs index is [README.md](README.md). This page explains mechanism only.

## Lifecycle

One `/workflow <file> [args]` run. Each step names its owner module.

| # | Step | Owner | Detail |
|---|---|---|---|
| 1 | Reserve | `workflow/coordinator.ts` | `reserveWorkflow` claims a process-global slot before any await; `workflow/command.ts` releases it in `finally`. |
| 2 | Parse argument | `workflow/file.ts` | `parseWorkflowArgs` splits the first token (name) from the verbatim remainder (args). |
| 3 | Resolve / list | `workflow/file.ts` | `resolveWorkflowPath` resolves path-like names against cwd and bare names against `<cwd>/.pi/workflows` then `<agentDir>/workflows`. A miss lists `listWorkflows` names. |
| 4 | Read | `workflow/file.ts` | `readWorkflow` reads the source; `workflow/command.ts` (`readAndCompile`) wraps the failure. |
| 5 | Compile | `workflow/compile.ts` | `compileWorkflow` parses, validates the synchronous contract, and rewrites calls. |
| 6 | Compose driver | `workflow/driver.ts` | `composeWorkflow` prepends `WORKFLOW_DRIVER`, which defines `defineWorkflow`. |
| 7 | Resolve limits | `workflow/limits-dialog.ts` | `resolveLimits` (defined here, called from `startWorkflow` in `workflow/command.ts`): `--workflow-cost`/`--workflow-time` bypass the dialogs; an interactive session prompts; a headless session runs with no targets. |
| 8 | Build host | `workflow/host.ts` | `createWorkflowHost` via `command.ts` (`buildHost`): run registry, child-usage sink, exit state, and metrics. `host.globals()` supplies the handle list. |
| 9 | Suppress input, arm cancel | `workflow/command.ts` | Installs the `input` handler and the arm-then-confirm cancellation funnel. |
| 10 | Build sandbox | `workflow/sandbox.ts` | `createWorkflowSandbox` clamps the deadline; `command.ts` (`runSandbox`) supplies `MEMORY_LIMIT_BYTES` and `hardDeadlineMs(timeBudgetMs)`. |
| 11 | Seed store | `workflow/command.ts` | `sandbox.execute(compiled, { store: { intent, args }, signal })`; the script reads it with `load`. |
| 12 | Execute | `@earendil-works/pi-codemode` | The QuickJS worker runs the composed script body. |
| 13 | Dispatch handles | `workflow/host.ts` | `executeGuarded` gates, counts, and runs each `workflow.<member>` effect. |
| 14 | Deferred stop / checkpoint | `workflow/host.ts` | `guardDeferredStop` arms a pending stop; `handleCheckpoint` stops there and salvages. |
| 15 | Exit record | `workflow/host.ts` + `workflow/command.ts` | `handleExit`, `handleCheckpoint`, and `recordHardAbortExit` write it; `command.ts` (`recordExitOnce`) enforces exactly one. |
| 16 | Summary | `workflow/summary.ts` | `buildWorkflowSummary`; `command.ts` (`finalizeRun`) appends it. |

## Module map

| File | Responsibility |
|---|---|
| `workflow/activity.ts` | Live shell widget (`workflow-activity`) plus `workflow-shell`/`workflow-log` entry types and renderers. |
| `workflow/autocomplete.ts` | Filesystem-backed `/workflow` name completion provider. |
| `workflow/classify.ts` | `workflow.classify` request handling; never rejects. |
| `workflow/command.ts` | `/workflow` orchestration: budget dialogs, input suppression, cancellation, `new`/`handoff`, exit finalization. |
| `workflow/compile.ts` | acorn parse, synchronous-contract validation, magic-string await rewrite. |
| `workflow/coordinator.ts` | Process-global run reservation and per-session runtime registry. |
| `workflow/driver.ts` | Prepends the injected `defineWorkflow` driver to compiled source. |
| `workflow/card.ts` | Shared bordered-card layout for the activity widget and the summary card. |
| `workflow/errors.ts` | Shared error mapping (`messageOf`) and `safeAppendEntry`, the advisory append. |
| `workflow/file.ts` | Argument parse, path resolution, discovery, source read. |
| `workflow/host.ts` | Host effects: handle dispatch, limits, exit record, run correlation, metrics. |
| `workflow/limits-dialog.ts` | Soft-target resolution: flag bypass, interactive budget/time dialogs, headless no-target fallback; emits the `workflow-limits` entry. |
| `workflow/notebook.ts` | `workflow.notebook*` inspectors and writer. |
| `workflow/output.ts` | Run-scoped structured-output tool (`workflow_output`). |
| `workflow/rebind.ts` | `performNewSession`, `performHandoff`, `rebindRun` + `RebindBundle`/`RebindableDeps`; the per-wait handoff deadline (`HANDOFF_COMPACTION_TIMEOUT_MS`). |
| `workflow/run-registry.ts` | Correlates sent runs with `agent_settled` boundaries; resolves run targets. |
| `workflow/sandbox.ts` | Sandbox construction, timeout clamp, hard-deadline factor. |
| `workflow/shell.ts` | `workflow.shell` through pi's bash tool plus the readonly guard. |
| `workflow/spend.ts` | `SpendState`, `armPendingStop`, `branchSpend`, `runSpendRows`, `computeCurrentCost`, `limitReason`; live cost budget and the target→final overrun projection. |
| `workflow/state-digest.ts` | Derives `workflow.state`/`workflow.entries` digests from branch entries. |
| `workflow/summary-renderer.ts` | Renders the `workflow-summary` entry as a transcript card. |
| `workflow/summary.ts` | `workflow-summary` entry type and pure builder. |
| `workflow/types.ts` | Boundary types; the handle-name union. |

## Compile pipeline

`compileWorkflow(source)` in `workflow/compile.ts` is pure: no pi runtime imports.

**Parse.** acorn with `ecmaVersion: "latest"`, `sourceType: "script"`, `allowReturnOutsideFunction: true`, `locations: true`. The raw source parses in script mode; `allowReturnOutsideFunction` makes the top-level `return` legal. The driver (`composeWorkflow`, `workflow/driver.ts`) is prepended after compilation, never parsed. The compiled output is parsed a second time, so an injected `async` cannot yield invalid JS.

**Shape.** The file MUST be exactly one top-level `return defineWorkflow(<arrow>)` statement. `defineWorkflow` takes a single arrow; the arrow takes exactly one parameter named `workflow`. The driver invokes that arrow with the sandbox's global `workflow` namespace object. The trailing `;` on the driver separates it from the appended source.

**Rewrite.** `insertAwaits` (magic-string) wraps every direct `workflow.<member>(...)` call in `(await ...)`, including optional-chain forms. It prepends `async ` to the arrow when it wrapped at least one call. A call already awaited is not wrapped twice.

**Rejections.** The rules live in [workflows.md](workflows.md) — the author contract owns them (checkpoint rule in "Constraints", language rejections in "Accepted control flow"). Mechanism: every violation throws `WorkflowCompileError` with `line:column`. Non-reference positions (property keys, method names, labels) are exempt from the global-object, dynamic-code, and `workflow` reference checks.

## Sandbox

`workflow/sandbox.ts` builds a `CodemodeSandbox` from `@earendil-works/pi-codemode`; tests inject a factory through `WorkflowSandboxFactory`.

**Globals.** codemode always exposes the built-ins `tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `store`, and `load`. The engine registers no `tools`; it adds the `workflow` namespace as codemode `globals`. codemode groups `workflow.<member>` names into one frozen `workflow` object. The seed store is `{ intent, args }` (both hold the same argument remainder). The script reads it with `load("intent")` / `load("args")`. `console.*` and `text()` produce text output items that `command.ts` (`surfaceConsoleOutput`) appends as one `workflow-log` entry. `store()` writes are not consumed by the engine.

**Memory cap.** `MEMORY_LIMIT_BYTES` in `workflow/command.ts` caps the script heap. Exceeding it fails inside the script as `InternalError: out of memory`.

**Deadline clamp.** `workflow/sandbox.ts` `hardDeadlineMs(timeBudgetMs)` returns `clampTimeoutMs(timeBudgetMs * HARD_DEADLINE_FACTOR)` with `HARD_DEADLINE_FACTOR`, the backstop factor (rule in [workflows.md](workflows.md)). `clampTimeoutMs` clamps a finite positive value to `MAX_TIMEOUT_MS`; a non-finite or non-positive input becomes `Infinity` (no limit). A null time target disables the sandbox deadline. `createWorkflowSandbox` clamps any explicit `timeoutMs` the same way.

**Boundary.** The VM has no timers and no I/O. The compile checks add no network, file, or dynamic-code path. The security posture is stated in [workflows.md](workflows.md) (Constraints).

## Host effects and handles

**Reaching the host.** Each handle is a codemode `globals` entry named `workflow.<member>`. `buildHandle` wraps it in `executeGuarded`, which passes `args` and `context.signal`. `spread: true` delivers multiple call arguments; otherwise codemode passes one. The return value crosses as JSON.

**Two-level, JSON round-trip.** codemode allows at most one dot per global name, so the surface is two-level only (`workflow.notebookRead`, never `workflow.notebook.read`). Arguments and results cross as a JSON round trip. The host re-resolves identifiers against its live runtime; for example, `workflow.run` resolves its target against `pi.getCommands()`.

**Non-overlap.** Compiled workflows are async, so `Promise.all` could interleave two effects. `executeGuarded` sets `state.executing` for the duration of one effect and throws `workflow calls must not overlap` if a second starts. This keeps previews, run markers, and counters consistent.

**Guarded vs inspector split.** Every handle carries a `HandleSpec`.

| Kind | Handles | Behavior |
|---|---|---|
| Guarded | `run`, `handoff`, `classify`, `shell`, `entries`, `notebookWrite`, `readonly`, `new` | `guardDeferredStop` runs first, so a crossed target arms a pending stop. Counted. |
| Inspector | `state`, `budget`, `notebookIndex`, `notebookRead`, `notebookTopic` | Never gated. Stay reachable past a target so the workflow can observe the crossing. Not counted. |
| `checkpoint` | — | Not guarded; counted so progress is visible. |
| `exit` | — | Not guarded; not counted. Terminal. |

`classify` sets `softLifecycle`: lifecycle and escalation failures become a normal aborted `ClassifierResult` instead of a rejection. `counted` defaults to `guarded`; only `checkpoint` overrides it.

## Targets, exit, salvage

Soft targets and author semantics live in [workflows.md](workflows.md). Engine mechanics:

- A crossed target calls `armPendingStop` (`workflow/host.ts`); the crossing effect still runs. `handleCheckpoint` stops the run and salvages the checkpoint metadata.
- `MAX_DEFERRED_EFFECTS` in `workflow/host.ts` bounds guarded effects after a pending stop (rule in [workflows.md](workflows.md)); beyond it `recordHardAbortExit` writes the exit and `abortHost` hard-aborts.
- `HARD_DEADLINE_FACTOR` in `workflow/sandbox.ts` sets the sandbox backstop past the soft time target.
- Reserved abort reasons: the list and the no-reuse rule live in [workflows.md](workflows.md) (`ReservedReason` in `workflow/types.ts` pins the tokens). `handleExit` rejects a workflow reason that reuses one.
- Exactly one `workflow-exit` entry per finished run. `command.ts` (`recordExitOnce`) guards it; `workflow.exit`, a checkpoint stop, a hard abort, or `returned` all converge on it.
- `salvagedPartial` (`command.ts`) attaches the last checkpoint metadata only for a checkpoint stop or an abort after a checkpoint.

## Observable surfaces

All surfaces are CustomEntry or UI only. None enter the LLM context.

| Surface | Owner | Content |
|---|---|---|
| `workflow-exit` entry | `workflow/host.ts`, `workflow/command.ts` | One exit record: exit metadata, `{ reason, partial }`, or `returned`. No registered renderer. |
| `workflow-summary` entry | `workflow/summary.ts`, rendered by `workflow/summary-renderer.ts` | Run overview: reason, elapsed, counts, spend rows, effect log. |
| `workflow-shell` entry | `workflow/activity.ts` | One shell call: exit status, duration, bounded output tail. |
| `workflow-log` entry | `workflow/command.ts` | The script's `console`/`text()` output. |
| `workflow-error` entry | `workflow/command.ts`, `workflow/limits-dialog.ts`, `workflow/host.ts` | Diagnostic `{ phase, error }`. |
| `workflow-limits` entry | `workflow/limits-dialog.ts` | Headless no-target start: `costLimit` and `timeBudgetMs` both null, with a notice. |
| `workflow-activity` widget | `workflow/activity.ts` | Live shell progress above the editor. TUI only. |

`workflow-error` phases: `command.ts` writes `reserve`, `start`, `exit-record`, `summary`, `cleanup`; `limits-dialog.ts` writes `start`; `host.ts` writes `abort`, `effect`, `progress`.

## Process coordination

`workflow/coordinator.ts` keeps one `globalThis`-registered symbol so a module reload shares one map.

- **Reservation.** `reserveWorkflow`/`releaseWorkflow` in `workflow/coordinator.ts` own the process-global slot; the serial invariant it serves is specified in [workflows.md](workflows.md) (Constraints).
- **Runtime registry.** `publishWorkflowRuntime` writes per-session bindings on `session_start`; `discardWorkflowRuntime` removes them on `session_shutdown` and drops the binding only (the reservation is released in `finally`, see Reservation); `takeWorkflowRuntime` consumes a replacement's binding.
- **`workflow.new` rebinding.** `performNewSession` runs `from.newSession({ withSession })`. Inside `withSession`, `rebindRun` calls `takeWorkflowRuntime(nextSessionId)` and throws if the replacement published none. It then swaps `bundle.pi`, `bundle.state`, and the `setReadonly`/`requestHandoff`/`prepareRunFrontmatter` deps; re-installs input suppression and cancellation; reattaches the settled relay; and re-seeds `state.childUsageSink` to the run's installed sink. A cancelled replacement restores the previous context and fails the handle. A failed rebind also restores the snapshot and re-runs `hooks.onRebound`, re-arming input suppression and cancellation on the restored session (workflow/rebind.ts), so the run keeps a live, guarded context.

## Stable vs internal

**Contract.** `WorkflowHandleName` in `workflow/types.ts` is the single source of truth for the `workflow.<member>` surface. Its option and result types are the wire shape. The author-visible semantics live in [workflows.md](workflows.md). `ReservedReason` pins the reserved abort tokens.

**Constants.** The code owns every value. Each contract-visible rule is stated once in [workflows.md](workflows.md). The tables name each constant and the file that owns it.

Contract-visible knobs shape behavior the author contract states:

| Constant | Owner | Rule |
|---|---|---|
| `CANCEL_CONFIRM_MS` | `workflow/command.ts` | [Targets, exit, cancellation, salvage](workflows.md#targets-exit-cancellation-salvage) |
| `HANDOFF_COMPACTION_TIMEOUT_MS` | `workflow/rebind.ts` | [workflow.handoff](workflows.md#workflowhandoff) |
| `MAX_DEFERRED_EFFECTS` | `workflow/host.ts` | [Targets, exit, cancellation, salvage](workflows.md#targets-exit-cancellation-salvage) |
| `HARD_DEADLINE_FACTOR` | `workflow/sandbox.ts` | [Targets, exit, cancellation, salvage](workflows.md#targets-exit-cancellation-salvage) |

Internal knobs stay invisible to the author contract; none is part of it.

| Constant | Owner |
|---|---|
| `MEMORY_LIMIT_BYTES` | `workflow/command.ts` |
| `WORKFLOW_PROGRESS_TICK_MS` | `workflow/command.ts` |
| `MAX_EFFECTS` | `workflow/host.ts` |
| `MAX_TIMEOUT_MS` | `workflow/sandbox.ts` |
| `STRUCTURED_OUTPUT_TOOL` | `workflow/output.ts` |
| `MAX_EFFECT_ROWS` | `workflow/summary-renderer.ts` |
| `MAX_MODELS_COLLAPSED` | `workflow/summary-renderer.ts` |
| `MAX_ENTRY_OUTPUT_LINES` | `workflow/activity.ts` |
| `MAX_ENTRY_OUTPUT_CHARS` | `workflow/activity.ts` |
| `MAX_SUGGESTIONS` | `workflow/autocomplete.ts` |

Entry-type strings are named exports: `WORKFLOW_SUMMARY_ENTRY_TYPE` (`summary.ts`), `WORKFLOW_SHELL_ENTRY_TYPE` and `WORKFLOW_LOG_ENTRY_TYPE` (`activity.ts`), `WORKFLOW_EXIT_ENTRY_TYPE` and `WORKFLOW_ERROR_ENTRY_TYPE` (`types.ts`), `SPAWN_NOTICE_ENTRY_TYPE` (`spawn/shared.ts`). `workflow-limits` stays an inline literal.

## Intentional deviations

- An invalid `--workflow-cost` or `--workflow-time` flag cancels the run (`workflow/limits-dialog.ts`).
- The partial summary row reads `stopped at checkpoint` (`workflow/summary-renderer.ts`).
- The collapsed summary card caps its model rows (`workflow/summary-renderer.ts`).
- The footer has two zones (`tui.ts`).
- `workflow.exit` returns its metadata argument (`workflow/host.ts`).

## See also

- [workflows.md](workflows.md) — author contract
- [architecture.md](architecture.md) — extension architecture
- [README.md](README.md) — docs index
