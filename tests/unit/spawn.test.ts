import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createState, resetState } from "../../state.js";
import {
	buildChildToolNames,
	createChildTools,
	executeSpawn,
	normalizeSpawnRequirements,
	registerSpawnTool,
	truncateText,
} from "../../spawn/index.js";
import { renderSpawnResult } from "../../spawn/renderer.js";
import { SpawnRouteError } from "../../model-groups/router.js";
import { createConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { Value } from "typebox/value";
import { testMinContext } from "./model-groups-constraints-fixture.js";
import { createTestPI, createRenderContext, createSession, theme, createDeferred } from "./helpers.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";

let h: TestHarness;

// ── Test helpers ─────────────────────────────────────────────────────
// Hoisted so all tests can reference them (used from line ~79 onward).
function mockSessionFactory(opts: {
	prompt?: (prompt?: string) => Promise<any>;
	abort?: () => Promise<any>;
	dispose?: () => void;
	result?: any[];
	thinkingLevel?: string;
	getSessionStats?: () => any;
} = {}) {
	const defaultResult = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
	const session: any = {
		messages: [] as any[],
		get thinkingLevel() { return opts.thinkingLevel; },
		prompt: async (p?: string) => {
			if (opts.prompt) await opts.prompt(p);
			session.messages = opts.result ?? defaultResult;
		},
		abort: opts.abort ?? (async () => {}),
		dispose: opts.dispose ?? (() => {}),
		getSessionStats: opts.getSessionStats ?? (() => undefined),
	};
	return session;
}

/** Create a session factory for spawn tests — wraps mockSessionFactory with the expected return shape. */
function mockFactoryWith(opts: Parameters<typeof mockSessionFactory>[0] = {}) {
	return async () => ({ session: mockSessionFactory(opts), extensionsResult: undefined as any });
}

function makeChildSpawnTool(state: any) {
	const pi = createTestPI();
	registerSpawnTool(pi as any, state);
	return pi.tools.get("spawn");
}

beforeEach(() => {
	h = createTestHarness();
});

afterEach(() => {
	h.teardown();
});

function createFailingCleanupSession(primaryFailure: unknown, cleanupFailure: unknown) {
	return {
		messages: [] as any[],
		prompt: async () => { throw primaryFailure; },
		abort: async () => {},
		dispose: () => { throw cleanupFailure; },
		getSessionStats: () => undefined,
	};
}

function executeWithFailingCleanup(primaryFailure: unknown, cleanupFailure: unknown, context: Record<string, unknown> = {}) {
	const pi = createTestPI();
	const state = createState();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const session = createFailingCleanupSession(primaryFailure, cleanupFailure);
	return {
		execution: executeSpawn(
			"spawn-cleanup-failure", pi as any,
			{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: false, ...context } as any,
			state, { prompt: "Do the task" }, undefined, undefined, "medium",
			async () => ({ extensionsResult: undefined as any, session: session as any }),
		),
		state,
	};
}

function executeWithDisposeFailure(toolCallId: string, context: Record<string, unknown> = {}) {
	const cleanupError = new Error("dispose failed");
	const pi = createTestPI();
	const state = createState();
	pi.setActiveTools(["read", "bash", "spawn"]);
	registerSpawnTool(pi as any, state, mockFactoryWith({
		prompt: async () => {},
		dispose: () => { throw cleanupError; },
	}));
	return {
		execution: pi.tools.get("spawn").execute(
			toolCallId,
			{ prompt: "Do the task" },
			undefined,
			undefined,
			{ model: { id: "mock-model" }, cwd: "/tmp", ...context } as any,
		),
		state,
		cleanupError,
	};
}

function assertChildRegistriesCleared(state: ReturnType<typeof createState>): void {
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
}

function assertAggregateFailure(error: unknown, message: string, failures: unknown[]): boolean {
	assert.ok(error instanceof AggregateError);
	assert.equal(error.message, message);
	assert.deepEqual(error.errors, failures);
	return true;
}

test("spawn execute passes broad active registered tool formula to child session", async () => {
	const pi = createTestPI();
	pi.setToolSource("project_search", "project");
	pi.setToolSource("inactive_registered", "extension");
	pi.setActiveTools(["read", "bash", "spawn", "handoff", "project_search", "phantom_tool"]);
	pi.setAllTools(["read", "bash", "spawn", "handoff", "project_search", "inactive_registered"]);
	const state = createState();
	const requestedCwd = "/tmp";

	let seenConfig: any;
	registerSpawnTool(pi as any, state, async (config: any) => {
		seenConfig = config;
		return { session: mockSessionFactory({ prompt: async () => {} }), extensionsResult: undefined as any };
	});

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task", thinking: "high" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: requestedCwd },
	);

	assert.equal(seenConfig.model.id, "mock-model");
	assert.equal(seenConfig.thinkingLevel, "high");
	assert.equal(seenConfig.cwd, requestedCwd);
	assert.equal(
		seenConfig.sessionManager.getCwd(),
		resolve(requestedCwd),
		"child session manager resolves ctx.cwd through Pi's native path semantics",
	);
	assert.equal(seenConfig.sessionManager.isPersisted(), false, "child transcript remains in-memory and isolated");
	assert.equal(seenConfig.sessionManager.getSessionFile(), undefined, "child transcript has no parent session file");
	assert.deepEqual(seenConfig.sessionManager.getEntries(), [], "child transcript starts independently empty");
	assert.deepEqual(
		new Set(seenConfig.tools),
		new Set(["read", "bash", "project_search", "notebook_write", "notebook_read", "notebook_index"]),
	);
	assert.deepEqual(seenConfig.customTools.map((tool: any) => tool.name), ["notebook_write", "notebook_read", "notebook_index"]);
});

test("spawn forwards requested thinking and reports the session effective thinking", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "spawn"]);
	const state = createState();
	const updates: any[] = [];
	let seenConfig: any;
	registerSpawnTool(pi as any, state, async (config: any) => {
		seenConfig = config;
		return { session: mockSessionFactory({ thinkingLevel: "off", prompt: async () => {} }), extensionsResult: undefined as any };
	});

	const result = await pi.tools.get("spawn").execute(
		"spawn-effective-thinking",
		{ prompt: "Do the task", thinking: "max" },
		undefined,
		(update: any) => updates.push(update),
		{ model: { id: "non-reasoning-model", reasoning: false }, cwd: "/tmp" },
	);

	assert.equal(seenConfig.thinkingLevel, "max", "requested thinking is forwarded unchanged");
	assert.equal(updates[0].details.thinking, "off", "running details report Pi's effective thinking");
	assert.equal(result.details.thinking, "off", "final details report Pi's effective thinking");
	assert.deepEqual(result.details.route, { status: "inherited" });
});

