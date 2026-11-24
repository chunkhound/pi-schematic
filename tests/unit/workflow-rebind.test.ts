// WHY: a handoff the model never completes must not hang the run; these tests pin
// the deadline, the abort path, and the replacement rebind through the public seams.
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { publishWorkflowRuntime } from "../../workflow/coordinator.js";
import type { RunRegistry } from "../../workflow/run-registry.js";
import { performHandoff, performNewSession, rebindRun, type RebindableDeps, type RebindBundle, type RebindHooks, type RunCtl } from "../../workflow/rebind.js";

/** ExtensionAPI stub plus `emit`, so a test can fire the events a real runtime would. */
type EmittingPi = ExtensionAPI & { emit(event: string, payload: unknown): void; count(event: string): number };

function fakePi(): EmittingPi {
	const listeners = new Map<string, Set<(event: never) => void>>();
	return {
		on(event: string, cb: (event: never) => void) {
			let set = listeners.get(event);
			if (!set) {
				listeners.set(event, (set = new Set()));
			}
			set.add(cb);
			return () => {
				set.delete(cb);
			};
		},
		emit(event: string, payload: unknown) {
			for (const cb of listeners.get(event) ?? []) {
				cb(payload as never);
			}
		},
		count(event: string) {
			return listeners.get(event)?.size ?? 0;
		},
	} as unknown as EmittingPi;
}

function ctxWith(branch: unknown[] = [], idle = true): { ctx: ExtensionCommandContext; setIdle: (value: boolean) => void } {
	const box = { idle };
	const ctx = {
		sessionManager: { getBranch: () => branch },
		isIdle: () => box.idle,
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		setIdle: (value: boolean) => {
			box.idle = value;
		},
	};
}

function ctlWith(ctx: ExtensionCommandContext | null, signal: AbortSignal, aborts: [string, string | undefined][] = []): RunCtl {
	return {
		ctx,
		host: { signal, abort: (reason: string, message?: string) => aborts.push([reason, message]) },
		name: "w",
		progress: null,
		unsubscribeInput: () => {},
		unsubscribeCancel: () => {},
		unsubscribeTurnEnd: () => {},
	} as unknown as RunCtl;
}

/** No-op registry for tests that do not exercise correlate. */
function noopRegistry(): RunRegistry {
	return { correlate: () => ({ promise: Promise.reject(new Error("not correlated")), reject: () => {} }), dispose: () => {} };
}

interface Settlement {
	status: "complete" | "failed";
	handoffId: string | null;
	reason: string | null;
}

