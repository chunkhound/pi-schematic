// WHY: a session replacement builds a fresh runtime (fresh pi/state), so a running
// workflow must rebind to the replacement's live pieces. Effects are serial, so no run
// correlation is pending across a rebind: the registry's lazy subscribe re-attaches to
// the new pi on the next correlate through the live bundle getter — no Proxy needed.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import type { HandoffWatch } from "../handoff/boundary.js";
import type { WorkflowProgressView } from "../tui.js";
import { takeWorkflowRuntime } from "./coordinator.js";
import { messageOf } from "./errors.js";
import type { RunRegistry } from "./run-registry.js";
import { clampTimeoutMs } from "./sandbox.js";
import type { WorkflowHost, WorkflowLimits, WorkflowProgress } from "./types.js";

/** Deadline per handoff wait: a handoff the model never completes must not hang the run. docs/workflows.md (workflow.handoff) pins the value. */
export const HANDOFF_TIMEOUT_MS = 15 * 60 * 1000;

/** Minimal deps a rebound run needs; command.ts extends this with its test seams. */
export interface RebindableDeps {
	setReadonly(enabled: boolean): boolean;
	requestHandoff(direction: string, ctx: ExtensionCommandContext): Promise<void>;
	/**
	 * Watch the next handoff settlement. The handoff boundary owns cut identity and
	 * success/failure, so the workflow never re-derives either; this is a dep, not an
	 * import, because the settling handlers may live in another module copy after a
	 * `workflow.new` rebind.
	 */
	watchHandoffSettlement(): HandoffWatch;
	/** Apply skill/prompt frontmatter (model routing + readonly) for one `workflow.run` turn before dispatch. */
	prepareRunFrontmatter(text: string, ctx: ExtensionCommandContext): Promise<void>;
	/** Test seam: overrides each handoff wait's deadline (settlement and idle each get the full budget; default {@link HANDOFF_TIMEOUT_MS}). */
	handoffTimeoutMs?: number;
}

/** Live runtime bindings of one workflow run; every field is rebound on replacement. */
export interface RebindBundle {
	pi: ExtensionAPI;
	state: SchematicState;
	deps: RebindableDeps;
	limits: WorkflowLimits;
	/** True when the workflow declares no checkpoint: the run is unbounded. */
	unbounded: boolean;
}

/** Final exit outcome is owned by the host (`WorkflowHost.exitRecord`); the run control
 * holds only the live bindings that follow a session replacement. */
export interface RunCtl {
	/** Null from `newSession` teardown until `withSession` rebinds: pi invalidates the old
	 * command ctx before the replacement is live, so no reader may touch it in that window. */
	ctx: ExtensionCommandContext | null;
	host: WorkflowHost | null;
	/** Workflow name; survives replacement so progress can be republished on the fresh UI. */
	name: string;
	/** Latest progress snapshot; survives replacement so the fresh UI restores the indicator. */
	progress: WorkflowProgressView | null;
	unsubscribeInput: () => void;
	unsubscribeCancel: () => void;
	/** Bridges pi's per-turn outcome to the host, so an RPC/print abort (no TUI key funnel) still
	 * cancels the run. Re-subscribed on rebind: the replacement has its own runner. */
	unsubscribeTurnEnd: () => void;
}

/** Command-owned resubscription: input suppression, cancel funnel, progress repaint. */
export interface RebindHooks<B extends RebindBundle> {
	onRebound(bundle: B, ctl: RunCtl, next: ExtensionCommandContext): void;
	registry: RunRegistry;
}

/** Pre-replacement runtime snapshot; the restore returns the run to what it actually used. */
interface RuntimeSnapshot<B extends RebindBundle> {
	pi: B["pi"];
	state: B["state"];
	deps: B["deps"];
}

function snapshotRuntime<B extends RebindBundle>(bundle: B): RuntimeSnapshot<B> {
	return { pi: bundle.pi, state: bundle.state, deps: bundle.deps };
}

function restoreRuntime<B extends RebindBundle>(bundle: B, ctl: RunCtl, snapshot: RuntimeSnapshot<B>, ctx: ExtensionCommandContext): void {
	bundle.pi = snapshot.pi;
	bundle.state = snapshot.state;
	bundle.deps = snapshot.deps;
	ctl.ctx = ctx;
}

/**
 * `workflow.new`: replace the session and rebind the run to the replacement's live
 * runtime inside `withSession`, where the replacement context is in scope and the
 * fresh runtime's `session_start` has already published its bindings.
 */
