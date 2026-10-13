// WHY: one host owns every `workflow.<member>` effect, the cost/time limits, the exit
// record, and the run correlation. Handles are two-level codemode globals. Cost
// includes completed sessions, the live branch, host-charged classifier usage, and
// spawned child agents (the spawn tool reports child usage on its tool result).
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import type { ClassifierResult, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { classifierAbortedResult, classifyRequest } from "./classify.js";
import { messageOf, safeAppendEntry, withRecordStatus } from "./errors.js";
import { notebookIndex, notebookRead, notebookTopic, notebookWrite } from "./notebook.js";
import { createRunRegistry, resolveRunTarget, type RunCorrelation, type RunMatch } from "./run-registry.js";
import { createShellRunner } from "./shell.js";
import { armStructuredOutput, disarmStructuredOutput, type OutputCapture } from "./output.js";
import { addModelSpend, assistantCount, collectUsage, mergeModelSpend, spendRowsTotal } from "../usage.js";
import { armPendingStop, branchSpend, computeCurrentCost, liveBranch, limitReason, runSpendRows, type SpendState } from "./spend.js";
import type { ChildUsageSink } from "../state.js";
import { buildEntryDigests, buildStateDigest, contextPercentOf, lastAssistantModel, lastAssistantText } from "./state-digest.js";
import type {
	Budget,
	CheckpointRecord,
	ClassifierRequest,
	EntriesOptions,
	ExitRecord,
	WorkflowEntry,
	WorkflowHandleName,
	WorkflowHost,
	WorkflowHostDeps,
	WorkflowProgress,
	WorkflowRunMetrics,
	ReservedReason,
	RunOptions,
	RunResult,
	ShellOptions,
	ShellResult,
	StateDigest,
	WorkflowEffect,
	WorkflowEffectEvent,
} from "./types.js";
import { RESERVED_REASONS, WORKFLOW_ERROR_ENTRY_TYPE, WORKFLOW_EXIT_ENTRY_TYPE, deriveExitReason } from "./types.js";

type AnyMessage = { role?: string; stopReason?: string };
// A deferred stop lets a workflow reach its next checkpoint, but an unreachable or
// far-away one must not spend without bound: after this many guarded effects past the
// pending stop the host escalates to a hard abort and salvages the last checkpoint.
// Count pinned by docs/workflows.md (cooperative deferred stop) and docs/workflow-engine.md: 16.
export const MAX_DEFERRED_EFFECTS = 16;
// Bounded effect log for user visibility; the newest entries win on overflow.
export const MAX_EFFECTS = 100;
// A detail is a human-readable label (e.g. the shell command); the run message and output
// live elsewhere. Without a cap, 100 records of long commands bloat the summary entry in
// the session file. Not docs-pinned; the overview truncates further for display.
export const MAX_EFFECT_DETAIL = 200;
type AnyRun = (args: unknown, signal: AbortSignal) => unknown;
type ReplacementOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacementContext = Parameters<NonNullable<ReplacementOptions["withSession"]>>[0];

interface HostState extends SpendState {
	controller: AbortController;
	registry: ReturnType<typeof createRunRegistry>;
	startedAt: number;
	/** Invocation counts per counted handle; the run's technical metrics. Inspectors are absent. */
	counts: Map<WorkflowHandleName, number>;
	/** Assistant messages appended by settled `workflow.run` calls; the run's model round-trips. */
	turns: number;
	previews: string[];
	abortReason: ReservedReason | null;
	exit: ExitRecord | null;
	/** Last `workflow.checkpoint(...)` reached; the salvage payload of a later stop. */
	checkpoint: CheckpointRecord | null;
	/** Reserved reason whose stop awaits the next checkpoint; null until a target is crossed. */
	pendingStop: ReservedReason | null;
	/** Cost/time at the first target crossing; the overshoot baseline for the overview. */
	crossedAt: { costUsd: number; elapsedMs: number } | null;
	/** Guarded effects executed since `pendingStop` was set, bounded by MAX_DEFERRED_EFFECTS. */
	deferredEffects: number;
	exited: boolean;
	disposed: boolean;
	executing: boolean;
	settledRuns: number;
	/** The child-usage sink this host installed; dispose clears it only while still current. */
	installedSink: ChildUsageSink | null;
	activeRun: RunCorrelation | null;
	/** Completed effects for the overview; capped at MAX_EFFECTS. Never sent to the LLM. */
	effects: WorkflowEffect[];
	nextEffectId: number;
	/** Detail of the effect currently running, shown in the footer; null between effects. */
	currentEffect: string | null;
}

interface PreparedRun {
	ctx: ExtensionCommandContext;
	options: RunOptions;
	text: string;
	/** Previews removed from the shared buffer for this run; restored when the send never happened. */
	previewsForRun: string[];
	/** pendingReadonlyCommands depth before this run's frontmatter queued its decision;
	 * the rollback point when the run fails before dispatch (see restoreUnsentRun). */
	readonlyDepth: number;
}

/** Host decided the reserved reason after a failed execute; script/unknown errors are "error". */
export function mapSandboxError(error: { kind: string }, aborted: ReservedReason | null): ReservedReason {
	if (error.kind === "timeout") return "time-limit";
	if (error.kind === "aborted") return aborted ?? "cancelled";
	return aborted ?? "error";
}

function abortHost(deps: WorkflowHostDeps, state: HostState, reason: ReservedReason, message?: string): void {
	if (state.abortReason) return;
	state.abortReason = reason;
	const error = new Error(message ?? reason);
	state.controller.abort(error);
	state.activeRun?.reject(error);
	// The sandbox signal alone stops the workflow, not the model turn it started.
	try {
		// No live ctx during a session replacement; the sandbox signal already stopped the run.
		deps.getCtx()?.abort();
	} catch (error) {
		// The sandbox is stopped, but a provider turn can still consume resources.
		reportHostError(deps, "abort", error);
	}
}

function ensureActive(state: HostState): void {
	if (state.disposed) throw new Error("workflow host disposed");
	if (state.abortReason) throw new Error(`workflow aborted: ${state.abortReason}`);
	if (state.exited) throw new Error("workflow has exited");
}

/** Effect handlers run only between replacements, so a missing ctx here is a real bug. */
function requireCtx(deps: WorkflowHostDeps): ExtensionCommandContext {
	const ctx = deps.getCtx();
	if (!ctx) throw new Error("workflow has no live session context");
	return ctx;
}

/**
 * The only writer of `state.exit`. Append first: a failed append aborts with `abortReason`
 * and leaves `exit` null, so the infra path still records the single exit entry.
 * `messagePrefix` labels the abort message of the failed append.
 */
function commitExit(deps: WorkflowHostDeps, state: HostState, record: { entry: unknown; exit: ExitRecord; abortReason: ReservedReason; messagePrefix?: string }): void {
	try {
		deps.pi.appendEntry(WORKFLOW_EXIT_ENTRY_TYPE, record.entry);
	} catch (error) {
		// A failed append must not prevent the host from aborting with the correct reason.
		abortHost(deps, state, record.abortReason, `${record.messagePrefix ?? ""}${messageOf(error)}`);
		throw error;
	}
	state.exit = record.exit;
}

/** Hard-abort exit: salvage the last checkpoint (null when none) as the single exit record. The escalation message is part of the record (docs/workflows.md, Exit: reserved reason plus the error message). */
function recordHardAbortExit(deps: WorkflowHostDeps, state: HostState, error: string): void {
	if (state.exit) return;
	const checkpoint = state.checkpoint;
	const partial = checkpoint?.metadata ?? null;
	commitExit(deps, state, {
		entry: { reason: state.pendingStop, partial, error },
		exit: { reason: state.pendingStop ?? undefined, metadata: partial, error, ...(checkpoint ? { checkpoint: true } : {}) },
		abortReason: state.pendingStop ?? "error",
	});
}

/**
 * Cooperative deferred stop: crossing a target arms `pendingStop` and lets the crossing
 * effect run; the workflow stops at its next checkpoint. Guarded effects past that point
 * are bounded so an unreachable checkpoint cannot spend without bound. Inspectors that
 * cannot reach a checkpoint do not run here at all.
 */
function guardDeferredStop(deps: WorkflowHostDeps, state: HostState, softLifecycle = false): void {
	// softLifecycle handles convert lifecycle failures themselves (see executeGuarded).
	if (!softLifecycle) ensureActive(state);
	const reason = limitReason(deps, state);
	if (state.pendingStop) {
		if (++state.deferredEffects > MAX_DEFERRED_EFFECTS) {
			// pendingStop is a reserved REASON (e.g. cost-limit), not a location — say "stop", not "checkpoint".
			const message = `workflow hard-aborted after ${MAX_DEFERRED_EFFECTS} deferred effects past the ${state.pendingStop} stop`;
			recordHardAbortExit(deps, state, message);
			abortHost(deps, state, state.pendingStop, message);
			throw new Error(message);
		}
	} else if (reason) {
		armPendingStop(deps, state, reason);
	}
}

/** Abort the sandbox signal WITHOUT a reserved abort reason: a controlled stop the workflow chose. */
function stopSandbox(state: HostState, message: string): void {
	state.exited = true;
	state.controller.abort(new Error(message));
}

function buildDigest(deps: WorkflowHostDeps, state: HostState): StateDigest {
	const ctx = requireCtx(deps);
	const branch = ctx.sessionManager.getBranch();
	return buildStateDigest({
		sessionId: ctx.sessionManager.getSessionId(),
		leafId: ctx.sessionManager.getLeafId(),
		branch,
		contextPercent: contextPercentOf(ctx.getContextUsage()),
		activeTools: deps.pi.getActiveTools(),
		readonly: deps.isReadonly(),
		notebookTopic: deps.state.activeNotebookTopic,
		notebookTopicSource: deps.state.activeNotebookTopicSource,
		settledRuns: state.settledRuns,
		cost: computeCurrentCost(deps, state),
	});
}

/** Remainders measure to the soft targets: null means no target, so no sentinel leaks into JSON or remainder math. Both can read 0 while the run still reaches its next checkpoint. */
function buildBudget(deps: WorkflowHostDeps, state: HostState): Budget {
	const cost = computeCurrentCost(deps, state);
	const costLimit = deps.limits.costLimit;
	const timeBudget = deps.limits.timeBudgetMs;
	return {
		cost,
		costRemaining: costLimit === null ? null : Math.max(0, costLimit - cost),
		timeRemainingMs: timeBudget === null ? null : Math.max(0, timeBudget - (Date.now() - state.startedAt)),
	};
}

function buildEntries(deps: WorkflowHostDeps, args: unknown): WorkflowEntry[] {
	const options = (args ?? {}) as EntriesOptions;
	return buildEntryDigests(requireCtx(deps).sessionManager.getBranch(), options);
}

function handleHandoff(deps: WorkflowHostDeps, state: HostState, args: unknown): Promise<null> {
	if (typeof args !== "string" || !args.trim()) throw new Error("workflow.handoff requires a non-empty direction");
	return deps.handoff(args).then(() => {
		state.settledRuns += 1;
		return null;
	});
}

// The per-call context.signal covers sandbox timeout, script end, and host abort,
// so `ctx.modelRegistry.classify` stops provider work instead of outliving the run.
// docs/workflows.md (workflow.classify): "classify never rejects" — a run that ends before classify (disposed, aborted,
// exited, or in a session-replacement gap) still gets a normal result with no provider
// work, and the deferred-stop escalation in executeGuarded converts the same way
// (see abortedClassifyResult). Provider failures stay inside classifyRequest, which
// converts them itself.
async function handleClassify(deps: WorkflowHostDeps, state: HostState, args: unknown, signal: AbortSignal): Promise<ClassifierResult> {
	try {
		return await classifyViaRegistry(deps, state, args, signal);
	} catch (error) {
		return abortedClassifyResult(error);
	}
}

/** Lifecycle or escalation failure → a normal aborted result; `classify` never rejects. */
function abortedClassifyResult(error: unknown): ClassifierResult {
	return classifierAbortedResult({ provider: "unknown", id: "unknown" }, messageOf(error));
}

async function classifyViaRegistry(deps: WorkflowHostDeps, state: HostState, args: unknown, signal: AbortSignal): Promise<ClassifierResult> {
	ensureActive(state);
	const ctx = requireCtx(deps);
	const result = await classifyRequest(
		{
			getModels: () => ctx.modelRegistry.getModelsOfType("classifier"),
			classify: (model, context, options) => ctx.modelRegistry.classify(model, context, options),
		},
		args as ClassifierRequest,
		signal,
	);
	if (result.usage) addModelSpend(state.classifierSpend, result.provider, result.model, result.usage);
	return result;
}

/** pi's configured shell path; the bash tool falls back to its own resolution order when absent. */
function shellPathOf(deps: WorkflowHostDeps): string | undefined {
	return deps.pi.getSettings().shellPath;
}

/** Transcript visibility is best-effort: reporting must never break the run it describes. Interactive runs also surface the failure as a UI notice, which names a failed record. */
function reportHostError(deps: WorkflowHostDeps, phase: string, error: unknown): void {
	const message = `workflow ${phase} failed: ${messageOf(error)}`;
	// Advisory: the exit record and summary carry the outcome.
	const recorded = safeAppendEntry(deps.pi, WORKFLOW_ERROR_ENTRY_TYPE, { phase, error: messageOf(error) });
	try {
		deps.notify?.(withRecordStatus(message, recorded), "error");
	} catch {
		// Advisory only; the transcript carries the failure when the append succeeded.
	}
}

/** Visibility callbacks are advisory: a throwing UI is reported, never propagated. */
function safeOnEffect(deps: WorkflowHostDeps, event: WorkflowEffectEvent): void {
	try {
		deps.onEffect?.(event);
	} catch (error) {
		reportHostError(deps, "effect", error);
	}
}

/** Push one progress snapshot. Visibility callbacks are advisory (contract above safeOnEffect):
 * a throwing UI is reported, never propagated, so it never rejects an effect or leaves state.currentEffect stale. */
function safeEmitProgress(deps: WorkflowHostDeps, state: HostState): void {
	try {
		deps.onProgress?.(currentProgress(deps, state));
	} catch (error) {
		reportHostError(deps, "progress", error);
	}
}

/** Open an effect record and tell the UI it started. The detail is capped here, at capture:
 * every downstream consumer (live widget, bounded log, summary entry) inherits the bound. */
function startEffect(deps: WorkflowHostDeps, state: HostState, name: WorkflowEffect["name"], rawDetail: string): WorkflowEffect {
	const detail = rawDetail.length > MAX_EFFECT_DETAIL ? `${rawDetail.slice(0, MAX_EFFECT_DETAIL - 3)}...` : rawDetail;
	const effect: WorkflowEffect = { id: state.nextEffectId++, name, detail, ok: true, durationMs: 0 };
	state.currentEffect = detail;
	safeOnEffect(deps, { phase: "start", effect });
	safeEmitProgress(deps, state);
	return effect;
}

/** Commit an effect to the bounded log and tell the UI it ended. */
function endEffect(deps: WorkflowHostDeps, state: HostState, effect: WorkflowEffect, patch: Partial<WorkflowEffect>): void {
	const done = { ...effect, ...patch };
	state.currentEffect = null;
	// The overview keeps only the row; the per-call output lives in the workflow-shell
	// CustomEntry, so the summary entry cannot duplicate up to MAX_EFFECTS large outputs.
	state.effects.push({ ...done, output: undefined });
	if (state.effects.length > MAX_EFFECTS) state.effects.splice(0, state.effects.length - MAX_EFFECTS);
	safeOnEffect(deps, { phase: "end", effect: done });
}

async function handleShell(deps: WorkflowHostDeps, state: HostState, args: unknown[], contextSignal: AbortSignal): Promise<ShellResult> {
	const [command, options] = args;
	const ctx = requireCtx(deps);
	const effect = startEffect(deps, state, "shell", typeof command === "string" ? command : "");
	const startedAt = Date.now();
	const runner = buildShellRunner(deps, state, ctx, effect, contextSignal);
	try {
		const result = await runner(command, (options ?? {}) as ShellOptions);
		endEffect(deps, state, effect, shellEndPatch(result, Date.now() - startedAt));
		return result;
	} catch (error) {
		endEffect(deps, state, effect, { ok: false, durationMs: Date.now() - startedAt });
		throw error;
	}
}

/** Build the runner for one shell effect: host+context abort signals combined, live ctx,
 * and advisory output fan-out (a throwing UI is reported, never fails the shell). */
function buildShellRunner(deps: WorkflowHostDeps, state: HostState, ctx: ExtensionCommandContext, effect: WorkflowEffect, contextSignal: AbortSignal): (command: unknown, options?: ShellOptions) => Promise<ShellResult> {
	return createShellRunner({
		cwd: ctx.cwd,
		signal: AbortSignal.any([state.controller.signal, contextSignal]),
		isReadonly: deps.isReadonly,
		shellPath: shellPathOf(deps),
		ctx,
		onOutput: (display) => safeOnEffect(deps, { phase: "update", effect, display }),
		run: deps.shellRun,
	});
}

/** Shell result → end-of-effect patch for the bounded log; fullOutputPath rides only when present. */
function shellEndPatch(result: ShellResult, durationMs: number): Partial<WorkflowEffect> {
	return {
		ok: result.ok,
		durationMs,
		exitCode: result.exitCode,
		killed: result.killed,
		truncated: result.truncated,
		...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
		output: result.display,
	};
}

function handleReadonly(deps: WorkflowHostDeps, state: HostState, args: unknown): { readonly: boolean } {
	ensureActive(state);
	requireCtx(deps);
	// Strict: a coerced value such as "false" would silently enable readonly.
	if (typeof args !== "boolean") throw new Error(`workflow.readonly takes a boolean, got ${typeof args}`);
	const enabled = deps.setReadonly(args);
	// Mirror `/readonly`'s observable effect (indicator refresh + notice) through the
	// command-owned UI channel, so the posture is visible mid-run.
	deps.onReadonlyToggled?.(enabled);
	return { readonly: enabled };
}

async function handleNew(deps: WorkflowHostDeps, state: HostState): Promise<null> {
	ensureActive(state);
	// WHY: baseline folds only the settled run portion. The pre-run conversation is excluded
	// by id and child spend lives in the run-scoped child ledger, so only the run rows
	// (child-owned tool results skipped) commit after the replacement succeeds. A
	// cancelled `workflow.new` therefore cannot double-count the unchanged branch.
	const spend = branchSpend(deps, state);
	await deps.newSession();
	state.baselineSpend = mergeModelSpend(state.baselineSpend, spend);
	return null;
}

/**
 * Final run metrics. Rows and total are one projection: `costUsd` is the row sum, never a
 * parallel snapshot, so the overview cannot hide unattributed spend in a residual row.
 */
function buildMetrics(deps: WorkflowHostDeps, state: HostState): WorkflowRunMetrics {
	const rows = runSpendRows(deps, state);
	return {
		startedAt: state.startedAt,
		elapsedMs: Date.now() - state.startedAt,
		checkpoints: state.counts.get("checkpoint") ?? 0,
		steps: state.counts.get("run") ?? 0,
		turns: state.turns,
		classifySteps: state.counts.get("classify") ?? 0,
		activity: Object.fromEntries(state.counts) as Partial<Record<WorkflowHandleName, number>>,
		costUsd: spendRowsTotal(rows),
		spend: [...rows.values()].sort((a, b) => b.costUsd - a.costUsd),
		limits: deps.limits,
		unbounded: deps.unbounded,
		crossedAt: state.crossedAt,
		effects: state.effects,
	};
}

/** Reject workflow-supplied reasons that collide with the host's reserved abort tokens. */
function validateExitReason(reason: string): void {
	if ((RESERVED_REASONS as readonly string[]).includes(reason)) {
		throw new Error(`workflow.exit: "${reason}" is a reserved abort reason; use a different reason`);
	}
}

function handleExit(deps: WorkflowHostDeps, state: HostState, args: unknown): unknown {
	ensureActive(state);
	const metadata = (args ?? null) as Record<string, unknown> | null;
	const reason = deriveExitReason(metadata);
	validateExitReason(reason);
	commitExit(deps, state, { entry: metadata, exit: { reason, metadata }, abortReason: "error" });
	// `workflow.exit` is terminal: stop the script at this call, unlike a checkpoint's deferral.
	stopSandbox(state, "workflow exit");
	return metadata;
}

/**
 * Safe exit point: record the partial result, then stop here if a limit was crossed or
 * already pending (a deferred stop). Otherwise continue. The engine stops at a
 * checkpoint, never mid-effect, so the recorded metadata is always consistent.
 */
function handleCheckpoint(deps: WorkflowHostDeps, state: HostState, args: unknown): unknown {
	ensureActive(state);
	const metadata = args ?? null;
	state.checkpoint = { metadata, at: Date.now() };
	const reason = limitReason(deps, state);
	if (reason && !state.pendingStop) armPendingStop(deps, state, reason);
	if (!state.pendingStop) return metadata;
	// Aborting with the pending-stop reason (first-wins) keeps the infra retry from re-labelling
	// the stop as a generic "error".
	commitExit(deps, state, {
		entry: { reason: state.pendingStop, partial: metadata },
		exit: { reason: state.pendingStop, metadata, checkpoint: true },
		abortReason: state.pendingStop,
		messagePrefix: "checkpoint exit append failed: ",
	});
	stopSandbox(state, `workflow stopped at checkpoint: ${state.pendingStop}`);
	return metadata;
}

/** Accounting/gating contract for one `workflow.<member>` handle. */
interface HandleSpec {
	/** Cost/time limit gate: the host checks limits before the effect runs. */
	guarded: boolean;
	/** Lifecycle self-gated: the handler converts disposed/aborted/exited/no-ctx failures to a normal result; the deferred-stop escalation throw is converted in executeGuarded. */
	softLifecycle?: boolean;
	/** Accounting: counted handles feed the run's technical metrics. Defaults to `guarded`. */
	counted?: boolean;
	spread: boolean;
}

function buildHandle(name: WorkflowHandleName, spec: HandleSpec, run: AnyRun, state: HostState, deps: WorkflowHostDeps): CodemodeTool {
	return {
		name: `workflow.${name}`,
		spread: spec.spread,
		execute: (args, context) => executeGuarded(name, spec, () => run(args, context.signal), state, deps),
	};
}

// Serial-effects invariant; the overlap guard test matches this message.
const OVERLAP_ERROR = "workflow calls must not overlap: workflow effects are serial — never run workflow.* calls in Promise.all; await each call in turn (a serial loop) instead";

/** Deferred-stop gate for one guarded call. Returns a normal aborted result when a
 * soft-lifecycle handle is blocked by escalation (classify never rejects); rethrows otherwise. */
function gateRun(deps: WorkflowHostDeps, state: HostState, spec: HandleSpec): unknown {
	try {
		guardDeferredStop(deps, state, spec.softLifecycle);
	} catch (error) {
		// Escalation already aborted the host and wrote the single exit record, but a
		// soft-lifecycle handle must still return a normal result: classify never rejects.
		if (!spec.softLifecycle) throw error;
		return abortedClassifyResult(error);
	}
	return undefined;
}

async function executeGuarded(name: WorkflowHandleName, spec: HandleSpec, run: () => unknown, state: HostState, deps: WorkflowHostDeps): Promise<unknown> {
	// Classify never rejects: it self-gates lifecycle failures (see handleClassify) so a
	// run ended before classify gets a normal aborted result, not a workflow error.
	if (!spec.softLifecycle) ensureActive(state);
	if (state.executing) throw new Error(OVERLAP_ERROR);
	if (spec.guarded) {
		const blocked = gateRun(deps, state, spec);
		if (blocked !== undefined) return blocked;
	}
	state.executing = true;
	try {
		return await run();
	} finally {
		state.executing = false;
		// Count only accounted handles: inspectors must not inflate the metrics a human reads
		// as real progress. Blocked effects (rejected gate or overlap) never reach this finally.
		if (spec.counted ?? spec.guarded) state.counts.set(name, (state.counts.get(name) ?? 0) + 1);
		safeEmitProgress(deps, state);
	}
}

/** One snapshot shape for both push (effect done) and pull (elapsed tick). */
function currentProgress(deps: WorkflowHostDeps, state: HostState): WorkflowProgress {
	return {
		checkpoints: state.counts.get("checkpoint") ?? 0,
		costUsd: computeCurrentCost(deps, state),
		elapsedMs: Date.now() - state.startedAt,
		pendingStop: state.pendingStop,
		limits: deps.limits,
		unbounded: deps.unbounded,
		currentEffect: state.currentEffect,
	};
}

function buildNotebookDeps(deps: WorkflowHostDeps, state: HostState): { pi: typeof deps.pi; state: typeof deps.state; bufferPreview: (preview: string) => void } {
	return {
		get pi() { return deps.pi; },
		get state() { return deps.state; },
		bufferPreview: (preview: string) => state.previews.push(preview),
	};
}

/**
 * Public contract: each `workflow.<member>` global maps to its option/result types in
 * `types.ts` (codemode allows at most one dot per global name). The `WorkflowHandleName`
 * union and its option/result types there are the single source of truth.
 */
function buildGlobals(deps: WorkflowHostDeps, state: HostState): CodemodeTool[] {
	const specs = buildHandleSpecs(deps, state, buildNotebookDeps(deps, state));
	// The map keys ARE the built handles, so assembly cannot omit one.
	return (Object.keys(specs) as WorkflowHandleName[]).map((name) => {
		const { run, ...spec } = specs[name];
		return buildHandle(name, spec, run, state, deps);
	});
}

type HandleSpecEntry = HandleSpec & { run: AnyRun };

/** Spec+handler for every `workflow.<member>` handle. The Record annotation is the
 * compile-time exhaustiveness guard: a new WorkflowHandleName member in types.ts fails
 * here (missing key) until its entry is declared; an unknown key fails excess-property
 * check, so the map cannot drift from the union in either direction. */
function buildHandleSpecs(deps: WorkflowHostDeps, state: HostState, notebookDeps: ReturnType<typeof buildNotebookDeps>): Record<WorkflowHandleName, HandleSpecEntry> {
	return {
		run: { guarded: true, spread: true, run: (args) => handleRun(deps, state, args as unknown[]) },
		handoff: { guarded: true, spread: false, run: (args) => handleHandoff(deps, state, args) },
		classify: { guarded: true, softLifecycle: true, spread: false, run: (args, signal) => handleClassify(deps, state, args, signal) },
		shell: { guarded: true, spread: true, run: (args, signal) => handleShell(deps, state, args as unknown[], signal) },
		state: { guarded: false, spread: false, run: () => buildDigest(deps, state) },
		entries: { guarded: true, spread: false, run: (args) => buildEntries(deps, args) },
		notebookIndex: { guarded: false, spread: false, run: () => notebookIndex(deps.state) },
		notebookRead: { guarded: false, spread: false, run: (args) => notebookRead(deps.state, args) },
		notebookWrite: { guarded: true, spread: false, run: (args) => notebookWrite(notebookDeps, args) },
		notebookTopic: { guarded: false, spread: false, run: () => notebookTopic(deps.state) },
		budget: { guarded: false, spread: false, run: () => buildBudget(deps, state) },
		readonly: { guarded: true, spread: false, run: (args) => handleReadonly(deps, state, args) },
		new: { guarded: true, spread: false, run: () => handleNew(deps, state) },
		checkpoint: { guarded: false, counted: true, spread: false, run: (args) => handleCheckpoint(deps, state, args) },
		exit: { guarded: false, spread: false, run: (args) => handleExit(deps, state, args) },
	};
}

/** Apply the explicit `workflow.run` model for this turn; an unknown or unauthenticated model fails the run. */
async function applyModelOverride(deps: WorkflowHostDeps, ctx: ExtensionCommandContext, options: RunOptions): Promise<void> {
	if (!options.model) return;
	const model = ctx.modelRegistry.getModelOfType("chat", options.model.provider, options.model.id);
	if (!model) throw new Error(`model not found: ${options.model.provider}/${options.model.id}`);
	if (!(await deps.pi.setModel(model)))
		throw new Error(`cannot authenticate model: ${options.model.provider}/${options.model.id}`);
}

/** Built BEFORE any mutation: if setThinkingLevel throws after setModel succeeded,
 * the changed model must still be restored. */
function buildOverrideRestore(
	deps: WorkflowHostDeps,
	options: RunOptions,
	previousModel: ExtensionCommandContext["model"],
	previousThinking: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): () => Promise<void> {
	return async (): Promise<void> => {
		// Restore each field independently: a throwing setModel must not skip the thinking restore.
		// Aggregate both failures so neither is masked.
		const failures: unknown[] = [];
		if (options.model && previousModel) {
			try {
				await deps.pi.setModel(previousModel);
			} catch (error) {
				failures.push(error);
			}
		}
		if (options.thinking) {
			try {
				deps.pi.setThinkingLevel(previousThinking);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0)
			throw new Error(`workflow.run override restore failed: ${failures.map(messageOf).join("; ")}`);
	};
}

async function applyOverrides(deps: WorkflowHostDeps, ctx: ExtensionCommandContext, options: RunOptions): Promise<() => Promise<void>> {
	const restore = buildOverrideRestore(deps, options, ctx.model, deps.pi.getThinkingLevel());
	try {
		await applyModelOverride(deps, ctx, options);
		if (options.thinking) deps.pi.setThinkingLevel(options.thinking as ThinkingLevel);
	} catch (error) {
		throw await joinRestoreFailure(error, restore);
	}
	return restore;
}

/** Restore after a failed override. A restore failure joins the original message, so neither error is masked. */
async function joinRestoreFailure(error: unknown, restore: () => Promise<void>): Promise<unknown> {
	try {
		await restore();
		return error;
	} catch (restoreError) {
		return new Error(`${messageOf(error)}; ${messageOf(restoreError)}`, { cause: error });
	}
}

function composeInput(previewsForRun: readonly string[], input: unknown): string {
	const blocks = [...previewsForRun];
	if (input !== undefined) blocks.push(typeof input === "string" ? input : JSON.stringify(input));
	return blocks.filter((block) => block.length > 0).join("\n");
}

function buildRunMessage(invocation: string, options: RunOptions, previewsForRun: readonly string[]): string {
	const line = options.args ? `${invocation} ${String(options.args)}` : invocation;
	const input = composeInput(previewsForRun, options.input);
	return input ? `${line}\n\n\`\`\`\n${input}\n\`\`\`` : line;
}

function dispatchMessage(deps: WorkflowHostDeps, ctx: ExtensionCommandContext, text: string): void | Promise<void> {
	const replaced = ctx as ExtensionCommandContext & Partial<ReplacementContext>;
	const options = { expandPromptTemplates: true };
	return replaced.sendUserMessage ? replaced.sendUserMessage(text, options) : deps.pi.sendUserMessage(text, options);
}

// Subscribe before either send: replacement sends propagate errors, initial sends
// expose only void. In both sessions only agent_settled defines the final branch.
// Initial-session dispatch failures are invisible to the host: see docs/workflows.md (Host gaps).
async function sendCorrelated(deps: WorkflowHostDeps, state: HostState, ctx: ExtensionCommandContext, marker: string | null, text: string, onDispatched?: () => void): Promise<RunMatch> {
	const correlation = state.registry.correlate(marker);
	state.activeRun = correlation;
	try {
		await dispatchMessage(deps, ctx, text);
		onDispatched?.();
		const match = await correlation.promise;
		rejectIfTerminalFailure(match.branch);
		return match;
	} catch (error) {
		correlation.reject(error);
		throw error;
	} finally {
		state.activeRun = null;
	}
}

// Reject the run if the final assistant has error/aborted stopReason; allow retries otherwise.
function rejectIfTerminalFailure(branch: readonly import("@earendil-works/pi-coding-agent").SessionEntry[]): void {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && (entry.message as AnyMessage).role === "assistant") {
			const stopReason = (entry.message as AnyMessage).stopReason;
			if (stopReason === "error" || stopReason === "aborted") {
				throw new Error(`run failed: ${stopReason}`);
			}
			return;
		}
	}
}

