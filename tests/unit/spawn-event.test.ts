import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { initTheme, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { createState, type SchematicState } from "../../state.js";
import { flushSpawnFrameScheduler, NestedAgentSessionComponent, renderSpawnResult } from "../../spawn/renderer.js";
import { getSingletons } from "../../runtime-singletons.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { realTheme } from "../support/theme.js";
import { assistantMessage, createSubscribableSession, messageUpdateEvent, type SubscribableSession } from "../support/session.js";

let h: TestHarness;

const CWD = "/tmp";

type ResultContext = Parameters<typeof renderSpawnResult>[3];

/**
 * Renders the running result of `toolCallId` over `child`, which is stored as both its claimable and
 * its live session, and returns the nested session component the renderer builds for it.
 */
function renderLiveChild(
	state: SchematicState,
	child: SubscribableSession,
	{ expanded = false, ...overrides }: Partial<ResultContext> & { expanded?: boolean } = {},
): NestedAgentSessionComponent {
	const context: ResultContext = { toolCallId: "tool-call-1", invalidate: () => undefined, showImages: true, ...overrides };
	state.childSessions.set(context.toolCallId, child.session);
	state.liveChildSessions.set(context.toolCallId, child.session);
	const component = renderSpawnResult({ content: [], details: { model: "m", thinking: "low", truncated: false } }, expanded, realTheme, context, state);
	if (!(component instanceof NestedAgentSessionComponent)) {
		throw new Error("Expected the spawn renderer to return its nested session component.");
	}
	return component;
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function assistantText(text: string, fields: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {}) {
	return assistantMessage([{ type: "text", text }], fields);
}

const STARTED = { type: "message_start", message: assistantMessage([]) } as const;

// pi's theme is global and initTheme() cannot be undone, so every test in this file runs with it:
// nested tool components render only with a theme.
beforeAll(() => {
	initTheme();
});

beforeEach(() => {
	h = createTestHarness();
	return () => {
		h.teardown();
	};
});

test("frame scheduler requeues a throwing target without diagnostics and recovers", () => {
	const scheduler = getSingletons().frameScheduler;
	const failingFlushes = vi.fn().mockImplementationOnce(() => {
		throw new Error("throw once");
	});
	const failingRenders = vi.fn();
	const healthyFlushes = vi.fn();
	const healthyRenders = vi.fn();
	const failing = {
		flushPendingUpdates: failingFlushes,
		clearRenderCache: vi.fn(),
		flushScheduledRender() {
			return { requestRender: failingRenders, restoreAfterFailure: () => true };
		},
	};
	const healthy = {
		flushPendingUpdates: healthyFlushes,
		clearRenderCache: vi.fn(),
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
	const failingInvalidates = vi.fn().mockImplementationOnce(() => {
		throw new Error("invalidate once");
	});
	const healthyInvalidates = vi.fn();
	const failing = {
		flushPendingUpdates: failingFlushes,
		clearRenderCache: vi.fn(),
		flushScheduledRender() {
			return {
				requestRender: failingInvalidates,
				restoreAfterFailure: () => true,
			};
		},
	};
	const healthy = {
		flushPendingUpdates: vi.fn(),
		clearRenderCache: vi.fn(),
		flushScheduledRender() {
			return { requestRender: healthyInvalidates, restoreAfterFailure: () => true };
		},
	};

	scheduler.markDirty(failing);
	scheduler.markDirty(healthy);
	expect(() => {
		flushSpawnFrameScheduler();
	}).not.toThrow();
	expect(failingInvalidates).toHaveBeenCalledOnce();
	expect(healthyInvalidates).toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);

	flushSpawnFrameScheduler();
	expect(failingFlushes, "callback failure requeues its component").toHaveBeenCalledTimes(2);
	expect(failingInvalidates).toHaveBeenCalledTimes(2);
	expect(healthyInvalidates).toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);
});

test("frame scheduler flushes a failed target exactly once in its recovery frame", () => {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
	const scheduler = getSingletons().frameScheduler;
	const flushes = vi.fn(() => {
		throw new Error("retry later");
	});
	const failing = {
		flushPendingUpdates: flushes,
		clearRenderCache: vi.fn(),
		flushScheduledRender() {
			return undefined;
		},
	};

	scheduler.markDirty(failing);
	flushSpawnFrameScheduler();
	expect(flushes).toHaveBeenCalledOnce();

	// One frame of the scheduler's 33 ms interval.
	vi.advanceTimersByTime(33);
	expect(flushes).toHaveBeenCalledTimes(2);
});

test("nested spawn live action tracks tool execution events", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child);

	child.emit(STARTED);
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "💭 thinking…")));

	child.emit(messageUpdateEvent(assistantText("writing code now")));
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "writing code now")));

	child.emit({ type: "message_end", message: assistantText("summary") });
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "✅ m • low")));

	child.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "[bash] …")));
});

