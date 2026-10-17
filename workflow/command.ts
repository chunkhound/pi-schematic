// WHY: `/workflow` is the single blocking entry point for the workflow engine. This
// module owns the TUI budget dialog, compile/execute orchestration, input
// suppression, cancellation, and the two context-shift deps (`new`, `handoff`).
// A replacement session invalidates the captured pi/state/deps, so every runtime
// reference is read through the live bundle and rebound from the coordinator, and
// all user-visible output goes through ctx.ui — never console.*.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import type { CodemodeResult, CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { SchematicState } from "../state.js";
import { installWorkflowFooter, uninstallWorkflowFooter, updateIndicators, reasonLabel, type WorkflowProgressView } from "../tui.js";
import { discardWorkflowRuntime, publishWorkflowRuntime, releaseWorkflow, reserveWorkflow } from "./coordinator.js";
import { registerWorkflowAutocomplete } from "./autocomplete.js";
import { compileWorkflow } from "./compile.js";
import { composeWorkflow } from "./driver.js";
import { messageOf, notify, safeAppendEntry, withRecordStatus, reportRejectedStart } from "./errors.js";
import { createWorkflowHost, mapSandboxError } from "./host.js";
import { resolveLimits } from "./limits-dialog.js";
import { performHandoff, performNewSession, type RebindableDeps, type RebindBundle, type RebindHooks, type RunCtl } from "./rebind.js";
import { createShellActivity, WORKFLOW_LOG_ENTRY_TYPE, type ShellActivity } from "./activity.js";
import { READONLY_DISABLED_NOTIFICATION, READONLY_ENABLED_STATUS } from "../notifications.js";
import type { ShellRun } from "./shell.js";
import { createWorkflowSandbox, hardDeadlineMs } from "./sandbox.js";
import { WORKFLOW_SUMMARY_ENTRY_TYPE, buildWorkflowSummary } from "./summary.js";
import type { WorkflowHost, WorkflowHostDeps, WorkflowProgress, WorkflowSandboxFactory, ReservedReason, ExitOutcome, ExitRecord, WorkflowErrorPhase } from "./types.js";
import { WORKFLOW_ERROR_ENTRY_TYPE } from "./types.js";
import { parseWorkflowArgs, listWorkflows, readWorkflow, resolveWorkflowPath } from "./file.js";

type CancelKey = "escape" | "ctrl+c";
const CANCEL_KEYS: readonly CancelKey[] = ["escape", "ctrl+c"];
// Arm-then-confirm window for cancellation, matching pi's double-press interrupt guard
// (`lastSigintTime`/`lastEscapeTime`): one stray keypress must not kill a long run.
/** Arm-then-confirm window: two presses of the same cancel key within this window abort. Rule: docs/workflows.md (Targets, exit, cancellation, salvage). */
export const CANCEL_CONFIRM_MS = 500;
const CANCEL_LABEL: Record<CancelKey, string> = { escape: "Escape", "ctrl+c": "Ctrl+C" };
// Sandbox memory cap; listed in docs/workflow-engine.md (Stable vs internal).
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

export interface WorkflowCommandDeps extends RebindableDeps {
	/** Test seam. Production builds the real CodemodeSandbox. */
	sandboxFactory?: WorkflowSandboxFactory;
	/** Test seam: overrides the cancel arm-then-confirm window (default {@link CANCEL_CONFIRM_MS}). */
	cancelConfirmMs?: number;
	/** Test seam: overrides the total handoff deadline for compaction + successor settle (default {@link HANDOFF_COMPACTION_TIMEOUT_MS}). */
	handoffTimeoutMs?: number;
	/** Test seam: progress tick period; production uses {@link WORKFLOW_PROGRESS_TICK_MS}. */
	progressTickMs?: number;
	/** Test seam: replaces pi's bash tool so command tests never spawn. */
	shellRun?: ShellRun;
}

// Elapsed time only advances between host effects, so a one-second ticker keeps the
// indicator honest through long model turns; effect completion republishes at once.
const WORKFLOW_PROGRESS_TICK_MS = 1000;

