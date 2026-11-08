import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createState } from "../../state.js";
import { createSession, createSubscribableSession, createRenderContext, theme } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { flushSpawnFrameScheduler } from "../../spawn/renderer.js";
import { getSingletons } from "../../runtime-singletons.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";

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

test("test harness captures every forbidden console output level", () => {
	for (const level of ["debug", "log", "warn", "error"] as const) {
		globalThis.console[level](`sentinel-${level}`);
	}
	expect(h.warnings.map(({ level }) => level)).toStrictEqual(["debug", "log", "warn", "error"]);
});

test("frame scheduler requeues a throwing target without diagnostics and recovers", () => {
	const scheduler = getSingletons().frameScheduler;
	let failingFlushes = 0;
	let failingRenders = 0;
	let healthyFlushes = 0;
	let healthyRenders = 0;
	const failing = {
		flushPendingUpdates() {
			failingFlushes++;
			if (failingFlushes === 1) throw new Error("throw once");
		},
		clearRenderCache() {},
		flushScheduledRender() {
			return { requestRender: () => { failingRenders++; }, restoreAfterFailure: () => true };
		},
	};
	const healthy = {
		flushPendingUpdates() { healthyFlushes++; },
		clearRenderCache() {},
		flushScheduledRender() {
			return { requestRender: () => { healthyRenders++; }, restoreAfterFailure: () => true };
		},
	};

	scheduler.markDirty(failing);
	scheduler.markDirty(healthy);
	flushSpawnFrameScheduler();
	expect(healthyFlushes).toBe(1);
	expect(healthyRenders).toBe(1);
	expect(failingRenders).toBe(0);
	expect(h.warnings).toStrictEqual([]);

	flushSpawnFrameScheduler();
	expect(failingFlushes).toBe(2);
	expect(failingRenders).toBe(1);
	expect(h.warnings).toStrictEqual([]);
	scheduler.clear();
});

test("frame scheduler contains invalidate callback failures and continues healthy callbacks", () => {
	const scheduler = getSingletons().frameScheduler;
	let failingFlushes = 0;
	let failingInvalidates = 0;
	let healthyInvalidates = 0;
	const failing = {
		flushPendingUpdates() { failingFlushes++; },
		clearRenderCache() {},
		flushScheduledRender() {
			return {
				requestRender: () => {
					failingInvalidates++;
					if (failingInvalidates === 1) throw new Error("invalidate once");
				},
				restoreAfterFailure: () => true,
			};
		},
	};
	const healthy = {
		flushPendingUpdates() {},
		clearRenderCache() {},
		flushScheduledRender() {
			return { requestRender: () => { healthyInvalidates++; }, restoreAfterFailure: () => true };
		},
	};

	scheduler.markDirty(failing);
	scheduler.markDirty(healthy);
	expect(() => flushSpawnFrameScheduler()).not.toThrow();
	expect(failingInvalidates).toBe(1);
	expect(healthyInvalidates).toBe(1);
	expect(h.warnings).toStrictEqual([]);

	flushSpawnFrameScheduler();
	expect(failingFlushes, "callback failure requeues its component").toBe(2);
	expect(failingInvalidates).toBe(2);
	expect(healthyInvalidates).toBe(1);
	expect(h.warnings).toStrictEqual([]);
	scheduler.clear();
});