/** Streams an assistant tool call `tc-1` to `bash` through one frame, so the nested component tracks it as pending. */
function streamPendingToolCall(child: SubscribableSession): void {
	const call = assistantMessage([{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" });
	child.emit(STARTED);
	child.emit(messageUpdateEvent(call));
	flushSpawnFrameScheduler();
}

// A bash tool definition whose call renders whether pi marked the call's arguments complete, and whose
// result renders its text and whether pi marked it an error.
const probeDefinition: ToolDefinition = {
	name: "bash",
	label: "bash",
	description: "bash probe",
	parameters: Type.Object({}),
	execute: () => Promise.resolve({ content: [], details: undefined }),
	renderCall: (_args, _theme, context) => new Text(`args complete: ${String(context.argsComplete)}`, 0, 0),
	renderResult: (result, _options, _theme, context) =>
		new Text(`result isError=${String(context.isError)}: ${result.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`, 0, 0),
};

/** A child session whose bash tool renders through the probe definition. */
function probedChild(): SubscribableSession {
	const child = createSubscribableSession(CWD);
	Object.assign(child.session, { getToolDefinition: () => probeDefinition });
	return child;
}

const failedMessageEndCases = [
	{ stopReason: "aborted", errorMessage: "killed", label: "aborted", kind: "abort", expected: "result isError=true: killed" },
	{ stopReason: "error", errorMessage: "provider failed", label: "error", kind: "error", expected: "result isError=true: provider failed" },
] as const;

test.for(failedMessageEndCases)(
	"nested spawn message_end with $label stopReason fails pending tool calls with the $kind message",
	({ stopReason, errorMessage, expected }) => {
		const state = createState();
		const child = probedChild();
		const component = renderLiveChild(state, child, { expanded: true });
		streamPendingToolCall(child);

		child.emit({ type: "message_end", message: assistantText("partial", { stopReason, errorMessage }) });
		// A later failed message no longer reaches the tool call the first one failed.
		child.emit(STARTED);
		child.emit({ type: "message_end", message: assistantText("later", { stopReason: "error", errorMessage: "later failure" }) });
		flushSpawnFrameScheduler();

		const results = plain(component.render(120))
			.map((line) => line.trim())
			.filter((line) => line.startsWith("result "));
		expect(results).toStrictEqual([expected]);
	},
);

test("nested spawn message_end without a failure completes the args of pending tool calls", () => {
	const state = createState();
	const child = probedChild();
	const component = renderLiveChild(state, child, { expanded: true });
	streamPendingToolCall(child);
	expect(plain(component.render(120)), "the streamed call starts with incomplete args").toContainEqual(expect.stringContaining("args complete: false"));

	child.emit({ type: "message_end", message: assistantText("done") });

	expect(plain(component.render(120))).toContainEqual(expect.stringContaining("args complete: true"));
});

test("nested spawn live action drops the result preview when a partial result has no text", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child);
	child.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: {} });
	const update = { type: "tool_execution_update", toolCallId: "tc-1", toolName: "bash", args: {} } as const;
	child.emit({ ...update, partialResult: { content: [{ type: "text", text: "line one" }], details: undefined } });
	expect(component.render(120), "a text partial result shows its preview").toContainEqual(expect.stringContaining(realTheme.fg("dim", "[bash] line one")));

	child.emit({ ...update, partialResult: { content: [], details: undefined } });

	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "[bash] …")));
});

const USER_TASK: UserMessage = { role: "user", content: [{ type: "text", text: "live task" }], timestamp: 1_767_225_600_000 };

const startedUserMessageCases: { label: string; message: UserMessage; shown: string }[] = [
	{ label: "block content", message: USER_TASK, shown: "live task" },
	{ label: "plain text content", message: { role: "user", content: "live plain task", timestamp: 1_767_225_600_000 }, shown: "live plain task" },
];

test.for(startedUserMessageCases)("nested spawn shows a user message when it starts: $label", ({ message, shown }) => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child, { expanded: true });

	child.emit({ type: "message_start", message });

	expect(plain(component.render(120))).toContainEqual(expect.stringContaining(shown));
});

const userMessageEventCases: { label: string; event: AgentSessionEvent }[] = [
	{ label: "end", event: { type: "message_end", message: USER_TASK } },
	{ label: "streamed update", event: { type: "message_update", message: USER_TASK, assistantMessageEvent: { type: "start", partial: assistantMessage([]) } } },
];