export function registerWorkflowCommand(pi: ExtensionAPI, state: SchematicState, deps: WorkflowCommandDeps): void {
	pi.registerFlag("workflow-cost", { description: "Soft cost target in USD: stops at the next checkpoint, so the final cost can run over", type: "string" });
	pi.registerFlag("workflow-time", { description: "Soft wall-clock target in milliseconds, e.g. 3600000 for 1 hour: stops at the next checkpoint, so the final time can run over", type: "string" });
	publishRuntimeOnSessionStart(pi, state, deps);
	pi.registerCommand("workflow", {
		description: "Run a workflow: /workflow <workflow> [args]. The workflow runs in a codemode sandbox and owns control flow and the exit.",
		handler: async (raw, ctx) => runWorkflow(pi, state, deps, raw, ctx),
	});
}

/** Publish this runtime's live bindings so a workflow rebinding into a replacement session
 * reaches the current pi/state/deps, not a stale captured set. */
function publishRuntimeOnSessionStart(pi: ExtensionAPI, state: SchematicState, deps: WorkflowCommandDeps): void {
	const publishedFor = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		registerWorkflowAutocomplete(ctx);
		// Partial event contexts (test stubs) may omit the session manager; a missing
		// publication then surfaces explicitly when a replacement tries to rebind.
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return;
		publishedFor.add(sessionId);
		publishWorkflowRuntime(sessionId, { pi, state, setReadonly: deps.setReadonly, requestHandoff: deps.requestHandoff, prepareRunFrontmatter: deps.prepareRunFrontmatter });
	});
	pi.on("session_shutdown", () => {
		// SessionShutdownEvent carries no session id and pi emits shutdown(old) before
		// session_start(new) (agent-session-runtime), so the single slot is safe to discard here.
		for (const sessionId of publishedFor) discardWorkflowRuntime(sessionId);
	});
}

async function runWorkflow(pi: ExtensionAPI, state: SchematicState, deps: WorkflowCommandDeps, raw: string, ctx: ExtensionCommandContext): Promise<void> {
	// A workflow owns serial turns. pi runs an extension command even while streaming, so a
	// mid-turn `/workflow` would dispatch its first `workflow.run` into a busy session, where
	// `sendUserMessage` throws and the fire-and-forget wrapper swallows it, hanging the run.
	if (!ctx.isIdle()) {
		reportStartFailure(pi, ctx, "Cannot start a workflow while the agent is busy. Wait for the current turn to finish, then run /workflow again.");
		return;
	}
	// Claimed before any await: one workflow per process, and the reservation survives
	// session replacements so a replacement cannot admit a second workflow.
	if (!reserveWorkflow()) {
		rejectSecondRun(pi, ctx);
		return;
	}
	try {
		await startWorkflow(pi, state, deps, raw, ctx);
	} finally {
		releaseWorkflow();
	}
}

/** docs/workflows.md (Constraints): a second `/workflow` is rejected with a visible notice. `notify` no-ops
 * headless, so the transcript carries a workflow-error entry instead. */
function rejectSecondRun(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	reportRejectedStart(pi, ctx, "A workflow is already running in this process. Wait for it to finish or press Escape or Ctrl+C twice to cancel it before you start a new one.", "reserve");
}

/** Start-failure visibility: `notify` no-ops headless, so the transcript carries a
 * workflow-error entry instead (mirrors {@link rejectSecondRun}). */
function reportStartFailure(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): void {
	reportRejectedStart(pi, ctx, message, "start");
}

async function startWorkflow(pi: ExtensionAPI, state: SchematicState, deps: WorkflowCommandDeps, raw: string, ctx: ExtensionCommandContext): Promise<void> {
	const program = await resolveProgram(pi, raw, ctx);
	if (!program) return;
	// Compile before limits: a broken workflow must fail without prompting for a budget.
	const outcome = await resolveLimits(pi, ctx, program.hasCheckpoint);
	if (outcome.kind === "cancelled") {
		// An invalid flag already showed its own error; only a user cancel adds the generic notice.
		if (!outcome.notified) notify(ctx, "Workflow cancelled.", "info");
		return;
	}
	await executeWorkflow(
		{ pi, state, deps, limits: outcome.limits, unbounded: !program.hasCheckpoint },
		{ name: program.name, args: program.args, compiled: program.compiled, ctx },
	);
}

