// WHY: a handoff the model never completes must not hang the run; these tests pin
// the deadline, the abort path, and the replacement rebind through the public seams.
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { publishWorkflowRuntime } from "../../workflow/coordinator.js";
import { type RunRegistry } from "../../workflow/run-registry.js";
import { performHandoff, performNewSession, rebindRun, type RebindBundle, type RebindHooks, type RunCtl } from "../../workflow/rebind.js";

/** ExtensionAPI stub plus `emit`, so a test can fire the events a real runtime would. */
type EmittingPi = ExtensionAPI & { emit(event: string, payload: unknown): void; count(event: string): number };

function fakePi(): EmittingPi {
	const listeners = new Map<string, Set<(event: never) => void>>();
	return {
		on(event: string, cb: (event: never) => void) {
			let set = listeners.get(event);
			if (!set) listeners.set(event, (set = new Set()));
			set.add(cb);
			return () => { set.delete(cb); };
		},
		emit(event: string, payload: unknown) {
			for (const cb of listeners.get(event) ?? []) cb(payload as never);
		},
		count(event: string) {
			return listeners.get(event)?.size ?? 0;
		},
	} as unknown as EmittingPi;
}

function ctxWith(branch: unknown[] = []): ExtensionCommandContext {
	return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionCommandContext;
}

function ctlWith(ctx: ExtensionCommandContext | null, signal: AbortSignal): RunCtl {
	return {
		ctx, host: { signal }, name: "w", progress: null, exitRecorded: false, outcome: null,
		unsubscribeInput: () => {}, unsubscribeCancel: () => {},
		registry: { correlate: () => ({ promise: Promise.reject(new Error("not correlated")), reject: () => {} }), dispose: () => {} },
	} as unknown as RunCtl;
}

/** No-op registry for tests that do not exercise correlate. */
function noopRegistry(): RunRegistry {
	return { correlate: () => ({ promise: Promise.reject(new Error("not correlated")), reject: () => {} }), dispose: () => {} };
}

function bundleWith(pi: ExtensionAPI, handoffTimeoutMs = 50, requestHandoff: (direction: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {}): RebindBundle {
	return {
		pi, state: {}, deps: { setReadonly: () => false, requestHandoff, prepareRunFrontmatter: async () => {}, handoffTimeoutMs },
		limits: { costLimit: null, timeBudgetMs: null },
	} as unknown as RebindBundle;
}

test("compaction timeout rejects with the handoff message", async () => {
	const pi = fakePi();
	await assert.rejects(
		performHandoff(bundleWith(pi), ctlWith(ctxWith(), new AbortController().signal), "next"),
		/handoff compaction did not start/,
	);
});

test("abort during wait rejects as cancelled", async () => {
	const pi = fakePi();
	const controller = new AbortController();
	const pending = performHandoff(bundleWith(pi), ctlWith(ctxWith(), controller.signal), "next");
	controller.abort(new Error("stop"));
	await assert.rejects(pending, /cancelled/);
});

// WHY: a successor that never settles must not hang the run past the deadline. Only the
// compaction marker exists; no delivered user prompt and no assistant turn follow it.
test("a handoff whose successor never settles is bounded by the deadline", async () => {
	const pi = fakePi();
	const branch: unknown[] = [{ type: "compaction", id: "c1" }];
	const requestHandoff = async () => {
		pi.emit("session_compact", { fromExtension: true, compactionEntry: { id: "c1" } });
	};
	await assert.rejects(
		performHandoff(bundleWith(pi, 30, requestHandoff), ctlWith(ctxWith(branch), new AbortController().signal), "next"),
		/handoff successor did not settle/,
	);
});

// WHY: settle tracking is armed BEFORE the request, so a successor that settles while the
// request is still in flight is buffered and observed once the compaction marker is known.
test("a successor that settles before the request completes is still observed", async () => {
	const pi = fakePi();
	const branch: unknown[] = [];
	const requestHandoff = async () => {
		branch.push({ type: "compaction", id: "c1" });
		pi.emit("session_compact", { fromExtension: true, compactionEntry: { id: "c1" } });
		branch.push({ type: "message", id: "u1", message: { role: "user" } });
		branch.push({ type: "message", id: "a1", message: { role: "assistant" } });
		pi.emit("agent_settled", {});
	};
	await performHandoff(bundleWith(pi, 500, requestHandoff), ctlWith(ctxWith(branch), new AbortController().signal), "next");
});

// WHY: the preparing turn's own tail (a tool result or closing assistant text) lands after
// the compaction marker; only a delivered user prompt plus its assistant may resolve.
test("a settle without a delivered successor prompt never satisfies the wait", async () => {
	const pi = fakePi();
	const branch: unknown[] = [{ type: "compaction", id: "c1" }];
	const requestHandoff = async () => {
		pi.emit("session_compact", { fromExtension: true, compactionEntry: { id: "c1" } });
		branch.push({ type: "message", id: "a1", message: { role: "assistant" } });
		pi.emit("agent_settled", {});
	};
	await assert.rejects(
		performHandoff(bundleWith(pi, 30, requestHandoff), ctlWith(ctxWith(branch), new AbortController().signal), "next"),
		/handoff successor did not settle/,
	);
});

// WHY: cancel must not leak: a surviving compaction/settle listener would fire into a
// disposed run, and a surviving deadline timer would pin the event loop for its full span.
test("a cancelled handoff disposes its event listeners", async () => {
	const pi = fakePi();
	const controller = new AbortController();
	const pending = performHandoff(bundleWith(pi, 60_000), ctlWith(ctxWith(), controller.signal), "next");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pi.count("agent_settled"), 1, "the settle gate is armed");
	controller.abort(new Error("stop"));
	await assert.rejects(pending, /cancelled/);
	assert.equal(pi.count("agent_settled"), 0, "the settle listener was removed");
	assert.equal(pi.count("session_compact"), 0, "the compaction listener was removed");
	assert.equal(pi.count("session_compact_failed"), 0, "the failed-compaction listener was removed");
});

