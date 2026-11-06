import test, { afterEach, beforeEach } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type SessionEntry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createState, resetState } from "../../state.js";
import { READONLY_BASH_SCOPE, READONLY_NO_SHELL_SUMMARY, READONLY_WRITE_EDIT_SUMMARY } from "../../notifications.js";
import {
	buildChildToolNames,
	createChildTools,
	executeSpawn,
	normalizeSpawnRequirements,
	registerSpawnTool,
} from "../../spawn/index.js";
import { renderSpawnResult } from "../../spawn/renderer.js";
import { formatByteCap } from "../../notebook/store.js";
import { SpawnRouteError } from "../../model-groups/router.js";
import { createConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { Value } from "typebox/value";
import { testMinContext } from "./model-groups-constraints-fixture.js";
import { assertErrorResult, createRenderContext, createSession, theme, createDeferred, EMPTY_CHILD_USAGE } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { createTestHarness, type TestHarness } from "../test-utils.js";

let h: TestHarness;

// ── Test helpers ─────────────────────────────────────────────────────
function mockSessionFactory(opts: {
	prompt?: (prompt?: string) => Promise<any>;
	abort?: () => Promise<any>;
	dispose?: () => void;
	result?: any[];
	thinkingLevel?: string;
	getEntries?: () => SessionEntry[];
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
		sessionManager: { getEntries: opts.getEntries ?? (() => []) },
	};
	return session;
}

/** Create a session factory for spawn tests — wraps mockSessionFactory with the expected return shape. */
function mockFactoryWith(opts: Parameters<typeof mockSessionFactory>[0] = {}) {
	return async () => ({ session: mockSessionFactory(opts), extensionsResult: undefined as any });
}

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

async function executeWithFailingCleanup(primaryFailure: unknown, cleanupFailure: unknown, context: Record<string, unknown> = {}) {
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
	const state = createState();
	const session = mockSessionFactory({
		prompt: async () => { throw primaryFailure; },
		dispose: () => { throw cleanupFailure; },
	});
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

function assertChildRegistriesCleared(state: ReturnType<typeof createState>): void {
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
}

test("spawn execute passes broad active registered tool formula to child session", async () => {
	const state = createState();
	const requestedCwd = "/tmp";

	let seenConfig: any;
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async (config: any) => {
		seenConfig = config;
		return { session: mockSessionFactory({ prompt: async () => {} }), extensionsResult: undefined as any };
	}), { toolSources: { "project_search": "project", "inactive_registered": "extension" }, activeTools: ["read", "bash", "spawn", "handoff", "project_search", "phantom_tool"], allTools: ["read", "bash", "spawn", "handoff", "project_search", "inactive_registered"] });

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
	const state = createState();
	const updates: any[] = [];
	let seenConfig: any;
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async (config: any) => {
		seenConfig = config;
		return { session: mockSessionFactory({ thinkingLevel: "off", prompt: async () => {} }), extensionsResult: undefined as any };
	}), { activeTools: ["read", "spawn"] });

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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async (config: any) => {
		seenConfig = config;
		return { session: mockSessionFactory({
			prompt: async (p?: string) => { seenPrompt = p ?? ""; },
		}), extensionsResult: undefined as any };
	}), { activeTools: ["read", "bash", "write", "edit", "powershell", "spawn", "handoff"], allTools: ["read", "bash", "write", "edit", "powershell", "spawn", "handoff"] });

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
	assert.ok(!seenConfig.tools.includes("powershell"));
	assert.ok(!seenConfig.tools.includes("spawn"));
	assert.ok(!seenConfig.tools.includes("handoff"));
	assert.match(seenPrompt, /inherit readonly authority/i);
	assert.ok(seenPrompt.includes(READONLY_WRITE_EDIT_SUMMARY));
	assert.deepEqual(result.details.route, { status: "routed", group: "review", provider: "openai", modelId: "gpt-routed" });
});

test("readonly child without a bash tool gets the no-shell summary and no bash rules", async () => {
	const state = createState();
	state.readonlyEnabled = true;
	let seenPrompt = "";
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async () => ({
		session: mockSessionFactory({ prompt: async (p?: string) => { seenPrompt = p ?? ""; } }),
		extensionsResult: undefined as any,
	})), { activeTools: ["read", "powershell", "edit", "write"], allTools: ["read", "powershell", "edit", "write"] });

	await pi.tools.get("spawn").execute(
		"spawn-no-shell",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { provider: "openai", id: "parent" }, cwd: "/tmp" },
	);

	assert.ok(seenPrompt.includes(READONLY_NO_SHELL_SUMMARY));
	assert.ok(!seenPrompt.includes(READONLY_BASH_SCOPE));
});

test("spawn routes capability requirements to capable members via random selection on the filtered pool", async () => {
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async (config: any) => {
		seenModels.push(config.model.id);
		return { session: mockSessionFactory({ prompt: async () => {} }), extensionsResult: undefined as any };
	}), { activeTools: ["read", "bash", "spawn"] });
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async (config: any) => ({
		session: mockSessionFactory({ prompt: async (p?: string) => { seenPrompt = p ?? ""; } }),
		extensionsResult: undefined as any,
	})), { activeTools: ["read", "bash", "spawn"] });
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async () => ({
		session: mockSessionFactory({ prompt: async (prompt?: string) => { seenPrompt = prompt ?? ""; } }),
		extensionsResult: undefined as any,
	}), createConstraintRegistry([testMinContext])), { activeTools: ["read", "bash", "spawn"] });
	await pi.tools.get("spawn").execute("spawn-context-cap", { prompt: "Do the task", group: "context-capped" }, undefined, undefined, {
		model: { provider: "openai", id: "parent", contextWindow: 100 }, cwd: "/tmp",
		modelRegistry: { find: (_provider: string, id: string) => id === "small" ? small : id === "large" ? large : undefined, hasConfiguredAuth: () => true },
	} as any);
	assert.match(seenPrompt, /## Model Group capability ceiling/i);
	assert.match(seenPrompt, /minimum context is capped at 50 tokens/i);
});

test("spawn execute builds prompt with notebook pages and task", async () => {
	const state = createState();
	state.notebookPages.set("entry-a", "preview line\nfull body");

	let seenPrompt = "";
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactoryWith({
		prompt: async (p?: string) => { seenPrompt = p ?? ""; },
	})), { activeTools: ["read", "bash", "spawn"] });

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
	const limitLine = `Keep the result under ${DEFAULT_MAX_LINES} lines / ${formatByteCap(DEFAULT_MAX_BYTES)}.`;
	assert.equal(seenPrompt.slice(-limitLine.length), limitLine);
});

test("spawn emits no capability notice when the routed group has no explicit override", async () => {
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async (config: any) => ({
		session: mockSessionFactory({ prompt: async (p?: string) => { seenPrompt = p ?? ""; } }),
		extensionsResult: undefined as any,
	})), { activeTools: ["read", "bash", "spawn"] });
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

