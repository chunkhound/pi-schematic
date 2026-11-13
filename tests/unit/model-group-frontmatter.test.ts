/**
 * Model-group frontmatter integration tests.
 *
 * Exercises the full pipeline:
 *   input preflight → model selection → optional before_agent_start readonly handling
 */

import { expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext, ModelRegistry, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelGroupsPath } from "../../model-groups/store.js";
import { createExtensionContext, createModelRegistry, createUIContext, recordOf, testWithDir, tmpDir } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost, getHandler, getHandlers, getHostRecords, type AppendedEntry, type HostHandler, type TestPI } from "./test-host.js";
import { withTemp } from "./model-groups-helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────

// A reasoning-capable registry model; its fields beyond identity and `reasoning` are
// neutral: an empty `input` reads like an absent one, and nothing on these paths
// reads the name, api, cost or token limits.
function mockModel(provider: string, id: string): Model<Api> {
	return {
		provider, id, reasoning: true,
		name: "", api: "test-api", baseUrl: "", input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0,
	};
}

// A `ModelRegistry` whose `find` and `hasConfiguredAuth` answer from `models` and
// `authenticated`; reading any other method throws.
function mockRegistry(
	models: Model<Api>[] = [mockModel("openai", "gpt-4o")],
	authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`)),
): ModelRegistry {
	return createModelRegistry({
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: Model<Api>) => authenticated.has(`${m.provider}:${m.id}`),
	});
}

/** The data of an appended entry; throws when the entry is missing or its data is not an object. */
function entryData(entry: AppendedEntry | undefined): Record<string, unknown> {
	if (entry === undefined) {throw new Error("No appended entry.");}
	return recordOf(entry.data, `the data of the ${entry.customType} entry`);
}

// The extension registers several `session_start` handlers; its model-group refresh is the last one.
function lastSessionStartHandler(pi: TestPI): HostHandler<"session_start"> {
	const handlers = getHandlers(pi, "session_start");
	return handlers[handlers.length - 1];
}

function writeModelGroupsConfig(dir: string, groups: Record<string, { models: { provider: string; modelId: string; thinkingLevel?: string }[] }>): void {
	const configDir = path.dirname(modelGroupsPath("project", dir));
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", dir), JSON.stringify({ version: 1, groups }), "utf8");
}

async function writeSkillMd(dir: string, name: string, frontmatter: Record<string, unknown>): Promise<string> {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\n${fm}\n---\n\nBody content.\n`);
	return filePath;
}

function makeNotifyCtx(overrides: Partial<ExtensionContext> = {}) {
	const notifications: { message: string; level: "info" | "warning" | "error" | undefined }[] = [];
	const ctx = createExtensionContext({
		mode: "tui",
		hasUI: true,
		ui: createUIContext({
			notify: (message, level) => { notifications.push({ message, level }); },
			setStatus: () => {},
			setWidget: () => {},
			// session_start registers the model-group autocomplete provider; these tests never query it.
			addAutocompleteProvider: () => undefined,
		}),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		...overrides,
	});
	return { ctx, notifications };
}

function makePromptCommand(name: string, filePath: string): SlashCommandInfo {
	return {
		name,
		source: "prompt",
		description: "Test prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	};
}

function makeSkillCommand(name: string, filePath: string): SlashCommandInfo {
	return { ...makePromptCommand(`skill:${name}`, filePath), source: "skill" };
}

// ── Tests ─────────────────────────────────────────────────────────────

testWithDir("model-group frontmatter triggers model switch for /name command", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called once").toHaveLength(1);
	expect(setModelCalls[0].provider).toBe("openai");
	expect(setModelCalls[0].id).toBe("gpt-4o");
	expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model changed.*reviewer.*\/review/));

	const groupEntries = getHostRecords(pi).appendedEntries.filter((e) => e.customType === "pi-schematic-model-group-switch");
	expect(groupEntries, "should append one model-group-switch entry").toHaveLength(1);
	expect(groupEntries, "should append one model-group-switch entry").toMatchObject([
		{ data: { command: "/review", groupName: "reviewer", provider: "openai", modelId: "gpt-4o" } },
	]);
}));

testWithDir("model-group-only frontmatter applies and records the group's effective thinking", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, {
		reviewer: { models: [{ provider: "openai", modelId: "gpt-4o", thinkingLevel: "high" }] },
	});
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
	const pi = await makeMockPI();
	const setThinkingCalls: string[] = [];
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const routedModel = mockModelWithThinking("openai", "gpt-4o", {
		off: null, minimal: "minimal", low: "low", medium: "medium", high: null,
	});
	const { ctx } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry([routedModel]),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setThinkingCalls, "group thinking is clamped for the routed model").toStrictEqual(["medium"]);
	const entry = getHostRecords(pi).appendedEntries.find((e) => e.customType === "pi-schematic-model-group-switch");
	expect(entryData(entry).thinking, "entry records effective thinking").toBe("medium");
}));