function bundleWith(
	pi: ExtensionAPI,
	handoffTimeoutMs = 50,
	requestHandoff: (direction: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {},
	settlement?: Promise<Settlement>,
	disposed?: () => void,
): RebindBundle {
	return {
		pi,
		state: {},
		deps: {
			setReadonly: () => false,
			requestHandoff,
			watchHandoffSettlement: () => ({
				done: settlement ?? new Promise<Settlement>(() => {}),
				dispose: () => {
					disposed?.();
				},
			}),
			prepareRunFrontmatter: async () => {},
			handoffTimeoutMs,
		},
		limits: { costLimit: null, timeBudgetMs: null },
	} as unknown as RebindBundle;
}

// WHY: the boundary publishes no extension event, so the workflow owns the deadline. A
// settlement that never arrives must abort the run before the rejection surfaces.
test("a handoff settlement timeout aborts the host with error before rejecting", async () => {
	const pi = fakePi();
	const aborts: [string, string | undefined][] = [];
	const { ctx } = ctxWith();
	await expect(performHandoff(bundleWith(pi, 30), ctlWith(ctx, new AbortController().signal, aborts), "next")).rejects.toThrow(/handoff did not complete/);
	expect(aborts.length, "the host is aborted exactly once").toBe(1);
	expect(aborts[0][0], "the abort reason is error").toBe("error");
	expect(aborts[0][1] ?? "", "the abort message names the timeout").toMatch(/handoff did not complete/);
});

test("abort during the wait rejects as cancelled", async () => {
	const pi = fakePi();
	const controller = new AbortController();
	const { ctx } = ctxWith();
	const pending = performHandoff(bundleWith(pi), ctlWith(ctx, controller.signal), "next");
	controller.abort(new Error("stop"));
	await expect(pending).rejects.toThrow(/cancelled/);
});

// WHY: a failed boundary is a real handoff failure (lost cut, dropped successor). The
// workflow must see it as an error, and it must not abort a host that is already settled.
test("a failed settlement rejects with the boundary's reason", async () => {
	const pi = fakePi();
	const aborts: [string, string | undefined][] = [];
	const settlement = Promise.resolve<Settlement>({ status: "failed", handoffId: null, reason: "successor-not-persisted" });
	const { ctx } = ctxWith();
	await expect(
		performHandoff(
			bundleWith(pi, 500, async () => {}, settlement),
			ctlWith(ctx, new AbortController().signal, aborts),
			"next",
		),
	).rejects.toThrow(/workflow\.handoff failed: successor-not-persisted/);
	expect(aborts, "a boundary failure is not a timeout: nothing is aborted").toStrictEqual([]);
});

test("a completed settlement resolves at once when the run is already idle", async () => {
	const pi = fakePi();
	const settlement = Promise.resolve<Settlement>({ status: "complete", handoffId: "h1", reason: null });
	const { ctx } = ctxWith([], true);
	const outcome = await performHandoff(
		bundleWith(pi, 500, async () => {}, settlement),
		ctlWith(ctx, new AbortController().signal),
		"next",
	).then(() => "resolved");
	expect(outcome, "the settlement completes when the run is already idle").toBe("resolved");
});

// WHY: the successor turn continues the same run, so completion at turn_start still has a
// live run; the next workflow.run must not start until that run settles.
test("a completed settlement waits for the live run to settle", async () => {
	const pi = fakePi();
	const settlement = Promise.resolve<Settlement>({ status: "complete", handoffId: "h1", reason: null });
	const { ctx, setIdle } = ctxWith([], false);
	let settled = false;
	const pending = performHandoff(
		bundleWith(pi, 500, async () => {}, settlement),
		ctlWith(ctx, new AbortController().signal),
		"next",
	).then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	expect(settled, "a live run keeps the handoff open").toBe(false);
	pi.emit("agent_settled", {});
	expect(settled, "a settle that leaves the run active is not the gate").toBe(false);
	setIdle(true);
	pi.emit("agent_settled", {});
	await pending;
	expect(settled).toBe(true);
});

test("an idle wait that outlives the deadline aborts the host", async () => {
	const pi = fakePi();
	const aborts: [string, string | undefined][] = [];
	const settlement = Promise.resolve<Settlement>({ status: "complete", handoffId: "h1", reason: null });
	const { ctx } = ctxWith([], false);
	await expect(
		performHandoff(
			bundleWith(pi, 30, async () => {}, settlement),
			ctlWith(ctx, new AbortController().signal, aborts),
			"next",
		),
	).rejects.toThrow(/handoff successor did not settle/);
	expect(aborts.length).toBe(1);
	expect(aborts[0][0]).toBe("error");
	expect(aborts[0][1] ?? "").toMatch(/successor did not settle/);
});

// WHY: cancel must not leak: a surviving settle listener would fire into a disposed run,
// and a surviving deadline timer would pin the event loop for its full span.
test("a cancelled handoff disposes its settlement watch", async () => {
	const pi = fakePi();
	const controller = new AbortController();
	let disposed = 0;
	const settlement = Promise.resolve<Settlement>({ status: "complete", handoffId: "h1", reason: null });
	const { ctx } = ctxWith([], false);
	const pending = performHandoff(
		bundleWith(
			pi,
			60_000,
			async () => {},
			settlement,
			() => {
				disposed += 1;
			},
		),
		ctlWith(ctx, controller.signal),
		"next",
	);
	await new Promise((resolve) => setImmediate(resolve));
	expect(pi.count("agent_settled"), "the idle gate is armed").toBe(1);
	controller.abort(new Error("stop"));
	await expect(pending).rejects.toThrow(/cancelled/);
	expect(disposed, "the settlement watch is disposed").toBe(1);
	expect(pi.count("agent_settled"), "the idle listener was removed").toBe(0);
});

test("a completed handoff disposes its settlement watch", async () => {
	const pi = fakePi();
	let disposed = 0;
	const settlement = Promise.resolve<Settlement>({ status: "complete", handoffId: "h1", reason: null });
	const { ctx } = ctxWith([], true);
	await performHandoff(
		bundleWith(
			pi,
			500,
			async () => {},
			settlement,
			() => {
				disposed += 1;
			},
		),
		ctlWith(ctx, new AbortController().signal),
		"next",
	);
	expect(disposed).toBe(1);
});

test("rebindRun swaps bundle pi/state/deps and republishes progress", () => {
	const fns = { setReadonly: () => true, requestHandoff: async () => {}, prepareRunFrontmatter: async () => {} };
	const fresh = { pi: fakePi(), state: { marker: "fresh" } };
	publishWorkflowRuntime("sess-rebind", {
		pi: fresh.pi,
		state: fresh.state,
		rebindDeps: (current: RebindableDeps) => ({ ...current, ...fns }),
	} as never);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(null, new AbortController().signal);
	let rebound = 0;
	const next = { sessionManager: { getSessionId: () => "sess-rebind" } } as unknown as ExtensionCommandContext;
	rebindRun(
		bundle,
		ctl,
		next,
		{
			onRebound: () => {
				rebound += 1;
			},
			registry: noopRegistry(),
		},
		false,
	);
	expect(bundle.pi).toBe(fresh.pi);
	expect(bundle.state).toBe(fresh.state as never);
	expect(bundle.deps.setReadonly).toBe(fns.setReadonly);
	expect(ctl.ctx).toBe(next);
	expect(rebound).toBe(1);
});

test("rebindRun throws when no runtime was published", () => {
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(null, new AbortController().signal);
	const next = { sessionManager: { getSessionId: () => "sess-missing" } } as unknown as ExtensionCommandContext;
	expect(() => {
		rebindRun(bundle, ctl, next, { onRebound: () => {}, registry: noopRegistry() }, false);
	}).toThrow(/no runtime was published/);
});

/** A ctx that replaces the session the way pi does: `withSession` runs, and its failure rejects the call. */
function ctxThatReplaces(next: ExtensionCommandContext, settleMs = 0) {
	let calls = 0;
	return {
		calls: () => calls,
		newSession: async (init?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }) => {
			calls += 1;
			if (settleMs) {
				await new Promise((resolve) => setTimeout(resolve, settleMs));
			}
			await init?.withSession?.(next);
			return { cancelled: false };
		},
	};
}