test("spawn execute composes Model Group routing with readonly child guards", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "write", "edit", "spawn", "handoff"]);
	pi.setAllTools(["read", "bash", "write", "edit", "spawn", "handoff"]);
	const state = createState();
	state.readonlyEnabled = true;
	const routedModel = { provider: "openai", id: "gpt-routed", reasoning: true };
	state.modelGroups.groups = [{
		name: "review",
		scope: "project",
		sourcePath: "<project>",
		models: [{ provider: "openai", modelId: "gpt-routed", thinkingLevel: "low" }],
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: false },
	} as any];
	const parentRegistry = {
		find: (provider: string, modelId: string) => provider === "openai" && modelId === "gpt-routed" ? routedModel : undefined,
		hasConfiguredAuth: (model: any) => model === routedModel,
	};
	let seenConfig: any;
	let seenPrompt = "";
	registerSpawnTool(pi as any, state, async (config: any) => {
		seenConfig = config;
		return { session: mockSessionFactory({
			prompt: async (p?: string) => { seenPrompt = p ?? ""; },
		}), extensionsResult: undefined as any };
	});

	const result = await pi.tools.get("spawn").execute(
		"spawn-routed",
		{ prompt: "Do the task", group: "review", thinking: "xhigh" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent" }, cwd: "/tmp", modelRegistry: parentRegistry },
	);

	assert.equal(seenConfig.model, routedModel);
	assert.equal(seenConfig.thinkingLevel, "low");
	assert.equal(seenConfig.modelRegistry, undefined);
	assert.equal(seenConfig.authStorage, undefined);
	assert.deepEqual(
		new Set(seenConfig.tools),
		new Set(["read", "bash", "notebook_write", "notebook_read", "notebook_index"]),
	);
	assert.ok(seenConfig.customTools.some((tool: any) => tool.name === "bash"));
	assert.ok(!seenConfig.tools.includes("write"));
	assert.ok(!seenConfig.tools.includes("edit"));
	assert.ok(!seenConfig.tools.includes("spawn"));
	assert.ok(!seenConfig.tools.includes("handoff"));
	assert.match(seenPrompt, /inherit readonly authority/i);
	assert.match(seenPrompt, /\[readonly\] write\/edit blocked/i);
	assert.deepEqual(result.details.route, { status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" });
});

test("spawn routes capability requirements to capable members via random selection on the filtered pool", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const capA = { provider: "openai", id: "gpt-cap-a", reasoning: true, input: ["text", "image"] };
	const capB = { provider: "openai", id: "gpt-cap-b", reasoning: true, input: ["text", "image"] };
	const textOnly = { provider: "openai", id: "gpt-text", reasoning: true, input: ["text"] };
	state.modelGroups.groups = [{
		name: "multi",
		scope: "project",
		sourcePath: "<project>",
		models: [{ provider: "openai", modelId: "gpt-cap-a" }, { provider: "openai", modelId: "gpt-cap-b" }, { provider: "openai", modelId: "gpt-text" }],
		constraints: { modalities: ["text", "image"] },
		modalities: { common: ["text"], supported: ["text", "image"], effective: ["text", "image"] },
	} as any];
	const seenModels: string[] = [];
	registerSpawnTool(pi as any, state, async (config: any) => {
		seenModels.push(config.model.id);
		return { session: mockSessionFactory({ prompt: async () => {} }), extensionsResult: undefined as any };
	});
	const ctx = { model: { provider: "openai", id: "parent" }, cwd: "/tmp", modelRegistry: {
		find: (_p: string, id: string) => id === "gpt-cap-a" ? capA : id === "gpt-cap-b" ? capB : id === "gpt-text" ? textOnly : undefined,
		hasConfiguredAuth: (m: any) => m === capA || m === capB || m === textOnly,
	} } as any;
	// Deterministic random draws: first spawn lands on the first capable member,
	// the second on the second — proving selection is random over the filtered pool.
	const originalRandom = Math.random;
	let draw = 0;
	Math.random = () => (draw++ === 0 ? 0.05 : 0.95);
	try {
		await pi.tools.get("spawn").execute("spawn-a", { prompt: "t", group: "multi", constraints: { modalities: { required: ["image"] } } }, undefined, undefined, ctx);
		await pi.tools.get("spawn").execute("spawn-b", { prompt: "t", group: "multi", constraints: { modalities: { required: ["image"] } } }, undefined, undefined, ctx);
	} finally {
		Math.random = originalRandom;
	}
	assert.deepEqual(seenModels, ["gpt-cap-a", "gpt-cap-b"], "each spawn draws a capable member from the filtered pool; non-capable members are never selected");
});

test("spawn injects a capability ceiling notice for a routed group with image disabled", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.notebookPages.set("entry-a", "preview\nbody");
	const routedModel = { provider: "openai", id: "gpt-vision", reasoning: true, input: ["text", "image"] };
	state.modelGroups.groups = [{
		name: "quick",
		scope: "project",
		sourcePath: "<project>",
		models: [{ provider: "openai", modelId: "gpt-vision" }],
		constraints: { modalities: ["text", "reasoning"] },
		modalities: {
			common: ["text", "reasoning"],
			supported: ["text", "image", "reasoning"],
			effective: ["text", "reasoning"],
		},
	} as any];
	const parentRegistry = {
		find: (_provider: string, modelId: string) => modelId === "gpt-vision" ? routedModel : undefined,
		hasConfiguredAuth: (model: any) => model === routedModel,
	};
	let seenPrompt = "";
	registerSpawnTool(pi as any, state, async (config: any) => ({
		session: mockSessionFactory({ prompt: async (p?: string) => { seenPrompt = p ?? ""; } }),
		extensionsResult: undefined as any,
	}));
	await pi.tools.get("spawn").execute(
		"spawn-quick",
		{ prompt: "Read the image in file.png", group: "quick" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent" }, cwd: "/tmp", modelRegistry: parentRegistry },
	);
	assert.match(seenPrompt, /## Model Group capability ceiling/i);
	assert.match(seenPrompt, /image input is disabled/i);
	assert.match(seenPrompt, /report the capability mismatch/i);
});

test("spawn injects descriptor-provided scalar capability ceilings", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const small = { provider: "openai", id: "small", input: ["text"], reasoning: false, contextWindow: 10 };
	const large = { provider: "openai", id: "large", input: ["text"], reasoning: false, contextWindow: 100 };
	state.modelGroups.groups = [{
		name: "context-capped", scope: "project", sourcePath: "<project>",
		models: [{ provider: "openai", modelId: "small" }, { provider: "openai", modelId: "large" }],
		constraints: { testMinContext: 50 },
		modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
	} as any];
	let seenPrompt = "";
	registerSpawnTool(pi as any, state, async () => ({
		session: mockSessionFactory({ prompt: async (prompt?: string) => { seenPrompt = prompt ?? ""; } }),
		extensionsResult: undefined as any,
	}), createConstraintRegistry([testMinContext]));
	await pi.tools.get("spawn").execute("spawn-context-cap", { prompt: "Do the task", group: "context-capped" }, undefined, undefined, {
		model: { provider: "openai", id: "parent", contextWindow: 100 }, cwd: "/tmp",
		modelRegistry: { find: (_provider: string, id: string) => id === "small" ? small : id === "large" ? large : undefined, hasConfiguredAuth: () => true },
	} as any);
	assert.match(seenPrompt, /## Model Group capability ceiling/i);
	assert.match(seenPrompt, /minimum context is capped at 50 tokens/i);
});

test("spawn execute builds prompt with notebook pages and task", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.notebookPages.set("entry-a", "preview line\nfull body");

	let seenPrompt = "";
	registerSpawnTool(pi as any, state, mockFactoryWith({
		prompt: async (p?: string) => { seenPrompt = p ?? ""; },
	}));

	await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	// Verify user-facing invariants: task text is included, notebook pages are referenced
	assert.match(seenPrompt, /Do the task/);
	assert.match(seenPrompt, /entry-a: preview line/);
	assert.match(seenPrompt, /durable shared memory for the parent and future contexts/i);
	assert.doesNotMatch(seenPrompt, /durable grounding/i);
});

test("spawn emits no capability notice when the routed group has no explicit override", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.modelGroups.groups = [{
		name: "open",
		scope: "project",
		sourcePath: "<project>",
		models: [{ provider: "openai", modelId: "gpt-vision" }],
	} as any];
	const routedModel = { provider: "openai", id: "gpt-vision", reasoning: true, input: ["text", "image"] };
	const parentRegistry = {
		find: (_provider: string, modelId: string) => modelId === "gpt-vision" ? routedModel : undefined,
		hasConfiguredAuth: (model: any) => model === routedModel,
	};
	let seenPrompt = "";
	registerSpawnTool(pi as any, state, async (config: any) => ({
		session: mockSessionFactory({ prompt: async (p?: string) => { seenPrompt = p ?? ""; } }),
		extensionsResult: undefined as any,
	}));
	await pi.tools.get("spawn").execute(
		"spawn-open",
		{ prompt: "Do the task", group: "open" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent" }, cwd: "/tmp", modelRegistry: parentRegistry },
	);
	assert.doesNotMatch(seenPrompt, /capability ceiling/i);
	assert.doesNotMatch(seenPrompt, /image input is disabled/i);
});

test("truncateText handles multi-byte boundaries correctly", () => {
	assert.equal(truncateText("🙂", 10, 2), "");
	assert.equal(truncateText("🙂", 10, 4), "🙂");
	assert.equal(truncateText("", 10, 1024), "");
	assert.equal(truncateText("hello", 10, 1024), "hello");
});

test("truncateText respects line limit before byte limit", () => {
	const text = Array.from({ length: 2500 }, (_, i) => `Line ${i}`).join("\n");
	const truncated = truncateText(text, 2000, 50 * 1024);
	const lines = truncated.split("\n");
	assert.ok(lines.length <= 2000, `expected <= 2000 lines, got ${lines.length}`);
	assert.ok(lines[0].startsWith("Line 0"));
});

test("truncateText applies byte limit after line limit", () => {
	const longText = "🙂".repeat(20_000);
	const truncated = truncateText(longText, 10, 100);
	const bytes = new TextEncoder().encode(truncated).length;
	assert.ok(bytes <= 100, `expected <= 100 bytes, got ${bytes}`);
});

// ── Build child tool names ─────────────────────────────────────────