testWithDir("model-group frontmatter triggers model switch for /skill:name command", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { fast: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
	const filePath = await writeSkillMd(skillDir, "quick", { "model-group": "fast" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry([mockModel("anthropic", "claude-sonnet")]),
	});

	pi.setCommands([makeSkillCommand("quick", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/skill:quick", source: "interactive" }, ctx);

	expect(setModelCalls).toHaveLength(1);
	expect(setModelCalls[0].provider).toBe("anthropic");
	expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model changed.*fast.*\/skill:quick/));
}));

testWithDir("unknown model-group in /skill:name frontmatter blocks execution before agent start", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "quick", { "model-group": "nonexistent" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makeSkillCommand("quick", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const result = await inputHandler({ type: "input", text: "/skill:quick", source: "interactive" }, ctx);

	expect(result, "selection failure must prevent command expansion and agent start").toStrictEqual({ action: "handled" });
	expect(setModelCalls, "setModel should not be called").toHaveLength(0);
	const error = notifications.find((notification) => notification.level === "error")?.message ?? "";
	expect(error).toMatch(/nonexistent/);
	expect(error).toMatch(/\/skill:quick/);
}));

testWithDir("unknown model-group in frontmatter blocks execution with error", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "nonexistent" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const result = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(result, "selection failure must prevent command expansion and agent start").toStrictEqual({ action: "handled" });
	expect(setModelCalls, "setModel should not be called").toHaveLength(0);
	const error = notifications.find((n) => n.level === "error")?.message ?? "";
	expect(error).toMatch(/nonexistent/);
	expect(error).toMatch(/not defined/);
	expect(error).toMatch(/reviewer/);
}));

testWithDir("empty model-group (SpawnRouteError) blocks execution with error", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { empty: { models: [] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "empty" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const result = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(result).toStrictEqual({ action: "handled" });
	expect(setModelCalls).toHaveLength(0);
	expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/empty/);
}));

testWithDir("headless session does not inherit model-group changes", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");

	pi.setCommands([makePromptCommand("review", filePath)]);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, createExtensionContext());

	expect(setModelCalls, "setModel should not be called in headless").toHaveLength(0);
}));

testWithDir("no model-group frontmatter is a silent no-op", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { readonly: true });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should not be called when no model-group frontmatter").toHaveLength(0);
	expect(notifications.map((n) => n.message)).not.toContainEqual(expect.stringMatching(/Model changed/));
}));

testWithDir("invalid model-group value produces warning notification", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should not be called for invalid model-group").toHaveLength(0);
	expect(notifications.map((n) => n.message), "should warn about invalid model-group").toContainEqual(expect.stringMatching(/model-group.*non-empty/));
}));

function mockModelWithThinking(provider: string, id: string, thinkingLevelMap?: Model<Api>["thinkingLevelMap"]): Model<Api> {
	return { ...mockModel(provider, id), thinkingLevelMap };
}

async function makeMockPI() {
	const pi = await createTestHost();
	pi.setModel = async () => true;
	pi.setThinkingLevel = () => {};
	pi.getThinkingLevel = () => "medium";
	return pi;
}

type SetModelBehavior = "success" | "false" | "reject";

async function makeTrackedPI(behavior: SetModelBehavior) {
	const pi = await makeMockPI();
	const modelCalls: Model<Api>[] = [];
	const thinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => {
		modelCalls.push(model);
		if (behavior === "reject") {throw new Error("setModel rejected");}
		return behavior !== "false";
	};
	pi.setThinkingLevel = (level: string) => thinkingCalls.push(level);
	return { pi, modelCalls, thinkingCalls };
}

async function executePromptInput(pi: TestPI, ctx: ExtensionContext, streamingBehavior?: "steer" | "followUp") {
	await lastSessionStartHandler(pi)({ type: "session_start", reason: "startup" }, ctx);
	const input = getHandler(pi, "input");
	return input({ type: "input", text: "/review", source: "interactive", streamingBehavior }, ctx);
}

