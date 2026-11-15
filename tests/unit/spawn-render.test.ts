/**
 * Render-focused tests for the spawn module.
 *
 * Extracted from spawn.test.ts to keep focused suites. These tests
 * verify visual rendering of spawn results — collapsed/expanded
 * output, theme application, truncation display, and render caching.
 *
 * Execution and lifecycle tests remain in spawn.test.ts.
 */

import { beforeAll, beforeEach, expect, onTestFinished, test } from "vitest";
import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences } from "@earendil-works/pi-tui";
import { initTheme, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expectPrefix, expectSuffix } from "../assertions.js";
import { createState, type SchematicState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { renderSpawnCall, renderSpawnResult } from "../../spawn/renderer.js";
import { createToolRenderContext } from "./helpers.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";
import { createRunner } from "../support/runner.js";
import { realTheme } from "../support/theme.js";
import { assistantMessage, createSubscribableSession, userMessage } from "../support/session.js";

let h: TestHarness;

const CWD = "/tmp";

type SpawnRenderedResult = Parameters<typeof renderSpawnResult>[0];
type ResultContext = Parameters<typeof renderSpawnResult>[3];

/** A render context for the call `tool-call-1` that shows images and has no previous component. */
function resultContext(overrides: Partial<ResultContext> = {}): ResultContext {
	return { toolCallId: "tool-call-1", invalidate: () => undefined, showImages: true, ...overrides };
}

/** A child session with the static transcript `messages`, stored for `tool-call-1` as the renderer's to claim. */
function storeChild(state: SchematicState, messages: AgentSession["messages"]) {
	const child = createSubscribableSession(CWD, messages);
	state.childSessions.set("tool-call-1", child.session);
	return child;
}

/** The registered spawn tool's definition, loaded through the runner fixture over `state`. */
async function spawnDefinition(state: SchematicState) {
	const fixture = await createRunner({
		cwd: CWD,
		mode: "print",
		factories: [
			(pi) => {
				registerSpawnTool(pi, state);
			},
		],
	});
	return fixture.registeredTool("spawn").definition;
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function assistantText(text: string) {
	return assistantMessage([{ type: "text", text }]);
}

// pi's theme is global and initTheme() cannot be undone, so every test in this file runs with it:
// nested tool components, the child's error message and the expand hint render only with a theme.
beforeAll(() => {
	initTheme();
});

beforeEach(() => {
	h = createTestHarness();
	return () => {
		h.teardown();
	};
});

test("collapsed nested spawn render shows preview and stats", () => {
	const state = createState();
	storeChild(state, [assistantText("one\ntwo\nthree\nfour\nfive\nsix\nseven")]);

	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		false,
		realTheme,
		resultContext(),
		state,
	);

	const lines = plain(component.render(120));
	expect(lines).toContainEqual(expect.stringContaining("mock-model • medium"));
	expect(lines).toContainEqual(expect.stringContaining("one"));
	expect(lines).toContainEqual(expect.stringContaining("five"));
	expect(lines).toContainEqual(expect.stringContaining("... 2 more lines"));
	expect(lines).toContainEqual(expect.stringContaining("tok 12/34 · 2t · $0.1250 · trunc"));
});

/** Renders a successful static result whose details carry `route`, with no child session stored. */
function renderRoutedResult(details: Record<string, unknown>): string[] {
	return renderSpawnResult(
		{ content: [{ type: "text", text: "done" }], details: { truncated: false, outcome: "success", ...details } },
		false,
		realTheme,
		resultContext(),
		createState(),
	).render(120);
}

test("spawn result identity formats a routed group", () => {
	const lines = renderRoutedResult({
		model: "gpt-routed",
		thinking: "high",
		route: { status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" },
	});

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "✅ review → openai/gpt-routed • high")));
});

test("spawn result identity formats the inherited parent", () => {
	const lines = renderRoutedResult({ model: "parent", thinking: "low", route: { status: "inherited" } });

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "✅ parent • low")));
});

