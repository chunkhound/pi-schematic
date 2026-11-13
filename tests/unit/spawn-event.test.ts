import { beforeEach, expect, test, vi } from "vitest";
import { createState } from "../../state.js";
import { createSession, createSubscribableSession, createRenderContext, theme } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { flushSpawnFrameScheduler } from "../../spawn/renderer.js";
import { getSingletons } from "../../runtime-singletons.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";

let h: TestHarness;

async function makeChildSpawnTool(state: any) {
	const pi = await createTestHost((api) => { registerSpawnTool(api, state); });
	return pi.tools.get("spawn");
}

beforeEach(() => {
	h = createTestHarness();
	return () => {
		h.teardown();
	};
});

test("test harness captures every forbidden console output level", () => {
	for (const level of ["debug", "log", "warn", "error"] as const) {
		globalThis.console[level](`sentinel-${level}`);
	}
	expect(h.warnings.map(({ level }) => level)).toStrictEqual(["debug", "log", "warn", "error"]);
});

test("frame scheduler requeues a throwing target without diagnostics and recovers", () => {
	const scheduler = getSingletons().frameScheduler;
	const failingFlushes = vi.fn().mockImplementationOnce(() => { throw new Error("throw once"); });
	const failingRenders = vi.fn();
	const healthyFlushes = vi.fn();
	const healthyRenders = vi.fn();
	const failing = {
		flushPendingUpdates: failingFlushes,
		clearRenderCache() {},
		flushScheduledRender() {
			return { requestRender: failingRenders, restoreAfterFailure: () => true };
		},
	};
	const healthy = {
		flushPendingUpdates: healthyFlushes,
		clearRenderCache() {},
		flushScheduledRender() {
			return { requestRender: healthyRenders, restoreAfterFailure: () => true };
		},
	};

	scheduler.markDirty(failing);
	scheduler.markDirty(healthy);
	flushSpawnFrameScheduler();
	expect(healthyFlushes).toHaveBeenCalledOnce();
	expect(healthyRenders).toHaveBeenCalledOnce();
	expect(failingRenders).not.toHaveBeenCalled();
	expect(h.warnings).toStrictEqual([]);

	flushSpawnFrameScheduler();
	expect(failingFlushes).toHaveBeenCalledTimes(2);
	expect(failingRenders).toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);
});

test("frame scheduler contains invalidate callback failures and continues healthy callbacks", () => {
	const scheduler = getSingletons().frameScheduler;
	const failingFlushes = vi.fn();
	const failingInvalidates = vi.fn().mockImplementationOnce(() => { throw new Error("invalidate once"); });
	const healthyInvalidates = vi.fn();
	const failing = {
		flushPendingUpdates: failingFlushes,
		clearRenderCache() {},
		flushScheduledRender() {
			return {
				requestRender: failingInvalidates,
				restoreAfterFailure: () => true,
			};
		},
	};
	const healthy = {
		flushPendingUpdates() {},
		clearRenderCache() {},
		flushScheduledRender() {
			return { requestRender: healthyInvalidates, restoreAfterFailure: () => true };
		},
	};

	scheduler.markDirty(failing);
	scheduler.markDirty(healthy);
	expect(() => { flushSpawnFrameScheduler(); }).not.toThrow();
	expect(failingInvalidates).toHaveBeenCalledOnce();
	expect(healthyInvalidates).toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);

	flushSpawnFrameScheduler();
	expect(failingFlushes, "callback failure requeues its component").toHaveBeenCalledTimes(2);
	expect(failingInvalidates).toHaveBeenCalledTimes(2);
	expect(healthyInvalidates).toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);
});

test("frame scheduler creates only one timer for a failed-target recovery frame", () => {
	const scheduler = getSingletons().frameScheduler;
	const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
		return { callback } as any;
	}) as typeof setTimeout);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation((() => {}));
	const failing = {
		flushPendingUpdates() { throw new Error("retry later"); },
		clearRenderCache() {},
		flushScheduledRender() { return undefined; },
	};

	scheduler.markDirty(failing);
	flushSpawnFrameScheduler();
	expect(setTimeoutSpy, "one initial frame and one recovery frame").toHaveBeenCalledTimes(2);
});

