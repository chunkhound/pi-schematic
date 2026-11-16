import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, expect, test, vi } from "vitest";
import { createState, resetState, abortChildSession, type SchematicState } from "../../state.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { flushSpawnFrameScheduler, NestedAgentSessionComponent, renderSpawnResult } from "../../spawn/renderer.js";
import { realTheme } from "../support/theme.js";
import { assistantMessage, createSubscribableSession, messageUpdateEvent, type SubscribableSession } from "../support/session.js";

let h: TestHarness;

const CWD = "/tmp";

type ResultContext = Parameters<typeof renderSpawnResult>[3];

const STARTED = { type: "message_start", message: assistantMessage([]) } as const;

/** Renders the running result of `tool-call-1` over the session stored for it and returns the nested session component. */
function renderChild(
	state: SchematicState,
	overrides: Partial<ResultContext> = {},
	result: Parameters<typeof renderSpawnResult>[0] = { content: [], details: { model: "m", thinking: "low", truncated: false } },
): NestedAgentSessionComponent {
	const component = renderSpawnResult(
		result,
		false,
		realTheme,
		{ toolCallId: "tool-call-1", invalidate: () => undefined, showImages: true, ...overrides },
		state,
	);
	if (!(component instanceof NestedAgentSessionComponent)) {
		throw new Error("Expected the spawn renderer to return its nested session component.");
	}
	return component;
}

/** Stores `child` for `tool-call-1` as both the claimable and the live session. */
function storeLive(state: SchematicState, child: SubscribableSession): SubscribableSession {
	state.childSessions.set("tool-call-1", child.session);
	state.liveChildSessions.set("tool-call-1", child.session);
	return child;
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function assistantText(text: string) {
	return assistantMessage([{ type: "text", text }]);
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
	const { abort } = storeLive(state, createSubscribableSession(CWD));
	resetState(state);
	expect(abort).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("resetState aborts a claimed child session after render ownership transfer", () => {
	const state = createState();
	const { abort } = storeLive(state, createSubscribableSession(CWD, [assistantText("hello")]));

	renderChild(state, {}, { content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } });

	expect([...state.childSessions.keys()]).not.toContain("tool-call-1");
	expect([...state.liveChildSessions.keys()]).toContain("tool-call-1");

	resetState(state);

	expect(abort).toHaveBeenCalledOnce();
	expect(state.childSessions.size).toBe(0);
	expect(state.liveChildSessions.size).toBe(0);
});

test("spawn renderResult transfers session ownership out of shared state", () => {
	const state = createState();
	state.childSessions.set("tool-call-1", createSubscribableSession(CWD, [assistantText("hello")]).session);

	const component = renderChild(state, {}, { content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } });

	expect([...state.childSessions.keys()]).not.toContain("tool-call-1");
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "hello")));
});

test("nested spawn dispose shares the deduplicated abort promise with other abort paths", async () => {
	const state = createState();
	const { session, abort } = storeLive(state, createSubscribableSession(CWD));
	const component = renderChild(state);

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
	const { session, abort } = storeLive(state, createSubscribableSession(CWD));
	const component = renderChild(state);

	component.dispose();
	expect(abort).toHaveBeenCalledOnce();

	// A later abort path must observe the promise dispose already created.
	await abortChildSession(state, session);
	expect(abort, "a later abortChildSession call does not re-abort").toHaveBeenCalledOnce();
});

test("nested spawn dispose is identity-guarded against a replaced live session", () => {
	const state = createState();
	const { abort } = storeLive(state, createSubscribableSession(CWD));
	const component = renderChild(state);

	// A newer child claimed the toolCallId slot before disposal.
	const replacement = createSubscribableSession(CWD).session;
	state.liveChildSessions.set("tool-call-1", replacement);

	component.dispose();

	expect(abort, "a superseded session is not aborted by dispose").not.toHaveBeenCalled();
	expect(state.liveChildSessions.get("tool-call-1"), "dispose must not delete the replacement's registry entry").toBe(replacement);
});

test("nested spawn dispose survives re-entrant dispose from abort", () => {
	const state = createState();
	const { abort } = storeLive(state, createSubscribableSession(CWD));
	const component = renderChild(state);
	abort.mockImplementation(() => {
		// Synchronous re-entrant dispose from within abort must be a no-op.
		component.dispose();
		return Promise.resolve();
	});

	component.dispose();

	expect(abort, "re-entrant dispose from abort does not double-abort").toHaveBeenCalledOnce();
	expect([...state.liveChildSessions.keys()], "outer dispose still clears the live registry entry").not.toContain("tool-call-1");
});