// ── Build child tool names ─────────────────────────────────────────

test("child tool names inherit active registered builtins and exclude recursive controls", async () => {
	const state = createState();
	const childTools = createChildTools(await createTestHost(), state);
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

test("child tool names inherit active registered MCP extension tools", async () => {
	const state = createState();
	const childTools = createChildTools(await createTestHost(), state);
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

test("child tool names inherit active registered project package and local extension tools", async () => {
	const state = createState();
	const childTools = createChildTools(await createTestHost(), state);
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

test("child tool names exclude inactive registered and active phantom tools", async () => {
	const state = createState();
	const childTools = createChildTools(await createTestHost(), state);
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

test("spawn renderResult falls back to static text when no live session is stored", async () => {
	const state = createState();

	const pi = await createTestHost((api) => registerSpawnTool(api, state));

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

test("spawn renderResult distinguishes aborted and error outcomes", async () => {
	const state = createState();

	const pi = await createTestHost((api) => registerSpawnTool(api, state));

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

test("spawn execute derives result stats from the child entries", async () => {
	const state = createState();

	const updates: any[] = [];
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactoryWith({
		prompt: async () => {},
		getEntries: () => [messageEntry("a1", {
			role: "assistant", content: [{ type: "text", text: "child result" }],
			usage: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, totalTokens: 999, cost: { input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0.1, total: 0.5 } },
		})],
	})), { activeTools: ["read", "bash", "spawn"] });

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
		turns: 1,
	});
	assert.equal(result.details.statsUnavailable, undefined);
});

// ── Child usage ──────────────────────────────────────────────────────

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message } as unknown as SessionEntry;
}

async function executeWithEntries(getEntries: () => SessionEntry[], opts: Parameters<typeof mockSessionFactory>[0] = {}) {
	const state = createState();
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactoryWith({ prompt: async () => {}, getEntries, ...opts })), { activeTools: ["read", "bash", "spawn"] });
	return pi.tools.get("spawn").execute(
		"spawn-usage",
		{ prompt: "Do the task" },
		undefined,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);
}

test("spawn execute returns the child usage summed over every counted entry kind", async () => {
	// Each entry kind owns one decimal place, so a missing or doubled entry shows in the totals.
	const entries = [
		messageEntry("u1", { role: "user", content: "task", timestamp: 1 }),
		messageEntry("a1", {
			role: "assistant", content: [{ type: "text", text: "child result" }], stopReason: "stop",
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1, totalTokens: 10, cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 } },
		}),
		{
			type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-01-01T00:00:01.000Z", summary: "s", firstKeptEntryId: "a1", tokensBefore: 1,
			usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, reasoning: 100, totalTokens: 1000, cost: { input: 500, output: 600, cacheRead: 700, cacheWrite: 800, total: 2600 } },
		} as unknown as SessionEntry,
		{
			type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-01-01T00:00:02.000Z", fromId: "a1", summary: "s",
			usage: { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000, totalTokens: 10000, cost: { input: 5000, output: 6000, cacheRead: 7000, cacheWrite: 8000, total: 26000 } },
		} as unknown as SessionEntry,
		messageEntry("t1", {
			role: "toolResult", toolCallId: "ext", toolName: "ext_tool", content: [], isError: false, timestamp: 2,
			usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 10, totalTokens: 100, cost: { input: 50, output: 60, cacheRead: 70, cacheWrite: 80, total: 260 } },
		}),
		messageEntry("t2", { role: "toolResult", toolCallId: "plain", toolName: "read", content: [], isError: false, timestamp: 3 }),
		{
			type: "usage", id: "x1", parentId: "t2", timestamp: "2026-01-01T00:00:03.000Z", kind: "cache_warm", provider: "p", model: "m",
			usage: { input: 10000, output: 20000, cacheRead: 30000, cacheWrite: 40000, cacheWrite1h: 10000, totalTokens: 100000, cost: { input: 50000, output: 60000, cacheRead: 70000, cacheWrite: 80000, total: 260000 } },
		} as unknown as SessionEntry,
		{ type: "model_change", id: "m1", parentId: "x1", timestamp: "2026-01-01T00:00:04.000Z", provider: "p", modelId: "m2" } as unknown as SessionEntry,
	];
	const result = await executeWithEntries(() => entries);

	assert.deepEqual(result.usage, {
		input: 11111,
		output: 22222,
		cacheRead: 33333,
		cacheWrite: 44444,
		cacheWrite1h: 10001,
		reasoning: 110,
		totalTokens: 111110,
		cost: { input: 55555, output: 66666, cacheRead: 77777, cacheWrite: 88888, total: 288886 },
	});
	assert.equal(result.details.statsUnavailable, undefined);
});

test("spawn execute omits cacheWrite1h and reasoning when no counted usage reports them", async () => {
	const result = await executeWithEntries(() => [
		messageEntry("a1", {
			role: "assistant", content: [{ type: "text", text: "child result" }], stopReason: "stop",
			usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
		}),
		{
			type: "usage", id: "x1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", kind: "cache_warm", provider: "p", model: "m",
			usage: { input: 1, output: 0, cacheRead: 2, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 0, cacheRead: 1, cacheWrite: 0, total: 2 } },
		} as unknown as SessionEntry,
	]);

	assert.deepEqual(result.usage, {
		input: 8,
		output: 3,
		cacheRead: 2,
		cacheWrite: 0,
		totalTokens: 13,
		cost: { input: 2, output: 2, cacheRead: 1, cacheWrite: 0, total: 5 },
	});
	assert.equal("cacheWrite1h" in result.usage, false);
	assert.equal("reasoning" in result.usage, false);
});

test("an undefined optional child usage field is treated as absent", async () => {
	const result = await executeWithEntries(() => [messageEntry("assistant-answer", {
		role: "assistant", content: [{ type: "text", text: "child result" }], stopReason: "stop",
		usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, cacheWrite1h: undefined, totalTokens: 13,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } },
	})]);

	assert.deepEqual(result.usage, {
		input: 7,
		output: 3,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 13,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	});
	assert.equal(result.details.statsUnavailable, undefined);
});

test("a completed spawn preserves its text when child entries cannot be read", async () => {
	const entriesError = new Error("entries unavailable");
	let disposeCalls = 0;
	const result = await executeWithEntries(() => { throw entriesError; }, { dispose: () => { disposeCalls++; } });

	assert.equal(result.content[0].text, "child result");
	assert.equal(result.details.statsUnavailable, true);
	assert.equal(result.details.stats, undefined);
	assert.deepEqual(result.usage, EMPTY_CHILD_USAGE);
	assert.equal(disposeCalls, 1, "the child session is disposed when the entries cannot be read");
});