const RUN_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
// Compile guard: a ThinkingLevel member missing from RUN_THINKING_LEVELS fails here.
type RunThinkingExhaustive = Exclude<ThinkingLevel, (typeof RUN_THINKING_LEVELS)[number]> extends never ? true : never;
const RUN_THINKING_EXHAUSTIVE: RunThinkingExhaustive = true;
void RUN_THINKING_EXHAUSTIVE;

function isModelRef(value: unknown): value is NonNullable<RunOptions["model"]> {
	const ref = value as Partial<Record<"provider" | "id", unknown>> | null;
	return typeof ref === "object" && ref !== null && typeof ref.provider === "string" && typeof ref.id === "string";
}

/** Run options arrive untyped from workflow JS: reject a bad field by name before any state changes. */
function parseRunOptions(raw: unknown): RunOptions {
	const options = raw ?? {};
	if (typeof options !== "object" || Array.isArray(options)) throw new Error("workflow.run: options must be an object");
	const { model, thinking } = options as RunOptions;
	if (model !== undefined && !isModelRef(model)) throw new Error("workflow.run: options.model must be { provider: string, id: string }");
	if (thinking !== undefined && !(RUN_THINKING_LEVELS as readonly unknown[]).includes(thinking))
		throw new Error(`workflow.run: options.thinking must be one of ${RUN_THINKING_LEVELS.join(", ")}`);
	return options as RunOptions;
}

