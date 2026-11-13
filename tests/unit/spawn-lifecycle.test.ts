import type { Component } from "@earendil-works/pi-tui";
import { beforeEach, expect, test, vi } from "vitest";
import { createState, resetState, abortChildSession, type SchematicState } from "../../state.js";
import { createSession, createSubscribableSession, createToolRenderContext, theme } from "./helpers.js";
import { createTestHost, getToolRenderResult, type ToolRenderResult } from "./test-host.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { flushSpawnFrameScheduler, NestedAgentSessionComponent } from "../../spawn/renderer.js";

let h: TestHarness;

// Every render here has a child session in state, so the spawn renderer returns its nested session component.
function nestedComponent(component: Component): NestedAgentSessionComponent {
	if (!(component instanceof NestedAgentSessionComponent)) {throw new Error("Expected the spawn renderer to return its nested session component.");}
	return component;
}

async function makeChildSpawnTool(state: SchematicState) {
	const pi = await createTestHost((api) => { registerSpawnTool(api, state); });
	const renderResult = getToolRenderResult(pi, "spawn");
	return { renderResult: (...args: Parameters<ToolRenderResult>) => nestedComponent(renderResult(...args)) };
}

beforeEach(() => {
	h = createTestHarness();
	return () => {
		h.teardown();
	};
});

// ── resetState tests ──────────────────────────────────────────────

test("resetState aborts and clears child session registries", () => {
	const state = createState();
	const abort = vi.fn(async () => {});
	const session = Object.assign(createSession([]), { abort });
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	resetState(state);
	expect(abort).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("resetState aborts a claimed child session after render ownership transfer", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const abort = vi.fn(async () => {});
	const session = Object.assign(createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]), { abort });
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext(),
	);

	expect([...state.childSessions.keys()]).not.toContain("tool-call-1");
	expect([...state.liveChildSessions.keys()]).toContain("tool-call-1");

	resetState(state);

	expect(abort).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("nested spawn dispose shares the deduplicated abort promise with other abort paths", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const abort = vi.fn(async () => {});
	const session = Object.assign(createSession([]), { abort });
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext(),
	);

	// Another abort path (spawn invalidation, /reset) already started the shared abort.
	const sharedAbort = abortChildSession(state, session);

	component.dispose();

	expect(abort, "dispose reuses the shared abort instead of aborting again").toHaveBeenCalledOnce();
	expect([...state.liveChildSessions.keys()], "dispose clears the live registry entry").not.toContain("tool-call-1");
	const lateAbort = abortChildSession(state, session);
	expect(lateAbort, "dispose and later abort share dedup promise identity").toBe(sharedAbort);

	await sharedAbort;
});

test("nested spawn dispose registers its abort in the shared dedup map", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const abort = vi.fn(async () => {});
	const session = Object.assign(createSession([]), { abort });
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext(),
	);

	component.dispose();
	expect(abort).toHaveBeenCalledOnce();

	// A later abort path must observe the promise dispose already created.
	const lateAbort = abortChildSession(state, session);
	expect(lateAbort, "dedup promise is stable across repeated calls").toBe(abortChildSession(state, session));
	await lateAbort;
	expect(abort, "a later abortChildSession call does not re-abort").toHaveBeenCalledOnce();
});

test("nested spawn dispose is identity-guarded against a replaced live session", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const abort = vi.fn(async () => {});
	const session = Object.assign(createSession([]), { abort });
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext(),
	);

	// A newer child claimed the toolCallId slot before disposal.
	const replacement = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacement);

	component.dispose();

	expect(abort, "a superseded session is not aborted by dispose").not.toHaveBeenCalled();
	expect(state.liveChildSessions.get("tool-call-1"), "dispose must not delete the replacement's registry entry").toBe(replacement);
});

test("nested spawn dispose survives re-entrant dispose from abort", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const abort = vi.fn(async () => {
		// Synchronous re-entrant dispose from within abort must be a no-op.
		component.dispose();
	});
	const session = Object.assign(createSession([]), { abort });
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext(),
	);

	component.dispose();

	expect(abort, "re-entrant dispose from abort does not double-abort").toHaveBeenCalledOnce();
	expect([...state.liveChildSessions.keys()], "outer dispose still clears the live registry entry").not.toContain("tool-call-1");
});

// ── nested spawn lifecycle tests ──────────────────────────────────

test("nested spawn drops events after resetState bumps child epoch", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ invalidate }),
	);
	const before = component.render(120);

	resetState(state);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	expect(invalidate, "stale events should not request rerender after reset").not.toHaveBeenCalled();
	expect(after, "stale events should not change rendered state after reset").toStrictEqual(before);
});

test("nested spawn drops events when session is replaced in live state", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ invalidate }),
	);
	const before = component.render(120);

	const replacementSession = createSubscribableSession([]).session;
	state.liveChildSessions.set("tool-call-1", replacementSession);
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	expect(invalidate, "replaced sessions should not request rerender").not.toHaveBeenCalled();
	expect(after, "replaced sessions should not change rendered state").toStrictEqual(before);
});

test("nested spawn completed-session deletion stays stale even if the toolCallId is later reused", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ invalidate }),
	);
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const afterDeletion = component.render(120);
	expect(invalidate, "completed-session deletion should immediately stale the old session").not.toHaveBeenCalled();
	expect(afterDeletion, "completed-session deletion should freeze the rendered state before reuse").toStrictEqual(before);

	state.liveChildSessions.set("tool-call-1", createSubscribableSession([]).session);
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "should be dropped" }] } });
	const afterReuse = component.render(120);
	expect(invalidate, "toolCallId reuse should not revive a completed stale session").not.toHaveBeenCalled();
	expect(afterReuse, "toolCallId reuse should keep the old rendered state frozen").toStrictEqual(before);
	expect(afterReuse.filter((l: string) => l.includes("should be dropped")), "toolCallId reuse should not admit stale text updates").toStrictEqual([]);
});

test("nested spawn drops late events after live registry deletion", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "initial" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ invalidate }),
	);
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	emit({ type: "message_start", message: { role: "assistant", content: [] } });

	const after = component.render(120);
	expect(invalidate, "completed-session deletion should stop rerenders from late events").not.toHaveBeenCalled();
	expect(after, "completed-session deletion should freeze the rendered state").toStrictEqual(before);
});

test("nested spawn reattach resets render guard for the new session", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ invalidate }),
	);

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	expect(invalidate, "first session event triggers invalidate after scheduler flush").toHaveBeenCalledOnce();

	// Reattach resets the render guard
	const second = createSubscribableSession([{ role: "assistant", content: [{ type: "text", text: "replacement" }] }]);
	state.childSessions.set("tool-call-1", second.session);
	state.liveChildSessions.set("tool-call-1", second.session);
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ lastComponent: component, invalidate }),
	);

	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "replacement 2" }] } });
	flushSpawnFrameScheduler();
	expect(invalidate, "second session event triggers another invalidate after reattach").toHaveBeenCalledTimes(2);
	const lines = sameComponent.render(120);
	expect(lines).toContainEqual(expect.stringContaining("replacement 2"));
});

test("nested spawn dispose then reattach streams new session events", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "first" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext(),
	);

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
		{ expanded: false, isPartial: false },
		theme,
		createToolRenderContext({ lastComponent: component }),
	);

	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "session B output" }] } });
	flushSpawnFrameScheduler();

	const lines = reattached.render(120);
	expect(lines, "reattached component should render events from the new session").toContainEqual(expect.stringContaining("session B output"));
	expect(lines, "reattached component should not show stale content from disposed session").not.toContainEqual(expect.stringContaining("first"));
});