test("nested spawn live action tracks tool execution events", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// message_start → thinking
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	let lines = component.render(120);
	expect(lines, `expected thinking, got: ${lines.join("\n")}`).toContainEqual(expect.stringContaining("thinking"));

	// message_update with text → live preview
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "writing code now" }] } });
	lines = component.render(120);
	expect(lines, `expected live text preview, got: ${lines.join("\n")}`).toContainEqual(expect.stringContaining("writing code now"));

	// message_end → success marker in identity line
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "end_turn" } });
	lines = component.render(120);
	expect(lines, `expected success marker, got: ${lines.join("\n")}`).toContainEqual(expect.stringContaining("✅"));

	// Tool events degrade gracefully in minimal test env and still update live action
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	lines = component.render(120);
	expect(lines, `expected tool live action, got: ${lines.join("\n")}`).toContainEqual(expect.stringContaining("[bash]"));
});

test("nested spawn handleEvent recovers from malformed events", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// Emit a malformed event that will throw inside handleEvent
	emit({ type: "message_start", message: null });

	// Subsequent valid events still process
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const lines = component.render(120);
	expect(lines, `expected thinking after recovery, got: ${lines.join("\n")}`).toContainEqual(expect.stringContaining("thinking"));
});

test("nested spawn message_end with aborted stopReason clears pending tools", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// Start an assistant message
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	// End it with aborted — sets lastAction to "aborted"
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", errorMessage: "killed" } });

	const lines = component.render(120);
	expect(lines, `expected aborted, got: ${lines.join("\n")}`).toContainEqual(expect.stringContaining("aborted"));
});

test("nested spawn dispose stops event processing", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	component.dispose();

	// Emit event after dispose — should not update state or crash
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const after = component.render(120);

	expect(after.filter((line: string) => line.includes("thinking")), `unexpected post-dispose update: ${after.join("\n")}`).toStrictEqual([]);
});

test("nested spawn dispose aborts but does not dispose a claimed live child session", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const abort = vi.fn(async () => {});
	const dispose = vi.fn();
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort,
		dispose,
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	expect([...state.childSessions.keys()]).not.toContain("tool-call-1");
	expect([...state.liveChildSessions.keys()]).toContain("tool-call-1");

	component.dispose();

	expect(abort).toHaveBeenCalledOnce();
	expect(dispose).not.toHaveBeenCalled();
	expect([...state.liveChildSessions.keys()]).not.toContain("tool-call-1");
});

test("nested spawn rapid events collapse to last state", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// Start a tool execution
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });

	// Rapid burst of updates without rendering between them
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file1" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file2" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file3" }] } });

	// Single render should reflect last state
	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining("file3"));

	// End the tool and verify final state
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });

	const finalLines = component.render(120);
	expect(finalLines).toContainEqual(expect.stringContaining("✓"));
});

// Verifies pendingToolCallCreations accumulation: the last streamed args
// overwrite on each message_update before the first frame flush.
test("nested spawn uses the latest streamed tool-call args before first frame flush", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: true },
		theme,
		createRenderContext(),
	);

	// Spy on createToolComponent to capture args while preserving original behavior
	const createToolComponent = vi.spyOn(component, "createToolComponent");

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "inspect", arguments: { value: "old" } }] },
	});
	emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "inspect", arguments: { value: "new" } }] },
	});
	flushSpawnFrameScheduler();

	expect(createToolComponent.mock.lastCall?.[2]).toStrictEqual({ value: "new" });
});

test("nested spawn coalesces same-turn child events into one parent invalidate", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate }),
	);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "file1" }] } });
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "file2" }] } });

	expect(invalidate, "child events do not invalidate synchronously").not.toHaveBeenCalled();
	flushSpawnFrameScheduler();
	expect(invalidate, "same-turn events coalesce into one invalidate").toHaveBeenCalledOnce();

	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining("file2"));
});

test("nested spawn retries a throw-once parent invalidate without a new child event", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn().mockImplementationOnce(() => { throw new Error("invalidate once"); });

	childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate }),
	);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	expect(() => { flushSpawnFrameScheduler(); }).not.toThrow();
	expect(invalidate).toHaveBeenCalledOnce();

	flushSpawnFrameScheduler();
	expect(invalidate, "failed invalidate retries on the recovery frame").toHaveBeenCalledTimes(2);
	flushSpawnFrameScheduler();
	expect(invalidate, "successful retry consumes the queued render").toHaveBeenCalledTimes(2);
	expect(h.warnings).toStrictEqual([]);
});

test("nested spawn does not restore a failed invalidate after disposal", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn(() => {
		component.dispose();
		throw new Error("invalidate after disposal");
	});

	const component: any = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate }),
	);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	expect(() => { flushSpawnFrameScheduler(); }).not.toThrow();
	expect(invalidate).toHaveBeenCalledOnce();
	flushSpawnFrameScheduler();
	expect(invalidate, "dispose prevents stale render restoration").toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);
});