function prepareRun(deps: WorkflowHostDeps, state: HostState, args: unknown[]): PreparedRun {
	const target = resolveRunTarget(deps.pi.getCommands(), args[0] as string);
	const options = parseRunOptions(args[1]);
	// WHY (preview-buffer + marker-after-override invariant): previews buffer until
	// frontmatter and overrides succeed, and the marker is captured after overrides
	// (setModel/setThinkingLevel append branch entries that would shift fromEntryId).
	// A rejected target, blocked model, or failed override therefore keeps the buffered
	// previews for the next successful run instead of dropping or double-sending them.
	// WHY (live-ctx-first invariant): a replacement gap must fail before the buffer is
	// touched, so the previews stay buffered for the next run instead of being dropped.
	const ctx = requireCtx(deps);
	const previewsForRun = state.previews.splice(0);
	return { ctx, options, text: buildRunMessage(target.text, options, previewsForRun), previewsForRun, readonlyDepth: deps.state.pendingReadonlyCommands.length };
}

/** A run that failed before dispatch leaves no trace in shared state: the buffered previews
 * return for the next run, and the frontmatter's queued readonly decision is dropped —
 * otherwise a later human command would consume this workflow turn's decision
 * (index.ts pendingReadonlyCommands is only drained by the next agent run). */
