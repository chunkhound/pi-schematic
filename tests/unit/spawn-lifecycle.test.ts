import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createState, resetState, abortChildSession } from "../../state.js";
import { createSession, createSubscribableSession, createRenderContext, theme } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { flushSpawnFrameScheduler } from "../../spawn/renderer.js";

let h: TestHarness;

async function makeChildSpawnTool(state: any) {
	const pi = await createTestHost((api) => registerSpawnTool(api, state));
	return pi.tools.get("spawn");
}

beforeEach(() => {
	h = createTestHarness();
});

afterEach(() => {
	h.teardown();
});

// ── resetState tests ──────────────────────────────────────────────

test("resetState aborts and clears child session registries", () => {
	const state = createState();
	let abortCalls = 0;
	const session = {
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	resetState(state);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("resetState aborts a claimed child session after render ownership transfer", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(state.liveChildSessions.has("tool-call-1"), true);

	resetState(state);

	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("nested spawn dispose shares the deduplicated abort promise with other abort paths", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// Another abort path (spawn invalidation, /reset) already started the shared abort.
	const sharedAbort = abortChildSession(state, session);

	component.dispose();

	assert.equal(abortCalls, 1, "dispose reuses the shared abort instead of aborting again");
	assert.equal(state.liveChildSessions.has("tool-call-1"), false, "dispose clears the live registry entry");
	const lateAbort = abortChildSession(state, session);
	assert.strictEqual(lateAbort, sharedAbort, "dispose and later abort share dedup promise identity");

	await sharedAbort;
});

test("nested spawn dispose registers its abort in the shared dedup map", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => {
			abortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	component.dispose();
	assert.equal(abortCalls, 1);

	// A later abort path must observe the promise dispose already created.
	const lateAbort = abortChildSession(state, session);
	assert.strictEqual(lateAbort, abortChildSession(state, session), "dedup promise is stable across repeated calls");
	await lateAbort;
	assert.equal(abortCalls, 1, "a later abortChildSession call does not re-abort");
});

test("nested spawn dispose is identity-guarded against a replaced live session", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	let oldAbortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => {
			oldAbortCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	// A newer child claimed the toolCallId slot before disposal.
	const replacement = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacement);

	component.dispose();

	assert.equal(oldAbortCalls, 0, "a superseded session is not aborted by dispose");
	assert.equal(state.liveChildSessions.get("tool-call-1"), replacement, "dispose must not delete the replacement's registry entry");
});

test("nested spawn dispose survives re-entrant dispose from abort", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	let abortCalls = 0;
	let component: any;
	const session = {
		...createSession([]),
		abort: async () => {
			abortCalls++;
			// Synchronous re-entrant dispose from within abort must be a no-op.
			component.dispose();
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	component.dispose();

	assert.equal(abortCalls, 1, "re-entrant dispose from abort does not double-abort");
	assert.equal(state.liveChildSessions.has("tool-call-1"), false, "outer dispose still clears the live registry entry");
});

// ── nested spawn lifecycle tests ──────────────────────────────────

test("nested spawn drops events after resetState bumps child epoch", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	resetState(state);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "stale events should not request rerender after reset");
	assert.deepEqual(after, before, "stale events should not change rendered state after reset");
});

test("nested spawn drops events when session is replaced in live state", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	const replacementSession = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacementSession);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "replaced sessions should not request rerender");
	assert.deepEqual(after, before, "replaced sessions should not change rendered state");
});

test("nested spawn completed-session deletion stays stale even if the toolCallId is later reused", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const afterDeletion = component.render(120);
	assert.equal(invalidateCalls, 0, "completed-session deletion should immediately stale the old session");
	assert.deepEqual(afterDeletion, before, "completed-session deletion should freeze the rendered state before reuse");

	state.liveChildSessions.set("tool-call-1", createSubscribableSession([]).session);
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "should be dropped" }] } });
	const afterReuse = component.render(120);
	assert.equal(invalidateCalls, 0, "toolCallId reuse should not revive a completed stale session");
	assert.deepEqual(afterReuse, before, "toolCallId reuse should keep the old rendered state frozen");
	assert.ok(afterReuse.every((l: string) => !l.includes("should be dropped")), "toolCallId reuse should not admit stale text updates");
});

test("nested spawn drops late events after live registry deletion", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	assert.equal(invalidateCalls, 0, "completed-session deletion should stop rerenders from late events");
	assert.deepEqual(after, before, "completed-session deletion should freeze the rendered state");
});

test("nested spawn reattach resets render guard for the new session", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 1, "first session event triggers invalidate after scheduler flush");

	// Reattach resets the render guard
	const second = createSubscribableSession([{ role: "assistant", content: [{ type: "text", text: "replacement" }] }]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component, invalidate: () => { invalidateCalls++; } }),
	) as any;

	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "replacement 2" }] } });
	flushSpawnFrameScheduler();
	assert.equal(invalidateCalls, 2, "second session event triggers another invalidate after reattach");
	const lines = sameComponent.render(120);
	assert.ok(lines.some((l: string) => l.includes("replacement 2")));
});

test("nested spawn dispose then reattach streams new session events", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "first" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	component.dispose();

	// Attach a second session to the same toolCallId after dispose
	const second = createSubscribableSession([
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
	]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const reattached = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "second" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "session B output" }] } });
	flushSpawnFrameScheduler();

	const lines = reattached.render(120);
	assert.ok(lines.some((l: string) => l.includes("session B output")),
		"reattached component should render events from the new session");
	assert.equal(lines.some((l: string) => l.includes("first")), false,
		"reattached component should not show stale content from disposed session");
});