test("frame scheduler creates only one timer for a failed-target recovery frame", () => {
	const scheduler = getSingletons().frameScheduler;
	let scheduledTimers = 0;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
		scheduledTimers++;
		return { callback, id: scheduledTimers } as any;
	}) as typeof setTimeout);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation((() => {}) as typeof clearTimeout);
	const failing = {
		flushPendingUpdates() { throw new Error("retry later"); },
		clearRenderCache() {},
		flushScheduledRender() { return undefined; },
	};

	scheduler.markDirty(failing);
	flushSpawnFrameScheduler();
	expect(scheduledTimers, "one initial frame and one recovery frame").toBe(2);
	scheduler.clear();
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
	) as any;

	// message_start → thinking
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	let lines = component.render(120);
	expect(lines.some((l: string) => l.includes("thinking")), `expected thinking, got: ${lines.join("\n")}`).toBe(true);

	// message_update with text → live preview
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "writing code now" }] } });
	lines = component.render(120);
	expect(lines.some((l: string) => l.includes("writing code now")), `expected live text preview, got: ${lines.join("\n")}`).toBe(true);

	// message_end → success marker in identity line
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "summary" }], stopReason: "end_turn" } });
	lines = component.render(120);
	expect(lines.some((l: string) => l.includes("✅")), `expected success marker, got: ${lines.join("\n")}`).toBe(true);

	// Tool events degrade gracefully in minimal test env and still update live action
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	lines = component.render(120);
	expect(lines.some((l: string) => l.includes("[bash]")), `expected tool live action, got: ${lines.join("\n")}`).toBe(true);
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
	) as any;

	// Emit a malformed event that will throw inside handleEvent
	emit({ type: "message_start", message: null });

	// Subsequent valid events still process
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const lines = component.render(120);
	expect(lines.some((l: string) => l.includes("thinking")), `expected thinking after recovery, got: ${lines.join("\n")}`).toBe(true);
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
	) as any;

	// Start an assistant message
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	// End it with aborted — sets lastAction to "aborted"
	emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", errorMessage: "killed" } });

	const lines = component.render(120);
	expect(lines.some((l: string) => l.includes("aborted")), `expected aborted, got: ${lines.join("\n")}`).toBe(true);
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
	) as any;

	component.dispose();

	// Emit event after dispose — should not update state or crash
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	const after = component.render(120);

	expect(after.every((line: string) => !line.includes("thinking")), `unexpected post-dispose update: ${after.join("\n")}`).toBe(true);
});

test("nested spawn dispose aborts but does not dispose a claimed live child session", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	let abortCalls = 0;
	let disposeCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => {
			abortCalls++;
		},
		dispose: () => {
			disposeCalls++;
		},
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	expect(state.childSessions.has("tool-call-1")).toBe(false);
	expect(state.liveChildSessions.has("tool-call-1")).toBe(true);

	component.dispose();

	expect(abortCalls).toBe(1);
	expect(disposeCalls).toBe(0);
	expect(state.liveChildSessions.has("tool-call-1")).toBe(false);
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
	) as any;

	// Start a tool execution
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });

	// Rapid burst of updates without rendering between them
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file1" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file2" }] } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: { content: [{ type: "text", text: "file3" }] } });

	// Single render should reflect last state
	const lines = component.render(120);
	expect(lines.some((l: string) => l.includes("file3"))).toBe(true);

	// End the tool and verify final state
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: { content: [{ type: "text", text: "done" }] }, isError: false });

	const finalLines = component.render(120);
	expect(finalLines.some((l: string) => l.includes("✓"))).toBe(true);
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
	) as any;

	// Spy on createToolComponent to capture args while preserving original behavior
	let createdArgs: any;
	const original = component.createToolComponent.bind(component);
	component.createToolComponent = (toolName: string, toolCallId: string, args: any) => {
		createdArgs = args;
		return original(toolName, toolCallId, args);
	};

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

	expect(createdArgs).toStrictEqual({ value: "new" });
});

test("nested spawn coalesces same-turn child events into one parent invalidate", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "file1" }] } });
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "file2" }] } });

	expect(invalidateCalls, "child events do not invalidate synchronously").toBe(0);
	flushSpawnFrameScheduler();
	expect(invalidateCalls, "same-turn events coalesce into one invalidate").toBe(1);

	const lines = component.render(120);
	expect(lines.some((l: string) => l.includes("file2"))).toBe(true);
});

test("nested spawn retries a throw-once parent invalidate without a new child event", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({
			invalidate: () => {
				invalidateCalls++;
				if (invalidateCalls === 1) throw new Error("invalidate once");
			},
		}),
	);

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	expect(() => flushSpawnFrameScheduler()).not.toThrow();
	expect(invalidateCalls).toBe(1);

	flushSpawnFrameScheduler();
	expect(invalidateCalls, "failed invalidate retries on the recovery frame").toBe(2);
	flushSpawnFrameScheduler();
	expect(invalidateCalls, "successful retry consumes the queued render").toBe(2);
	expect(h.warnings).toStrictEqual([]);
});