/** Resolve the workflow source, or surface why it cannot start. Null means reported and done. */
async function resolveProgram(pi: ExtensionAPI, raw: string, ctx: ExtensionCommandContext): Promise<{ name: string; args: string; compiled: string; hasCheckpoint: boolean } | null> {
	const { name, args } = parseWorkflowArgs(raw);
	if (!name) {
		reportStartFailure(pi, ctx, "Usage: /workflow <workflow> [args]");
		return null;
	}
	const path = resolveWorkflowPath(name, ctx.cwd, getAgentDir());
	if (!path) {
		reportStartFailure(pi, ctx, await workflowNotFound(name, ctx.cwd));
		return null;
	}
	const compiled = await readAndCompile(pi, path, ctx);
	return compiled === null ? null : { name, args, compiled: compiled.code, hasCheckpoint: compiled.hasCheckpoint };
}

/** Name the available workflows so a typo is self-correcting. */
async function workflowNotFound(name: string, cwd: string): Promise<string> {
	const available = (await listWorkflows(cwd, getAgentDir())).map((entry) => entry.name);
	return available.length > 0 ? `Workflow not found: ${name}. Available: ${available.join(", ")}.` : `Workflow not found: ${name}.`;
}

async function readAndCompile(pi: ExtensionAPI, path: string, ctx: ExtensionCommandContext): Promise<{ code: string; hasCheckpoint: boolean } | null> {
	let source: string;
	try {
		source = await readWorkflow(path);
	} catch (error) {
		reportStartFailure(pi, ctx, `Cannot read workflow: ${messageOf(error)}`);
		return null;
	}
	try {
		const compiled = compileWorkflow(source);
		return { code: composeWorkflow(compiled.code), hasCheckpoint: compiled.hasCheckpoint };
	} catch (error) {
		reportStartFailure(pi, ctx, messageOf(error));
		return null;
	}
}


/** Live run bindings with command test seams; rebindable fields come from {@link RebindBundle}. */
interface RunBundle extends RebindBundle {
	deps: WorkflowCommandDeps;
}

interface RunProgram {
	compiled: string;
	args: string;
	name: string;
	ctx: ExtensionCommandContext;
}

/** Fold a host snapshot into the run's view and repaint every visible surface. */
function publishProgress(ctl: RunCtl, bundle: RunBundle, progress: WorkflowProgress): void {
	ctl.progress = { name: ctl.name, ...progress };
	applyWorkflowProgress(ctl, bundle);
}

function applyWorkflowProgress(ctl: RunCtl, bundle: RunBundle): void {
	// No live ctx while replacing: skip the paint; rebindRun repaints on the fresh ctx.
	if (!ctl.progress || !ctl.ctx) return;
	// Persistent indicators feed the non-workflow footer; the unified footer replaces it
	// for the run. Both share the workflow tick so they cannot drift while it drives turns.
	updateIndicators(ctl.ctx, bundle.state);
	installWorkflowFooter(ctl.ctx, () => ({ state: bundle.state, progress: ctl.progress as WorkflowProgressView }));
}

/** Command-owned resubscription applied after every session replacement. The live host owns
 * the run registry (single ownership: no cross-run slot to keep in sync), so the hooks read it
 * straight from the run control; the factory binds one run's ctl, whose host is set before any
 * `workflow.new` can run. */
function rebindHooksFor(ctl: RunCtl): RebindHooks<RunBundle> {
	return {
		onRebound(bundle, ctl, next) {
			ctl.unsubscribeInput();
			ctl.unsubscribeInput = suppressInput(bundle);
			ctl.unsubscribeCancel();
			ctl.unsubscribeCancel = subscribeCancellation(bundle, ctl, next);
			ctl.unsubscribeTurnEnd();
			ctl.unsubscribeTurnEnd = subscribeTurnEnd(bundle, ctl);
			applyWorkflowProgress(ctl, bundle);
		},
		get registry() {
			// rebindRun only runs inside a live run, whose host is already built.
			const registry = ctl.host?.registry;
			if (!registry) throw new Error("workflow run registry is not set");
			return registry;
		},
	};
}

/** Host deps for one run: pi/state are read live through the bundle getters so the host
 * survives replacements (rebindRun swaps bundle.pi/state/deps without rebuilding it).
 * The run registry subscribes to agent_settled lazily on first correlate (deps.pi.on)
 * and resolves runs via getBranch on these live getters; effects are serial, so no run
 * correlation is pending across a rebind. */
