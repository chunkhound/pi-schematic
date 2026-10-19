/**
 * Render-focused tests for the spawn module.
 *
 * Extracted from spawn.test.ts to keep focused suites. These tests
 * verify visual rendering of spawn results — collapsed/expanded
 * output, theme application, truncation display, and render caching.
 *
 * Execution and lifecycle tests remain in spawn.test.ts.
 */

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
});

afterEach(() => {
	h.teardown();
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
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("mock-model • medium")));
	assert.ok(lines.some((l: string) => l.includes("one")));
	assert.ok(lines.some((l: string) => l.includes("five")));
	assert.ok(lines.some((l: string) => l.includes("... 2 more lines")));
	assert.ok(lines.some((l: string) => l.includes("tok 12/34")));
	assert.ok(lines.some((l: string) => l.includes("trunc")));
});

test("spawn result identity formats default routed and unknown fallback", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
	const routed = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "gpt-routed", thinking: "high", truncated: false, outcome: "success", route: { status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" } } },
		{ expanded: false }, theme, createRenderContext(),
	) as any;
	assert.ok(routed.render(120).some((l: string) => l.includes("review → openai/gpt-routed • high")));

	const inherited = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "parent", thinking: "low", truncated: false, outcome: "success", route: { status: "inherited" } } },
		{ expanded: false }, theme, createRenderContext(),
	) as any;
	assert.ok(inherited.render(120).some((l: string) => l.includes("✅ parent • low")));

	const fallback = childSpawnTool.renderResult(
		{ content: [{ type: "text", text: "done" }], details: { model: "parent", thinking: "medium", truncated: false, outcome: "success", route: { status: "unknown-fallback", requestedGroup: "rev", provider: "openai", modelId: "parent" } } },
		{ expanded: false }, theme, createRenderContext(),
	) as any;
	assert.ok(fallback.render(120).some((l: string) => l.includes("rev? fallback → openai/parent • medium")));

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
	) as any;
	const escapedLines = escaped.render(120);
	assert.ok(escapedLines.some((line: string) => line.includes("review\\n\\x1B → open\\tai/gpt\\rrouted • low")));
	assert.ok(escapedLines.every((line: string) => !line.includes("\u001b")));
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
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("first")));
	assert.ok(lines.some((l: string) => l.includes("second")));
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
	) as any;
	return component.render(width);
}

test("collapsed nested spawn preview strips OSC 8 hyperlink sequences from child text", async () => {
	const lines = await renderCollapsedPreview(
		"see \u001b]8;;https://example.com\u0007the docs\u001b]8;;\u0007 now",
		120,
	);

	const preview = lines.find((l: string) => l.includes("the docs"));
	assert.ok(preview, "preview line with the link label is rendered");
	assert.ok(preview.includes("see the docs now"));
	assert.ok(!preview.includes("\u001b"), `escape byte leaked: ${JSON.stringify(preview)}`);
	assert.ok(!preview.includes("example.com"));
});

test("collapsed nested spawn preview strips erase and cursor-home sequences from child text", async () => {
	const lines = await renderCollapsedPreview("before\u001b[2Kmiddle\u001b[Hafter", 120);

	const preview = lines.find((l: string) => l.includes("before"));
	assert.ok(preview, "preview line is rendered");
	assert.ok(preview.includes("beforemiddleafter"));
	assert.ok(!preview.includes("\u001b"), `escape byte leaked: ${JSON.stringify(preview)}`);
});