test("spawn result identity formats an unknown fallback", () => {
	const lines = renderRoutedResult({
		model: "parent",
		thinking: "medium",
		route: { status: "unknown-fallback", requestedGroup: "rev", provider: "openai", modelId: "parent" },
	});

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "✅ rev? fallback → openai/parent • medium")));
});

test("spawn result identity formats an escaped routed group", () => {
	const lines = renderRoutedResult({
		model: "unused",
		thinking: "low",
		route: { status: "routed", group: "review\n\u001b", provider: "open\tai", modelId: "gpt\rrouted" },
	});

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "✅ review\\n\\x1B → open\\tai/gpt\\rrouted • low")));
});

test("collapsed nested spawn render keeps all text blocks from the last assistant message", () => {
	const state = createState();
	storeChild(state, [
		assistantMessage([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]),
	]);

	const component = renderSpawnResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "mock-model", thinking: "medium", truncated: false } },
		false,
		realTheme,
		resultContext(),
		state,
	);

	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "first")));
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "second")));
});

function renderCollapsedPreview(text: string, width: number): string[] {
	const state = createState();
	storeChild(state, [assistantText(text)]);
	const component = renderSpawnResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "mock-model", thinking: "medium", truncated: false } },
		false,
		realTheme,
		resultContext(),
		state,
	);
	return component.render(width);
}

test("collapsed nested spawn preview strips OSC 8 hyperlink sequences from child text", () => {
	const lines = renderCollapsedPreview("see \u001b]8;;https://example.com\u0007the docs\u001b]8;;\u0007 now", 120);

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "see the docs now")));
	expect(lines).not.toContainEqual(expect.stringContaining("example.com"));
});

test("collapsed nested spawn preview strips erase and cursor-home sequences from child text", () => {
	const lines = renderCollapsedPreview("before\u001b[2Kmiddle\u001b[Hafter", 120);

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "beforemiddleafter")));
});

test("collapsed nested spawn preview leaves plain text unchanged", () => {
	const lines = renderCollapsedPreview("plain text, with unicode: café — 日本", 120);

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "plain text, with unicode: café — 日本")));
});

test("collapsed nested spawn truncation preserves shell background across preview and stats lines", () => {
	const state = createState();
	storeChild(state, [assistantText("Research the nudge on toggle off TODO from the readonly mode plan.")]);

	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		false,
		realTheme,
		resultContext(),
		state,
	);

	const lines = component.render(24);
	expect(lines).toContainEqual(realTheme.bg("toolPendingBg", ` ${realTheme.fg("toolOutput", "Research the nudge ...")} `));
	expect(lines).toContainEqual(realTheme.bg("toolPendingBg", ` ${realTheme.fg("dim", "tok 12/34 · 2t · $0...")} `));
});

test("collapsed nested spawn keeps truncated stats line calm", () => {
	const state = createState();
	storeChild(state, [assistantText("short preview")]);

	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		false,
		realTheme,
		resultContext(),
		state,
	);

	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "tok 12/34 · 2t · $0.1250 · trunc")));
});

test("static no-output child error with empty details renders without fabricated identity", () => {
	const component = renderSpawnResult(
		{ content: [{ type: "text", text: "Child agent produced no output." }], details: {} },
		false,
		realTheme,
		resultContext({ isError: true }),
		createState(),
	);
	const lines = component.render(120);

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("warning", "💬 error")));
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "Child agent produced no output.")));
	expect(plain(lines)).not.toContainEqual(expect.stringContaining("unknown"));
});