/** Publish a replacement runtime the way a fresh session's `session_start` does. */
function publishReplacement(sessionId: string, prepareRunFrontmatter: (text: string, ctx: ExtensionCommandContext) => Promise<void> = async () => {}) {
	const fresh = { pi: fakePi(), state: { marker: `state:${sessionId}` } };
	publishWorkflowRuntime(sessionId, {
		...fresh,
		rebindDeps: (current: RebindableDeps) => ({
			...current,
			setReadonly: () => false,
			requestHandoff: async () => {},
			prepareRunFrontmatter,
		}),
	} as never);
	return fresh;
}

function cancelFixture(): {
	bundle: RebindBundle;
	previous: { pi: unknown; state: unknown; deps: unknown };
	from: ExtensionCommandContext;
	ctl: ReturnType<typeof ctlWith>;
	hooks: RebindHooks<RebindBundle>;
	reboundWith: () => unknown;
} {
	const bundle = bundleWith(fakePi());
	const previous = { pi: bundle.pi, state: bundle.state, deps: bundle.deps };
	const from = { newSession: () => Promise.resolve({ cancelled: true }) } as unknown as ExtensionCommandContext;
	const ctl = ctlWith(from, new AbortController().signal);
	// WHY: teardown drops the run's input-suppression/cancel subscriptions, so the
	// failure path re-arms them on the restored session (onRebound is idempotent).
	let reboundWith: unknown = null;
	const hooks: RebindHooks<RebindBundle> = {
		onRebound: (_bundle, _ctl, ctx) => {
			reboundWith = ctx;
		},
		registry: noopRegistry(),
	};
	return { bundle, previous, from, ctl, hooks, reboundWith: () => reboundWith };
}