test("child tool names inherit active registered builtins and exclude recursive controls", () => {
	const state = createState();
	const childTools = createChildTools(createTestPI() as any, state);
	assert.equal(childTools.some(t => t.name === "spawn"), false);
	const childToolNames = buildChildToolNames(
		["read", "bash", "spawn", "handoff", "future_tool"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "spawn", sourceInfo: { source: "builtin" } },
			{ name: "handoff", sourceInfo: { source: "builtin" } },
			{ name: "future_tool", sourceInfo: { source: "project" } },
		] as any,
	);
	assert.equal(childToolNames.includes("read"), true);
	assert.equal(childToolNames.includes("bash"), true);
	assert.equal(childToolNames.includes("spawn"), false);
	assert.equal(childToolNames.includes("handoff"), false);
});

test("child tool names inherit active registered MCP extension tools", () => {
	const state = createState();
	const childTools = createChildTools(createTestPI() as any, state);
	const toolNames = buildChildToolNames(
		["read", "chunkhound_code_research", "mcp_status"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "chunkhound_code_research", sourceInfo: { source: "extension" } },
			{ name: "mcp_status", sourceInfo: { source: "extension" } },
		] as any,
	);
	assert.equal(toolNames.includes("chunkhound_code_research"), true);
	assert.equal(toolNames.includes("mcp_status"), true);
});

test("child tool names inherit active registered project package and local extension tools", () => {
	const state = createState();
	const childTools = createChildTools(createTestPI() as any, state);
	const toolNames = buildChildToolNames(
		["project_search", "package_lint", "local_helper"],
		childTools,
		[
			{ name: "project_search", sourceInfo: { source: "project" } },
			{ name: "package_lint", sourceInfo: { source: "package" } },
			{ name: "local_helper", sourceInfo: { source: "local" } },
		] as any,
	);
	assert.equal(toolNames.includes("project_search"), true);
	assert.equal(toolNames.includes("package_lint"), true);
	assert.equal(toolNames.includes("local_helper"), true);
});

test("child tool names exclude inactive registered and active phantom tools", () => {
	const state = createState();
	const childTools = createChildTools(createTestPI() as any, state);
	const toolNames = buildChildToolNames(
		["read", "active_phantom"],
		childTools,
		[
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "inactive_registered", sourceInfo: { source: "extension" } },
		] as any,
	);
	assert.equal(toolNames.includes("read"), true);
	assert.equal(toolNames.includes("inactive_registered"), false);
	assert.equal(toolNames.includes("active_phantom"), false);
	assert.ok(toolNames.includes("notebook_write"));
	assert.ok(toolNames.includes("notebook_read"));
	assert.ok(toolNames.includes("notebook_index"));
	assert.equal(toolNames.includes("handoff"), false);
	assert.equal(toolNames.includes("spawn"), false);
});

test("buildChildToolNames (2-arg fallback) removes spawn and handoff from inherited tools", () => {
	const result = buildChildToolNames(["read", "bash", "spawn", "handoff"], []);
	assert.ok(!result.includes("spawn"), "spawn must be filtered out");
	assert.ok(!result.includes("handoff"), "handoff must be filtered out");
	assert.ok(result.includes("read"), "read must be preserved");
	assert.ok(result.includes("bash"), "bash must be preserved");
});

test("buildChildToolNames (2-arg fallback) preserves non-spawn/handoff tools", () => {
	const result = buildChildToolNames(["read", "bash", "write", "edit"], []);
	assert.deepEqual(result.sort(), ["bash", "edit", "read", "write"]);
});

test("buildChildToolNames (2-arg fallback) adds custom child tools to the list", () => {
	const result = buildChildToolNames(["read"], [{ name: "custom-tool", description: "", parameters: {}, label: "", execute: async () => ({ content: [], details: undefined }) }]);
	assert.ok(result.includes("custom-tool"), "custom child tool must be added");
	assert.ok(result.includes("read"), "inherited tool must be preserved");
});

test("buildChildToolNames (2-arg fallback) deduplicates overlapping inherited and custom names", () => {
	const result = buildChildToolNames(["read", "bash"], [{ name: "bash", description: "", parameters: {}, label: "", execute: async () => ({ content: [], details: undefined }) }]);
	assert.deepEqual(result, ["read", "bash"]);
});

test("buildChildToolNames (2-arg fallback) handles empty parent tool names", () => {
	assert.deepEqual(buildChildToolNames([], [{ name: "only-child", description: "", parameters: {}, label: "", execute: async () => ({ content: [], details: undefined }) }]), ["only-child"]);
});

test("buildChildToolNames (2-arg fallback) handles empty custom tools", () => {
	assert.deepEqual(buildChildToolNames(["read", "bash"], []), ["read", "bash"]);
});

test("buildChildToolNames (2-arg fallback) handles both empty inputs", () => {
	assert.deepEqual(buildChildToolNames([], []), []);
});

// ── Render tests ─────────────────────────────────────────────────────

test("spawn renderResult falls back to static text when no live session is stored", () => {
	const state = createState();
	const pi = createTestPI();
	registerSpawnTool(pi as any, state);

	const result = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "fallback output" }],
			details: { model: "m", thinking: "low", truncated: false },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = result.render(120);
	assert.ok(lines.some((l: string) => l.includes("m • low")));
	assert.ok(lines.some((l: string) => l.includes("fallback output")));
});

test("spawn renderResult distinguishes aborted and error outcomes", () => {
	const state = createState();
	const pi = createTestPI();
	registerSpawnTool(pi as any, state);

	const aborted = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "stopped" }],
			details: { model: "m", thinking: "low", truncated: false, outcome: "aborted" },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;
	const error = pi.tools.get("spawn").renderResult(
		{
			content: [{ type: "text", text: "failed" }],
			details: { model: "m", thinking: "low", truncated: false, outcome: "error" },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const abortedLines = aborted.render(120);
	const errorLines = error.render(120);
	assert.ok(abortedLines.some((l: string) => l.includes("✗ m • low")));
	assert.ok(abortedLines.some((l: string) => l.includes("aborted")));
	assert.ok(errorLines.some((l: string) => l.includes("⚠ m • low")));
	assert.ok(errorLines.some((l: string) => l.includes("error")));
});

test("spawn execute returns result and stats", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	const updates: any[] = [];
	registerSpawnTool(pi as any, state, mockFactoryWith({
		prompt: async () => {},
		getSessionStats: () => ({
			tokens: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, total: 40 },
			cost: 0.5,
			assistantMessages: 2,
		}),
	}));

	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task", thinking: "high" },
		undefined,
		(update: any) => updates.push(update),
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.deepEqual(updates, [{
		content: [],
		details: { model: "mock-model", thinking: "high", truncated: false, outcome: "running", route: { status: "inherited" } },
	}]);
	assert.equal(result.content[0].text, "child result");
	assert.equal(result.details.outcome, "success");
	assert.deepEqual(result.details.stats, {
		inputTokens: 11,
		outputTokens: 22,
		cacheReadTokens: 3,
		cacheWriteTokens: 4,
		totalTokens: 40,
		cost: 0.5,
		turns: 2,
	});
});

test("spawn execute marks stats unavailable when stats collection throws", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	registerSpawnTool(pi as any, state, mockFactoryWith({
		prompt: async () => {},
		getSessionStats: () => { throw new Error("stats failed"); },
	}));
	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.details.stats, undefined);
	assert.equal(result.details.statsUnavailable, true);
});

test("spawn execute throws when child produces no output", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	registerSpawnTool(pi as any, state, mockFactoryWith({ result: [] }));

	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { model: { id: "mock-model" }, cwd: "/tmp" }),
		/Child agent produced no output\./,
	);
});

test("spawn execute clears childSessions when prompt throws", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	registerSpawnTool(pi as any, state, mockFactoryWith({
		prompt: async () => { throw new Error("prompt failed"); },
	}));

	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { model: { id: "mock-model" }, cwd: "/tmp" }),
		/prompt failed/,
	);
	assert.equal(state.childSessions.size, 0);
});

test("headless spawn aggregates Error and cleanup failures without mutating the primary error", async () => {
	const originalCause = new Error("original cause");
	const primaryFailure = new Error("prompt failed", { cause: originalCause });
	const cleanupFailure = new Error("dispose failed");
	Object.freeze(primaryFailure);
	const { execution, state } = executeWithFailingCleanup(primaryFailure, cleanupFailure);

	await assert.rejects(
		() => execution,
		(error: unknown) => assertAggregateFailure(error, "Spawn failed and cleanup failed.", [primaryFailure, cleanupFailure]),
	);
	assert.equal(primaryFailure.cause, originalCause);
	assertChildRegistriesCleared(state);
});

test("headless spawn aggregates primitive and cleanup failures", async () => {
	const primaryFailure = "prompt failed";
	const cleanupFailure = new Error("dispose failed");
	const { execution, state } = executeWithFailingCleanup(primaryFailure, cleanupFailure);

	await assert.rejects(
		() => execution,
		(error: unknown) => assertAggregateFailure(error, "Spawn failed and cleanup failed.", [primaryFailure, cleanupFailure]),
	);
	assertChildRegistriesCleared(state);
});