test("spawn result renders without a shell background when the theme has no bg", () => {
	// pi's Theme.bg is a prototype method, so an own property shadows it for this instance only.
	Reflect.set(realTheme, "bg", undefined);
	onTestFinished(() => {
		Reflect.deleteProperty(realTheme, "bg");
	});

	const lines = renderSpawnResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "m", thinking: "low", truncated: false, outcome: "success" } },
		false,
		realTheme,
		resultContext(),
		createState(),
	).render(20);

	expect(lines.join("\n")).not.toContain("\u001b[48;");
	expect(plain(lines)).toStrictEqual(["                    ", " ✅ m • low         ", " 💬 done            ", " done               ", "                    "]);
});

const returnedErrorResult: SpawnRenderedResult = {
	content: [{ type: "text", text: "Child agent produced no output." }],
	details: {
		model: "mock-model",
		thinking: "high",
		truncated: false,
		outcome: "error",
		route: { status: "inherited" },
		stats: { inputTokens: 80, outputTokens: 4, turns: 2, cost: 0.5 },
	},
};

// Each case renders its error result statically and over a retained running child.
// `present` and `absent` hold for both; `staticPresent` holds for the static render only.
const errorResultRenderCases: { name: string; result: SpawnRenderedResult; present: string[]; staticPresent: string[]; absent: string[] }[] = [
	{
		name: "returned spawn error result with details renders as an error",
		result: returnedErrorResult,
		present: ["⚠ mock-model • high", "💬 error"],
		staticPresent: ["Child agent produced no output."],
		absent: ["💬 done"],
	},
	{
		name: "an aborted error result renders as aborted",
		result: {
			content: [{ type: "text", text: "child stopped" }],
			details: { model: "mock-model", thinking: "high", truncated: false, outcome: "aborted" },
		},
		present: ["✗ mock-model • high", "💬 aborted"],
		staticPresent: [],
		absent: ["💬 error"],
	},
	{
		name: "a result flagged isError renders as an error even when its details report success",
		result: {
			content: [{ type: "text", text: "flagged failure" }],
			details: { model: "mock-model", thinking: "high", truncated: false, outcome: "success" },
		},
		present: ["💬 error"],
		staticPresent: ["flagged failure"],
		absent: ["💬 done"],
	},
];

test.for(errorResultRenderCases)("$name statically", ({ result, present, staticPresent, absent }) => {
	const lines = plain(renderSpawnResult(result, false, realTheme, resultContext({ isError: true }), createState()).render(120));

	expect([...present, ...staticPresent].filter((text) => !lines.some((line) => line.includes(text)))).toStrictEqual([]);
	expect(lines.filter((line) => absent.some((text) => line.includes(text)))).toStrictEqual([]);
});

test.for(errorResultRenderCases)("$name on a retained child", ({ result, present, absent }) => {
	const state = createState();
	storeChild(state, []);
	const running = renderSpawnResult(
		{ content: [], details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running" } },
		false,
		realTheme,
		resultContext(),
		state,
	);

	const retained = renderSpawnResult(result, false, realTheme, resultContext({ lastComponent: running, isError: true }), state);

	const lines = plain(retained.render(120));
	expect(retained).toBe(running);
	expect(present.filter((text) => !lines.some((line) => line.includes(text)))).toStrictEqual([]);
	expect(lines.filter((line) => absent.some((text) => line.includes(text)))).toStrictEqual([]);
});

test("retained nested spawn preserves identity when malformed terminal details report an error", () => {
	const state = createState();
	storeChild(state, []);

	const component = renderSpawnResult(
		{ content: [], details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running" } },
		false,
		realTheme,
		resultContext(),
		state,
	);
	const sameComponent = renderSpawnResult({ content: [], details: {} }, false, realTheme, resultContext({ lastComponent: component, isError: true }), state);
	const collapsedLines = sameComponent.render(120);

	expect(sameComponent).toBe(component);
	expect(collapsedLines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "⚠ mock-model • high")));
	expect(collapsedLines).toContainEqual(expect.stringContaining(realTheme.fg("warning", "💬 error")));

	const expandedComponent = renderSpawnResult(
		{ content: [], details: {} },
		true,
		realTheme,
		resultContext({ lastComponent: sameComponent, isError: true }),
		state,
	);
	const expandedLines = expandedComponent.render(120);
	expect(expandedComponent).toBe(component);
	expect(expandedLines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "⚠ mock-model • high")));
});