function hostDeps(bundle: RunBundle, ctl: RunCtl, onEffect: WorkflowHostDeps["onEffect"]): WorkflowHostDeps {
	return {
		get pi() { return bundle.pi; },
		get state() { return bundle.state; },
		limits: bundle.limits,
		unbounded: bundle.unbounded,
		getCtx: () => ctl.ctx,
		setReadonly: (enabled) => bundle.deps.setReadonly(enabled),
		prepareRunFrontmatter: (text, ctx) => bundle.deps.prepareRunFrontmatter(text, ctx),
		handoff: (direction) => performHandoff(bundle, ctl, direction),
		newSession: () => performNewSession(bundle, ctl, rebindHooksFor(ctl)),
		onProgress: (progress) => publishProgress(ctl, bundle, progress),
		onEffect,
		shellRun: bundle.deps.shellRun,
		// The host never formats UI text: command.ts owns the UI channel and drops it
		// when no live UI context exists.
		notify: (message, tone) => { if (ctl.ctx) notify(ctl.ctx, message, tone); },
		onReadonlyToggled: (enabled) => announceReadonlyToggle(ctl, bundle, enabled),
	};
}

function buildHost(bundle: RunBundle, ctl: RunCtl, onEffect: WorkflowHostDeps["onEffect"]): WorkflowHost {
	return createWorkflowHost(hostDeps(bundle, ctl, onEffect));
}

/** Workflow-driven readonly mirrors `/readonly`'s visible effect: refresh the indicators
 * and notify the human so the posture is visible mid-run. */
function announceReadonlyToggle(ctl: RunCtl, bundle: RunBundle, enabled: boolean): void {
	if (!ctl.ctx) return;
	// Advisory paint: a cosmetic failure must not reject the workflow.readonly handle and abort the run.
	try {
		updateIndicators(ctl.ctx, bundle.state);
		notify(ctl.ctx, enabled ? READONLY_ENABLED_STATUS : READONLY_DISABLED_NOTIFICATION, "info");
	} catch {
		// Advisory chrome only; the posture is already applied.
	}
}

/** Backstop: `reserveWorkflow` guarantees no live run, so a set flag/sink here is stale.
 * `executeWorkflow`'s try/finally owns cleanup for every throw, so this only covers state a
 * prior run could not reach cleanup for (for example a process killed between reserve and
 * teardown). Happy path is already false/null, so this is a noop there. The run registry is
 * owned by the live host and disposed with it, so no cross-run slot needs clearing here. */
function clearStaleRunState(bundle: RunBundle): void {
	bundle.state.inputSuppressed = false;
	bundle.state.childUsageSink = null;
}

/** Open one live run: bindings, shell activity channel, and the host wired to them. */
function openRun(bundle: RunBundle, program: RunProgram): { ctl: RunCtl; host: WorkflowHost; activity: ShellActivity } {
	clearStaleRunState(bundle);
	const ctl: RunCtl = { ctx: program.ctx, host: null, name: program.name, progress: null, unsubscribeInput: () => {}, unsubscribeCancel: () => {}, unsubscribeTurnEnd: () => {} };
	// Shell visibility is UI-only and never enters LLM context: a live widget plus CustomEntry audit rows.
	const activity = createShellActivity({ getPi: () => bundle.pi, getCtx: () => ctl.ctx });
	const host = buildHost(bundle, ctl, (event) => activity.onEffect(event));
	ctl.host = host;
	return { ctl, host, activity };
}

async function executeWorkflow(bundle: RunBundle, program: RunProgram): Promise<void> {
	// One value for the whole opened run: `ctl`, `host` and `activity` are always all-null or all-set.
	let run: ReturnType<typeof openRun> | null = null;
	let stopTicker: () => void = () => {};
	try {
		// ALL setup lives inside the try, including openRun: a throwing binding seam (progress
		// paint, cancel funnel) must still reach the finally so input stays usable and the host
		// gets disposed.
		run = openRun(bundle, program);
		stopTicker = armRun(bundle, run.ctl, run.host, program.ctx);
		await runSandbox(bundle, program, run.host, run.ctl);
	} catch (error) {
		// runSandbox records its own failures; anything escaping it is a setup failure
		// (openRun binding, suppression, cancel, first paint), recorded here so no run ends silently.
		if (run) recordInfraExit(bundle.pi, run.host, run.ctl, error);
		else reportStartFailure(bundle.pi, program.ctx, `workflow failed to start: ${messageOf(error)}`);
	} finally {
		stopTicker();
		if (run) {
			finalizeRun(bundle, run.ctl, run.host);
			releaseRun(bundle, run.ctl, run.host, run.activity);
		}
	}
}

