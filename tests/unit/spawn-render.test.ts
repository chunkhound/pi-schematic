/**
 * Render-focused tests for the spawn module.
 *
 * Extracted from spawn.test.ts to keep focused suites. These tests
 * verify visual rendering of spawn results — collapsed/expanded
 * output, theme application, truncation display, and render caching.
 *
 * Execution and lifecycle tests remain in spawn.test.ts.
 */

import { beforeEach, expect, test } from "vitest";
import { assertPresent, expectPrefix } from "../assertions.js";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { createState } from "../../state.js";
import { registerSpawnTool } from "../../spawn/index.js";
import { renderSpawnResult } from "../../spawn/renderer.js";
import {
	theme,
	ansiTheme,
	createRenderContext,
	createSession,
	stripAnsi,
	getRenderedLine,
	getLineContaining,
	assertShellBackgroundPreserved,
} from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";

let h: TestHarness;

async function makeChildSpawnTool(state: any) {
	const pi = await createTestHost((api) => registerSpawnTool(api, state));
	return pi.tools.get("spawn");
}

beforeEach(() => {
	h = createTestHarness();
	return () => {
		h.teardown();
	};
});

test("collapsed nested spawn render shows preview and stats", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining("mock-model • medium"));
	expect(lines).toContainEqual(expect.stringContaining("one"));
	expect(lines).toContainEqual(expect.stringContaining("five"));
	expect(lines).toContainEqual(expect.stringContaining("... 2 more lines"));
	expect(lines).toContainEqual(expect.stringContaining("tok 12/34"));
	expect(lines).toContainEqual(expect.stringContaining("trunc"));
});

test("spawn result identity formats default routed and unknown fallback", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const routed = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "gpt-routed", thinking: "high", truncated: false, outcome: "success", route: { status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" } } },
		{ expanded: false }, theme, createRenderContext(),
	);
	expect(routed.render(120)).toContainEqual(expect.stringContaining("review → openai/gpt-routed • high"));

	const inherited = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "parent", thinking: "low", truncated: false, outcome: "success", route: { status: "inherited" } } },
		{ expanded: false }, theme, createRenderContext(),
	);
	expect(inherited.render(120)).toContainEqual(expect.stringContaining("✅ parent • low"));

	const fallback = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "parent", thinking: "medium", truncated: false, outcome: "success", route: { status: "unknown-fallback", requestedGroup: "rev", provider: "openai", modelId: "parent" } } },
		{ expanded: false }, theme, createRenderContext(),
	);
	expect(fallback.render(120)).toContainEqual(expect.stringContaining("rev? fallback → openai/parent • medium"));

	const escaped = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				model: "unused",
				thinking: "low",
				truncated: false,
				outcome: "success",
				route: {
					status: "routed",
					group: "review\n\u001b",
					provider: "open\tai",
					modelId: "gpt\rrouted",
				},
			},
		},
		{ expanded: false }, theme, createRenderContext(),
	);
	const escapedLines = escaped.render(120);
	expect(escapedLines).toContainEqual(expect.stringContaining("review\\n\\x1B → open\\tai/gpt\\rrouted • low"));
	expect(escapedLines.filter((line: string) => line.includes("\u001b"))).toStrictEqual([]);
});

test("collapsed nested spawn render keeps all text blocks from the last assistant message", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining("first"));
	expect(lines).toContainEqual(expect.stringContaining("second"));
});

async function renderCollapsedPreview(text: string, width: number): Promise<string[]> {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text }] },
	]));
	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	return component.render(width);
}

test("collapsed nested spawn preview strips OSC 8 hyperlink sequences from child text", async () => {
	const lines = await renderCollapsedPreview(
		"see \u001b]8;;https://example.com\u0007the docs\u001b]8;;\u0007 now",
		120,
	);

	const preview = lines.find((l: string) => l.includes("the docs"));
	assertPresent(preview, "preview line with the link label is rendered");
	expect(preview).toContain("see the docs now");
	expect(preview, `escape byte leaked: ${JSON.stringify(preview)}`).not.toContain("\u001b");
	expect(preview).not.toContain("example.com");
});

test("collapsed nested spawn preview strips erase and cursor-home sequences from child text", async () => {
	const lines = await renderCollapsedPreview("before\u001b[2Kmiddle\u001b[Hafter", 120);

	const preview = lines.find((l: string) => l.includes("before"));
	assertPresent(preview, "preview line is rendered");
	expect(preview).toContain("beforemiddleafter");
	expect(preview, `escape byte leaked: ${JSON.stringify(preview)}`).not.toContain("\u001b");
});