// WHY: each handoff wait carries its own full deadline. With one shared budget, a
// compaction landing near the deadline would leave the settle wait almost no time and
// reject instantly instead of waiting for the successor run.
test("a near-deadline compaction does not starve the successor-settle wait", async () => {
	const budgetMs = 1200;
	const branch: unknown[] = [];
	const pi = fakePi();
	const requestHandoff = async () => {
		// Compaction lands at 80% of the budget: a shared deadline would leave only 20%.
		setTimeout(() => {
			branch.push({ type: "compaction", id: "c1" });
			pi.emit("session_compact", { fromExtension: true, compactionEntry: { id: "c1" } });
		}, budgetMs * 0.8);
		// The successor settles only at 150% of the budget: past a shared deadline (100%),
		// but well inside the settle wait's fresh per-wait deadline (80% + 100%).
		setTimeout(() => {
			branch.push({ type: "message", id: "u1", message: { role: "user" } });
			branch.push({ type: "message", id: "a1", message: { role: "assistant" } });
			pi.emit("agent_settled", {});
		}, budgetMs * 1.5);
	};
	const bundle = bundleWith(pi, budgetMs, requestHandoff);
	// Rejects with "handoff successor did not settle" if the settle wait shares the budget.
	await performHandoff(bundle, ctlWith(ctxWith(branch), new AbortController().signal), "next");
});

test("rebindRun swaps bundle pi/state/deps and republishes progress", () => {
	const fns = { setReadonly: () => true, requestHandoff: async () => {}, prepareRunFrontmatter: async () => {} };
	const fresh = { pi: fakePi(), state: { marker: "fresh" } };
	publishWorkflowRuntime("sess-rebind", { pi: fresh.pi, state: fresh.state, ...fns } as never);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(null, new AbortController().signal);
	let rebound = 0;
	const next = { sessionManager: { getSessionId: () => "sess-rebind" } } as unknown as ExtensionCommandContext;
	rebindRun(bundle, ctl, next, { onRebound: () => { rebound += 1; }, registry: noopRegistry() });
	assert.equal(bundle.pi, fresh.pi);
	assert.equal(bundle.state, fresh.state as never);
	assert.equal(bundle.deps.setReadonly, fns.setReadonly);
	assert.equal(ctl.ctx, next);
	assert.equal(rebound, 1);
});

test("rebindRun throws when no runtime was published", () => {
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(null, new AbortController().signal);
	const next = { sessionManager: { getSessionId: () => "sess-missing" } } as unknown as ExtensionCommandContext;
	assert.throws(() => rebindRun(bundle, ctl, next, { onRebound: () => {}, registry: noopRegistry() }), /no runtime was published/);
});

/** A ctx that replaces the session the way pi does: `withSession` runs, and its failure rejects the call. */
function ctxThatReplaces(next: ExtensionCommandContext, settleMs = 0) {
	let calls = 0;
	return {
		calls: () => calls,
		newSession: async (init?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }) => {
			calls += 1;
			if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
			await init?.withSession?.(next);
			return { cancelled: false };
		},
	};
}