test.for(userMessageEventCases)("nested spawn stays running through the $label of a user message", ({ event }) => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child);

	child.emit(event);

	expect(plain(component.render(120)).map((line) => line.trim())).toStrictEqual(["m • low", "⏳ initializing…"]);
});

test("nested spawn dispose stops event processing", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child);

	component.dispose();

	expect(() => {
		child.emit(STARTED);
	}, "dispose unsubscribes from the child").toThrow("Nothing is subscribed to the test session; the message_start event would be lost.");
	expect(plain(component.render(120))).not.toContainEqual(expect.stringContaining("thinking"));
});

test("nested spawn dispose aborts but does not dispose a claimed live child session", () => {
	const state = createState();
	const child = createSubscribableSession(CWD, [assistantText("hello")]);
	const component = renderLiveChild(state, child);

	expect([...state.childSessions.keys()]).not.toContain("tool-call-1");
	expect([...state.liveChildSessions.keys()]).toContain("tool-call-1");

	// The session has no dispose member: calling it would throw, naming it.
	expect(() => {
		component.dispose();
	}).not.toThrow();

	expect(child.abort).toHaveBeenCalledOnce();
	expect([...state.liveChildSessions.keys()]).not.toContain("tool-call-1");
});

test("nested spawn rapid events collapse to last state", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child);

	child.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls" } });
	child.emit({
		type: "tool_execution_update",
		toolCallId: "tc-1",
		toolName: "bash",
		args: { command: "ls" },
		partialResult: { content: [{ type: "text", text: "file1" }], details: undefined },
	});
	child.emit({
		type: "tool_execution_update",
		toolCallId: "tc-1",
		toolName: "bash",
		args: { command: "ls" },
		partialResult: { content: [{ type: "text", text: "file2" }], details: undefined },
	});
	child.emit({
		type: "tool_execution_update",
		toolCallId: "tc-1",
		toolName: "bash",
		args: { command: "ls" },
		partialResult: { content: [{ type: "text", text: "file3" }], details: undefined },
	});

	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "[bash] file3")));

	child.emit({
		type: "tool_execution_end",
		toolCallId: "tc-1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "done" }], details: undefined },
		isError: false,
	});

	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "[bash] ✓")));
});

// Verifies pendingToolCallCreations accumulation: the last streamed args
// overwrite on each message_update before the first frame flush.
test("nested spawn uses the latest streamed tool-call args before first frame flush", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child, { expanded: true });

	child.emit(STARTED);
	child.emit(messageUpdateEvent(assistantMessage([{ type: "toolCall", id: "tc-1", name: "inspect", arguments: { value: "old" } }])));
	child.emit(messageUpdateEvent(assistantMessage([{ type: "toolCall", id: "tc-1", name: "inspect", arguments: { value: "new" } }])));
	flushSpawnFrameScheduler();

	const lines = plain(component.render(120));
	expect(lines).toContainEqual(expect.stringContaining('"value": "new"'));
	expect(lines).not.toContainEqual(expect.stringContaining('"value": "old"'));
});

test("nested spawn coalesces same-turn child events into one parent invalidate", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const invalidate = vi.fn();
	const component = renderLiveChild(state, child, { invalidate });

	child.emit(STARTED);
	child.emit(messageUpdateEvent(assistantText("file1")));
	child.emit(messageUpdateEvent(assistantText("file2")));

	expect(invalidate, "child events do not invalidate synchronously").not.toHaveBeenCalled();
	flushSpawnFrameScheduler();
	expect(invalidate, "same-turn events coalesce into one invalidate").toHaveBeenCalledOnce();

	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "file2")));
});

test("nested spawn retries a throw-once parent invalidate without a new child event", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const invalidate = vi.fn().mockImplementationOnce(() => {
		throw new Error("invalidate once");
	});
	renderLiveChild(state, child, { invalidate });

	child.emit(STARTED);
	expect(() => {
		flushSpawnFrameScheduler();
	}).not.toThrow();
	expect(invalidate).toHaveBeenCalledOnce();

	flushSpawnFrameScheduler();
	expect(invalidate, "failed invalidate retries on the recovery frame").toHaveBeenCalledTimes(2);
	flushSpawnFrameScheduler();
	expect(invalidate, "successful retry consumes the queued render").toHaveBeenCalledTimes(2);
	expect(h.warnings).toStrictEqual([]);
});

test("nested spawn does not restore a failed invalidate after disposal", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const invalidate = vi.fn(() => {
		component.dispose();
		throw new Error("invalidate after disposal");
	});
	const component = renderLiveChild(state, child, { invalidate });

	child.emit(STARTED);
	expect(() => {
		flushSpawnFrameScheduler();
	}).not.toThrow();
	expect(invalidate).toHaveBeenCalledOnce();
	flushSpawnFrameScheduler();
	expect(invalidate, "dispose prevents stale render restoration").toHaveBeenCalledOnce();
	expect(h.warnings).toStrictEqual([]);
});