test("UI spawn notifies when cleanup also fails after a primary failure", async () => {
	const primaryFailure = new Error("prompt failed");
	const cleanupFailure = new Error("dispose failed");
	const notifications: Array<[string, string]> = [];
	const { execution, state } = executeWithFailingCleanup(primaryFailure, cleanupFailure, {
		hasUI: true,
		ui: { notify: (message: string, level: string) => { notifications.push([message, level]); } },
	});

	await assert.rejects(() => execution, (error: unknown) => error === primaryFailure);
	assert.deepEqual(notifications, [["Spawn cleanup failed: dispose failed", "error"]]);
	assertChildRegistriesCleared(state);
});

test("UI spawn aggregates failures without mutating a frozen primary error", async () => {
	const originalCause = new Error("original cause");
	const primaryFailure = new Error("prompt failed", { cause: originalCause });
	const cleanupFailure = new Error("dispose failed");
	const notifyError = new Error("notify failed");
	Object.freeze(primaryFailure);
	const { execution, state } = executeWithFailingCleanup(primaryFailure, cleanupFailure, {
		hasUI: true,
		ui: { notify: () => { throw notifyError; } },
	});

	await assert.rejects(
		() => execution,
		(error: unknown) => assertAggregateFailure(
			error,
			"Spawn, cleanup, and notification failed.",
			[primaryFailure, cleanupFailure, notifyError],
		),
	);
	assert.equal(primaryFailure.cause, originalCause);
	assertChildRegistriesCleared(state);
});

test("UI spawn aggregates primitive primary, cleanup, and notification failures", async () => {
	const primaryFailure = "prompt failed";
	const cleanupFailure = new Error("dispose failed");
	const notifyError = new Error("notify failed");
	const notifications: Array<[string, string]> = [];
	const { execution, state } = executeWithFailingCleanup(primaryFailure, cleanupFailure, {
		hasUI: true,
		ui: { notify: (message: string, level: string) => { notifications.push([message, level]); throw notifyError; } },
	});

	await assert.rejects(
		() => execution,
		(error: unknown) => assertAggregateFailure(
			error,
			"Spawn, cleanup, and notification failed.",
			[primaryFailure, cleanupFailure, notifyError],
		),
	);
	assert.equal(notifications.length, 1, "notification is attempted exactly once");
	assertChildRegistriesCleared(state);
});

test("spawn execute clears childSessions after successful completion when unrendered", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	registerSpawnTool(pi as any, state, mockFactoryWith({
		prompt: async () => {},
	}));
	const result = await pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	assert.equal(result.content[0].text, "child result");
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn execute fails explicitly without a configured model", async () => {
	const pi = createTestPI();
	const state = createState();
	registerSpawnTool(pi as any, state);
	await assert.rejects(
		() => pi.tools.get("spawn").execute("spawn-1", { prompt: "Do the task" }, undefined, undefined, { cwd: "/tmp" }),
		/No model configured\. Cannot spawn child agent\./,
	);
});

test("executeSpawn propagates unusable-group errors before creating child work", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.modelGroups.groups = [{
		name: "broken",
		scope: "project",
		sourcePath: "<test>",
		models: [{ provider: "openai", modelId: "missing" }],
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: true },
	} as any];
	let factoryCalls = 0;

	await assert.rejects(
		() => executeSpawn(
			"spawn-route-error",
			pi as any,
			{
				model: { provider: "openai", id: "parent" },
				cwd: "/tmp",
				modelRegistry: {
					find: () => undefined,
					hasConfiguredAuth: () => false,
				},
			} as any,
			state,
			{ prompt: "Do the task", group: "broken" },
			undefined,
			undefined,
			"medium",
			async () => {
				factoryCalls++;
				throw new Error("sessionFactory must not be called");
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof SpawnRouteError, "route error must propagate without wrapping");
			assert.equal(error.kind, "unusable-group");
			assert.equal(error.group, "broken");
			assert.equal(error.reason, "no-usable-models");
			return true;
		},
	);

	assert.equal(factoryCalls, 0, "sessionFactory must not be called on routing failure");
	assert.equal(state.childSessions.size, 0, "no child session registered");
	assert.equal(state.liveChildSessions.size, 0, "no live child session registered");
});

test("executeSpawn propagates missing modalities before creating child work", async () => {
	const pi = createTestPI();
	const state = createState();
	state.modelGroups.groups = [{
		name: "text-only", scope: "project", sourcePath: "<test>", models: [{ provider: "openai", modelId: "text" }],
		modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] },
	}];
	let factoryCalls = 0;
	await assert.rejects(() => executeSpawn("missing-modality", pi as any, {
		model: { provider: "openai", id: "parent", input: ["text"], reasoning: false }, cwd: "/tmp",
		modelRegistry: { find: (_provider: string, id: string) => ({ provider: "openai", id, input: ["text"], reasoning: false }), hasConfiguredAuth: () => true },
	} as any, state, { prompt: "Do the task", group: "text-only", constraints: { modalities: { required: ["image"] } } }, undefined, undefined, "medium", async () => { factoryCalls++; throw new Error("must not create child"); }), (error: unknown) => error instanceof SpawnRouteError && error.reason === "missing-modality");
	assert.equal(factoryCalls, 0);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn rejects unknown requirements before factory or session publication", async () => {
	const pi = createTestPI(); const state = createState(); let factoryCalls = 0;
	await assert.rejects(() => executeSpawn("unknown-constraint", pi as any, {
		model: { provider: "openai", id: "parent", input: ["text"], reasoning: false }, cwd: "/tmp",
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
	} as any, state, { prompt: "Do the task", constraints: { unknown: {} } }, undefined, undefined, "medium", async () => { factoryCalls++; throw new Error("must not create child"); }), /Unknown spawn constraint/);
	assert.equal(factoryCalls, 0); assert.equal(state.childSessions.size, 0); assert.equal(state.liveChildSessions.size, 0);
});

test("registered spawn tool rejects missing modalities before creating child work", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	state.modelGroups.groups = [{
		name: "text-only", scope: "project", sourcePath: "<test>", models: [{ provider: "openai", modelId: "text" }],
		modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] },
	}];
	let factoryCalls = 0;
	registerSpawnTool(pi as any, state, (async () => { factoryCalls++; throw new Error("sessionFactory must not be called"); }) as any);

	await assert.rejects(
		() => pi.tools.get("spawn").execute("registered-missing-modality", { prompt: "Do the task", group: "text-only", constraints: { modalities: { required: ["image"] } } }, undefined, undefined, {
			model: { provider: "openai", id: "parent", input: ["text"], reasoning: false }, cwd: "/tmp",
			modelRegistry: { find: (_provider: string, id: string) => ({ provider: "openai", id, input: ["text"], reasoning: false }), hasConfiguredAuth: () => true },
		} as any),
		(error: unknown) => {
			assert.ok(error instanceof SpawnRouteError);
			assert.equal(error.kind, "unusable-group");
			assert.equal(error.reason, "missing-modality");
			return true;
		},
	);
	assert.equal(factoryCalls, 0);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("registered spawn tool rejects injected scalar group and model requirements before publication", async () => {
	const pi = createTestPI(); pi.setActiveTools(["spawn"]);
	const state = createState(); let factoryCalls = 0;
	state.modelGroups.groups = [
		{ name: "small", scope: "project", sourcePath: "<test>", models: [{ provider: "openai", modelId: "small" }], modalities: { common: ["text"], supported: ["text"], effective: ["text"] }, validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] } },
	];
	registerSpawnTool(pi as any, state, (async () => { factoryCalls++; throw new Error("sessionFactory must not be called"); }) as any, createConstraintRegistry([testMinContext]));
	await assert.rejects(
		() => pi.tools.get("spawn").execute("registered-scalar", { prompt: "Do the task", group: "small", constraints: { testMinContext: 20 } }, undefined, undefined, {
			model: { provider: "openai", id: "parent", input: ["text"], reasoning: false, contextWindow: 100 }, cwd: "/tmp",
			modelRegistry: { find: (_provider: string, id: string) => ({ provider: "openai", id, input: ["text"], reasoning: false, contextWindow: id === "small" ? 10 : 100 }), hasConfiguredAuth: () => true },
		} as any),
		(error: unknown) => error instanceof SpawnRouteError && error.reason === "constraint-unsatisfied" && error.constraintUnsatisfied?.length === 2 && error.missingModalities.length === 0 && error.missingFromGroup.length === 0 && error.missingFromModel.length === 0,
	);
	assert.equal(factoryCalls, 0); assert.equal(state.childSessions.size, 0); assert.equal(state.liveChildSessions.size, 0);
});