test("collapsed nested spawn preview leaves plain text unchanged", async () => {
	const lines = await renderCollapsedPreview("plain text, with unicode: café — 日本", 120);

	expect(lines).toContainEqual(expect.stringContaining("plain text, with unicode: café — 日本"));
});

test("collapsed nested spawn truncation preserves shell background across preview and stats lines", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "Research the nudge on toggle off TODO from the readonly mode plan." }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		ansiTheme,
		createRenderContext(),
	);

	const lines = component.render(24);
	const previewLine = getRenderedLine(lines, plain => plain.includes("Research"));
	const statsLine = getRenderedLine(lines, plain => plain.includes("tok 12/34"));
	assertShellBackgroundPreserved(previewLine);
	assertShellBackgroundPreserved(statsLine);
	expect(stripAnsi(statsLine)).toMatch(/tok 12\/34/);
});

test("collapsed nested spawn keeps truncated stats line calm", async () => {
	const markerTheme = {
		fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "short preview" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				model: "mock-model",
				thinking: "medium",
				truncated: true,
				stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 },
			},
		},
		{ expanded: false },
		markerTheme,
		createRenderContext(),
	);

	const lines = component.render(120);
	const statsLine = getLineContaining(lines, "tok 12/34");
	expect(statsLine).toMatch(/<dim>.*tok 12\/34.*trunc.*<\/dim>/);
	expect(statsLine).not.toContain("<warning>");
});

test("static no-output child error with empty details renders without fabricated identity", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "Child agent produced no output." }],
			details: {},
		},
		{ expanded: false },
		theme,
		createRenderContext({ isError: true }),
	);
	const lines = component.render(120);

	expect(lines).toContainEqual(expect.stringContaining("💬 error"));
	expect(lines).toContainEqual(expect.stringContaining("Child agent produced no output."));
	expect(lines).not.toContainEqual(expect.stringContaining("unknown"));
});

const returnedErrorResult = {
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
const errorResultRenderCases = [
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

for (const { name, result, present, staticPresent, absent } of errorResultRenderCases) {
	test(`${name} statically`, async () => {
		const state = createState();
		const childSpawnTool = await makeChildSpawnTool(state);

		const lines = (childSpawnTool.renderResult(
			result,
			{ expanded: false },
			theme,
			createRenderContext({ isError: true }),
		)).render(120);
		for (const text of [...present, ...staticPresent]) {
			expect(lines).toContainEqual(expect.stringContaining(text));
		}
		for (const text of absent) {
			expect(lines).not.toContainEqual(expect.stringContaining(text));
		}
	});

	test(`${name} on a retained child`, async () => {
		const state = createState();
		const childSpawnTool = await makeChildSpawnTool(state);

		state.childSessions.set("tool-call-1", createSession([]));
		const running = childSpawnTool.renderResult(
			{ content: [], details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running" } },
			{ expanded: false },
			theme,
			createRenderContext(),
		);
		const retained = childSpawnTool.renderResult(
			result,
			{ expanded: false },
			theme,
			createRenderContext({ lastComponent: running, isError: true }),
		);
		const lines = retained.render(120);
		expect(retained).toBe(running);
		for (const text of present) {
			expect(lines).toContainEqual(expect.stringContaining(text));
		}
		for (const text of absent) {
			expect(lines).not.toContainEqual(expect.stringContaining(text));
		}
	});
}

test("retained nested spawn preserves identity when malformed terminal details report an error", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running" } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: {} },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component, isError: true }),
	);
	const collapsedLines = sameComponent.render(120);

	expect(sameComponent).toBe(component);
	expect(collapsedLines).toContainEqual(expect.stringContaining("⚠ mock-model • high"));
	expect(collapsedLines).toContainEqual(expect.stringContaining("💬 error"));
	expect((sameComponent).details.outcome).toBe("error");

	const expandedComponent = childSpawnTool.renderResult(
		{ content: [], details: {} },
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, lastComponent: sameComponent, isError: true }),
	);
	const expandedLines = expandedComponent.render(120);
	expect(expandedComponent).toBe(component);
	expect(expandedLines).toContainEqual(expect.stringContaining("⚠ mock-model • high"));
});