function restoreUnsentRun(deps: WorkflowHostDeps, state: HostState, prepared: PreparedRun): void {
	state.previews.unshift(...prepared.previewsForRun);
	const queue = deps.state.pendingReadonlyCommands;
	// Guard against a shrink: only roll back what this run's frontmatter pushed.
	if (queue.length > prepared.readonlyDepth) queue.length = prepared.readonlyDepth;
}

/** Frontmatter resolves before overrides: explicit RunOptions win for the turn, while a
 * frontmatter model persists as the post-run session model. Returns the post-override
 * branch marker and the override restore. */
async function primeRunTurn(deps: WorkflowHostDeps, prepared: PreparedRun): Promise<{ marker: string | null; restore: () => Promise<void> }> {
	await deps.prepareRunFrontmatter(prepared.text, prepared.ctx);
	const restore = await applyOverrides(deps, prepared.ctx, prepared.options);
	// WHY (marker-after-override invariant): setModel/setThinkingLevel append branch
	// entries, so a pre-override marker would shift fromEntryId and matchRun's branch.
	return { marker: prepared.ctx.sessionManager.getLeafId(), restore };
}

async function settleRun(deps: WorkflowHostDeps, state: HostState, prepared: PreparedRun, marker: string | null, onDispatched?: () => void): Promise<RunResult> {
	const match = await sendCorrelated(deps, state, prepared.ctx, marker, prepared.text, onDispatched);
	state.settledRuns += 1;
	// One settled run may contain many assistant messages (the tool-use loop); each is a model turn.
	state.turns += assistantCount(match.branch);
	return {
		text: lastAssistantText(match.branch),
		fromEntryId: match.fromEntryId,
		toEntryId: match.toEntryId,
		usage: collectUsage(match.branch),
		state: buildDigest(deps, state),
		model: lastAssistantModel(match.branch),
	};
}