test("registered spawn tool schema accepts injected scalar requirements", () => {
	const pi = createTestPI();
	registerSpawnTool(pi as any, createState(), undefined, createConstraintRegistry([testMinContext]));
	const schema = pi.tools.get("spawn").parameters;
	assert.equal(
		Value.Check(schema, { prompt: "Do the task", constraints: { testMinContext: 20 } }),
		true,
		"the registered schema accepts an injected descriptor's scalar requirement",
	);
	assert.equal(
		Value.Check(schema, { prompt: "Do the task", constraints: { testMinContext: 0 } }),
		false,
		"the injected descriptor retains its requirement schema",
	);
	assert.equal(
		Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["text"] } } }),
		false,
		"the injected registry, not the production registry, defines the registered schema",
	);
});

test("spawn requirements validate the canonical envelope and keep its shape", () => {
	assert.deepEqual(normalizeSpawnRequirements({ constraints: { modalities: { required: ["image", "text"] } } }), { modalities: { required: ["image", "text"] } });
	assert.deepEqual(normalizeSpawnRequirements({ constraints: { modalities: { required: ["image"] } } }), { modalities: { required: ["image"] } });
	assert.throws(() => normalizeSpawnRequirements({ constraints: { unknown: {} } }), /Unknown spawn constraint/);
	assert.throws(() => normalizeSpawnRequirements({ constraints: "{\"modalities\":{\"required\":[\"text\"]}}" as any }), /must be an object/);
	assert.throws(() => normalizeSpawnRequirements({ constraints: { modalities: ["text"] } }), /must be an object with required modalities/);
	assert.throws(() => normalizeSpawnRequirements({ constraints: { modalities: ["required", ["text"]] } }), /must be an object with required modalities/);
	assert.deepEqual(normalizeSpawnRequirements({}), normalizeSpawnRequirements({ constraints: {}}));
});

test("spawn tool schema validates constraints via Value.Check", () => {
	const pi = createTestPI();
	const state = createState();
	registerSpawnTool(pi as any, state);
	const tool = pi.tools.get("spawn");
	const schema = (tool as any).parameters;
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["text", "image"] } } }), true, "valid generic envelope accepted");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { unknown: {} } }), false, "unknown generic requirement rejected");
	assert.equal(Value.Check(schema, { prompt: "Do the task" }), true, "omitted constraints allowed");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: [] } } }), true, "empty array allowed");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["text", "text"] } } }), false, "duplicates rejected");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: { required: ["audio"] } } }), false, "out-of-vocabulary rejected");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: "text" } }), false, "non-object requirement rejected");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: "{\"modalities\":{\"required\":[\"text\"]}}" }), false, "stringified constraints rejected");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: ["text", "image"] } }), false, "bare-array modalities rejected");
	assert.equal(Value.Check(schema, { prompt: "Do the task", constraints: { modalities: ["required", ["text"]] } }), false, "array-with-embedded-required rejected");
});

test("spawn constraints description enumerates the registry keys (production)", () => {
	const pi = createTestPI();
	registerSpawnTool(pi as any, createState());
	const parameters = (pi.tools.get("spawn") as any).parameters;
	const constraintsDesc = parameters.properties.constraints.description as string;
	assert.ok(constraintsDesc.includes("Keys: modalities"), "description names the production constraint key");
});

test("spawn constraints description enumerates injected registry keys", () => {
	const pi = createTestPI();
	registerSpawnTool(pi as any, createState(), undefined, createConstraintRegistry([testMinContext]));
	const parameters = (pi.tools.get("spawn") as any).parameters;
	const constraintsDesc = parameters.properties.constraints.description as string;
	assert.ok(constraintsDesc.includes("Keys: testMinContext"), "description names the injected registry's constraint key");
});

test("executeSpawn forwards inherited constraints to routing and succeeds when satisfied", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "spawn"]);
	const state = createState();
	let factoryCalls = 0;
	const session = {
		messages: [] as any[],
		prompt: async () => {
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
		},
		abort: async () => {},
		getSessionStats: () => undefined,
	};
	registerSpawnTool(pi as any, state, (async () => { factoryCalls++; return { session: session as any }; }) as any);
	const result = await executeSpawn("spawn-inherited-rm", pi as any, {
		model: { provider: "openai", id: "parent", input: ["text", "image"], reasoning: false }, cwd: "/tmp",
		modelRegistry: { find: (_p: string, id: string) => ({ provider: "openai", id, input: ["text", "image"], reasoning: false }), hasConfiguredAuth: () => true },
	} as any, state, { prompt: "Do the task", constraints: { modalities: { required: ["text", "image"] } } }, undefined, undefined, "medium", async () => { factoryCalls++; return { session: session as any, extensionsResult: undefined as any }; });
	assert.equal(result.details.outcome, "success");
	assert.deepEqual(result.details.route, { status: "inherited" });
	assert.equal(factoryCalls, 1, "inherited route with satisfied requirements creates one child");
});

test("spawn renderResult transfers session ownership out of shared state", () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const pi = createTestPI();
	registerSpawnTool(pi as any, state);

	const component = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	assert.equal(state.childSessions.has("tool-call-1"), false);
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("spawn renderResult reuses lastComponent", () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const pi = createTestPI();
	registerSpawnTool(pi as any, state);

	const first = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	);
	const second = pi.tools.get("spawn").renderResult(
		{ content: [{ type: "text", text: "hello" }], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: first }),
	);
	assert.equal(first, second);
});

test("spawn render shows success state when stats are unavailable", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "final summary" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: { model: "mock-model", thinking: "medium", truncated: false, outcome: "success", statsUnavailable: true },
		},
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("✅ mock-model • medium")));
	assert.ok(lines.some((l: string) => l.includes("stats unavailable")));
	assert.equal(lines.some((l: string) => l.includes("initializing")), false);
});

test("spawn execute aborts child session when signal fires during execution", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let abortCalled = false;
	let disposeCalls = 0;
	let resolvePrompt!: () => void;
	let promptStarted!: () => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const mockFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async () => {
				promptStarted();
				await new Promise<void>((resolve) => { resolvePrompt = resolve; });
				session.messages = [{ role: "assistant", content: [{ type: "text", text: "aborted mid-flight" }] }];
			},
			abort: async () => {
				abortCalled = true;
				resolvePrompt();
			},
			dispose: () => { disposeCalls++; },
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const controller = new AbortController();
	const executePromise = pi.tools.get("spawn").execute(
		"spawn-1",
		{ prompt: "Do the task" },
		controller.signal,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);

	await started;
	controller.abort();

	const result = await executePromise;
	assert.equal(abortCalled, true);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
	assert.equal(result.content[0].text, "aborted mid-flight");
	assert.equal(result.details.outcome, "aborted");
	assert.equal(disposeCalls, 1, "mid-prompt abort disposes exactly once");
});