/** Arm input suppression, the cancel funnel, and the first progress paint; start the idle
 * ticker and return its stop. Runs inside executeWorkflow's try so any throw still cleans up. */
function armRun(bundle: RunBundle, ctl: RunCtl, host: WorkflowHost, ctx: ExtensionCommandContext): () => void {
	ctl.unsubscribeInput = suppressInput(bundle);
	ctl.unsubscribeCancel = subscribeCancellation(bundle, ctl, ctx);
	ctl.unsubscribeTurnEnd = subscribeTurnEnd(bundle, ctl);
	publishProgress(ctl, bundle, host.progress());
	return startTicker(bundle, ctl, host);
}

/** Idle backoff: elapsed ticks alone must not repaint every second when no effect is
 * running and nothing material changed. Effect start/end republishes immediately via
 * onProgress, so the ticker only covers long model turns (currentEffect set) and
 * pending-stop flips; otherwise it skips the paint. Baseline is the last published
 * view, so effect-driven publishes also reset the idle comparison. */
function startTicker(bundle: RunBundle, ctl: RunCtl, host: WorkflowHost): () => void {
	const ticker = setInterval(() => {
		// Advisory paint: a throwing UI must not escape the timer and kill pi mid-run.
		try {
			const next = host.progress();
			const prev = ctl.progress;
			const idle = prev !== null && next.currentEffect === null && next.pendingStop === null
				&& prev.currentEffect === null && prev.pendingStop === null
				&& next.costUsd === prev.costUsd && next.checkpoints === prev.checkpoints;
			if (idle) return;
			publishProgress(ctl, bundle, next);
		} catch {
			// Advisory chrome only; the run continues.
		}
	}, bundle.deps.progressTickMs ?? WORKFLOW_PROGRESS_TICK_MS);
	return () => clearInterval(ticker);
}

/** Run one teardown step in isolation: a throw must not skip the steps after it. Teardown is
 * advisory — the run outcome is already recorded — so each step is best-effort. */
function runCleanup(step: () => void): void {
	try {
		step();
	} catch {
		// Advisory teardown only; the next step must still run.
	}
}

/** Release every run-owned resource. Each step is independent, so a throw in one must not
 * leave input suppressed, the cancel funnel armed, the host undisposed, or the footer/indicators
 * unrestored. Order matters: the host (owner of the run registry and the child-usage sink) is
 * disposed first, and chrome is restored last. */
function releaseRun(bundle: RunBundle, ctl: RunCtl, host: WorkflowHost, activity: ShellActivity): void {
	runCleanup(() => ctl.unsubscribeInput());
	runCleanup(() => ctl.unsubscribeCancel());
	runCleanup(() => ctl.unsubscribeTurnEnd());
	runCleanup(() => activity.dispose());
	runCleanup(() => host.dispose());
	// Null the slot BEFORE restoring chrome: a late publishProgress from an orphaned effect
	// then skips, instead of re-installing the footer the run just removed.
	const ctx = ctl.ctx;
	ctl.ctx = null;
	if (ctx) {
		runCleanup(() => uninstallWorkflowFooter(ctx));
		runCleanup(() => updateIndicators(ctx, bundle.state));
	}
}

async function runSandbox(bundle: RunBundle, program: RunProgram, host: WorkflowHost, ctl: RunCtl): Promise<void> {
	let sandbox: CodemodeSandbox | null = null;
	try {
		sandbox = createWorkflowSandbox(
			{ globals: host.globals(), timeoutMs: hardDeadlineMs(bundle.limits), memoryLimitBytes: MEMORY_LIMIT_BYTES },
			bundle.deps.sandboxFactory,
		);
		const result = await sandbox.execute(program.compiled, { store: { intent: program.args, args: program.args }, signal: host.signal });
		reportResult(host, result, ctl);
		surfaceConsoleOutput(bundle.pi, result, ctl.ctx);
	} catch (error) {
		recordInfraExit(bundle.pi, host, ctl, error);
	} finally {
		if (sandbox) await closeSandbox(sandbox, bundle.pi, ctl.ctx);
	}
}