async function handleRun(deps: WorkflowHostDeps, state: HostState, args: unknown[]): Promise<RunResult> {
	const prepared = prepareRun(deps, state, args);
	// WHY (preview-buffer invariant): prepareRun removes the buffered previews from the shared
	// buffer; a failure before the send restores them, after the send it must not (they went out).
	let sent = false;
	// The footer middle cell names the running effect; run and shell are serial, so no clash.
	state.currentEffect = prepared.text;
	safeEmitProgress(deps, state);
	try {
		const { marker, restore } = await primeRunTurn(deps, prepared);
		return await runWithStructuredOutput(deps, state, prepared, marker, restore, () => { sent = true; });
	} catch (error) {
		if (!sent) restoreUnsentRun(deps, state, prepared);
		throw error;
	} finally {
		state.currentEffect = null;
		safeEmitProgress(deps, state);
	}
}

/** One run with `output` armed for this run only; the tool is inert otherwise. */
async function runWithStructuredOutput(deps: WorkflowHostDeps, state: HostState, prepared: PreparedRun, marker: string | null, restore: () => Promise<void>, onDispatched?: () => void): Promise<RunResult> {
	const capture: OutputCapture | null = prepared.options.output ? { request: prepared.options.output } : null;
	let previousActive: string[] | null = null;
	const release = (): Promise<void> => releaseStructuredRun(deps, previousActive, restore);
	let result: RunResult;
	try {
		// Arm inside the try: a registration failure (e.g. a malformed output.schema) must still
		// run the override restore, or this run's model/thinking leak into the next turn.
		previousActive = capture ? armStructuredOutput(deps.pi, capture) : null;
		result = await settleRun(deps, state, prepared, marker, onDispatched);
		// WHY: a requested output with no captured object is an unsatisfied contract. Never
		// resolve silently: the workflow may catch this, otherwise the run aborts as `error`.
		if (capture && capture.value === undefined)
			throw new Error("workflow.run: output was requested but the model did not call workflow_output");
	} catch (error) {
		// WHY: a failed run keeps its error even when the release also fails (joinRestoreFailure).
		throw await joinRestoreFailure(error, release);
	}
	await release();
	return capture ? { ...result, output: capture.value } : result;
}