test("spawn execute swallows prompt rejection when signal aborts mid-flight", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const controller = new AbortController();
	let abortCalled = false;
	let disposeCalls = 0;
	let promptStarted!: () => void;
	let rejectPrompt!: (err: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const mockFactory = async () => {
		return { session: mockSessionFactory({
			prompt: async () => {
				promptStarted();
				await new Promise<void>((_, reject) => { rejectPrompt = reject; });
			},
			abort: async () => {
				abortCalled = true;
				rejectPrompt(Object.assign(new Error("aborted"), { name: "AbortError" }));
			},
			dispose: () => { disposeCalls++; },
		}) };
	};
	registerSpawnTool(pi as any, state, mockFactory as any);

	const executePromise = pi.tools.get("spawn").execute(
		"spawn-aborted-throw",
		{ prompt: "Do the task" },
		controller.signal,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	controller.abort();
	const result = await executePromise;
	assert.equal(abortCalled, true);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
	assert.equal(result.details.outcome, "aborted");
	// Outcome and cleanup are the external contracts; text format is secondary.
	assert.equal(result.content[0]?.text ?? "", "");
	assert.equal(disposeCalls, 1, "mid-prompt abort disposes exactly once");
});

test("spawn execute preserves a real prompt failure that races with abort", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const controller = new AbortController();
	let disposeCalls = 0;
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const promptError = new Error("prompt failed despite abort");
	registerSpawnTool(pi as any, state, async () => ({ session: mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		},
		dispose: () => { disposeCalls++; },
	}), extensionsResult: undefined as any }));

	const execution = pi.tools.get("spawn").execute(
		"spawn-abort-real-error", { prompt: "Do the task" }, controller.signal,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	controller.abort();
	rejectPrompt(promptError);

	await assert.rejects(execution, (error: unknown) => error === promptError);
	assert.equal(disposeCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn invalidation wins the abort and prompt-rejection race", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const controller = new AbortController();
	let abortCalls = 0;
	let disposeCalls = 0;
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const mockFactory = async () => ({ session: mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		},
		abort: async () => { abortCalls++; },
		dispose: () => { disposeCalls++; },
	}) });
	registerSpawnTool(pi as any, state, mockFactory as any);

	const execution = pi.tools.get("spawn").execute(
		"spawn-abort-reset-race", { prompt: "Do the task" }, controller.signal,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	controller.abort();
	resetState(state);
	rejectPrompt(new Error("prompt rejected after abort and reset"));

	await assert.rejects(() => execution, /invalidated by reset/i);
	assert.equal(abortCalls, 1, "signal cancellation and reset share one abort");
	assert.equal(disposeCalls, 1, "the raced child disposes exactly once");
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn surfaces AggregateError when abort rejects during active-prompt reset", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let disposeCalls = 0;
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const abortError = new Error("abort failed");
	const invalidatedError = "Spawn invalidated by reset.";
	const mockFactory = async () => ({ session: mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		},
		abort: async () => { throw abortError; },
		dispose: () => { disposeCalls++; },
	}), extensionsResult: undefined as any });
	registerSpawnTool(pi as any, state, mockFactory as any);

	const execution = pi.tools.get("spawn").execute(
		"spawn-abort-rejects", { prompt: "Do the task" }, undefined,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	resetState(state);
	rejectPrompt(new Error("prompt rejected"));

	await assert.rejects(
		execution,
		(error: unknown) => {
			assert.ok(error instanceof AggregateError, `expected AggregateError, got: ${String(error)}`);
			assert.ok(error.message.includes("Spawn invalidated by reset"), `message should mention invalidation: ${error.message}`);
			// Errors[0] is the invalidatedError, errors[1] is the abortFailure
			assert.ok(error.errors[0] instanceof Error, "first error should be the invalidatedError");
			assert.equal((error.errors[0] as Error).message, invalidatedError);
			assert.equal(error.errors[1], abortError, "second error should be the abort failure");
			return true;
		},
	);
	assert.equal(disposeCalls, 1, "the aborted child disposes exactly once");
	assertChildRegistriesCleared(state);
});

test("reset before registration reports AggregateError when shared abort rejects", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let abortCalls = 0;
	let disposeCalls = 0;
	let factoryCalled = false;
	const abortError = new Error("abort failed");
	const factoryReady = createDeferred();
	const mockFactory = async () => {
		factoryCalled = true;
		await factoryReady.promise;
		return {
			extensionsResult: undefined as any,
			session: {
				messages: [] as any[],
				prompt: async () => {},
				abort: async () => { abortCalls++; throw abortError; },
				dispose: () => { disposeCalls++; },
				getSessionStats: () => undefined,
			} as any,
		};
	};

	registerSpawnTool(pi as any, state, mockFactory as any);

	const execution = pi.tools.get("spawn").execute(
		"spawn-pre-reg-abort-reject", { prompt: "Do the task" }, undefined,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);

	// Reset while the factory is still producing the session
	resetState(state);
	// Allow the factory to resolve — session is immediately stale
	factoryReady.resolve();

	await assert.rejects(
		execution,
		(error: unknown) => {
			assert.ok(error instanceof AggregateError, `expected AggregateError, got: ${String(error)}`);
			assert.ok(error.errors[0] instanceof Error, "first error should be the invalidatedError");
			assert.equal((error.errors[0] as Error).message, "Spawn invalidated by reset.");
			assert.equal(error.errors[1], abortError, "second error should be the abort failure");
			return true;
		},
	);
	assert.equal(factoryCalled, true, "factory was called");
	assert.equal(abortCalls, 1, "abort was called exactly once");
	assert.equal(disposeCalls, 1, "child disposed exactly once");
	assertChildRegistriesCleared(state);
});

test("reset during prompt reports AggregateError when shared abort rejects (UI reports once)", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let abortCalls = 0;
	let disposeCalls = 0;
	const abortError = new Error("abort failed");
	const notifications: Array<[string, string]> = [];
	const mockFactory = async () => ({ session: mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		},
		abort: async () => { abortCalls++; throw abortError; },
		dispose: () => { disposeCalls++; },
	}), extensionsResult: undefined as any });
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	registerSpawnTool(pi as any, state, mockFactory as any);

	const execution = pi.tools.get("spawn").execute(
		"spawn-reset-prompt-abort-reject-ui",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: true, ui: { notify: (m: string, l: string) => { notifications.push([m, l]); } } } as any,
	);
	await started;
	resetState(state);
	rejectPrompt(new Error("prompt rejected"));

	await assert.rejects(
		execution,
		(error: unknown) => {
			assert.ok(error instanceof AggregateError, `expected AggregateError, got: ${String(error)}`);
			assert.equal(error.errors[0] instanceof Error ? (error.errors[0] as Error).message : null, "Spawn invalidated by reset.");
			assert.equal(error.errors[1], abortError);
			return true;
		},
	);
	assert.equal(notifications.length, 1, "abort failure reported exactly once via UI");
	assert.deepEqual(notifications, [["Spawn cleanup failed: abort failed", "error"]]);
	assert.equal(abortCalls, 1);
	assert.equal(disposeCalls, 1);
	assertChildRegistriesCleared(state);
});

test("throwing notify during abort-fail reporting does not emit unhandledRejection", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const abortError = new Error("abort failed");
	const notifyError = new Error("notify exploded");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const mockFactory = async () => ({ session: mockSessionFactory({
			prompt: async () => {
				promptStarted();
				await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
			},
			abort: async () => { throw abortError; },
			dispose: () => {},
		}), extensionsResult: undefined as any });
		registerSpawnTool(pi as any, state, mockFactory as any);

		const execution = pi.tools.get("spawn").execute(
			"spawn-throwing-notify",
			{ prompt: "Do the task" },
			undefined,
			undefined,
			{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: true, ui: { notify: () => { throw notifyError; } } } as any,
		);
		await started;
		resetState(state);
		rejectPrompt(new Error("prompt rejected"));

		await assert.rejects(
			execution,
			(error: unknown) => {
				assert.ok(error instanceof AggregateError, `expected AggregateError, got: ${String(error)}`);
				assert.equal(error.errors[1], abortError);
				return true;
			},
		);
		// Give any detached microtasks a chance to flush
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(unhandled.length, 0, `no unhandled rejections from notify throwing: ${unhandled.map((e) => String(e)).join(", ")}`);
		assertChildRegistriesCleared(state);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("spawn renderCall shows prompt preview and optional routing controls", () => {

	const state = createState();
	const pi = createTestPI();
	registerSpawnTool(pi as any, state);

	const tool = pi.tools.get("spawn");

	// Collapsed: short prompt
	const collapsed = tool.renderCall({ prompt: "Do X" }, theme, { expanded: false });
	const collapsedLines = collapsed.render(120);
	assert.ok(collapsedLines.some((l: string) => l.includes("spawn")));
	assert.ok(collapsedLines.some((l: string) => l.includes("Do X")));

	// Collapsed: long prompt shows truncation hint
	const longPrompt = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n");
	const truncated = tool.renderCall({ prompt: longPrompt }, theme, { expanded: false });
	const truncatedLines = truncated.render(120);
	assert.ok(truncatedLines.some((l: string) => l.includes("more lines")));

	// Explicit thinking is shown without a group; grouped calls show only the route.
	const withThinking = tool.renderCall({ prompt: "Do X", thinking: "high" }, theme, { expanded: false });
	const thinkingLines = withThinking.render(120);
	assert.ok(thinkingLines.some((l: string) => l.includes("high")));
	const withWhitespaceGroup = tool.renderCall(
		{ prompt: "Do X", group: " \t ", thinking: "high" },
		theme,
		{ expanded: false },
	);
	assert.ok(withWhitespaceGroup.render(120).some((l: string) => l.includes("high")));
	const withRouting = tool.renderCall(
		{ prompt: "Do X", group: "review", thinking: "max" },
		theme,
		{ expanded: false },
	);
	const routingLines = withRouting.render(120);
	assert.ok(routingLines.some((l: string) => l.includes("review")));
	assert.ok(routingLines.every((l: string) => !l.includes("max")));
	const withEscapedGroup = tool.renderCall(
		{ prompt: "Do X", group: "review\n\u001b" },
		theme,
		{ expanded: false },
	);
	const escapedGroupLines = withEscapedGroup.render(120);
	assert.ok(escapedGroupLines.some((line: string) => line.includes("review\\n\\x1B")));
	assert.ok(escapedGroupLines.every((line: string) => !line.includes("\u001b")));

	// Expanded: shows full prompt
	const expanded = tool.renderCall({ prompt: longPrompt }, theme, { expanded: true });
	const expandedLines = expanded.render(120);
	assert.ok(!expandedLines.some((l: string) => l.includes("more lines")));
});

test("nested spawn invalidate rebuilds from the attached session transcript", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	(session.messages[0] as any).content[0].text = "after";
	component.invalidate();

	const secondRender = component.render(120);
	assert.notEqual(firstRender, secondRender);
	assert.ok(secondRender.some((l: string) => l.includes("after")));
	assert.equal(secondRender.some((l: string) => l.includes("before")), false);
});