test("spawn result ignores malformed route and stats fields", () => {
	const state = createState();
	const component = renderSpawnResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				model: "safe-model",
				thinking: "medium",
				truncated: false,
				outcome: "success",
				route: { status: "routed", group: ["review"], provider: null, modelId: 42 },
				stats: { inputTokens: "12", outputTokens: null, cost: Number.NaN },
			},
		},
		false,
		realTheme,
		resultContext(),
		state,
	);
	const lines = plain(component.render(120));

	expect(lines).toContainEqual(expect.stringContaining("✅ safe-model • medium"));
	expect(lines).not.toContainEqual(expect.stringContaining("review"));
	expect(lines).not.toContainEqual(expect.stringContaining("tok "));
});

test("expanded nested spawn header stays within width after indent", () => {
	const state = createState();
	storeChild(state, [assistantText("hello")]);

	const component = renderSpawnResult(
		{ content: [{ type: "text", text: "ignored" }], details: { model: "model-name", thinking: "medium", truncated: false } },
		true,
		realTheme,
		resultContext(),
		state,
	);

	const headerLine = plain(component.render(24)).find((line) => line.includes("model-name")) ?? "";
	expectPrefix(headerLine, " ".repeat(5));
	expect(headerLine.length).toBeLessThanOrEqual(24);
});

test("nested spawn switches between image data and the image placeholder as showImages toggles", () => {
	const state = createState();
	storeChild(state, [
		assistantMessage([{ type: "toolCall", id: "tc-1", name: "screenshot", arguments: {} }], { stopReason: "toolUse" }),
		{
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "screenshot",
			content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
			isError: false,
			timestamp: 1_767_225_600_000,
		},
	]);
	// An inline image renders only on a terminal that draws images.
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	onTestFinished(() => {
		resetCapabilitiesCache();
	});
	const details = { model: "mock-model", thinking: "medium", truncated: false };

	const component = renderSpawnResult({ content: [{ type: "text", text: "ignored" }], details }, true, realTheme, resultContext({ showImages: true }), state);
	const linesWithImages = component.render(120);
	const sameComponent = renderSpawnResult(
		{ content: [{ type: "text", text: "ignored" }], details },
		true,
		realTheme,
		resultContext({ showImages: false, lastComponent: component }),
		state,
	);
	const linesWithoutImages = sameComponent.render(120);

	expect(sameComponent).toBe(component);
	expect(linesWithImages).toContainEqual(expect.stringContaining("iVBORw0KGgo="));
	expect(plain(linesWithoutImages)).toContainEqual(expect.stringContaining("[Image: [image/png]]"));
	expect(linesWithoutImages).not.toContainEqual(expect.stringContaining("iVBORw0KGgo="));
});