/** Publish a replacement runtime the way a fresh session's `session_start` does. */
function publishReplacement(sessionId: string, prepareRunFrontmatter: (text: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {}) {
	const fresh = { pi: fakePi(), state: { marker: `state:${sessionId}` } };
	publishWorkflowRuntime(sessionId, { ...fresh, setReadonly: () => false, requestHandoff: async () => {}, prepareRunFrontmatter } as never);
	return fresh;
}

test("a cancelled replacement restores the pre-replacement runtime and keeps its context", async () => {
	const bundle = bundleWith(fakePi());
	const previous = { pi: bundle.pi, state: bundle.state, deps: bundle.deps };
	const from = { newSession: async () => ({ cancelled: true }) } as unknown as ExtensionCommandContext;
	const ctl = ctlWith(from, new AbortController().signal);
	// WHY: teardown drops the run's input-suppression/cancel subscriptions, so the
	// failure path re-arms them on the restored session (onRebound is idempotent).
	let reboundWith: unknown = null;
	const hooks: RebindHooks<RebindBundle> = { onRebound: (_bundle, _ctl, ctx) => { reboundWith = ctx; }, registry: noopRegistry() };

	await assert.rejects(performNewSession(bundle, ctl, hooks), /new session was cancelled/);
	assert.equal(bundle.pi, previous.pi, "the runtime the run was actually using survives");
	assert.equal(bundle.state, previous.state);
	assert.equal(bundle.deps, previous.deps);
	assert.equal(ctl.ctx, from, "the run keeps a live context");
	assert.equal(reboundWith, from, "the restored session is re-subscribed");
});

// WHY: the restore above covers the cancelled path only. Once pi has built the replacement
// session, its runtime is the live one, so a rebind that fails after installing it keeps
// those bindings and fails the run loudly instead of silently reverting to a dead session.
test("a rebind that fails inside withSession aborts the run with its own error", async () => {
	const fresh = publishReplacement("sess-rebind-fail");
	const next = { sessionManager: { getSessionId: () => "sess-rebind-fail" } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next);
	const bundle = bundleWith(fakePi());
	const previousPi = bundle.pi;
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal);
	const boom = new Error("workflow.new rebind failed");

	await assert.rejects(performNewSession(bundle, ctl, { onRebound: () => { throw boom; }, registry: noopRegistry() }), (error: unknown) => error === boom);
	assert.equal(bundle.pi, previousPi, "previous runtime is restored");
	assert.equal(ctl.ctx, from, "previous context is restored");
});

// WHY: a rebind that fails after installing the replacement keeps the restored runtime,
// but the teardown already dropped this run's subscriptions — the restored session must
// be re-subscribed for input suppression and cancellation, or input leaks mid-run.
test("a failed rebind re-arms the restored session's subscriptions", async () => {
	const next = { sessionManager: { getSessionId: () => "sess-rebind-rearm" } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal);
	let reboundWith: unknown = null;
	const hooks: RebindHooks<RebindBundle> = { onRebound: (_bundle, _ctl, ctx) => { reboundWith = ctx; }, registry: noopRegistry() };

	// No runtime is published for the replacement, so the rebind fails inside withSession.
	await assert.rejects(performNewSession(bundle, ctl, hooks), /no runtime was published/);
	assert.equal(ctl.ctx, from, "the run keeps its pre-replacement context");
	assert.equal(reboundWith, from, "the restored session is re-subscribed");
});

// WHY: the rollback runs on the SDK-invalidated pre-replacement context. A throw from that
// dead context must never replace the real replacement error, and the rollback failure must
// stay visible instead of being swallowed.
test("a failed publication with a stale rollback keeps the original replacement error", async () => {
	const next = { sessionManager: { getSessionId: () => "sess-stale" } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next);
	const bundle = bundleWith(fakePi());
	const previousPi = bundle.pi;
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal);
	let rebounds = 0;

	await assert.rejects(
		performNewSession(bundle, ctl, {
			onRebound: () => { rebounds += 1; throw new Error("stale context"); },
			registry: noopRegistry(),
		}),
		(error: unknown) => {
			assert.match(String(error), /no runtime was published/, "the original replacement error stays in the message");
			assert.match(String(error), /rollback failed: stale context/, "the rollback failure is reported, not swallowed");
			return true;
		},
	);
	assert.equal(rebounds, 1, "the rollback re-armed once");
	assert.equal(bundle.pi, previousPi, "the pre-replacement runtime is restored");
	assert.equal(ctl.ctx, from, "the run keeps its pre-replacement context");
});

test("the rebound run's next turn runs the replacement's prepareRunFrontmatter", async () => {
	const sessionId = "sess-rebind-frontmatter";
	const boom = new Error("model group unavailable");
	publishReplacement(sessionId, async () => { throw boom; });
	const next = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionCommandContext;
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(ctxThatReplaces(next) as unknown as ExtensionCommandContext, new AbortController().signal);

	await performNewSession(bundle, ctl, { onRebound: () => {}, registry: noopRegistry() });
	await assert.rejects(bundle.deps.prepareRunFrontmatter("/review diff", next), (error: unknown) => error === boom);
});

// WHY: a replacement has no live ctx between `newSession` and `withSession`, so a second
// `workflow.new` in that window cannot start a competing replacement: it fails fast and the
// first replacement stays the only one.
test("a concurrent workflow.new fails fast instead of starting a second replacement", async () => {
	const sessionId = "sess-rebind-concurrent";
	publishReplacement(sessionId);
	const next = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next, 10);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal);
	const hooks: RebindHooks<RebindBundle> = { onRebound: () => {}, registry: noopRegistry() };

	const first = performNewSession(bundle, ctl, hooks);
	await assert.rejects(performNewSession(bundle, ctl, hooks), /no live session context/);
	await first;
	assert.equal(from.calls(), 1, "exactly one replacement ran");
	assert.equal(ctl.ctx, next, "the run is bound to the replacement");
});