test("nested spawn attachSession rebuilds after appended session messages", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]));

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
		{ role: "assistant", content: [{ type: "text", text: "after" }] },
	]));
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	const secondRender = sameComponent.render(120);
	assert.notEqual(firstRender, secondRender);
	assert.ok(secondRender.some((l: string) => l.includes("after")));
});

test("nested spawn attachSession rebuilds after replacing session transcript structure", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	state.childSessions.set("tool-call-1", createSession([
		{ role: "assistant", content: [{ type: "text", text: "before" }] },
	]));

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const firstRender = component.render(120);
	assert.ok(firstRender.some((l: string) => l.includes("before")));

	state.childSessions.set("tool-call-1", createSession([
		{ role: "user", content: [{ type: "text", text: "new task" }] },
		{ role: "assistant", content: [{ type: "text", text: "replacement" }] },
	]));
	const sameComponent = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext({ lastComponent: component }),
	) as any;

	const secondRender = sameComponent.render(120);
	assert.notEqual(firstRender, secondRender);
	assert.ok(secondRender.some((l: string) => l.includes("replacement")));
	assert.equal(secondRender.some((l: string) => l.includes("before")), false);
});

test("nested spawn rebuildFromSession quietly tolerates missing tool definitions", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const session = {
		messages: [{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "ls" } }],
			stopReason: "error",
			errorMessage: "boom",
		}],
		subscribe: () => () => {},
		getToolDefinition: () => { throw new Error("missing tool definition"); },
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false, outcome: "error" } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("⚠ m • low")));
	assert.ok(lines.some((l: string) => l.includes("error")));
	assert.equal(state.childSessions.has("tool-call-1"), false);
	assert.equal(h.warnings.length, 0);
});

test("nested spawn attachSession recovers from subscribe throwing", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);

	const throwingSession = {
		messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
		subscribe: () => { throw new Error("subscribe failed"); },
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => process.cwd() },
		abort: async () => {},
	} as any;
	state.childSessions.set("tool-call-1", throwingSession);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	assert.equal(state.childSessions.has("tool-call-1"), false);
	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

test("concurrent spawn executions produce independent results", async () => {
	const pi = createTestPI();
	const state = createState();

	let resolveA!: () => void;
	let resolveB!: () => void;
	let markStartedA!: () => void;
	let markStartedB!: () => void;
	const gateA = new Promise<void>((resolve) => { resolveA = resolve; });
	const gateB = new Promise<void>((resolve) => { resolveB = resolve; });
	const startedA = new Promise<void>((resolve) => { markStartedA = resolve; });
	const startedB = new Promise<void>((resolve) => { markStartedB = resolve; });
	const started: string[] = [];
	const outputs = new Map([
		["task A", "result-alpha"],
		["task B", "result-beta"],
	]);
	const sharedFactory = async () => {
		const session = {
			messages: [] as any[],
			prompt: async (prompt: string) => {
				const task = /## Task\n\n([\s\S]*?)\n\nWhen complete/.exec(prompt)?.[1] ?? "";
				started.push(task);
				if (task === "task A") {
					markStartedA();
					await gateA;
				}
				if (task === "task B") {
					markStartedB();
					await gateB;
				}
				session.messages = [{ role: "assistant", content: [{ type: "text", text: outputs.get(task) ?? task }] }];
			},
			abort: async () => {},
			getSessionStats: () => undefined,
		};
		return { session: session as any };
	};

	registerSpawnTool(pi as any, state, sharedFactory as any);
	const spawnTool = pi.tools.get("spawn");

	const resultP1 = spawnTool.execute(
		"spawn-A", { prompt: "task A" }, undefined, undefined,
		{ model: { id: "mock" }, cwd: "/tmp" },
	);
	const resultP2 = spawnTool.execute(
		"spawn-B", { prompt: "task B" }, undefined, undefined,
		{ model: { id: "mock" }, cwd: "/tmp" },
	);

	await Promise.all([startedA, startedB]);
	assert.deepEqual(started.sort(), ["task A", "task B"]);
	resolveA();
	resolveB();

	const [r1, r2] = await Promise.all([resultP1, resultP2]);

	assert.equal(r1.content[0].text, "result-alpha");
	assert.equal(r2.content[0].text, "result-beta");
	assert.equal(state.childSessions.has("spawn-A"), false);
	assert.equal(state.childSessions.has("spawn-B"), false);
});

test("executeSpawn detects stale session before session creation", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let resolveFactory!: (value: any) => void;
	const factoryReady = new Promise<any>((resolve) => {
		resolveFactory = resolve;
	});
	let factoryCalled = false;
	let abortCalls = 0;

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		async () => {
			factoryCalled = true;
			await factoryReady;
			return {
				session: {
					messages: [] as any[],
					prompt: async () => {},
					abort: async () => { abortCalls++; },
					getSessionStats: () => undefined,
				} as any,
				extensionsResult: undefined as any,
			};
		},
	);

	// Reset state while executeSpawn is awaiting the factory
	resetState(state);
	// Now allow the factory to resolve — session should be immediately stale
	resolveFactory({});

	await assert.rejects(
		() => executePromise,
		/invalidated by reset/i,
	);
	assert.equal(factoryCalled, true);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn does not prompt when onUpdate synchronously resets the child epoch", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let promptCalls = 0;
	let abortCalls = 0;
	let disposeCalls = 0;

	const execution = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		() => { resetState(state); },
		"medium",
		mockFactoryWith({
			prompt: async () => { promptCalls++; },
			abort: async () => { abortCalls++; },
			dispose: () => { disposeCalls++; },
		}),
	);

	await assert.rejects(() => execution, /invalidated by reset/i);
	assert.equal(promptCalls, 0);
	assert.equal(abortCalls >= 1, true);
	assert.equal(disposeCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn does not prompt when onUpdate synchronously aborts the signal", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	const controller = new AbortController();
	const reason = new Error("cancelled during update");
	let promptCalls = 0;
	let abortCalls = 0;
	let disposeCalls = 0;

	const execution = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		controller.signal,
		() => { controller.abort(reason); },
		"medium",
		mockFactoryWith({
			prompt: async () => { promptCalls++; },
			abort: async () => { abortCalls++; },
			dispose: () => { disposeCalls++; },
		}),
	);

	await assert.rejects(async () => execution, (error) => error === reason);
	assert.equal(promptCalls, 0);
	assert.equal(abortCalls, 1);
	assert.equal(disposeCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn aborts stale child when resetState fires during prompt", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();

	let rejectPrompt!: (err: Error) => void;
	let resolvePromptStarted!: () => void;
	const promptStartedPromise = new Promise<void>((r) => { resolvePromptStarted = r; });
	let abortCalls = 0;
	let disposeCalls = 0;

	const executePromise = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		undefined,
		"medium",
		async () => ({
			extensionsResult: undefined as any,
			session: {
				messages: [] as any[],
				prompt: async () => {
					resolvePromptStarted();
					await new Promise<void>((_resolve, reject) => {
						rejectPrompt = reject;
					});
				},
				abort: async () => {
					abortCalls++;
					rejectPrompt?.(new Error("aborted"));
				},
				dispose: () => { disposeCalls++; },
				getSessionStats: () => undefined,
			} as any,
		}),
	);

	// Wait for session to be created and prompt to start
	await promptStartedPromise;
	// Reset cleanup starts the shared abort, then prompt rejection reaches invalidation.
	resetState(state);

	await assert.rejects(
		() => executePromise,
		/invalidated by reset/i,
	);
	assert.equal(abortCalls, 1, "reset and invalidation share one abort");
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
	assert.equal(disposeCalls, 1, "prompt-reset invalidation disposes exactly once");
});