test("a completed spawn keeps its text with zero usage when a child usage cannot be summed", async () => {
	const result = await executeWithEntries(() => [
		messageEntry("assistant-counted", {
			role: "assistant", content: [{ type: "text", text: "child result" }],
			usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
		}),
		messageEntry("assistant-without-cost", {
			role: "assistant", content: [{ type: "text", text: "child result" }],
			usage: { input: 11, output: 13, cacheRead: 0, cacheWrite: 0, totalTokens: 24 },
		}),
	]);

	assert.equal(result.content[0].text, "child result");
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.usage, EMPTY_CHILD_USAGE);
	assert.equal(result.details.stats, undefined);
	assert.equal(result.details.statsUnavailable, true);
});

test("child turns count assistants but not users or tool results", async () => {
	const result = await executeWithEntries(() => [
		messageEntry("user-task", { role: "user", content: "task" }),
		messageEntry("assistant-answer", {
			role: "assistant", content: [{ type: "text", text: "child result" }],
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}),
		messageEntry("tool-output", { role: "toolResult", content: [] }),
	]);

	assert.equal(result.details.stats?.turns, 1);
});

test("fractional nonnegative child cost remains available", async () => {
	const result = await executeWithEntries(() => [messageEntry("assistant-answer", { role: "assistant",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } })]);

	assert.equal(result.details.statsUnavailable, undefined);
	assert.equal(result.usage.cost.total, 0.3);
});

test("spawn execute counts a compaction or branch summary only when it carries usage", async () => {
	const result = await executeWithEntries(() => [
		{
			type: "compaction", id: "c1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", summary: "s", firstKeptEntryId: "a1", tokensBefore: 1,
		} as unknown as SessionEntry,
		{
			type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-01-01T00:00:02.000Z", fromId: "c1", summary: "s",
		} as unknown as SessionEntry,
		messageEntry("a1", {
			role: "assistant", content: [{ type: "text", text: "child result" }], stopReason: "stop",
			usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
		}),
	]);

	assert.deepEqual(result.usage, {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
	});
});

test("spawn execute skips an entry whose usage is null and sums the rest", async () => {
	const result = await executeWithEntries(() => [
		{
			type: "usage", id: "x1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", kind: "cache_warm", provider: "p", model: "m", usage: null,
		} as unknown as SessionEntry,
		messageEntry("a1", {
			role: "assistant", content: [{ type: "text", text: "child result" }], stopReason: "stop",
			usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
		}),
	]);

	assert.deepEqual(result.usage, {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
	});
	assert.equal(result.details.statsUnavailable, undefined);
});

test("aborted spawn returns the partial child usage", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let rejectPrompt!: (err: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactoryWith({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_, reject) => { rejectPrompt = reject; });
		},
		abort: async () => { rejectPrompt(Object.assign(new Error("aborted"), { name: "AbortError" })); },
		getEntries: () => [
			messageEntry("a1", {
				role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse",
				usage: { input: 40, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 45, cost: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 } },
			}),
			messageEntry("a2", {
				role: "assistant", content: [], stopReason: "aborted",
				usage: { input: 60, output: 2, cacheRead: 10, cacheWrite: 0, totalTokens: 72, cost: { input: 6, output: 1, cacheRead: 1, cacheWrite: 0, total: 8 } },
			}),
		],
	})), { activeTools: ["read", "bash", "spawn"] });

	const execution = pi.tools.get("spawn").execute(
		"spawn-aborted-usage",
		{ prompt: "Do the task" },
		controller.signal,
		undefined,
		{ model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	controller.abort();
	const result = await execution;

	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "Child agent aborted: This operation was aborted");
	assert.deepEqual(result.usage, {
		input: 100,
		output: 7,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 117,
		cost: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, total: 13 },
	});
});

test("a child model error keeps its failure message and earlier partial text", async () => {
	const result = await executeWithEntries(() => [], { result: [
		{ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "stop" },
		{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
	] });

	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "error");
	assert.equal(result.content[0].text, "Child agent failed: provider failed\n\npartial answer");
});

test("a child model error without text still names the failure", async () => {
	const result = await executeWithEntries(() => [], { result: [
		{ role: "assistant", content: [], stopReason: "error" },
	] });

	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "error");
	assert.equal(result.content[0].text, "Child agent failed: no error message");
});

test("a child abort includes its reported error message", async () => {
	const result = await executeWithEntries(() => [], { result: [
		{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "cancelled by provider" },
	] });

	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.content[0].text, "Child agent aborted: cancelled by provider");
});

test("a failed child abort during the prompt is reported through the UI notice", async () => {
	const state = createState();
	const controller = new AbortController();
	const notifications: string[] = [];
	let promptStarted!: () => void;
	let resolvePrompt!: () => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const session = mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => { resolvePrompt = resolve; });
		},
		abort: async () => { resolvePrompt(); throw new Error("abort failed"); },
	});
	const pi = await createTestHost((_api) => {});
	const execution = executeSpawn("spawn-abort-failure", pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: true,
			ui: { notify: (message: string) => { notifications.push(message); } } } as any,
		state, { prompt: "Do the task" }, controller.signal, undefined, "medium",
		async () => ({ session, extensionsResult: undefined as any }));
	await started;
	controller.abort();

	const result = await execution;
	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.content[0].text, "Child agent aborted: This operation was aborted\n\nchild result");
	assert.deepEqual(notifications, ["Spawn cleanup failed: abort failed"]);
});

// ── Usage of a spawn that fails ──────────────────────────────────────

function failedChildEntries(): SessionEntry[] {
	return [
		messageEntry("a1", {
			role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse",
			usage: { input: 30, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 36, cost: { input: 3, output: 1, cacheRead: 1, cacheWrite: 0, total: 5 } },
		}),
		messageEntry("a2", {
			role: "assistant", content: [], stopReason: "stop",
			usage: { input: 50, output: 0, cacheRead: 8, cacheWrite: 1, totalTokens: 59, cost: { input: 5, output: 0, cacheRead: 2, cacheWrite: 1, total: 8 } },
		}),
	];
}

const FAILED_CHILD_USAGE = {
	input: 80,
	output: 4,
	cacheRead: 10,
	cacheWrite: 1,
	totalTokens: 95,
	cost: { input: 8, output: 1, cacheRead: 3, cacheWrite: 1, total: 13 },
};

function failedSpawnResult(text: string) {
	return {
		content: [{ type: "text", text }],
		details: {
			model: "mock-model",
			thinking: "high",
			truncated: false,
			outcome: "error",
			route: { status: "inherited" },
			stats: { inputTokens: 80, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 1, totalTokens: 95, cost: 13, turns: 2 },
		},
		usage: FAILED_CHILD_USAGE,
		isError: true,
	};
}

async function hostWithFailedUsage(opts: NonNullable<Parameters<typeof mockSessionFactory>[0]>) {
	const state = createState();
	let entryReads = 0;
	const getEntries = opts.getEntries ?? failedChildEntries;
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactoryWith({
		...opts,
		getEntries: () => { entryReads++; return getEntries(); },
	})), { activeTools: ["read", "bash", "spawn"] });
	return {
		state,
		get entryReads() { return entryReads; },
		execute: (toolCallId: string, ctx: Record<string, unknown> = { model: { id: "mock-model" }, cwd: "/tmp" }, signal?: AbortSignal) =>
			pi.tools.get("spawn").execute(toolCallId, { prompt: "Do the task", thinking: "high" }, signal, undefined, ctx),
	};
}

