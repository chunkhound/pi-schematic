// WHY: a session replacement builds a fresh runtime (fresh pi/state), so a running
// workflow must rebind to the replacement's live pieces. Effects are serial, so no run
// correlation is pending across a rebind: the registry's lazy subscribe re-attaches to
// the new pi on the next correlate through the live bundle getter — no Proxy needed.
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import type { WorkflowProgressView } from "../tui.js";
import { takeWorkflowRuntime } from "./coordinator.js";
import { messageOf } from "./errors.js";
import { matchRun, type RunRegistry } from "./run-registry.js";
import { clampTimeoutMs } from "./sandbox.js";
import type { WorkflowHost, WorkflowLimits, WorkflowProgress } from "./types.js";

/** Deadline per handoff wait: a handoff the model never completes must not hang the run. docs/workflows.md (workflow.handoff) pins the value. */
export const HANDOFF_COMPACTION_TIMEOUT_MS = 15 * 60 * 1000;

/** Minimal deps a rebound run needs; command.ts extends this with its test seams. */
export interface RebindableDeps {
	setReadonly(enabled: boolean): boolean;
	requestHandoff(direction: string, ctx: ExtensionCommandContext): Promise<void>;
	/** Apply skill/prompt frontmatter (model routing + readonly) for one `workflow.run` turn before dispatch. */
	prepareRunFrontmatter(text: string, ctx: ExtensionCommandContext): Promise<void>;
	/** Test seam: overrides each handoff wait's deadline (compaction and successor settle each get the full budget; default {@link HANDOFF_COMPACTION_TIMEOUT_MS}). */
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
	// pi invalidates `from` the moment `newSession` starts tearing down the session, and a
	// fresh ctx exists only inside `withSession`. Null the slot so every reader skips it.
	ctl.ctx = null;
	let result: { cancelled: boolean };
	try {
		result = await from.newSession({ withSession: async (next) => rebindRun(bundle, ctl, next, hooks) });
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
export function rebindRun<B extends RebindBundle>(bundle: B, ctl: RunCtl, next: ExtensionCommandContext, hooks: RebindHooks<B>): void {
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
	// Test seams (sandboxFactory, handoffTimeoutMs) stay from the original registration.
	bundle.deps = { ...bundle.deps, setReadonly: binding.setReadonly, requestHandoff: binding.requestHandoff, prepareRunFrontmatter: binding.prepareRunFrontmatter };
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

/**
 * `workflow.handoff`: arm settle tracking BEFORE the request (a successor that settles
 * immediately after the compaction must still be observed), await the compaction,
 * then await the successor run so the next `workflow.run` cannot overtake the shifted
 * context. docs/workflows.md (workflow.handoff): each wait carries its own full deadline.
 * One shared deadline would starve the settle wait when compaction consumes the budget,
 * so a near-deadline compaction would reject instantly instead of waiting for the successor.
 */
export async function performHandoff(bundle: RebindBundle, ctl: RunCtl, direction: string): Promise<void> {
	// Handoff compacts in place; the ctx stays valid for the whole wait.
	const ctx = ctl.ctx;
	if (!ctx) throw new Error("workflow.handoff: no live session context");
	const gate = armSettleGate(bundle.pi, () => ctx.sessionManager.getBranch());
	const compaction = waitForCompaction(bundle.pi);
	try {
		await bundle.deps.requestHandoff(direction, ctx);
		// Clamp stops a huge test-seam value overflowing the Node timer and firing at once.
		const budgetMs = clampTimeoutMs(bundle.deps.handoffTimeoutMs ?? HANDOFF_COMPACTION_TIMEOUT_MS);
		const signal = getSignal(ctl);
		const marker = await withDeadline(compaction.done, budgetMs, undefined, signal);
		await withDeadline(gate.wait(marker), budgetMs, "handoff successor did not settle; the successor run never finished", signal);
	} finally {
		compaction.dispose();
		gate.dispose();
	}
}

/** Bound a handoff wait: no other backstop exists if the model never calls the handoff tool.
 * The abort signal rejects as "cancelled" (also when already dead: a pending wait must not
 * hang past cancellation) and clears the timer — after a cancelled handoff a surviving timer
 * would pin the event loop for up to the full deadline, blocking headless process exit. */
function withDeadline<T>(promise: Promise<T>, ms: number, message = "handoff compaction did not start; the model did not call the handoff tool", signal?: AbortSignal): Promise<T> {
	if (!Number.isFinite(ms)) return promise;
	if (signal?.aborted) {
		promise.catch(() => {});
		return Promise.reject(new Error("cancelled"));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); reject(new Error(message)); }, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => { signal?.removeEventListener("abort", onAbort); clearTimeout(timer); resolve(value); },
			(error) => { signal?.removeEventListener("abort", onAbort); clearTimeout(timer); reject(error); },
		);
	});
}

/** Resolve with the compaction entry id; reject on a failed compaction. */
function waitForCompaction(pi: ExtensionAPI): { done: Promise<string>; dispose: () => void } {
	let resolve!: (id: string) => void;
	let reject!: (error: Error) => void;
	const done = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
	done.catch(() => {});
	const offOk = pi.on("session_compact", (event) => {
		if (event.fromExtension) resolve(event.compactionEntry.id);
	});
	const offFail = pi.on("session_compact_failed", (event) => {
		reject(new Error(event.errorMessage ?? "handoff compaction failed"));
	});
	return { done, dispose: () => { offOk(); offFail(); } };
}

/** The successor run follows a delivered user message; the preparing turn's own tail (tool
 * result, closing text) also lands after the compaction entry and must not pass for it. */
function hasSuccessorRun(entries: readonly SessionEntry[], marker: string): boolean {
	const at = entries.findIndex((entry) => entry.id === marker);
	if (at < 0) return false;
	const delivered = entries.slice(at + 1).find((entry) =>
		entry.type === "message" && (entry.message as { role?: string }).role === "user",
	);
	return delivered ? matchRun(entries, delivered.id) !== null : false;
}

interface PendingSettle {
	marker: string;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface SettleGate {
	wait(marker: string): Promise<void>;
	dispose(): void;
}

interface GateState {
	buffered: Array<readonly SessionEntry[]>;
	pending: PendingSettle | null;
}

/**
 * Tracks `agent_settled` boundaries from before the handoff request, so a successor
 * that settles before the caller resumes still resolves; the compaction marker only
 * exists later, so snapshots are buffered until the marker is known.
 */
function armSettleGate(pi: ExtensionAPI, getBranch: () => readonly SessionEntry[]): SettleGate {
	const state: GateState = { buffered: [], pending: null };
	const off = pi.on("agent_settled", () => absorbSettle(state, getBranch()));
	return {
		wait: (marker) => awaitSettle(state, marker),
		dispose: () => {
			off();
			disposeGate(state);
		},
	};
}

/** Future settles either satisfy the waiter or buffer for a later marker scan. */
function absorbSettle(state: GateState, branch: readonly SessionEntry[]): void {
	const waiting = state.pending;
	if (waiting && hasSuccessorRun(branch, waiting.marker)) {
		state.pending = null;
		waiting.resolve();
		return;
	}
	state.buffered.push([...branch]);
}

function awaitSettle(state: GateState, marker: string): Promise<void> {
	// Buffer scan and waiter registration are synchronous: no settle can slip between.
	if (state.buffered.some((branch) => hasSuccessorRun(branch, marker))) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		state.pending = { marker, resolve, reject };
	});
}

function disposeGate(state: GateState): void {
	state.pending?.reject(new Error("successor settle tracking disposed"));
	state.pending = null;
}