/** Persist the workflow script's `console.log`/`text()` output as a UI-only entry. Advisory:
 * a failed append must never mask the run outcome established by `reportResult`. */
function surfaceConsoleOutput(pi: ExtensionAPI, result: CodemodeResult, ctx: ExtensionCommandContext | null): void {
	const text = result.output
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("")
		.trim();
	if (!text) return;
	// Advisory: visibility only; the exit record and summary already carry the outcome.
	if (!safeAppendEntry(pi, WORKFLOW_LOG_ENTRY_TYPE, { text }) && ctx) advisoryNotify(ctx, "workflow output could not be persisted", "warning");
}

function reportResult(host: WorkflowHost, result: CodemodeResult, ctl: RunCtl): void {
	// Read the exit BEFORE aborting: a controlled checkpoint/exit stop must not be
	// re-labelled as a cancelled/error sandbox abort.
	const exit = host.exitRecord();
	if (result.ok === false && !exit) host.abort(mapSandboxError(result.error, host.abortedReason()), result.error.message);
	const aborted = host.abortedReason();
	// A controlled checkpoint/exit stop is not an error: only a real sandbox failure or the
	// exit record's own escalation message (docs/workflows.md, Targets, exit, cancellation, salvage) carries one.
	const error = exit ? exit.error : result.ok === false ? result.error.message : undefined;
	// A controlled stop already recorded its exit; otherwise this is the run's single write.
	if (!exit) {
		host.recordExit(
			{ reason: aborted ?? "returned", error, partial: salvagedPartial(host, null, result.ok === false || aborted !== null) },
			"error",
		);
	}
	notifyRunOutcome(ctl, exit, aborted, result, error);
}

/** Interactive notice for the run outcome; headless runs rely on the transcript records. */
function notifyRunOutcome(ctl: RunCtl, exit: ReturnType<WorkflowHost["exitRecord"]>, aborted: ReservedReason | null, result: CodemodeResult, error: string | undefined): void {
	if (ctl.ctx?.hasUI) advisoryNotify(ctl.ctx, exitNotice(exit, aborted, result), error !== undefined ? "error" : "info");
}

/** Advisory UI notice: a throwing UI must never escape cleanup or mask the run outcome. */
function advisoryNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		notify(ctx, message, level);
	} catch {
		// Advisory only: the transcript records already stand.
	}
}

/** Infrastructure failure: abort the turn, keep the single-exit invariant, record the error. */
function recordInfraExit(pi: ExtensionAPI, host: WorkflowHost, ctl: RunCtl, error: unknown): void {
	// Read the exit before aborting: a controlled checkpoint/exit stop that reached this
	// path (e.g. its own append threw) must keep its reason, not become "error".
	const exit = host.exitRecord();
	host.abort("error", messageOf(error));
	try {
		// An exit that already recorded itself stays the run's single record.
		if (!exit) host.recordExit(infraOutcome(host, error), "error");
	} catch (recordError) {
		// Both append attempts failed: the run would end with zero persisted records.
		// Surface the loss on whatever surface is left instead of staying silent.
		surfaceLostExitRecord(pi, ctl, recordError);
	}
	notifyInfraFailure(ctl, error);
}

/** Outcome fields for an infra failure, read after `host.abort`: a prior reserved reason wins. */
function infraOutcome(host: WorkflowHost, error: unknown): ExitOutcome {
	return {
		reason: host.abortedReason() ?? "error",
		error: messageOf(error),
		partial: salvagedPartial(host, null, true),
	};
}

/** Advisory notice: the exit record already stands, so a throwing UI never escapes cleanup. */
function notifyInfraFailure(ctl: RunCtl, error: unknown): void {
	if (ctl.ctx) advisoryNotify(ctl.ctx, messageOf(error), "error");
}