test("a spawn whose child prompt fails returns an error result with the child usage read once", async () => {
	const host = await hostWithFailedUsage({ prompt: async () => { throw new Error("prompt failed"); } });

	assert.deepEqual(await host.execute("spawn-prompt-error"), failedSpawnResult("prompt failed"));
	assert.equal(host.entryReads, 1);
	assertChildRegistriesCleared(host.state);
});

test("a spawn whose child prompt rejects with a non-Error value returns its string form as an error result", async () => {
	const host = await hostWithFailedUsage({ prompt: async () => { throw "boom-string"; } });

	assert.deepEqual(await host.execute("spawn-prompt-non-error"), failedSpawnResult("boom-string"));
	assertChildRegistriesCleared(host.state);
});

test("a spawn whose child produces no output returns an error result with the child usage", async () => {
	const host = await hostWithFailedUsage({ prompt: async () => {}, result: [] });

	assert.deepEqual(await host.execute("spawn-no-output"), failedSpawnResult("Child agent produced no output."));
	assertChildRegistriesCleared(host.state);
});

test("a completed spawn whose dispose fails returns the dispose error with the child usage read once", async () => {
	const host = await hostWithFailedUsage({
		prompt: async () => {},
		dispose: () => { throw new Error("dispose failed"); },
	});

	assert.deepEqual(await host.execute("spawn-dispose-failure"), failedSpawnResult("dispose failed"));
	assert.equal(host.entryReads, 1);
	assertChildRegistriesCleared(host.state);
});

test("a spawn invalidated by a reset after its prompt started returns an error result with the child usage", async () => {
	const resetInPrompt: { run: () => void } = { run: () => {} };
	const host = await hostWithFailedUsage({ prompt: async () => { resetInPrompt.run(); } });
	resetInPrompt.run = () => resetState(host.state);

	assert.deepEqual(await host.execute("spawn-reset-mid-run"), failedSpawnResult("Spawn invalidated by reset."));
	assertChildRegistriesCleared(host.state);
});

test("a failed spawn whose child entries cannot be read returns its own error without stats", async () => {
	const host = await hostWithFailedUsage({
		prompt: async () => { throw new Error("prompt failed"); },
		getEntries: () => { throw new Error("entries unavailable"); },
	});

	const result = await host.execute("spawn-unreadable");

	assertErrorResult(result, "prompt failed", EMPTY_CHILD_USAGE);
	assert.equal(result.details.stats, undefined);
	assert.equal(result.details.statsUnavailable, true);
});

test("a parent abort between child creation and the prompt returns an aborted result", async () => {
	const controller = new AbortController();
	const reason = new Error("aborted before start");
	controller.abort(reason);
	let prompts = 0;
	const host = await hostWithFailedUsage({ prompt: async () => { prompts++; } });

	const result = await host.execute("spawn-aborted-early", undefined, controller.signal);
	assert.equal(result.isError, true);
	assert.deepEqual(result.details, {
		model: "mock-model",
		thinking: "high",
		truncated: false,
		outcome: "aborted",
		route: { status: "inherited" },
		stats: { inputTokens: 80, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 1, totalTokens: 95, cost: 13, turns: 2 },
	});
	assert.equal(result.content[0].text, "Child agent aborted: aborted before start");
	assert.deepEqual(result.usage, FAILED_CHILD_USAGE);
	assert.equal(prompts, 0);
	assert.equal(host.entryReads, 1);
});

// ── Result truncation ───────────────────────────────────────────────

const TRUNCATION_MARKER = `\n\n[Result truncated to ${DEFAULT_MAX_LINES} lines / ${formatByteCap(DEFAULT_MAX_BYTES)}. Spawn a new child with a narrower request if more is needed.]`;
// Whole 3-byte characters and, after a 1-byte prefix, whole 4-byte emoji that fit in the byte limit.
const FITTING_3_BYTE_CHARS = Math.floor(DEFAULT_MAX_BYTES / 3);
const FITTING_EMOJI = Math.floor((DEFAULT_MAX_BYTES - 1) / 4);

async function executeWithChildText(text: string) {
	return executeWithEntries(() => [], { result: [{ role: "assistant", content: [{ type: "text", text }] }] });
}

test("spawn result over the line limit keeps the first lines up to the limit and names the limits", async () => {
	const lines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `line ${i}`);
	assert.ok(Buffer.byteLength(lines.slice(0, DEFAULT_MAX_LINES).join("\n")) <= DEFAULT_MAX_BYTES, "kept lines must fit in the byte limit");
	const result = await executeWithChildText(lines.join("\n"));

	assert.equal(result.details.truncated, true);
	assert.equal(result.content[0].text, lines.slice(0, DEFAULT_MAX_LINES).join("\n") + TRUNCATION_MARKER);
});

test("spawn result at the line limit is not truncated", async () => {
	const text = Array(DEFAULT_MAX_LINES).fill("x").join("\n");
	assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES, "text must fit in the byte limit");
	const result = await executeWithChildText(text);

	assert.equal(result.details.truncated, false);
});

test("spawn result at the byte limit is not truncated", async () => {
	const result = await executeWithChildText("a".repeat(DEFAULT_MAX_BYTES));

	assert.equal(result.details.truncated, false);
	assert.equal(result.content[0].text, "a".repeat(DEFAULT_MAX_BYTES));
});

test("spawn result retains an untruncated lone surrogate", async () => {
	const text = "ab\uD800cd";
	const result = await executeWithChildText(text);

	assert.equal(result.details.truncated, false);
	assert.equal(result.content[0].text, text);
});

for (const { name, input, precondition, expectedText } of [
	{
		name: "spawn result one byte over the byte limit is truncated",
		input: "a".repeat(DEFAULT_MAX_BYTES + 1),
		expectedText: "a".repeat(DEFAULT_MAX_BYTES) + TRUNCATION_MARKER,
	},
	{
		name: "spawn result keeps the head of an oversized first line when more lines follow",
		input: "z".repeat(DEFAULT_MAX_BYTES + 1) + "\nsecond",
		expectedText: "z".repeat(DEFAULT_MAX_BYTES) + TRUNCATION_MARKER,
	},
	{
		name: "spawn result cuts an oversized line of 3-byte characters on a character boundary",
		input: "語".repeat(FITTING_3_BYTE_CHARS + 1),
		// The precondition puts the byte limit inside a character, so the cut must back off.
		precondition: () => assert.notEqual(DEFAULT_MAX_BYTES % 3, 0, "byte limit must not be a multiple of 3"),
		expectedText: "語".repeat(FITTING_3_BYTE_CHARS) + TRUNCATION_MARKER,
	},
	{
		name: "spawn result cuts an oversized line of surrogate pairs without splitting one",
		input: "x" + "😀".repeat(FITTING_EMOJI + 1),
		// The precondition puts the byte limit inside an emoji, so the cut must back off.
		precondition: () => assert.notEqual((DEFAULT_MAX_BYTES - 1) % 4, 0, "byte limit minus 1 must not be a multiple of 4"),
		expectedText: "x" + "😀".repeat(FITTING_EMOJI) + TRUNCATION_MARKER,
	},
]) {
	test(name, async () => {
		precondition?.();
		const result = await executeWithChildText(input);

		assert.equal(result.details.truncated, true);
		assert.equal(result.content[0].text, expectedText);
	});
}