/** Disarm the output tool, then restore overrides; the restore runs even when the disarm throws. */
async function releaseStructuredRun(deps: WorkflowHostDeps, previousActive: readonly string[] | null, restore: () => Promise<void>): Promise<void> {
	try {
		if (previousActive) disarmStructuredOutput(deps.pi, previousActive);
	} finally {
		await restore();
	}
}

/** Spend ledgers start empty; startedAt and pendingStop are set by the host/stop state. */
function initialSpendState(): Pick<SpendState, "baselineSpend" | "childSpend" | "classifierSpend" | "excludedEntryIds"> {
	return { baselineSpend: new Map(), childSpend: new Map(), classifierSpend: new Map(), excludedEntryIds: new Set() };
}

/** Stop/exit bookkeeping starts empty: nothing armed, nothing recorded. */
function initialStopState(): Pick<HostState, "abortReason" | "exit" | "checkpoint" | "pendingStop" | "crossedAt" | "deferredEffects" | "exited"> {
	return { abortReason: null, exit: null, checkpoint: null, pendingStop: null, crossedAt: null, deferredEffects: 0, exited: false };
}

/** Per-run counters and the bounded effect log start empty. */
function initialCounters(): Pick<HostState, "counts" | "turns" | "previews" | "settledRuns" | "effects" | "nextEffectId" | "currentEffect"> {
	return { counts: new Map(), turns: 0, previews: [], settledRuns: 0, effects: [], nextEffectId: 1, currentEffect: null };
}