test("executeSpawn suppresses a successful stale prompt that ignores reset abort", async () => {
	const pi = createTestPI();
	pi.setActiveTools(["read", "bash", "spawn"]);
	const state = createState();
	let resolvePrompt!: () => void;
	let promptStarted!: () => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	let abortCalls = 0;
	let disposeCalls = 0;
	const updates: unknown[] = [];
	const session = {
		messages: [] as any[],
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => { resolvePrompt = resolve; });
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "stale success" }] }];
		},
		abort: async () => { abortCalls++; },
		dispose: () => { disposeCalls++; },
		getSessionStats: () => undefined,
	};

	const execution = executeSpawn(
		"spawn-1",
		pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state,
		{ prompt: "Do the task" },
		undefined,
		(update) => { updates.push(update); },
		"medium",
		async () => ({ session: session as any, extensionsResult: undefined as any }),
	);

	await started;
	resetState(state);
	resolvePrompt();

	await assert.rejects(() => execution, /invalidated by reset/i);
	assert.equal(abortCalls >= 1, true);
	assert.equal(disposeCalls, 1);
	assert.equal(updates.length, 1, "no stale completion update is published");
	assert.deepEqual((updates[0] as any).content, []);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});


test("nested spawn setExpanded and setShowImages no-op when value matches", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);

	const component = childSpawnTool.renderResult(
		{ content: [], details: { model: "m", thinking: "low", truncated: false } },
		{ expanded: false },
		theme,
		createRenderContext(),
	) as any;

	component.setExpanded(false);
	component.setExpanded(true);
	component.setShowImages(true);
	component.setShowImages(false);

	const lines = component.render(120);
	assert.ok(lines.some((l: string) => l.includes("hello")));
});

// ── State management tests ───────────────────────────────────────────

test("resetState aborts and clears child session registries", () => {
	const state = createState();
	let abortCalls = 0;
	const session = {
		...createSession([]),
		abort: async () => { abortCalls++; },
	} as any;
	state.childSessions.set("tool-call-1", session);
	state.liveChildSessions.set("tool-call-1", session);
	resetState(state);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("resetState aborts a claimed child session after render ownership transfer", () => {
	const state = createState();
	const childSpawnTool = makeChildSpawnTool(state);
	let abortCalls = 0;
	const session = {
		...createSession([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]),
		abort: async () => { abortCalls++; },
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

test("abortAndClearChildSessions deduplicates sessions across both maps", () => {
	const state = createState();
	let abortCalls = 0;
	const mockSession = {
		messages: [],
		abort: async () => { abortCalls++; },
	} as any;

	state.childSessions.set("tc-1", mockSession);
	state.liveChildSessions.set("tc-1", mockSession);

	resetState(state);

	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

// ── Tool registration tests ──────────────────────────────────────────

test("spawn tool definitions include prompt hints when registered", () => {
	const pi = createTestPI();
	const state = createState();
	registerSpawnTool(pi as any, state);

	const spawnTool = pi.tools.get("spawn")!;
	assert.ok(typeof spawnTool.promptSnippet === "string", "spawn should have promptSnippet");
	assert.ok(spawnTool.promptSnippet!.length > 10, "spawn promptSnippet should be non-trivial");
	assert.ok(Array.isArray(spawnTool.promptGuidelines), "spawn should have promptGuidelines");
	assert.ok(spawnTool.promptGuidelines!.length > 0, "spawn promptGuidelines should be non-empty");
	for (const g of spawnTool.promptGuidelines!) {
		assert.ok(g.length > 10, "each spawn guideline should be non-trivial");
	}
});

test("registerSpawnTool registers a tool with correct name and metadata", () => {
	const pi = createTestPI();
	const state = createState();
	registerSpawnTool(pi as any, state);

	const tool = pi.tools.get("spawn");
	assert.ok(tool, "spawn tool should be registered");
	assert.equal(tool.name, "spawn");
	assert.equal(tool.label, "Spawn");
	assert.equal(typeof tool.description, "string");
	assert.match(tool.description, /active registered tools executable in the child session/);
	assert.match(tool.description, /shared notebook tools/);
	assert.match(tool.description, /cannot spawn or handoff/);
	assert.doesNotMatch(tool.description, /supported built-in tools/);
	assert.equal(typeof tool.execute, "function");
	assert.equal(typeof tool.renderCall, "function");
	assert.equal(typeof tool.renderResult, "function");
	assert.equal(tool.renderShell, "self");
	assert.ok(tool.parameters, "should have parameters");
	const constraints = (tool.parameters as any).properties.constraints;
	assert.equal(constraints.type, "object");
	assert.ok(constraints.properties.modalities);
	assert.equal(tool.executionMode, undefined, "spawn should not be sequential");
});

test("renderSpawnResult handles result with no details field", () => {
	const state = createState();
	const result = renderSpawnResult(
		{ content: [{ type: "text", text: "hello" }] },
		false,
		theme,
		{ toolCallId: "tc-1", invalidate: () => {}, showImages: false },
		state,
	);
	assert.ok(result, "renderSpawnResult should return a component");
	const lines = (result as any).render(120);
	assert.ok(Array.isArray(lines), "render should return an array of lines");
	assert.ok(lines.some((l: string) => l.includes("hello")), `expected 'hello' in output, got: ${lines.join("\n")}`);
});

test("spawn docs document active registered inheritance", async () => {
	const readme = await readFile("README.md", "utf8");
	const changelog = await readFile("CHANGELOG.md", "utf8");
	const spawnSection = /\| \*\*Spawn\*\* \|[^\|]*\|/.exec(readme)?.[0] ?? "";
	const v040 = /## \[0\.4\.0\][\s\S]*?## \[0\.3\.0\]/.exec(changelog)?.[0] ?? "";

	assert.match(spawnSection, /active registered (parent )?tools executable in the child session/);
	assert.match(spawnSection, /MCP\/extension tools such as ChunkHound/);
	assert.match(spawnSection, /[Cc]hild-local notebook tools/);
	assert.match(spawnSection, /cannot spawn grandchildren or handoff/);
	assert.doesNotMatch(spawnSection, /built-in tools only/);
	assert.match(v040, /active registered parent tools/);
	assert.match(v040, /spawn and handoff/);
	assert.match(v040, /notebook tools/);
});

// ── PR #23 follow-up: abort cleanup + dispose AggregateError coverage ──────

test("spawn abort cleanup notifies UI when abort rejects", async () => {
	const pi = createTestPI();
	const state = createState();
	const notifications: Array<[string, string]> = [];
	const ctx = {
		model: { id: "mock-model" },
		cwd: "/tmp",
		hasUI: true,
		ui: { notify: (m: string, l: string) => { notifications.push([m, l]); } },
	} as any;
	const abortError = new Error("abort failed");
	const session = {
		messages: [],
		prompt: async () => {},
		abort: async () => { throw abortError; },
		dispose: () => {},
		getSessionStats: () => undefined,
	};
	const controller = new AbortController();
	controller.abort(new Error("parent aborted"));

	await assert.rejects(
		() => executeSpawn(
			"spawn-abort-cleanup",
			pi as any,
			ctx,
			state,
			{ prompt: "Do the task" },
			controller.signal,
			undefined,
			"medium",
			async () => ({ session: session as any, extensionsResult: undefined as any }),
		),
		(error: unknown) => error === abortError,
	);
	assert.deepEqual(notifications, [["Spawn cleanup failed: abort failed", "error"]]);
});

test("spawn dispose failure without primary error propagates cleanup error", async () => {
	const headless = executeWithDisposeFailure("spawn-dispose-only", { hasUI: false });
	await assert.rejects(
		() => headless.execution,
		(err: unknown) => { assert.equal(err, headless.cleanupError); return true; },
	);
	assertChildRegistriesCleared(headless.state);

	const notifications: Array<[string, string]> = [];
	const ui = executeWithDisposeFailure("spawn-dispose-only-ui", {
		hasUI: true,
		ui: { notify: (m: string, l: string) => { notifications.push([m, l]); } },
	});
	await assert.rejects(
		() => ui.execution,
		(err: unknown) => { assert.equal(err, ui.cleanupError); return true; },
	);
	assert.equal(notifications.length, 0, "dispose-only failure does not notify");
	assertChildRegistriesCleared(ui.state);
});

test("spawn headless dispose AggregateError preserves both failures", async () => {
	const primaryFailure = new Error("prompt failed");
	const cleanupFailure = new Error("dispose failed");
	const { execution, state } = executeWithFailingCleanup(primaryFailure, cleanupFailure, { hasUI: false });
	await assert.rejects(
		() => execution,
		(err: unknown) => {
			assert.ok(err instanceof AggregateError);
			assert.equal((err as AggregateError).message, "Spawn failed and cleanup failed.");
			assert.deepEqual((err as AggregateError).errors, [primaryFailure, cleanupFailure]);
			return true;
		},
	);
	assertChildRegistriesCleared(state);
});