test("a long prompt failure is truncated at the result byte limit", async () => {
	const host = await hostWithFailedUsage({ prompt: async () => { throw new Error("a".repeat(DEFAULT_MAX_BYTES + 1)); } });

	const result = await host.execute("spawn-long-error");

	assert.equal(result.isError, true);
	assert.equal(result.details.truncated, true);
	assert.equal(result.content[0].text, "a".repeat(DEFAULT_MAX_BYTES) + TRUNCATION_MARKER);
});

test("spawn result trims a trailing newline before applying result limits", async () => {
	const expected = Array(DEFAULT_MAX_LINES).fill("x").join("\n");
	assert.ok(Buffer.byteLength(expected) <= DEFAULT_MAX_BYTES, "trimmed text must fit in the byte limit");
	const result = await executeWithChildText("x\n".repeat(DEFAULT_MAX_LINES));

	assert.equal(result.content[0].text, expected);
});

test("spawn result over the byte limit keeps the byte-limited head", async () => {
	const line = "a".repeat(99);
	// Each line takes 100 bytes with its newline, so these lines pass the byte limit; the precondition keeps them within the line limit.
	const lineCount = Math.ceil(DEFAULT_MAX_BYTES / 100) + 1;
	assert.ok(lineCount <= DEFAULT_MAX_LINES, "lines must stay within the line limit");
	const result = await executeWithChildText(Array(lineCount).fill(line).join("\n"));

	assert.equal(result.details.truncated, true);
	assert.equal(Buffer.byteLength(result.content[0].text.slice(0, -TRUNCATION_MARKER.length)), DEFAULT_MAX_BYTES);
});

test("spawn result keeps a UTF-8-safe head when a multi-byte line straddles the byte limit", async () => {
	// DEFAULT_MAX_BYTES - 3 bytes, a newline and two 3-byte euro signs end 4 bytes past the limit, which falls inside the first euro sign.
	const result = await executeWithChildText("a".repeat(DEFAULT_MAX_BYTES - 3) + "\n€€");

	assert.equal(result.details.truncated, true);
	assert.equal(result.content[0].text, "a".repeat(DEFAULT_MAX_BYTES - 3) + "\n" + TRUNCATION_MARKER);
});

test("spawn result with CRLF lines keeps the exact byte-limited prefix", async () => {
	// Line 1 is 99 chars + CR = 100 bytes; every later line adds an LF plus 98 chars + CR = 100 bytes.
	// The preconditions keep the lines within the line limit and put the byte limit between a CR and its LF.
	// The text is ASCII, so its first DEFAULT_MAX_BYTES characters are its first DEFAULT_MAX_BYTES bytes.
	const lineCount = Math.ceil(DEFAULT_MAX_BYTES / 100) + 1;
	assert.ok(lineCount <= DEFAULT_MAX_LINES, "lines must stay within the line limit");
	assert.equal(DEFAULT_MAX_BYTES % 100, 0, "byte limit must be a multiple of 100");
	const text = "c".repeat(99) + "\r\n" + Array(lineCount - 1).fill("b".repeat(98)).join("\r\n");
	const result = await executeWithChildText(text);

	assert.equal(result.details.truncated, true);
	assert.equal(result.content[0].text, text.slice(0, DEFAULT_MAX_BYTES) + TRUNCATION_MARKER);
});

test("spawn result retains the byte-limited prefix of a long second line", async () => {
	const result = await executeWithChildText(`short\n${"b".repeat(DEFAULT_MAX_BYTES)}`);
	const content = result.content[0].text.slice(0, -TRUNCATION_MARKER.length);

	assert.equal(Buffer.byteLength(content), DEFAULT_MAX_BYTES);
	assert.match(content, /^short\nb+/);
});

test("headless spawn aggregates Error and cleanup failures without mutating the primary error", async () => {
	const originalCause = new Error("original cause");
	const primaryFailure = new Error("prompt failed", { cause: originalCause });
	const cleanupFailure = new Error("dispose failed");
	Object.freeze(primaryFailure);
	const { execution, state } = await executeWithFailingCleanup(primaryFailure, cleanupFailure);

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; dispose failed", EMPTY_CHILD_USAGE);
	assert.equal(primaryFailure.cause, originalCause);
	assertChildRegistriesCleared(state);
});

test("headless spawn aggregates primitive and cleanup failures", async () => {
	const primaryFailure = "prompt failed";
	const cleanupFailure = new Error("dispose failed");
	const { execution, state } = await executeWithFailingCleanup(primaryFailure, cleanupFailure);

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; dispose failed", EMPTY_CHILD_USAGE);
	assertChildRegistriesCleared(state);
});

test("a prompt pre-check failure resolves with zero usage before an agent run starts", async () => {
	const preRunError = new Error("No API key found for test-provider.");
	let entryReads = 0;
	const session = mockSessionFactory({
		prompt: async () => { throw preRunError; },
		getEntries: () => { entryReads++; return []; },
	});
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
	const state = createState();

	assertErrorResult(
		await executeSpawn(
			"spawn-pre-run-failure", pi as any, { model: { id: "mock-model" }, cwd: "/tmp", hasUI: false } as any,
			state, { prompt: "Do the task" }, undefined, undefined, "medium",
			async () => ({ extensionsResult: undefined as any, session: session as any }),
		),
		"No API key found for test-provider.",
		EMPTY_CHILD_USAGE,
	);
	assert.equal(entryReads, 1);
	assertChildRegistriesCleared(state);
});

test("UI spawn notifies when cleanup also fails after a primary failure", async () => {
	const notifications: Array<[string, string]> = [];
	const { execution, state } = await executeWithFailingCleanup(new Error("prompt failed"), new Error("dispose failed"), {
		hasUI: true,
		ui: { notify: (message: string, level: string) => { notifications.push([message, level]); } },
	});

	assertErrorResult(await execution, "prompt failed", EMPTY_CHILD_USAGE);
	assert.deepEqual(notifications, [["Spawn cleanup failed: dispose failed", "error"]]);
	assertChildRegistriesCleared(state);
});