/** Field defaults for one host lifecycle; the child-usage sink wiring stays in createHostState. */
function initialHostState(registry: HostState["registry"]): HostState {
	return {
		controller: new AbortController(),
		registry,
		startedAt: Date.now(),
		disposed: false,
		executing: false,
		installedSink: null,
		activeRun: null,
		...initialSpendState(),
		...initialStopState(),
		...initialCounters(),
	};
}

function createHostState(deps: WorkflowHostDeps): HostState {
	const state = initialHostState(
		createRunRegistry({
			onSettled: (listener) => deps.pi.on("agent_settled", listener),
			getBranch: () => liveBranch(deps),
		}),
	);
	// Freeze the pre-run branch by id so spend rows and the cost limit count usage from
	// run start onward; the host is created as `/workflow` claims the run.
	state.excludedEntryIds = new Set(liveBranch(deps).map((entry) => entry.id));
	// Spawn writes each child's cumulative stats here as it works; identity is kept so a
	// disposed host never uninstalls the sink a newer host installed.
	state.installedSink = (toolCallId, provider, model, usage) => {
		state.childSpend.set(toolCallId, { provider, model, usage });
	};
	return state;
}

/** Reject pending correlations and clear the child-usage sink only while still current. */
function disposeHost(deps: WorkflowHostDeps, state: HostState): void {
	if (deps.state.childUsageSink === state.installedSink) deps.state.childUsageSink = null;
	state.disposed = true;
	state.registry.dispose();
	state.activeRun?.reject(new Error("host disposed"));
	state.activeRun = null;
}

function buildHostInterface(deps: WorkflowHostDeps, state: HostState): WorkflowHost {
	// Wire the child-usage sink here (not in createHostState) so rebinding installs
	// the replacement's sink on the live deps.state, not a half-rebuilt host.
	deps.state.childUsageSink = state.installedSink;
	return {
		signal: state.controller.signal,
		abort: (reason, message) => abortHost(deps, state, reason, message),
		globals: () => buildGlobals(deps, state),
		exitRecord: () => state.exit,
		checkpointRecord: () => state.checkpoint,
		abortedReason: () => state.abortReason,
		progress: () => currentProgress(deps, state),
		metrics: () => buildMetrics(deps, state),
		installedSink: state.installedSink,
		dispose: () => disposeHost(deps, state),
		registry: state.registry,
	};
}

export function createWorkflowHost(deps: WorkflowHostDeps): WorkflowHost {
	const state = createHostState(deps);
	return buildHostInterface(deps, state);
}