async function runPromptInput(
	cwd: string, frontmatter: Record<string, unknown>, behavior: SetModelBehavior,
	streamingBehavior?: "steer" | "followUp",
) {
	const dir = await tmpDir();
	try {
		const filePath = await writeSkillMd(dir, "review", frontmatter);
		const tracked = await makeTrackedPI(behavior);
		const { ctx, notifications } = makeNotifyCtx({
			cwd, model: mockModel("openai", "gpt-parent"), modelRegistry: mockRegistry(),
		});
		tracked.pi.setCommands([makePromptCommand("review", filePath)]);
		const result = await executePromptInput(tracked.pi, ctx, streamingBehavior);
		return { ...tracked, notifications, result };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function modelSelectionEntries(pi: TestPI): AppendedEntry[] {
	const types = new Set([
		"pi-schematic-model-switch",
		"pi-schematic-model-group-switch",
		"pi-schematic-thinking-change",
	]);
	return getHostRecords(pi).appendedEntries.filter((entry) => types.has(entry.customType));
}

// ── Explicit model frontmatter tests ──────────────────────────────

testWithDir("explicit model frontmatter switches model", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called once").toHaveLength(1);
	expect(setModelCalls[0].provider).toBe("openai");
	expect(setModelCalls[0].id).toBe("gpt-4o");
	expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model switched.*openai.*gpt-4o.*\/review/));

	const switchEntries = getHostRecords(pi).appendedEntries.filter((e) => e.customType === "pi-schematic-model-switch");
	expect(switchEntries, "should append one model-switch entry").toHaveLength(1);
	const switchData = entryData(switchEntries[0]);
	expect(switchData.command).toBe("/review");
	expect(switchData.provider).toBe("openai");
	expect(switchData.modelId).toBe("gpt-4o");
	expect(switchData.thinking).toBeNull();
}));

testWithDir("explicit model with thinking sets both model and thinking level", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "high" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	const setThinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	pi.getThinkingLevel = () => "medium";
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry([mockModelWithThinking("openai", "gpt-4o", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" })]),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called once").toHaveLength(1);
	expect(setModelCalls[0].id).toBe("gpt-4o");
	expect(setThinkingCalls, "setThinkingLevel should be called once").toHaveLength(1);
	expect(setThinkingCalls[0]).toBe("high");
	expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model switched.*openai.*gpt-4o/));
}));

testWithDir("explicit model without thinking does not change thinking level", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	const setThinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	pi.getThinkingLevel = () => "medium";
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called").toHaveLength(1);
	expect(setModelCalls[0].id).toBe("gpt-4o");
	expect(setThinkingCalls, "setThinkingLevel should NOT be called").toHaveLength(0);
}));

testWithDir("explicit model applies while invalid thinking is reported", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "ultra" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	const setThinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "valid model should still be applied").toHaveLength(1);
	expect(setThinkingCalls, "invalid thinking must not be applied").toHaveLength(0);
	const warnings = notifications.filter((n) => n.level === "warning");
	expect(warnings, "invalid thinking should produce one warning").toHaveLength(1);
	expect(warnings[0]?.message ?? "").toMatch(/`thinking`/);
	const issues = getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-frontmatter-issue");
	expect(issues, "invalid thinking should produce one issue entry").toHaveLength(1);
	const issueData = entryData(issues[0]);
	expect(issueData.type).toBe("command");
	expect(recordOf(issueData.issue, "data.issue of the pi-schematic-frontmatter-issue entry").kind).toBe("invalid-thinking-value");
}));

testWithDir("valid model applies when model-group frontmatter is invalid", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	const inputHandler = getHandler(pi, "input");
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	const result = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(result).toStrictEqual({ action: "continue" });
	expect(setModelCalls.map((model) => model.id)).toStrictEqual(["gpt-4o"]);
	const warnings = notifications.filter((notification) => notification.level === "warning");
	expect(warnings).toHaveLength(1);
	expect(warnings[0]?.message ?? "").toMatch(/`model-group`/);
}));

testWithDir("explicit model + model-group warns and uses explicit model", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "reviewer" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called once").toHaveLength(1);
	expect(setModelCalls[0].id, "explicit model should win over model-group").toBe("gpt-4o");
	expect(notifications.map((n) => n.message), "should warn about override").toContainEqual(expect.stringMatching(/reviewer.*overridden/));
}));

testWithDir("explicit model + model-group + thinking uses explicit model and thinking, warns about override", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "reviewer", thinking: "high" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	const setThinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	pi.getThinkingLevel = () => "medium";
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry([mockModelWithThinking("openai", "gpt-4o", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" })]),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called once").toHaveLength(1);
	expect(setModelCalls[0].id, "explicit model should win").toBe("gpt-4o");
	expect(setThinkingCalls, "setThinkingLevel should be called").toHaveLength(1);
	expect(setThinkingCalls[0], "thinking from frontmatter should be applied").toBe("high");
	expect(notifications.map((n) => n.message), "should warn about group override").toContainEqual(expect.stringMatching(/reviewer.*overridden/));
}));