test("UI spawn names both failures when the cleanup notice throws", async () => {
	let notifyCalls = 0;
	const { execution, state } = await executeWithFailingCleanup(new Error("prompt failed"), new Error("dispose failed"), {
		hasUI: true,
		ui: { notify: () => { notifyCalls++; throw new Error("notify exploded"); } },
	});

	assertErrorResult(await execution, "Spawn failed and cleanup failed: prompt failed; dispose failed", EMPTY_CHILD_USAGE);
	assert.equal(notifyCalls, 1);
	assertChildRegistriesCleared(state);
});

test("spawn execute clears childSessions after successful completion when unrendered", async () => {
	const state = createState();

	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactoryWith({
		prompt: async () => {},
	})), { activeTools: ["read", "bash", "spawn"] });
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
	const host = await hostWithFailedUsage({});
	await assert.rejects(
		() => host.execute("spawn-1", { cwd: "/tmp" }),
		/No model configured\. Cannot spawn child agent\./,
	);
	assert.equal(host.entryReads, 0);
});

test("a rejecting child session factory rejects spawn before a session exists", async () => {
	const pi = await createTestHost((_api) => {});
	const state = createState();

	await assert.rejects(
		() => executeSpawn("spawn-factory-rejection", pi as any,
			{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
			state, { prompt: "Do the task" }, undefined, undefined, "medium",
			async () => { throw new Error("factory unavailable"); }),
		/factory unavailable/,
	);
	assertChildRegistriesCleared(state);
});

test("executeSpawn propagates unusable-group errors before creating child work", async () => {
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
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
	const pi = await createTestHost((_api) => {});
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
	const pi = await createTestHost((_api) => {}); const state = createState(); let factoryCalls = 0;
	await assert.rejects(() => executeSpawn("unknown-constraint", pi as any, {
		model: { provider: "openai", id: "parent", input: ["text"], reasoning: false }, cwd: "/tmp",
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
	} as any, state, { prompt: "Do the task", constraints: { unknown: {} } }, undefined, undefined, "medium", async () => { factoryCalls++; throw new Error("must not create child"); }), /Unknown spawn constraint/);
	assert.equal(factoryCalls, 0); assert.equal(state.childSessions.size, 0); assert.equal(state.liveChildSessions.size, 0);
});

test("registered spawn tool rejects missing modalities before creating child work", async () => {
	const state = createState();
	state.modelGroups.groups = [{
		name: "text-only", scope: "project", sourcePath: "<test>", models: [{ provider: "openai", modelId: "text" }],
		modalities: { common: ["text"], supported: ["text"], effective: ["text"] },
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] },
	}];
	let factoryCalls = 0;
	const pi = await createTestHost((api) => registerSpawnTool(api, state, (async () => { factoryCalls++; throw new Error("sessionFactory must not be called"); }) as any), { activeTools: ["read", "bash", "spawn"] });

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
	const state = createState(); let factoryCalls = 0;
	state.modelGroups.groups = [
		{ name: "small", scope: "project", sourcePath: "<test>", models: [{ provider: "openai", modelId: "small" }], modalities: { common: ["text"], supported: ["text"], effective: ["text"] }, validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] } },
	];
	const pi = await createTestHost((api) => registerSpawnTool(api, state, (async () => { factoryCalls++; throw new Error("sessionFactory must not be called"); }) as any, createConstraintRegistry([testMinContext])), { activeTools: ["spawn"] });
	await assert.rejects(
		() => pi.tools.get("spawn").execute("registered-scalar", { prompt: "Do the task", group: "small", constraints: { testMinContext: 20 } }, undefined, undefined, {
			model: { provider: "openai", id: "parent", input: ["text"], reasoning: false, contextWindow: 100 }, cwd: "/tmp",
			modelRegistry: { find: (_provider: string, id: string) => ({ provider: "openai", id, input: ["text"], reasoning: false, contextWindow: id === "small" ? 10 : 100 }), hasConfiguredAuth: () => true },
		} as any),
		(error: unknown) => error instanceof SpawnRouteError && error.reason === "constraint-unsatisfied" && error.constraintUnsatisfied?.length === 2 && error.missingModalities.length === 0 && error.missingFromGroup.length === 0 && error.missingFromModel.length === 0,
	);
	assert.equal(factoryCalls, 0); assert.equal(state.childSessions.size, 0); assert.equal(state.liveChildSessions.size, 0);
});

test("registered spawn tool schema accepts injected scalar requirements", async () => {
	const pi = await createTestHost((api) => registerSpawnTool(api, createState(), undefined, createConstraintRegistry([testMinContext])));
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

test("spawn tool schema validates constraints via Value.Check", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerSpawnTool(api, state));
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

test("spawn constraints description enumerates the registry keys (production)", async () => {
	const pi = await createTestHost((api) => registerSpawnTool(api, createState()));
	const parameters = (pi.tools.get("spawn") as any).parameters;
	const constraintsDesc = parameters.properties.constraints.description as string;
	assert.ok(constraintsDesc.includes("Keys: modalities"), "description names the production constraint key");
});

test("spawn constraints description enumerates injected registry keys", async () => {
	const pi = await createTestHost((api) => registerSpawnTool(api, createState(), undefined, createConstraintRegistry([testMinContext])));
	const parameters = (pi.tools.get("spawn") as any).parameters;
	const constraintsDesc = parameters.properties.constraints.description as string;
	assert.ok(constraintsDesc.includes("Keys: testMinContext"), "description names the injected registry's constraint key");
});

test("executeSpawn forwards inherited constraints to routing and succeeds when satisfied", async () => {
	const state = createState();
	let factoryCalls = 0;
	const session = {
		messages: [] as any[],
		prompt: async () => {
			session.messages = [{ role: "assistant", content: [{ type: "text", text: "child result" }] }];
		},
		abort: async () => {},
		sessionManager: { getEntries: () => [] },
	};
	const pi = await createTestHost((api) => registerSpawnTool(api, state, (async () => { factoryCalls++; return { session: session as any }; }) as any), { activeTools: ["read", "spawn"] });
	const result = await executeSpawn("spawn-inherited-rm", pi as any, {
		model: { provider: "openai", id: "parent", input: ["text", "image"], reasoning: false }, cwd: "/tmp",
		modelRegistry: { find: (_p: string, id: string) => ({ provider: "openai", id, input: ["text", "image"], reasoning: false }), hasConfiguredAuth: () => true },
	} as any, state, { prompt: "Do the task", constraints: { modalities: { required: ["text", "image"] } } }, undefined, undefined, "medium", async () => { factoryCalls++; return { session: session as any, extensionsResult: undefined as any }; });
	assert.equal(result.details.outcome, "success");
	assert.deepEqual(result.details.route, { status: "inherited" });
	assert.equal(factoryCalls, 1, "inherited route with satisfied requirements creates one child");
});

test("spawn renderResult transfers session ownership out of shared state", async () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);


	const pi = await createTestHost((api) => registerSpawnTool(api, state));

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

test("spawn renderResult reuses lastComponent", async () => {
	const state = createState();
	const session = createSession([
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
	]);
	state.childSessions.set("tool-call-1", session);


	const pi = await createTestHost((api) => registerSpawnTool(api, state));

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

test("spawn render shows success state when stats are unavailable", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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
			sessionManager: { getEntries: () => [] },
		};
		return { session: session as any };
	};

	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

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
	assert.equal(result.content[0].text, "Child agent aborted: This operation was aborted\n\naborted mid-flight");
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.isError, true);
	assert.equal(disposeCalls, 1, "mid-prompt abort disposes exactly once");
});