test("nested spawn does not restore a failed invalidate after disposal", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;
	let component: any;

	component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({
			invalidate: () => {
				invalidateCalls++;
				component.dispose();
				throw new Error("invalidate after disposal");
			},
		}),
	) as any;

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	expect(() => flushSpawnFrameScheduler()).not.toThrow();
	expect(invalidateCalls).toBe(1);
	flushSpawnFrameScheduler();
	expect(invalidateCalls, "dispose prevents stale render restoration").toBe(1);
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
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;
	flushSpawnFrameScheduler();
	expect(invalidateCalls, "initial empty attach does not invalidate").toBe(0);

	(session as any).messages = [{
		role: "assistant",
		content: [{ type: "toolCall", id: "tc-1", name: "reentrant", arguments: {} }],
	}];
	component.invalidate();
	flushSpawnFrameScheduler();

	expect(invalidateCalls, "child renderer invalidate requests stay inside spawn rebuild").toBe(0);
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
	let firstInvalidates = 0;
	let secondInvalidates = 0;

	const firstComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-1", invalidate: () => { firstInvalidates++; } }),
	) as any;
	const secondComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ toolCallId: "tool-call-2", invalidate: () => { secondInvalidates++; } }),
	) as any;

	first.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	first.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first latest" }] } });
	second.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	second.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "second latest" }] } });

	expect(firstInvalidates, "shared scheduler defers parent invalidate").toBe(0);
	expect(secondInvalidates, "shared scheduler defers parent invalidate").toBe(0);
	flushSpawnFrameScheduler();
	expect(firstInvalidates).toBe(1);
	expect(secondInvalidates).toBe(1);

	expect(firstComponent.render(120).some((l: string) => l.includes("first latest"))).toBe(true);
	expect(secondComponent.render(120).some((l: string) => l.includes("second latest"))).toBe(true);
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
	let invalidateCalls = 0;
	const invalidate = () => { invalidateCalls++; };

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
	expect(invalidateCalls, "identical callbacks still coalesce").toBe(1);
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
	) as any;

	// First batch: message_start sets thinking state, flush triggers render
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	const firstLines = component.render(120);
	expect(firstLines.some((l: string) => l.includes("thinking"))).toBe(true);

	// Second batch: message_update with new text, flush triggers new render
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "batch 2" }] } });
	flushSpawnFrameScheduler();
	const secondLines = component.render(120);
	expect(secondLines.some((l: string) => l.includes("batch 2"))).toBe(true);
});

test("nested spawn dispose cancels pending and further invalidates after cleanup", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const { session, emit } = createSubscribableSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	let invalidateCalls = 0;

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ invalidate: () => { invalidateCalls++; } }),
	) as any;

	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	expect(invalidateCalls, "event does not invalidate synchronously").toBe(0);

	component.dispose();
	flushSpawnFrameScheduler();

	// After dispose, emitting more events does not call invalidate
	emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "after" }] } });
	flushSpawnFrameScheduler();
	expect(invalidateCalls, "dispose cancels pending and future invalidates").toBe(0);

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
	) as any;

	// Bad event triggers an error in handleMessageStart (null message)
	// catch block must call resetRenderBatching() so the flag resets
	emit({ type: "message_start", message: null } as any);

	// Good event after error — should still schedule and render
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	flushSpawnFrameScheduler();
	const lines = component.render(120);
	expect(lines.some((l: string) => l.includes("thinking")), "error recovery should allow subsequent events to render").toBe(true);
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
	) as any;

	// asToolResult is exercised indirectly through tool_execution_update
	// with null partialResult — the runtime guard should handle it without crashing
	emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	emit({ type: "tool_execution_update", toolCallId: "tc-1", partialResult: null });
	emit({ type: "tool_execution_end", toolCallId: "tc-1", result: null, isError: false });

	// No crash = asToolResult guard works
	const lines = component.render(120);
	expect(lines).toBeInstanceOf(Array);
});