test("spawn result ignores malformed route and stats fields", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				model: "safe-model",
				thinking: "medium",
				truncated: false,
				outcome: "success",
				route: { status: "routed", group: ["review"], provider: null, modelId: 42 },
				stats: { inputTokens: "12", outputTokens: null, cost: Number.NaN },
				statsUnavailable: "yes",
			},
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	const lines = component.render(120);

	expect(lines).toContainEqual(expect.stringContaining("✅ safe-model • medium"));
	expect(lines).not.toContainEqual(expect.stringContaining("review"));
	expect(lines).not.toContainEqual(expect.stringContaining("tok "));
	expect(lines).not.toContainEqual(expect.stringContaining("stats unavailable"));
});

test("nested spawn render is safe without details", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }] },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	const lines = component.render(120);
	expect(lines).toContainEqual(expect.stringContaining("hello"));
});

test("expanded nested spawn header stays within width after indent", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "model-name", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true }),
	);

	const lines = component.render(24);
	const headerLine = lines.find((line: string) => line.includes("model-name")) ?? "";
	expectPrefix(headerLine, " ".repeat(5));
	expect(stripAnsi(headerLine).length).toBeLessThanOrEqual(24);
});

test("nested spawn render cache preserves stable output for identical params", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([]);
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);

	const first = component.render(120);
	const second = component.render(120);
	expect(second).toStrictEqual(first);
});

test("nested spawn clears cached render when showImages changes", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }, { type: "image", data: "iVBOR", mimeType: "image/png" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: true }),
	);
	const linesWithImages = component.render(120);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: false, lastComponent: component }),
	);
	const linesWithoutImages = sameComponent.render(120);

	expect(sameComponent).toBe(component);
	expect(linesWithImages).toSatisfy(Array.isArray);
	expect(linesWithoutImages).toSatisfy(Array.isArray);
	expect((sameComponent).cachedShowImages).toBe(false);
});

test("nested spawn rerenders when stats become unavailable", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	const before = component.render(120);
	expect(before).not.toContainEqual(expect.stringContaining("stats unavailable"));

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	);
	const after = sameComponent.render(120);

	expect(sameComponent).toBe(component);
	expect(after).toContainEqual(expect.stringContaining("stats unavailable"));
	expect(after).not.toContainEqual(expect.stringContaining("initializing"));
});

const collapsedStatsCases = [
	{
		name: "collapsed spawn stats show unavailable text when stats are marked unavailable",
		stats: false,
		statsUnavailable: true,
		present: ["stats unavailable"],
		absent: ["tok 12/34"],
	},
	{
		name: "collapsed spawn stats show figures when stats are available",
		stats: true,
		statsUnavailable: false,
		present: ["tok 12/34"],
		absent: ["stats unavailable"],
	},
];

for (const { name, stats, statsUnavailable, present, absent } of collapsedStatsCases) {
	test(name, async () => {
		const state = createState();
		const childSpawnTool = await makeChildSpawnTool(state);
		state.childSessions.set("tool-call-1", createSession([]));
		const component = childSpawnTool.renderResult(
			{
				content: [],
				details: {
					model: "mock-model",
					thinking: "medium",
					truncated: false,
					outcome: "success",
					...(stats ? { stats: { inputTokens: 12, outputTokens: 34, turns: 2, cost: 0.125 } } : {}),
					...(statsUnavailable ? { statsUnavailable: true } : {}),
				},
			},
			{ expanded: false },
			theme,
			createRenderContext(),
		);
		const lines = component.render(120);
		for (const text of present) {
			expect(lines).toContainEqual(expect.stringContaining(text));
		}
		for (const text of absent) {
			expect(lines).not.toContainEqual(expect.stringContaining(text));
		}
	});
}

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

for (const { name, outcome, isError, present, absent } of stopReasonOutcomeCases) {
	test(name, async () => {
		// The child's error message renders through pi's global theme.
		initTheme();
		const state = createState();
		const childSpawnTool = await makeChildSpawnTool(state);
		state.childSessions.set("tool-call-1", createSession([
			{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "provider failed" },
		]));
		const lines = (childSpawnTool.renderResult(
			{ content: [], details: { model: "mock-model", thinking: "high", truncated: false, outcome } },
			{ expanded: false },
			theme,
			createRenderContext({ isError }),
		)).render(120);
		expect(lines).toContainEqual(expect.stringContaining(present));
		expect(lines).not.toContainEqual(expect.stringContaining(absent));
	});
}