test("a completed child error after parent cancellation is reported as aborted", async () => {
	const state = createState();
	const controller = new AbortController();
	let promptStarted!: () => void;
	let resolvePrompt!: () => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const session = mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((resolve) => { resolvePrompt = resolve; });
		},
		abort: async () => { resolvePrompt(); },
		result: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }],
	});
	const pi = await createTestHost((_api) => {});
	const execution = executeSpawn(
		"spawn-provider-error-after-abort", pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp" } as any,
		state, { prompt: "Do the task" }, controller.signal, undefined, "medium",
		async () => ({ session, extensionsResult: undefined as any }),
	);
	await started;
	controller.abort(new Error("parent cancelled"));

	const result = await execution;
	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.content[0].text, "Child agent aborted: parent cancelled");
});

test("spawn execute swallows prompt rejection when signal aborts mid-flight", async () => {
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

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
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "Child agent aborted: This operation was aborted");
	assert.equal(disposeCalls, 1, "mid-prompt abort disposes exactly once");
});

test("a real prompt failure that races with a parent abort keeps its text under the aborted outcome", async () => {
	const state = createState();
	const controller = new AbortController();
	let disposeCalls = 0;
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const promptError = new Error("prompt failed despite abort");
	const pi = await createTestHost((api) => registerSpawnTool(api, state, async () => ({ session: mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		},
		dispose: () => { disposeCalls++; },
	}), extensionsResult: undefined as any })), { activeTools: ["read", "bash", "spawn"] });

	const execution = pi.tools.get("spawn").execute(
		"spawn-abort-real-error", { prompt: "Do the task" }, controller.signal,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	controller.abort();
	rejectPrompt(promptError);

	const result = await execution;
	assert.equal(result.isError, true);
	assert.deepEqual(result.content, [{ type: "text", text: "prompt failed despite abort" }]);
	assert.equal(result.details.outcome, "aborted");
	assert.deepEqual(result.usage, EMPTY_CHILD_USAGE);
	assert.equal(disposeCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("spawn invalidation wins the abort and prompt-rejection race", async () => {
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

	const execution = pi.tools.get("spawn").execute(
		"spawn-abort-reset-race", { prompt: "Do the task" }, controller.signal,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	controller.abort();
	resetState(state);
	rejectPrompt(new Error("prompt rejected after abort and reset"));

	assertErrorResult(await execution, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
	assert.equal(abortCalls, 1, "signal cancellation and reset share one abort");
	assert.equal(disposeCalls, 1, "the raced child disposes exactly once");
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn reports the invalidation and abort failure when abort rejects during active-prompt reset", async () => {
	const state = createState();
	let disposeCalls = 0;
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const abortError = new Error("abort failed");
	const mockFactory = async () => ({ session: mockSessionFactory({
		prompt: async () => {
			promptStarted();
			await new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		},
		abort: async () => { throw abortError; },
		dispose: () => { disposeCalls++; },
	}), extensionsResult: undefined as any });
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

	const execution = pi.tools.get("spawn").execute(
		"spawn-abort-rejects", { prompt: "Do the task" }, undefined,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);
	await started;
	resetState(state);
	rejectPrompt(new Error("prompt rejected"));

	assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", EMPTY_CHILD_USAGE);
	assert.equal(disposeCalls, 1, "the aborted child disposes exactly once");
	assertChildRegistriesCleared(state);
});

test("reset before registration returns the invalidation and abort failure", async () => {
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
				sessionManager: { getEntries: () => [] },
			} as any,
		};
	};

	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

	const execution = pi.tools.get("spawn").execute(
		"spawn-pre-reg-abort-reject", { prompt: "Do the task" }, undefined,
		undefined, { model: { id: "mock-model" }, cwd: "/tmp" },
	);

	// Reset while the factory is still producing the session
	resetState(state);
	// Allow the factory to resolve — session is immediately stale
	factoryReady.resolve();

	assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", EMPTY_CHILD_USAGE);
	assert.equal(factoryCalled, true, "factory was called");
	assert.equal(abortCalls, 1, "abort was called exactly once");
	assert.equal(disposeCalls, 1, "child disposed exactly once");
	assertChildRegistriesCleared(state);
});

test("reset during prompt reports a failed abort once through the UI", async () => {
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
	const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

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

	assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", EMPTY_CHILD_USAGE);
	assert.deepEqual(notifications, [["Spawn cleanup failed: abort failed", "error"]]);
	assert.equal(abortCalls, 1);
	assert.equal(disposeCalls, 1);
	assertChildRegistriesCleared(state);
});

test("a throwing notice for a failed reset abort does not emit an unhandled rejection", async () => {
	const state = createState();
	let promptStarted!: () => void;
	let rejectPrompt!: (error: Error) => void;
	const started = new Promise<void>((resolve) => { promptStarted = resolve; });
	const abortError = new Error("abort failed");
	const notifyError = new Error("notify exploded");
	let notifyCalls = 0;
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
		const pi = await createTestHost((api) => registerSpawnTool(api, state, mockFactory as any), { activeTools: ["read", "bash", "spawn"] });

		const execution = pi.tools.get("spawn").execute(
			"spawn-throwing-notify",
			{ prompt: "Do the task" },
			undefined,
			undefined,
			{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: true, ui: { notify: () => { notifyCalls++; throw notifyError; } } } as any,
		);
		await started;
		resetState(state);
		rejectPrompt(new Error("prompt rejected"));

		assertErrorResult(await execution, "Spawn invalidated by reset; child abort failed.", EMPTY_CHILD_USAGE);
		// Give any detached microtasks a chance to flush
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(notifyCalls, 1);
		assert.equal(unhandled.length, 0, `no unhandled abort rejections: ${unhandled.map((e) => String(e)).join(", ")}`);
		assertChildRegistriesCleared(state);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("spawn renderCall shows prompt preview and optional routing controls", async () => {
	const state = createState();

	const pi = await createTestHost((api) => registerSpawnTool(api, state));

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

test("nested spawn invalidate rebuilds from the attached session transcript", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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

test("nested spawn attachSession rebuilds after appended session messages", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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

test("nested spawn attachSession rebuilds after replacing session transcript structure", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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

test("nested spawn rebuildFromSession quietly tolerates missing tool definitions", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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

test("nested spawn attachSession recovers from subscribe throwing", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);

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
			sessionManager: { getEntries: () => [] },
		};
		return { session: session as any };
	};

	const pi = await createTestHost((api) => registerSpawnTool(api, state, sharedFactory as any));
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
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
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
					sessionManager: { getEntries: () => [] },
				} as any,
				extensionsResult: undefined as any,
			};
		},
	);

	// Reset state while executeSpawn is awaiting the factory
	resetState(state);
	// Now allow the factory to resolve — session should be immediately stale
	resolveFactory({});

	assertErrorResult(await executePromise, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
	assert.equal(factoryCalled, true);
	assert.equal(abortCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn does not prompt when onUpdate synchronously resets the child epoch", async () => {
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
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

	assertErrorResult(await execution, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
	assert.equal(promptCalls, 0);
	assert.equal(abortCalls >= 1, true);
	assert.equal(disposeCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("executeSpawn does not prompt when onUpdate synchronously aborts the signal", async () => {
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
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

	const result = await execution;
	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.content[0].text, "Child agent aborted: cancelled during update");
	assert.deepEqual(result.usage, EMPTY_CHILD_USAGE);
	assert.equal(promptCalls, 0);
	assert.equal(abortCalls, 1);
	assert.equal(disposeCalls, 1);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});

test("an abort during a running update notifies a failed child abort once", async () => {
	const pi = await createTestHost((_api) => {});
	const state = createState();
	const controller = new AbortController();
	const notifications: string[] = [];
	let promptCalls = 0;
	const result = await executeSpawn(
		"spawn-update-abort-failure", pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: true,
			ui: { notify: (message: string) => { notifications.push(message); } } } as any,
		state, { prompt: "Do the task" }, controller.signal,
		() => { controller.abort(new Error("cancelled during update")); }, "medium",
		mockFactoryWith({
			prompt: async () => { promptCalls++; },
			abort: async () => { throw new Error("abort failed"); },
		}),
	);

	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.content[0].text, "abort failed");
	assert.deepEqual(notifications, ["Spawn cleanup failed: abort failed"]);
	assert.equal(promptCalls, 0);
});

test("reset during a running update reports one failed abort", async () => {
	const pi = await createTestHost((_api) => {});
	const state = createState();
	const notifications: string[] = [];
	let promptCalls = 0;
	const result = await executeSpawn(
		"spawn-reset-abort-failure", pi as any,
		{ model: { id: "mock-model" }, cwd: "/tmp", hasUI: true,
			ui: { notify: (message: string) => { notifications.push(message); } } } as any,
		state, { prompt: "Do the task" }, undefined,
		() => { resetState(state); }, "medium",
		mockFactoryWith({
			prompt: async () => { promptCalls++; },
			abort: async () => { throw new Error("abort failed"); },
		}),
	);

	assertErrorResult(result, "Spawn invalidated by reset; child abort failed.", EMPTY_CHILD_USAGE);
	assert.deepEqual(notifications, ["Spawn cleanup failed: abort failed"]);
	assert.equal(promptCalls, 0);
});

test("executeSpawn aborts stale child when resetState fires during prompt", async () => {
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
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
				sessionManager: { getEntries: () => [] },
			} as any,
		}),
	);

	// Wait for session to be created and prompt to start
	await promptStartedPromise;
	// Reset cleanup starts the shared abort, then prompt rejection reaches invalidation.
	resetState(state);

	assertErrorResult(await executePromise, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
	assert.equal(abortCalls, 1, "reset and invalidation share one abort");
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
	assert.equal(disposeCalls, 1, "prompt-reset invalidation disposes exactly once");
});

test("executeSpawn suppresses a successful stale prompt that ignores reset abort", async () => {
	const pi = await createTestHost((_api) => {}, { activeTools: ["read", "bash", "spawn"] });
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
		sessionManager: { getEntries: () => [] },
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

	assertErrorResult(await execution, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
	assert.equal(abortCalls >= 1, true);
	assert.equal(disposeCalls, 1);
	assert.equal(updates.length, 1, "no stale completion update is published");
	assert.deepEqual((updates[0] as any).content, []);
	assert.equal(state.childSessions.size, 0);
	assert.equal(state.liveChildSessions.size, 0);
});


test("nested spawn setExpanded and setShowImages no-op when value matches", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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

test("resetState aborts a claimed child session after render ownership transfer", async () => {
	const state = createState();
	const childSpawnTool = await makeChildSpawnTool(state);
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

test("spawn tool definitions include prompt hints when registered", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerSpawnTool(api, state));

	const spawnTool = pi.tools.get("spawn")!;
	assert.ok(typeof spawnTool.promptSnippet === "string", "spawn should have promptSnippet");
	assert.ok(spawnTool.promptSnippet!.length > 10, "spawn promptSnippet should be non-trivial");
	assert.ok(Array.isArray(spawnTool.promptGuidelines), "spawn should have promptGuidelines");
	assert.ok(spawnTool.promptGuidelines!.length > 0, "spawn promptGuidelines should be non-empty");
	for (const g of spawnTool.promptGuidelines!) {
		assert.ok(g.length > 10, "each spawn guideline should be non-trivial");
	}
});

test("registerSpawnTool registers a tool with correct name and metadata", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerSpawnTool(api, state));

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

// ── Abort cleanup and dispose failure coverage ───────────────────────

test("spawn abort before its prompt returns the failed abort and notifies the UI", async () => {
	const pi = await createTestHost((_api) => {});
	const state = createState();
	const notifications: Array<[string, string]> = [];
	const ctx = {
		model: { id: "mock-model" },
		cwd: "/tmp",
		hasUI: true,
		ui: { notify: (m: string, l: string) => { notifications.push([m, l]); } },
	} as any;
	const abortError = new Error("abort failed");
	const session = mockSessionFactory({ abort: async () => { throw abortError; } });
	const controller = new AbortController();
	controller.abort(new Error("parent aborted"));

	const result = await executeSpawn(
		"spawn-abort-cleanup",
		pi as any,
		ctx,
		state,
		{ prompt: "Do the task" },
		controller.signal,
		undefined,
		"medium",
		async () => ({ session: session as any, extensionsResult: undefined as any }),
	);
	assert.equal(result.isError, true);
	assert.equal(result.details.outcome, "aborted");
	assert.equal(result.content[0].text, "abort failed");
	assert.deepEqual(result.usage, EMPTY_CHILD_USAGE);
	assert.deepEqual(notifications, [["Spawn cleanup failed: abort failed", "error"]]);
});

test("a completed UI spawn whose dispose fails returns the dispose error without a notice", async () => {
	const notifications: Array<[string, string]> = [];
	const host = await hostWithFailedUsage({
		prompt: async () => {},
		dispose: () => { throw new Error("dispose failed"); },
	});

	const result = await host.execute("spawn-dispose-only-ui", {
		model: { id: "mock-model" },
		cwd: "/tmp",
		hasUI: true,
		ui: { notify: (m: string, l: string) => { notifications.push([m, l]); } },
	});

	assert.deepEqual(result, failedSpawnResult("dispose failed"));
	assert.deepEqual(notifications, []);
	assertChildRegistriesCleared(host.state);
});