test("collapsed spawn stats show figures when stats are available", () => {
	const state = createState();
	storeChild(state, []);

	const component = renderSpawnResult(
		{
			content: [],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: false,
				outcome: "success",
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		false,
		realTheme,
		resultContext(),
		state,
	);

	expect(component.render(120)).toContainEqual(expect.stringContaining(realTheme.fg("dim", "tok 12/34 · 2t · $0.1250")));
});

const stopReasonOutcomeCases = [
	{
		name: "a retained child whose last stop reason is error renders the aborted outcome of its final result",
		outcome: "aborted",
		isError: true,
		present: "💬 aborted",
		absent: "💬 error",
	},
	{
		name: "a retained running child whose last stop reason is error renders error",
		outcome: "running",
		isError: false,
		present: "💬 error",
		absent: "💬 aborted",
	},
];

test.for(stopReasonOutcomeCases)("$name", ({ outcome, isError, present, absent }) => {
	const state = createState();
	storeChild(state, [assistantMessage([{ type: "text", text: "partial" }], { stopReason: "error", errorMessage: "provider failed" })]);

	const lines = plain(
		renderSpawnResult(
			{ content: [], details: { model: "mock-model", thinking: "high", truncated: false, outcome } },
			false,
			realTheme,
			resultContext({ isError }),
			state,
		).render(120),
	);

	expect(lines).toContainEqual(expect.stringContaining(present));
	expect(lines).not.toContainEqual(expect.stringContaining(absent));
});

// ── Moved from spawn.test.ts ─────────────────────────────────────────

test("spawn renderResult falls back to static text when no live session is stored", async () => {
	const state = createState();
	const definition = await spawnDefinition(state);
	const renderResult = definition.renderResult;
	expect(renderResult, "the spawn tool registers a result renderer").toBeTypeOf("function");

	const result = renderResult?.(
		{ content: [{ type: "text", text: "fallback output" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false, isPartial: false },
		realTheme,
		createToolRenderContext(),
	);

	const lines = result?.render(120) ?? [];
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "m • low")));
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "fallback output")));
});

test("spawn renderResult distinguishes aborted and error outcomes", () => {
	const state = createState();

	const aborted = renderSpawnResult(
		{ content: [{ type: "text", text: "stopped" }], details: { model: "m", thinking: "low", truncated: false, outcome: "aborted" } },
		false,
		realTheme,
		resultContext(),
		state,
	);
	const error = renderSpawnResult(
		{ content: [{ type: "text", text: "failed" }], details: { model: "m", thinking: "low", truncated: false, outcome: "error" } },
		false,
		realTheme,
		resultContext(),
		state,
	);

	const abortedLines = aborted.render(120);
	const errorLines = error.render(120);
	expect(abortedLines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "✗ m • low")));
	expect(abortedLines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "💬 aborted")));
	expect(errorLines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "⚠ m • low")));
	expect(errorLines).toContainEqual(expect.stringContaining(realTheme.fg("warning", "💬 error")));
});

test("nested spawn invalidate rebuilds from the attached session transcript", () => {
	const state = createState();
	const block = { type: "text" as const, text: "before" };
	storeChild(state, [assistantMessage([block])]);

	const component = renderSpawnResult({ content: [], details: { model: "m", thinking: "low", truncated: false } }, false, realTheme, resultContext(), state);

	const firstRender = plain(component.render(120));
	expect(firstRender).toContainEqual(expect.stringContaining("before"));

	block.text = "after";
	component.invalidate();

	const secondRender = plain(component.render(120));
	expect(secondRender).toContainEqual(expect.stringContaining("after"));
	expect(secondRender).not.toContainEqual(expect.stringContaining("before"));
});

test("nested spawn attachSession rebuilds after appended session messages", () => {
	const state = createState();
	storeChild(state, [assistantText("before")]);

	const component = renderSpawnResult({ content: [], details: { model: "m", thinking: "low", truncated: false } }, false, realTheme, resultContext(), state);

	const firstRender = plain(component.render(120));
	expect(firstRender).toContainEqual(expect.stringContaining("before"));

	storeChild(state, [assistantText("before"), assistantText("after")]);
	const sameComponent = renderSpawnResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		false,
		realTheme,
		resultContext({ lastComponent: component }),
		state,
	);

	expect(sameComponent).toBe(component);
	expect(plain(sameComponent.render(120))).toContainEqual(expect.stringContaining("after"));
});

test("nested spawn attachSession rebuilds after replacing session transcript structure", () => {
	const state = createState();
	storeChild(state, [assistantText("before")]);

	const component = renderSpawnResult({ content: [], details: { model: "m", thinking: "low", truncated: false } }, false, realTheme, resultContext(), state);

	const firstRender = plain(component.render(120));
	expect(firstRender).toContainEqual(expect.stringContaining("before"));

	storeChild(state, [userMessage("new task"), assistantText("replacement")]);
	const sameComponent = renderSpawnResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		false,
		realTheme,
		resultContext({ lastComponent: component }),
		state,
	);

	const secondRender = plain(sameComponent.render(120));
	expect(secondRender).toContainEqual(expect.stringContaining("replacement"));
	expect(secondRender).not.toContainEqual(expect.stringContaining("before"));
});