test("collapsed nested spawn preview leaves plain text unchanged", async () => {
	const lines = await renderCollapsedPreview("plain text, with unicode: café — 日本", 120);

	assert.ok(lines.some((l: string) => l.includes("plain text, with unicode: café — 日本")));
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
	) as any;

	const lines = component.render(24);
	const previewLine = getRenderedLine(lines, plain => plain.includes("Research"));
	const statsLine = getRenderedLine(lines, plain => plain.includes("tok 12/34"));
	assertShellBackgroundPreserved(previewLine);
	assertShellBackgroundPreserved(statsLine);
	assert.match(stripAnsi(statsLine), /tok 12\/34/);
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
	) as any;

	const lines = component.render(120);
	const statsLine = getLineContaining(lines, "tok 12/34");
	assert.match(statsLine, /<dim>.*tok 12\/34.*trunc.*<\/dim>/);
	assert.equal(statsLine.includes("<warning>"), false);
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
	) as any;
	const lines = component.render(120);

	assert.ok(lines.some((line: string) => line.includes("💬 error")));
	assert.ok(lines.some((line: string) => line.includes("Child agent produced no output.")));
	assert.equal(lines.some((line: string) => line.includes("unknown")), false);
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
		) as any).render(120);
		for (const text of [...present, ...staticPresent]) {
			assert.ok(lines.some((line: string) => line.includes(text)));
		}
		for (const text of absent) {
			assert.equal(lines.some((line: string) => line.includes(text)), false);
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
		) as any;
		const retained = childSpawnTool.renderResult(
			result,
			{ expanded: false },
			theme,
			createRenderContext({ lastComponent: running, isError: true }),
		) as any;
		const lines = retained.render(120);
		assert.equal(retained, running);
		for (const text of present) {
			assert.ok(lines.some((line: string) => line.includes(text)));
		}
		for (const text of absent) {
			assert.equal(lines.some((line: string) => line.includes(text)), false);
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
	) as any;
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: {} },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component, isError: true }),
	) as any;
	const collapsedLines = sameComponent.render(120);

	assert.equal(sameComponent, component);
	assert.ok(collapsedLines.some((line: string) => line.includes("⚠ mock-model • high")));
	assert.ok(collapsedLines.some((line: string) => line.includes("💬 error")));
	assert.equal((sameComponent as any).details.outcome, "error");

	const expandedComponent = childSpawnTool.renderResult(
		{ content: [], details: {} },
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, lastComponent: sameComponent, isError: true }),
	) as any;
	const expandedLines = expandedComponent.render(120);
	assert.equal(expandedComponent, component);
	assert.ok(expandedLines.some((line: string) => line.includes("⚠ mock-model • high")));
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
	) as any;
	const lines = component.render(120);

	assert.ok(lines.some((line: string) => line.includes("✅ safe-model • medium")));
	assert.equal(lines.some((line: string) => line.includes("review")), false);
	assert.equal(lines.some((line: string) => line.includes("tok ")), false);
	assert.equal(lines.some((line: string) => line.includes("stats unavailable")), false);
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
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
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
	) as any;

	const lines = component.render(24);
	const headerLine = lines.find((line: string) => line.includes("model-name")) ?? "";
	assert.ok(headerLine.startsWith("     "));
	assert.ok(stripAnsi(headerLine).length <= 24);
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
	) as any;

	const first = component.render(120);
	const second = component.render(120);
	assert.deepEqual(second, first);
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
	) as any;
	const linesWithImages = component.render(120);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false },
		},
		{ expanded: true },
		theme,
		createRenderContext({ expanded: true, showImages: false, lastComponent: component }),
	) as any;
	const linesWithoutImages = sameComponent.render(120);

	assert.equal(sameComponent, component);
	assert.ok(Array.isArray(linesWithImages));
	assert.ok(Array.isArray(linesWithoutImages));
	assert.equal((sameComponent as any).cachedShowImages, false);
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
	) as any;
	const before = component.render(120);
	assert.equal(before.some((l: string) => l.includes("stats unavailable")), false);

	const sameComponent = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;
	const after = sameComponent.render(120);

	assert.equal(sameComponent, component);
	assert.ok(after.some((l: string) => l.includes("stats unavailable")));
	assert.equal(after.some((l: string) => l.includes("initializing")), false);
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
		) as any;
		const lines = component.render(120);
		for (const text of present) {
			assert.ok(lines.some((line: string) => line.includes(text)));
		}
		for (const text of absent) {
			assert.equal(lines.some((line: string) => line.includes(text)), false);
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
		) as any).render(120);
		assert.ok(lines.some((line: string) => line.includes(present)));
		assert.equal(lines.some((line: string) => line.includes(absent)), false);
	});
}