test("nested spawn ignores child renderer invalidations during parent rebuild", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session } = createSubscribableSession([]);
	(session as any).getToolDefinition = (toolName: string) => toolName === "reentrant"
		? {
			name: "reentrant",
			renderCall(_args: any, _theme: any, context: any) {
				if (!context.state.didInvalidate) {
					context.state.didInvalidate = true;
					context.invalidate();
				}
				return { render: () => ["reentrant"] };
			},
		}
		: undefined;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate }),
	);
	flushSpawnFrameScheduler();
	expect(invalidate, "initial empty attach does not invalidate").not.toHaveBeenCalled();

	(session as any).messages = [{
		role: "assistant",
		content: [{ type: "toolCall", id: "tc-1", name: "reentrant", arguments: {} }],
	}];
	component.invalidate();
	flushSpawnFrameScheduler();

	expect(invalidate, "child renderer invalidate requests stay inside spawn rebuild").not.toHaveBeenCalled();
});

test("nested spawn shared scheduler calls each distinct invalidate once per frame", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	const second = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	state.childSessions.set("tool-call-2", second.session);
	state.liveChildSessions.set("tool-call-2", second.session);
	const firstInvalidates = vi.fn();
	const secondInvalidates = vi.fn();

	const firstComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-1", invalidate: firstInvalidates }),
	);
	const secondComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-2", invalidate: secondInvalidates }),
	);

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	first.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first latest" }] } });
	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "second latest" }] } });

	expect(firstInvalidates, "shared scheduler defers parent invalidate").not.toHaveBeenCalled();
	expect(secondInvalidates, "shared scheduler defers parent invalidate").not.toHaveBeenCalled();
	flushSpawnFrameScheduler();
	expect(firstInvalidates).toHaveBeenCalledOnce();
	expect(secondInvalidates).toHaveBeenCalledOnce();

	expect(firstComponent.render(120)).toContainEqual(expect.stringContaining("first latest"));
	expect(secondComponent.render(120)).toContainEqual(expect.stringContaining("second latest"));
});

test("nested spawn shared scheduler still coalesces duplicate invalidate callbacks", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const first = createSubscribableSession([]);
	const second = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", first.session);
	state.liveChildSessions.set("tool-call-1", first.session);
	state.childSessions.set("tool-call-2", second.session);
	state.liveChildSessions.set("tool-call-2", second.session);
	const invalidate = vi.fn();

	childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-1", invalidate }),
	);
	childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-2", invalidate }),
	);

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	expect(invalidate, "identical callbacks still coalesce").toHaveBeenCalledOnce();
});

test("nested spawn renders state changes across frame boundaries", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// First batch: message_start sets thinking state, flush triggers render
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	const firstLines = component.render(120);
	expect(firstLines).toContainEqual(expect.stringContaining("thinking"));

	// Second batch: message_update with new text, flush triggers new render
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "batch 2" }] } });
	flushSpawnFrameScheduler();
	const secondLines = component.render(120);
	expect(secondLines).toContainEqual(expect.stringContaining("batch 2"));
});

test("nested spawn dispose cancels pending and further invalidates after cleanup", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	const invalidate = vi.fn();

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate }),
	);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	expect(invalidate, "event does not invalidate synchronously").not.toHaveBeenCalled();

	component.dispose();
	flushSpawnFrameScheduler();

	// After dispose, emitting more events does not call invalidate
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "after" }] } });
	flushSpawnFrameScheduler();
	expect(invalidate, "dispose cancels pending and future invalidates").not.toHaveBeenCalled();

	// Render still works after dispose without crashing
	const lines = component.render(120);
	expect(lines.length, "render after dispose should not crash").toBeGreaterThan(0);
});

test("nested spawn recovers batching state after event handler error", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// Bad event triggers an error in handleMessageStart (null message)
	// catch block must call resetRenderBatching() so the flag resets
	emit({ type: "message_start", message: null } as any);

	// Good event after error — should still schedule and render
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	const lines = component.render(120);
	expect(lines, "error recovery should allow subsequent events to render").toContainEqual(expect.stringContaining("thinking"));
});

test("handleEvent gracefully degrades with null message events", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	// asToolResult is exercised indirectly through tool_execution_update
	// with null partialResult — the runtime guard should handle it without crashing
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: null });
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: null, isError: false });

	// No crash = asToolResult guard works
	const lines = component.render(120);
	expect(lines).toSatisfy(Array.isArray);
});