testWithDir("model-group + thinking overrides group thinking level", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer", thinking: "low" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	const setThinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	pi.getThinkingLevel = () => "medium";
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry([mockModelWithThinking("openai", "gpt-4o", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" })]),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should be called once").toHaveLength(1);
	expect(setModelCalls[0].id, "model should come from group").toBe("gpt-4o");
	expect(setThinkingCalls, "setThinkingLevel should be called once").toHaveLength(1);
	expect(setThinkingCalls[0], "thinking should come from frontmatter, not group").toBe("low");
	expect(notifications.map((n) => n.message), "should notify about group change").toContainEqual(expect.stringMatching(/Model changed.*reviewer.*\/review/));
}));

testWithDir("thinking only frontmatter sets thinking level without changing model", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { thinking: "high" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	const setThinkingCalls: string[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	pi.getThinkingLevel = () => "medium";
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const currentModel = mockModelWithThinking("openai", "gpt-parent", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" });
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: currentModel,
		modelRegistry: mockRegistry([currentModel]),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should NOT be called").toHaveLength(0);
	expect(setThinkingCalls, "setThinkingLevel should be called").toHaveLength(1);
	expect(setThinkingCalls[0]).toBe("high");
	expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Thinking level set.*high.*\/review/));

	const thinkingEntries = getHostRecords(pi).appendedEntries.filter((e) => e.customType === "pi-schematic-thinking-change");
	expect(thinkingEntries, "should append one thinking-change entry").toHaveLength(1);
	const thinkingData = entryData(thinkingEntries[0]);
	expect(thinkingData.command).toBe("/review");
	expect(thinkingData.thinking).toBe("high");
}));

testWithDir("unknown model in frontmatter blocks execution", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "unknown/no-such-model" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const result = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(result).toStrictEqual({ action: "handled" });
	expect(setModelCalls, "setModel should not be called").toHaveLength(0);
	expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/unknown\/no-such-model.*not found/);
}));

testWithDir("model switch failure blocks explicit model selection", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
	const pi = await makeMockPI();
	pi.setModel = async () => false; // Simulate setModel failure
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const result = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(result).toStrictEqual({ action: "handled" });
	expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/failed to switch/);
}));

testWithDir("unauthenticated model in registry blocks explicit model selection", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
	const pi = await makeMockPI();
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		// Model exists in registry but has no configured auth
		modelRegistry: mockRegistry([mockModel("openai", "gpt-4o")], new Set()),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const result = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(result).toStrictEqual({ action: "handled" });
	expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/no API key/);
}));

testWithDir("invalid model format in frontmatter produces warning", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "not-valid-format" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setModelCalls, "setModel should not be called for invalid model format").toHaveLength(0);
	expect(notifications.map((n) => n.message), "should warn about invalid model format").toContainEqual(expect.stringMatching(/`model`.*`<provider>\/<model-id>`/));
}));

testWithDir("invalid thinking value produces warning", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	const filePath = await writeSkillMd(skillDir, "review", { thinking: "ultra" });
	const pi = await makeMockPI();
	const setThinkingCalls: string[] = [];
	pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx, notifications } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);

	expect(setThinkingCalls, "setThinkingLevel should NOT be called for invalid thinking").toHaveLength(0);
	expect(notifications.map((n) => n.message), "should warn about invalid thinking").toContainEqual(expect.stringMatching(/`thinking`.*off, minimal, low/));
}));

testWithDir("explicit model frontmatter is ignored in headless session", async ({ dir: skillDir }) => withTemp(async () => {
	const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
	const pi = await makeMockPI();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };
	const inputHandler = getHandler(pi, "input");

	pi.setCommands([makePromptCommand("review", filePath)]);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, createExtensionContext());

	expect(setModelCalls, "setModel should not be called in headless").toHaveLength(0);
}));


testWithDir("model-group toggle does not affect readonly state", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const beforeStartHandler = getHandler(pi, "before_agent_start");
	const { ctx } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry(),
	});

	pi.setCommands([makePromptCommand("review", filePath)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(setModelCalls, "model should be switched").toHaveLength(1);
	const readonlyEntries = getHostRecords(pi).appendedEntries.filter((e) => e.customType === "pi-schematic-readonly");
	expect(readonlyEntries, "readonly state should not be affected").toHaveLength(0);
}));