test("nested spawn rebuildFromSession quietly tolerates missing tool definitions", () => {
	const state = createState();
	// The subscribable session has no tool definitions, so the bash call renders without one.
	storeChild(state, [
		assistantMessage([{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "ls" } }], { stopReason: "error", errorMessage: "boom" }),
	]);

	const component = renderSpawnResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false, outcome: "error" } },
		false,
		realTheme,
		resultContext(),
		state,
	);

	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "⚠ m • low")));
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("warning", "💬 error")));
	expect([...state.childSessions.keys()]).not.toContain("tool-call-1");
	expect(h.warnings).toHaveLength(0);
});

test("renderSpawnResult handles result with no details field", () => {
	const lines = renderSpawnResult({ content: [{ type: "text", text: "hello" }] }, false, realTheme, resultContext({ showImages: false }), createState()).render(
		120,
	);

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("toolOutput", "hello")));
});

// ── renderCall ───────────────────────────────────────────────────────

const LONG_PROMPT = "Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9";

function renderCallLines(args: Parameters<typeof renderSpawnCall>[0], expanded = false): string[] {
	return renderSpawnCall(args, realTheme, { expanded }).render(120);
}

test("spawn renderCall shows a short prompt collapsed", async () => {
	const renderCall = (await spawnDefinition(createState())).renderCall;
	expect(renderCall, "the spawn tool registers a call renderer").toBeTypeOf("function");

	const lines = renderCall?.({ prompt: "Do X" }, realTheme, createToolRenderContext()).render(120) ?? [];

	expect(plain(lines)).toContainEqual(expect.stringContaining(" spawn child"));
	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", "Do X")));
});

test("spawn renderCall hints at hidden lines of a long prompt", () => {
	const lines = plain(renderCallLines({ prompt: LONG_PROMPT }));

	expect(lines).toContainEqual(expect.stringContaining("Line 2"));
	expect(lines).not.toContainEqual(expect.stringContaining("Line 3"));
	const hint = lines.find((line) => line.includes("more lines")) ?? "";
	expect(hint).toContain("... (7 more lines, ");
	expectSuffix(hint.trimEnd(), "to expand)");
});

test("spawn renderCall shows explicit thinking without a group", () => {
	expect(renderCallLines({ prompt: "Do X", thinking: "high" })).toContainEqual(expect.stringContaining(realTheme.fg("dim", " [high]")));
});

test("spawn renderCall treats a whitespace group as no group", () => {
	expect(renderCallLines({ prompt: "Do X", group: " \t ", thinking: "high" })).toContainEqual(expect.stringContaining(realTheme.fg("dim", " [high]")));
});

test("spawn renderCall shows the group instead of thinking when routed", () => {
	const lines = renderCallLines({ prompt: "Do X", group: "review", thinking: "max" });

	expect(lines).toContainEqual(expect.stringContaining(realTheme.fg("dim", " [review]")));
	expect(plain(lines)).not.toContainEqual(expect.stringContaining("max"));
});

test("spawn renderCall escapes control characters in the group", () => {
	expect(renderCallLines({ prompt: "Do X", group: "review\n\u001b" })).toContainEqual(expect.stringContaining(realTheme.fg("dim", " [review\\n\\x1B]")));
});

test("spawn renderCall shows the full prompt expanded", () => {
	const lines = plain(renderCallLines({ prompt: LONG_PROMPT }, true));

	expect(lines).toContainEqual(expect.stringContaining("Line 9"));
	expect(lines).not.toContainEqual(expect.stringContaining("more lines"));
});