test("a cancelled replacement restores the pre-replacement runtime and keeps its context", async () => {
	const { bundle, previous, ctl, hooks } = cancelFixture();
	await expect(performNewSession(bundle, ctl, hooks)).rejects.toThrow(/new session was cancelled/);
	expect(bundle.pi, "the runtime the run was actually using survives").toBe(previous.pi);
	expect(bundle.state).toBe(previous.state);
	expect(bundle.deps).toBe(previous.deps);
});

test("a cancelled replacement keeps the run's live context re-subscribed", async () => {
	const { bundle, from, ctl, hooks, reboundWith } = cancelFixture();
	await expect(performNewSession(bundle, ctl, hooks)).rejects.toThrow(/new session was cancelled/);
	expect(ctl.ctx, "the run keeps a live context").toBe(from);
	expect(reboundWith(), "the restored session is re-subscribed").toBe(from);
});

// WHY: once pi has torn the old session down, its runtime is dead; a rebind that fails after
// installing the replacement keeps that live replacement and fails the run loudly, instead of
// silently reverting to a dead session.
test("a rebind that fails inside withSession aborts the run with its own error", async () => {
	const fresh = publishReplacement("sess-rebind-fail");
	const next = { sessionManager: { getSessionId: () => "sess-rebind-fail" } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal);
	const boom = new Error("workflow.new rebind failed");

	await expect(
		performNewSession(bundle, ctl, {
			onRebound: () => {
				throw boom;
			},
			registry: noopRegistry(),
		}),
	).rejects.toBe(boom);
	expect(bundle.pi, "the run keeps the live replacement runtime").toBe(fresh.pi);
	expect(ctl.ctx, "the run keeps the live replacement context").toBe(next);
});

// WHY: a rebind that fails before installing the replacement leaves `ctl.ctx` null; re-arming
// subscriptions on the invalidated pre-replacement session would leak input into a dead ctx.
test("a failed rebind leaves no live context and arms no subscriptions", async () => {
	const next = { sessionManager: { getSessionId: () => "sess-rebind-rearm" } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal);
	let reboundWith: unknown = null;
	const hooks: RebindHooks<RebindBundle> = {
		onRebound: (_bundle, _ctl, ctx) => {
			reboundWith = ctx;
		},
		registry: noopRegistry(),
	};

	// No runtime is published for the replacement, so the rebind fails inside withSession.
	await expect(performNewSession(bundle, ctl, hooks)).rejects.toThrow(/no runtime was published/);
	expect(ctl.ctx, "no live context: the run must fail, not use a dead session").toBeNull();
	expect(reboundWith, "no subscriptions are re-armed on a dead session").toBeNull();
});

// WHY: a failed publication must preserve its own error (no masking rollback), abort the host,
// and drop the swapped child-usage sink so a disposed host cannot keep spending into the ledger.
async function failedPublicationFixture(): Promise<{
	rejection: unknown;
	bundle: RebindBundle;
	ctl: ReturnType<typeof ctlWith>;
	aborts: [string, string | undefined][];
	rebounds: () => number;
}> {
	const next = { sessionManager: { getSessionId: () => "sess-stale" } } as unknown as ExtensionCommandContext;
	const from = ctxThatReplaces(next);
	const bundle = bundleWith(fakePi());
	bundle.state.childUsageSink = () => {};
	const aborts: [string, string | undefined][] = [];
	const ctl = ctlWith(from as unknown as ExtensionCommandContext, new AbortController().signal, aborts);
	let rebounds = 0;

	const rejection = await performNewSession(bundle, ctl, {
		onRebound: () => {
			rebounds += 1;
			throw new Error("stale context");
		},
		registry: noopRegistry(),
	}).then(
		() => undefined,
		(e: unknown) => e,
	);
	return { rejection, bundle, ctl, aborts, rebounds: () => rebounds };
}

test("a failed publication preserves its error without rollback or rebound", async () => {
	const { rejection, rebounds } = await failedPublicationFixture();
	expect(rejection).toBeDefined();
	expect(String(rejection), "the original replacement error stands").toMatch(/no runtime was published/);
	expect(String(rejection), "no rollback runs for a non-cancelled failure").not.toMatch(/rollback failed/);
	expect(rebounds(), "a failed publication never re-arms the run").toBe(0);
});