/** Salvage (docs/workflows.md, Targets, exit, cancellation, salvage): only a checkpoint stop or an abort after a checkpoint carries the last
 * checkpoint's metadata; a plain `workflow.exit` or a normal return carries none. */
function salvagedPartial(host: WorkflowHost, exit: ExitRecord | null, abortedRun: boolean): unknown {
	if (exit) return exit.partial;
	return abortedRun ? host.checkpointRecord()?.metadata : undefined;
}

/** Last-resort visibility when even the workflow-error append fails on a headless run:
 * no surface is left, so fail the command loudly rather than drop the record silently. */
function surfaceLostExitRecord(pi: ExtensionAPI, ctl: RunCtl, error: unknown): void {
	const message = `workflow exit record could not be persisted: ${messageOf(error)}`;
	try {
		pi.appendEntry(WORKFLOW_ERROR_ENTRY_TYPE, { phase: "exit-record" satisfies WorkflowErrorPhase, error: message });
	} catch {
		if (!ctl.ctx) throw new Error(message, { cause: error });
		notify(ctl.ctx, message, "error");
	}
}

/**
 * End-of-run overview: append the persisted summary card exactly once from the cleanup
 * path, so both the sandbox-success and the sandbox-failure exits show it. The single
 * writer is `host.recordExit`; this only reads the recorded outcome. Advisory: a failed
 * append must never mask the run outcome or escape as a throw from cleanup.
 */
function finalizeRun(bundle: RunBundle, ctl: RunCtl, host: WorkflowHost): void {
	// No live ctx after a replacement that never rebound: still attempt the overview via
	// the last-known-good runtime pi. A rejecting append stays advisory — the exit record
	// already stands, so the single-record invariant is intact either way.
	const exit = host.exitRecord();
	const aborted = host.abortedReason();
	const reason = exit ? exitRecordReason(exit) : aborted ?? "returned";
	const partial = salvagedPartial(host, exit, aborted !== null);
	try {
		bundle.pi.appendEntry(WORKFLOW_SUMMARY_ENTRY_TYPE, buildWorkflowSummary(ctl.name, reason, exit?.error, host.metrics(), partial));
	} catch (error) {
		reportSummaryFailure(bundle.pi, ctl, error);
	}
}

/** Falls back to a UI notice when the advisory append fails; never masks the outcome. */
function reportSummaryFailure(pi: ExtensionAPI, ctl: RunCtl, error: unknown): void {
	const appended = safeAppendEntry(pi, WORKFLOW_ERROR_ENTRY_TYPE, { phase: "summary" satisfies WorkflowErrorPhase, error: messageOf(error) });
	if (!appended && ctl.ctx) advisoryNotify(ctl.ctx, `workflow overview could not be persisted: ${messageOf(error)}`, "warning");
}

/** Reportable reason of an exit record. The host derives every recorded reason with
 * `deriveExitReason` (workflow/types.ts), so `?? "returned"` is only a defensive
 * fallback for an undefined one, never the normal path. */
function exitRecordReason(exit: ExitRecord): string {
	return exit.reason ?? "returned";
}

function exitNotice(exit: ReturnType<WorkflowHost["exitRecord"]>, aborted: ReservedReason | null, result: CodemodeResult): string {
	if (exit) return exit.reason ? reasonLabel(exit.reason) : exitRecordReason(exit);
	if (aborted) return reasonLabel(aborted);
	if (result.ok === false) return result.error.message;
	return "returned";
}

/** A close failure must not mask the run's own outcome: it is always recorded, and noticed when a live ctx exists. */
async function closeSandbox(sandbox: CodemodeSandbox, pi: ExtensionAPI, ctx: ExtensionCommandContext | null): Promise<void> {
	try {
		await sandbox.close();
	} catch (error) {
		const message = `workflow sandbox close failed: ${messageOf(error)}`;
		const recorded = safeAppendEntry(pi, WORKFLOW_ERROR_ENTRY_TYPE, { phase: "cleanup" satisfies WorkflowErrorPhase, error: message });
		if (ctx) advisoryNotify(ctx, withRecordStatus(message, recorded), "warning");
	}
}