// A tool definition whose call renderer asks its host to rerender once, while the call first renders.
const reentrantDefinition: ToolDefinition = {
	name: "reentrant",
	label: "reentrant",
	description: "rerenders while it renders",
	parameters: Type.Object({}),
	execute: () => Promise.resolve({ content: [], details: undefined }),
	renderCall(_args, _theme, context) {
		if (Reflect.get(context.state, "didInvalidate") !== true) {
			Reflect.set(context.state, "didInvalidate", true);
			context.invalidate();
		}
		return new Text("reentrant", 0, 0);
	},
};

test("nested spawn ignores child renderer invalidations during parent rebuild", () => {
	const state = createState();
	const child = createSubscribableSession(CWD, [
		assistantMessage([{ type: "toolCall", id: "tc-1", name: "reentrant", arguments: {} }], { stopReason: "toolUse" }),
	]);
	Object.assign(child.session, { getToolDefinition: (toolName: string) => (toolName === "reentrant" ? reentrantDefinition : undefined) });
	const invalidate = vi.fn();

	const component = renderLiveChild(state, child, { invalidate, expanded: true });
	const lines = plain(component.render(120));
	flushSpawnFrameScheduler();

	expect(lines, "the rebuild renders the reentrant tool call").toContainEqual(expect.stringContaining("reentrant"));
	expect(invalidate, "child renderer invalidate requests stay inside spawn rebuild").not.toHaveBeenCalled();
});

test("nested spawn shared scheduler calls each distinct invalidate once per frame", () => {
	const state = createState();
	const first = createSubscribableSession(CWD);
	const second = createSubscribableSession(CWD);
	const firstInvalidates = vi.fn();
	const secondInvalidates = vi.fn();
	const firstComponent = renderLiveChild(state, first, { toolCallId: "tool-call-1", invalidate: firstInvalidates });
	const secondComponent = renderLiveChild(state, second, { toolCallId: "tool-call-2", invalidate: secondInvalidates });

	first.emit(STARTED);
	first.emit(messageUpdateEvent(assistantText("first latest")));
	second.emit(STARTED);
	second.emit(messageUpdateEvent(assistantText("second latest")));

	expect(firstInvalidates, "shared scheduler defers parent invalidate").not.toHaveBeenCalled();
	expect(secondInvalidates, "shared scheduler defers parent invalidate").not.toHaveBeenCalled();
	flushSpawnFrameScheduler();
	expect(firstInvalidates).toHaveBeenCalledOnce();
	expect(secondInvalidates).toHaveBeenCalledOnce();

	expect(firstComponent.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "first latest")));
	expect(secondComponent.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "second latest")));
});

test("nested spawn shared scheduler still coalesces duplicate invalidate callbacks", () => {
	const state = createState();
	const first = createSubscribableSession(CWD);
	const second = createSubscribableSession(CWD);
	const invalidate = vi.fn();
	renderLiveChild(state, first, { toolCallId: "tool-call-1", invalidate });
	renderLiveChild(state, second, { toolCallId: "tool-call-2", invalidate });

	first.emit(STARTED);
	second.emit(STARTED);
	flushSpawnFrameScheduler();
	expect(invalidate, "identical callbacks still coalesce").toHaveBeenCalledOnce();
});

test("nested spawn renders state changes across frame boundaries", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const component = renderLiveChild(state, child);

	child.emit(STARTED);
	flushSpawnFrameScheduler();
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "💭 thinking…")));

	child.emit(messageUpdateEvent(assistantText("batch 2")));
	flushSpawnFrameScheduler();
	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "batch 2")));
});

test("nested spawn dispose cancels pending and further invalidates after cleanup", () => {
	const state = createState();
	const child = createSubscribableSession(CWD);
	const invalidate = vi.fn();
	const component = renderLiveChild(state, child, { invalidate });

	child.emit(STARTED);
	expect(invalidate, "event does not invalidate synchronously").not.toHaveBeenCalled();

	component.dispose();
	flushSpawnFrameScheduler();

	// After dispose the child's events no longer reach the component.
	expect(() => {
		child.emit(messageUpdateEvent(assistantText("after")));
	}).toThrow("Nothing is subscribed to the test session; the message_update event would be lost.");
	flushSpawnFrameScheduler();
	expect(invalidate, "dispose cancels pending and future invalidates").not.toHaveBeenCalled();

	// Render still works after dispose without crashing
	expect(component.render(120).length, "render after dispose should not crash").toBeGreaterThan(0);
});