test("a failed publication clears the sink, aborts the host, and binds no live context", async () => {
	const { bundle, ctl, aborts } = await failedPublicationFixture();
	expect(bundle.state.childUsageSink, "the swapped child-usage sink cannot leak").toBeNull();
	expect(aborts, "the host is aborted with the failure").toStrictEqual([
		["error", "workflow.new: no runtime was published for replacement session sess-stale"],
	]);
	expect(ctl.ctx, "the dead replacement is never bound as the live context").toBeNull();
});

test("the rebound run's next turn runs the replacement's prepareRunFrontmatter", async () => {
	const sessionId = "sess-rebind-frontmatter";
	const boom = new Error("model group unavailable");
	publishReplacement(sessionId, () => Promise.reject(boom));
	const next = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionCommandContext;
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(ctxThatReplaces(next) as unknown as ExtensionCommandContext, new AbortController().signal);

	await performNewSession(bundle, ctl, { onRebound: () => {}, registry: noopRegistry() });
	await expect(bundle.deps.prepareRunFrontmatter("/review diff", next)).rejects.toBe(boom);
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
	await expect(performNewSession(bundle, ctl, hooks)).rejects.toThrow(/no live session context/);
	await first;
	expect(from.calls(), "exactly one replacement ran").toBe(1);
	expect(ctl.ctx, "the run is bound to the replacement").toBe(next);
});

// WHY (reviewer 4288158708): `workflow.new` must carry the readonly posture across the
// replacement; the replacement session_start resets it to false, so rebindRun re-applies the
// captured value through the binding setter BEFORE onRebound republishes progress.
test("rebindRun re-applies the previous readonly posture before republishing progress", () => {
	const log: string[] = [];
	const setReadonly = (enabled: boolean) => {
		log.push("setReadonly");
		return enabled;
	};
	publishWorkflowRuntime("sess-readonly", {
		pi: fakePi(),
		state: { marker: "fresh" },
		rebindDeps: (current: RebindableDeps) => ({ ...current, setReadonly, requestHandoff: async () => {}, prepareRunFrontmatter: async () => {} }),
	} as never);
	const bundle = bundleWith(fakePi());
	const ctl = ctlWith(null, new AbortController().signal);
	const next = { sessionManager: { getSessionId: () => "sess-readonly" } } as unknown as ExtensionCommandContext;
	rebindRun(
		bundle,
		ctl,
		next,
		{
			onRebound: () => {
				log.push("onRebound");
			},
			registry: noopRegistry(),
		},
		true,
	);
	expect(log, "readonly is carried via the binding setter before progress republish").toStrictEqual(["setReadonly", "onRebound"]);
	expect(bundle.deps.setReadonly, "the binding setter is the live replacement setter").toBe(setReadonly);
});

// WHY (reviewer 4288158708): capture happens in performNewSession, which reads the pre-replacement
// state before newSession's resetState runs.
test("workflow.new carries the previous readonly posture into the replacement session", async () => {
	const sessionId = "sess-new-readonly";
	const log: string[] = [];
	const setReadonly = (enabled: boolean) => {
		log.push(String(enabled));
		return enabled;
	};
	publishWorkflowRuntime(sessionId, {
		pi: fakePi(),
		state: { marker: "fresh", readonlyEnabled: false },
		rebindDeps: (current: RebindableDeps) => ({ ...current, setReadonly, requestHandoff: async () => {}, prepareRunFrontmatter: async () => {} }),
	} as never);
	const next = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionCommandContext;
	const bundle = bundleWith(fakePi());
	// The previous session (the one being replaced) had readonly enabled.
	bundle.state.readonlyEnabled = true;
	const ctl = ctlWith(ctxThatReplaces(next) as unknown as ExtensionCommandContext, new AbortController().signal);

	await performNewSession(bundle, ctl, { onRebound: () => {}, registry: noopRegistry() });
	expect(log[0], "the previous readonly posture is carried to the replacement session").toBe("true");
});

// WHY (reviewer 4288158850): a successor-settle deadline must abort the host (stopping the
// successor turn) BEFORE rejecting, so a workflow that catches the rejection does not keep the
// successor spending.