test("streaming blocks model selection without mutation", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const cases = [
		{ frontmatter: { model: "openai/gpt-4o" }, streamingBehavior: "steer" as const },
		{ frontmatter: { "model-group": "reviewer" }, streamingBehavior: "followUp" as const },
		{ frontmatter: { thinking: "high" }, streamingBehavior: "steer" as const },
	];
	for (const scenario of cases) {
		const run = await runPromptInput(cwd, scenario.frontmatter, "success", scenario.streamingBehavior);
		expect(run.result).toStrictEqual({ action: "handled" });
		expect(run.modelCalls).toHaveLength(0);
		expect(run.thinkingCalls).toHaveLength(0);
		expect(run.notifications.map((item) => item.level)).toContain("warning");
		expect(modelSelectionEntries(run.pi)).toStrictEqual([]);
	}
}));

testWithDir("embedded-slash prompt and skill tokens do not apply model-selection frontmatter", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const cases = [
		{ text: "/review/typo", command: "prompt" as const, frontmatter: { model: "openai/gpt-4o", thinking: "high" } },
		{ text: "/skill:review/typo", command: "skill" as const, frontmatter: { "model-group": "reviewer", thinking: "high" } },
	];
	for (const scenario of cases) {
		const filePath = await writeSkillMd(skillDir, `${scenario.command}-review`, scenario.frontmatter);
		const pi = await makeMockPI();
		const modelCalls: Model<Api>[] = [];
		const thinkingCalls: string[] = [];
		pi.setModel = async (model: Model<Api>) => { modelCalls.push(model); return true; };
		pi.setThinkingLevel = (thinking: string) => thinkingCalls.push(thinking);
		const inputHandler = getHandler(pi, "input");
		const sessionStartHandler = lastSessionStartHandler(pi);
		const { ctx } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});
		const name = `${scenario.command}-review`;
		pi.setCommands([scenario.command === "prompt" ? makePromptCommand(name, filePath) : makeSkillCommand(name, filePath)]);
		await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);

		const result = await inputHandler({ type: "input", text: scenario.text.replace("review", name), source: "interactive" }, ctx);
		expect(result).toStrictEqual({ action: "continue" });
		expect(modelCalls).toStrictEqual([]);
		expect(thinkingCalls).toStrictEqual([]);
		expect(modelSelectionEntries(pi)).toStrictEqual([]);
	}
}));

test("setModel failures block explicit and group selection without success entries", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const cases = [
		{ frontmatter: { model: "openai/gpt-4o" }, behavior: "false" as const },
		{ frontmatter: { model: "openai/gpt-4o" }, behavior: "reject" as const },
		{ frontmatter: { "model-group": "reviewer" }, behavior: "false" as const },
		{ frontmatter: { "model-group": "reviewer" }, behavior: "reject" as const },
	];
	for (const scenario of cases) {
		const run = await runPromptInput(cwd, scenario.frontmatter, scenario.behavior);
		expect(run.result).toStrictEqual({ action: "handled" });
		expect(run.notifications.find((item) => item.level === "error")?.message ?? "").toMatch(/failed to switch/);
		expect(modelSelectionEntries(run.pi)).toStrictEqual([]);
	}
}));

testWithDir("model-group commands are applied during their input preflight", async ({ dir: skillDir }) => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, {
		reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] },
		fast: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] },
	});
	const fp1 = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
	const fp2 = await writeSkillMd(skillDir, "quick", { "model-group": "fast" });
	const pi = await createTestHost();
	const setModelCalls: Model<Api>[] = [];
	pi.setModel = async (model: Model<Api>) => { setModelCalls.push(model); return true; };

	const inputHandler = getHandler(pi, "input");
	const sessionStartHandler = lastSessionStartHandler(pi);
	const { ctx } = makeNotifyCtx({
		cwd,
		model: mockModel("openai", "gpt-parent"),
		modelRegistry: mockRegistry([
			mockModel("openai", "gpt-4o"),
			mockModel("anthropic", "claude-sonnet"),
		]),
	});

	pi.setCommands([makePromptCommand("review", fp1), makePromptCommand("quick", fp2)]);
	await sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
	const reviewResult = await inputHandler({ type: "input", text: "/review", source: "interactive" }, ctx);
	const quickResult = await inputHandler({ type: "input", text: "/quick", source: "interactive" }, ctx);

	expect(reviewResult).toStrictEqual({ action: "continue" });
	expect(quickResult).toStrictEqual({ action: "continue" });
	expect(setModelCalls, "each command is selected before its agent turn").toHaveLength(2);
	expect(setModelCalls[0].id).toBe("gpt-4o");
	expect(setModelCalls[1].id).toBe("claude-sonnet");
}));