// ── nested spawn lifecycle tests ──────────────────────────────────

test("nested spawn drops events after resetState bumps child epoch", () => {
	const state = createState();
	const child = storeLive(state, createSubscribableSession(CWD));
	const invalidate = vi.fn();
	const component = renderChild(state, { invalidate });
	const before = component.render(120);

	resetState(state);
	child.emit(STARTED);

	const after = component.render(120);
	expect(invalidate, "stale events should not request rerender after reset").not.toHaveBeenCalled();
	expect(after, "stale events should not change rendered state after reset").toStrictEqual(before);
});

test("nested spawn drops events when session is replaced in live state", () => {
	const state = createState();
	const child = storeLive(state, createSubscribableSession(CWD));
	const invalidate = vi.fn();
	const component = renderChild(state, { invalidate });
	const before = component.render(120);

	state.liveChildSessions.set("tool-call-1", createSubscribableSession(CWD).session);
	child.emit(STARTED);

	const after = component.render(120);
	expect(invalidate, "replaced sessions should not request rerender").not.toHaveBeenCalled();
	expect(after, "replaced sessions should not change rendered state").toStrictEqual(before);
});

test("nested spawn completed-session deletion stays stale even if the toolCallId is later reused", () => {
	const state = createState();
	const child = storeLive(state, createSubscribableSession(CWD));
	const invalidate = vi.fn();
	const component = renderChild(state, { invalidate });
	const before = component.render(120);

	state.liveChildSessions.delete("tool-call-1");
	child.emit(STARTED);
	const afterDeletion = component.render(120);
	expect(invalidate, "completed-session deletion should immediately stale the old session").not.toHaveBeenCalled();
	expect(afterDeletion, "completed-session deletion should freeze the rendered state before reuse").toStrictEqual(before);

	state.liveChildSessions.set("tool-call-1", createSubscribableSession(CWD).session);
	child.emit(messageUpdateEvent(assistantText("should be dropped")));
	const afterReuse = component.render(120);
	expect(invalidate, "toolCallId reuse should not revive a completed stale session").not.toHaveBeenCalled();
	expect(afterReuse, "toolCallId reuse should keep the old rendered state frozen").toStrictEqual(before);
	expect(
		plain(afterReuse).filter((line) => line.includes("should be dropped")),
		"toolCallId reuse should not admit stale text updates",
	).toStrictEqual([]);
});

test("nested spawn reattach resets render guard for the new session", () => {
	const state = createState();
	const first = storeLive(state, createSubscribableSession(CWD));
	const invalidate = vi.fn();
	const component = renderChild(state, { invalidate });

	first.emit(STARTED);
	flushSpawnFrameScheduler();
	expect(invalidate, "first session event triggers invalidate after scheduler flush").toHaveBeenCalledOnce();

	// Reattach resets the render guard
	const second = storeLive(state, createSubscribableSession(CWD, [assistantText("replacement")]));
	const sameComponent = renderChild(state, { lastComponent: component, invalidate });

	second.emit(messageUpdateEvent(assistantText("replacement 2")));
	flushSpawnFrameScheduler();
	expect(invalidate, "second session event triggers another invalidate after reattach").toHaveBeenCalledTimes(2);
	expect(sameComponent.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "replacement 2")));
});

test("nested spawn dispose then reattach streams new session events", () => {
	const state = createState();
	const first = storeLive(state, createSubscribableSession(CWD));
	const component = renderChild(state, {}, { content: [{ type: "text", text: "first" }], details: { model: "m", thinking: "low", truncated: false } });

	first.emit(STARTED);
	flushSpawnFrameScheduler();
	component.dispose();

	// Attach a second session to the same toolCallId after dispose
	const second = storeLive(state, createSubscribableSession(CWD, [assistantText("second")]));
	const reattached = renderChild(
		state,
		{ lastComponent: component },
		{ content: [{ type: "text", text: "second" }], details: { model: "m", thinking: "low", truncated: false } },
	);

	second.emit(STARTED);
	second.emit(messageUpdateEvent(assistantText("session B output")));
	flushSpawnFrameScheduler();

	const lines = plain(reattached.render(120));
	expect(lines, "reattached component should render events from the new session").toContainEqual(expect.stringContaining("session B output"));
	expect(lines, "reattached component should not show stale content from disposed session").not.toContainEqual(expect.stringContaining("first"));
});