export async function performNewSession<B extends RebindBundle>(bundle: B, ctl: RunCtl, hooks: RebindHooks<B>): Promise<void> {
	const from = ctl.ctx;
	if (!from) throw new Error("workflow.new: no live session context");
	const previous = snapshotRuntime(bundle);
	// WHY: the replacement's session_start runs resetState, which clears readonlyEnabled to
	// false on the shared singleton state (state persists across sessions; resetState mutates
	// it in place). Capture the posture BEFORE newSession tears the session down, or rebindRun
	// would always read the reset value. Snapshot holds a reference, so it cannot recover it later.
	const readonlyEnabled = bundle.state.readonlyEnabled;
	// pi invalidates `from` the moment `newSession` starts tearing down the session, and a
	// fresh ctx exists only inside `withSession`. Null the slot so every reader skips it.
	ctl.ctx = null;
	let result: { cancelled: boolean };
	try {
		result = await from.newSession({ withSession: async (next) => rebindRun(bundle, ctl, next, hooks, readonlyEnabled) });
	} catch (error) {
		// Any throw once teardown started leaves `from` dead; the replacement, when built, is the
		// live runtime. Restoring either would bind the run to a dead session, so fail loudly on
		// the current bindings instead.
		failNewSession(bundle, ctl, error);
		throw error;
	}
	if (!result.cancelled) return;
	// Cancelled BEFORE teardown: `from` is still live, so put the run back on it and re-arm.
	const cancelled = new Error("workflow.new: new session was cancelled");
	try {
		restorePreReplacement(bundle, ctl, previous, from, hooks);
	} catch (rollbackError) {
		// The rollback failure must stay visible without replacing the cancellation: append to
		// the message instead of wrapping, so callers can still match the cancelled error.
		cancelled.message = `${cancelled.message}; rollback failed: ${messageOf(rollbackError)}`;
	}
	throw cancelled;
}

/** Fail a replacement that never completed: abort the host and drop the swapped child-usage
 * sink, so a disposed replacement host cannot keep spending into the run ledger. */
function failNewSession<B extends RebindBundle>(bundle: B, ctl: RunCtl, error: unknown): void {
	bundle.state.childUsageSink = null;
	ctl.host?.abort("error", messageOf(error));
}

/** Put the run back on the pre-replacement runtime and re-arm the subscriptions the teardown dropped. */
function restorePreReplacement<B extends RebindBundle>(bundle: B, ctl: RunCtl, previous: RuntimeSnapshot<B>, from: ExtensionCommandContext, hooks: RebindHooks<B>): void {
	restoreRuntime(bundle, ctl, previous, from);
	// WHY: the teardown dropped this run's input-suppression/cancel subscriptions; re-arm
	// them on the restored session (idempotent).
	hooks.onRebound(bundle, ctl, from);
}

/** Rebind the run to the replacement session's published runtime and subscriptions. */
export function rebindRun<B extends RebindBundle>(bundle: B, ctl: RunCtl, next: ExtensionCommandContext, hooks: RebindHooks<B>, readonlyEnabled: boolean): void {
	const sessionId = next.sessionManager.getSessionId();
	// takeWorkflowRuntime consumes the binding (it deletes the map entry): a replacement
	// session publishes exactly one runtime, so rebind is single-use. A later failure does
	// not put it back — the replacement's own session_start publishes afresh, never a retry.
	const binding = takeWorkflowRuntime(sessionId);
	if (!binding) throw new Error(`workflow.new: no runtime was published for replacement session ${sessionId}`);
	bundle.pi = binding.pi;
	bundle.state = binding.state;
	// Rebind the child-usage sink so children spawned after the replacement
	// still flush live spend into the run ledger.
	bundle.state.childUsageSink = ctl.host?.installedSink ?? null;
	// Rebind through the published registry: the session-scoped dep list lives there,
	// so a new dep cannot silently keep the dead session's implementation.
	bundle.deps = binding.rebindDeps(bundle.deps);
	// The old branch is gone; drop its ids so long runs do not scan dead history forever.
	const branch = next.sessionManager.getBranch?.() ?? [];
	ctl.host?.pruneExclusions?.(new Set(branch.map((entry) => entry.id)));
	// WHY: session_start reset readonlyEnabled to false on the shared state, so without this
	// re-apply the replacement drops the posture and observers would see a stale readwrite state.
	// Set it through the binding setter BEFORE onRebound republishes progress, so the refreshed
	// indicators already reflect the carried posture.
	bundle.deps.setReadonly(readonlyEnabled);
	ctl.ctx = next;
	hooks.onRebound(bundle, ctl, next);
	hooks.registry.dispose();
}