/**
 * Suppress non-extension input for the run. Also raises `state.inputSuppressed` so the
 * frontmatter `input` hook (registered at load, hence earlier in pi's dispatch order)
 * skips dropped submissions instead of mutating model/readonly state ahead of the drop.
 * Takes the bundle so rebindRun sets the flag on the replacement's live state.
 *
 * Input exclusion is not atomic, including across `workflow.new`: see docs/workflows.md (Host gaps).
 */
function suppressInput(bundle: RunBundle): () => void {
	// Capture the state: the unsubscribe that runs AFTER a rebind must clear the state
	// this subscription raised, not the replacement's (they are one object in production,
	// but distinct in tests — clearing must not depend on that identity).
	const state = bundle.state;
	// Register before raising the flag: a throwing registration then leaves no stuck flag.
	const off = bundle.pi.on("input", (event) => (event.source === "extension" ? undefined : { action: "handled" as const }));
	state.inputSuppressed = true;
	return () => {
		state.inputSuppressed = false;
		off();
	};
}

/** Bridge pi's per-turn outcome to the host: an aborted turn (RPC/print abort, provider abort)
 * must cancel a live workflow even though only TUI keys reach the key funnel. Child sessions run
 * their own extension runner, so a child's abort never fires this parent handler. */
function subscribeTurnEnd(bundle: RunBundle, ctl: RunCtl): () => void {
	return bundle.pi.on("turn_end", (event) => {
		if (event.outcome === "aborted") ctl.host?.abort("cancelled");
	});
}

/** Register cancellation for a live context. Arm state is per registration, so a
 * `workflow.new` rebind starts with no inherited armed press. */
function subscribeCancellation(bundle: RunBundle, ctl: RunCtl, ctx: ExtensionCommandContext): () => void {
	return registerCancellation(ctx, bundle.deps.cancelConfirmMs ?? CANCEL_CONFIRM_MS, () => ctl.host?.abort("cancelled"));
}

/** Escape / Ctrl+C arm a two-step funnel: the first press warns, a second press of the same
 * key inside the window aborts. This mirrors pi's double-press interrupt guard so a single
 * stray keypress cannot kill a long run. Terminal input is TUI-only. */
function registerCancellation(ctx: ExtensionCommandContext, confirmMs: number, onCancel: () => void): () => void {
	if (ctx.mode !== "tui") return () => {};
	const armedAt = new Map<CancelKey, number>();
	return ctx.ui.onTerminalInput((data) => {
		const press = cancelPressOf(data);
		if (!press) return undefined;
		// A coalesced pair is two physical presses: it already satisfies the guard.
		if (press.confirmed || confirmCancel(armedAt, press.key, Date.now(), confirmMs)) onCancel();
		else notify(ctx, `Press ${CANCEL_LABEL[press.key]} again within ${confirmMs}ms to cancel the workflow`, "warning");
		return { consume: true };
	});
}

/** Map a terminal read to a cancel press, or null to pass it through untouched.
 * pi-tui's StdinBuffer coalesces two Escape presses inside its 10ms escape window into
 * `"\x1b\x1b"` (stdin-buffer.js), which its parser reports as `ctrl+alt+[` and matches
 * against no cancel key (keys.js). Two physical presses must still cancel, so report that
 * read as an already-confirmed Escape. Kitty flag 2 also emits a press then a release for one
 * physical key; `isKeyRelease`/`isKeyRepeat` drop those non-press events. */
export function cancelPressOf(data: string): { key: CancelKey; confirmed: boolean } | null {
	if (data === "\x1b\x1b") return { key: "escape", confirmed: true };
	if (isKeyRelease(data) || isKeyRepeat(data)) return null;
	// Only the funnel's cancel keys are consumed: every other keypress must still reach the
	// editor while a run is active, instead of being swallowed wholesale.
	const key = CANCEL_KEYS.find((candidate) => matchesKey(data, candidate));
	return key ? { key, confirmed: false } : null;
}

/** Arm or confirm per key: a press inside the window consumes the arm and returns true; a
 * first press, or one after the window, (re)arms and returns false. Keys never cross-confirm. */
function confirmCancel(armedAt: Map<CancelKey, number>, key: CancelKey, now: number, windowMs: number): boolean {
	const at = armedAt.get(key);
	armedAt.delete(key);
	if (at !== undefined && now - at < windowMs) return true;
	armedAt.set(key, now);
	return false;
}