function getSignal(ctl: RunCtl): AbortSignal {
	// The host is built before execute; every handoff runs through it. Fail loudly if a
	// future rebind ever drops it, instead of silently passing a never-aborting signal.
	if (!ctl.host) throw new Error("workflow host missing during handoff");
	return ctl.host.signal;
}

/** Abort the run as `error` when a handoff wait expires, before the deadline rejects, so a
 * caught timeout still stops the run and the model turn it started. */
function abortOnTimeout(ctl: RunCtl, message: string): () => void {
	return () => ctl.host?.abort("error", message);
}

/** Rejection messages for the two handoff waits; each expiry aborts the run as `error`. */
const HANDOFF_SETTLE_TIMEOUT_MSG = "handoff did not complete; the model did not call the handoff tool";
const HANDOFF_IDLE_TIMEOUT_MSG = "handoff successor did not settle; the successor run never finished";

/**
 * `workflow.handoff`: arm the settlement watch BEFORE the request (a boundary that
 * completes immediately must still be observed), await the boundary outcome, then
 * await the run so the next `workflow.run` cannot overtake the shifted context.
 * docs/workflows.md (workflow.handoff): each wait carries its own full deadline.
 */
export async function performHandoff(bundle: RebindBundle, ctl: RunCtl, direction: string): Promise<void> {
	// Handoff continues in place; the ctx stays valid for the whole wait.
	const ctx = ctl.ctx;
	if (!ctx) throw new Error("workflow.handoff: no live session context");
	const watch = bundle.deps.watchHandoffSettlement();
	let idle: { done: Promise<void>; dispose: () => void } | undefined;
	try {
		await bundle.deps.requestHandoff(direction, ctx);
		// Clamp stops a huge test-seam value overflowing the Node timer and firing at once.
		const budgetMs = clampTimeoutMs(bundle.deps.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
		const signal = getSignal(ctl);
		// Both waits abort the host before their deadline rejects: a workflow that catches the
		// timeout must not leave the successor turn running outside the run.
		const settlement = await withDeadline(watch.done, budgetMs, HANDOFF_SETTLE_TIMEOUT_MSG, signal, abortOnTimeout(ctl, HANDOFF_SETTLE_TIMEOUT_MSG));
		if (settlement.status === "failed") {
			throw new Error(`workflow.handoff failed: ${settlement.reason ?? "unknown reason"}`);
		}
		idle = waitForIdle(bundle.pi, ctx);
		await withDeadline(idle.done, budgetMs, HANDOFF_IDLE_TIMEOUT_MSG, signal, abortOnTimeout(ctl, HANDOFF_IDLE_TIMEOUT_MSG));
	} finally {
		// A deadline or abort must not leave the settle listener attached to a dead run.
		idle?.dispose();
		watch.dispose();
	}
}

/** Bound a handoff wait: no other backstop exists if the model never calls the handoff tool.
 * The abort signal rejects as "cancelled" (also when already dead: a pending wait must not
 * hang past cancellation) and clears the timer — after a cancelled handoff a surviving timer
 * would pin the event loop for up to the full deadline, blocking headless process exit.
 * `onTimeout` runs before the deadline rejection, so the abort wins even if the caller catches. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
	if (!Number.isFinite(ms)) return promise;
	if (signal?.aborted) {
		promise.catch(() => {});
		return Promise.reject(new Error("cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			onTimeout?.();
			reject(new Error(message));
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => { signal?.removeEventListener("abort", onAbort); clearTimeout(timer); resolve(value); },
			(error) => { signal?.removeEventListener("abort", onAbort); clearTimeout(timer); reject(error); },
		);
	});
}

/**
 * Resolve once no agent run is active. The boundary can finalize at `turn_start`
 * (successor turn continues this run) or at `agent_settled` (run already done), so
 * check idleness first and only then wait for the next settle. pi clears its run
 * flag before emitting `agent_settled`, which makes the check at settle authoritative.
 */
function waitForIdle(pi: ExtensionAPI, ctx: ExtensionCommandContext): { done: Promise<void>; dispose: () => void } {
	let off: (() => void) | undefined;
	const done = new Promise<void>((resolve) => {
		if (ctx.isIdle()) {
			resolve();
			return;
		}
		off = pi.on("agent_settled", () => {
			if (!ctx.isIdle()) return;
			off?.();
			off = undefined;
			resolve();
		});
	});
	return { done, dispose: () => { off?.(); off = undefined; } };
}

