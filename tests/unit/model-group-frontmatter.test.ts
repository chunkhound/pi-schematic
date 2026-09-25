/**
 * Model-group frontmatter integration tests.
 *
 * Exercises the full pipeline:
 *   input preflight → model selection → optional before_agent_start readonly handling
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { __setModelGroupsFsForTests, modelGroupsPath } from "../../model-groups/store.js";
import { makeReadonlyUICtx, tmpDir, theme } from "./helpers.js";
import { createTestHost } from "./test-host.js";
import { withTemp } from "./model-groups-helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────

function mockModel(provider: string, id: string): any {
	return { provider, id, reasoning: true };
}

function mockRegistry(
	models: any[] = [mockModel("openai", "gpt-4o")],
	authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`)),
): any {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: any) => authenticated.has(`${m.provider}:${m.id}`),
	};
}

function writeModelGroupsConfig(dir: string, groups: Record<string, { models: Array<{ provider: string; modelId: string; thinkingLevel?: string }> }>): void {
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

function makeNotifyCtx(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		...makeReadonlyUICtx({
			ui: {
				notify: (message: string, level: string) => { notifications.push({ message, level }); },
				theme,
				setStatus: () => {},
				setWidget: () => {},
			},
		}),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		...overrides,
	};
	return { ctx, notifications };
}

function makePromptCommand(name: string, filePath: string) {
	return {
		name,
		source: "prompt",
		description: "Test prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	};
}

function makeSkill(name: string, filePath: string) {
	return {
		name,
		description: "Test skill",
		filePath,
		baseDir: "",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
		disableModelInvocation: false,
	};
}

function makeSkillCommand(name: string, filePath: string) {
	return { ...makePromptCommand(`skill:${name}`, filePath), source: "skill" };
}

// ── Tests ─────────────────────────────────────────────────────────────

test("model-group frontmatter triggers model switch for /name command", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called once");
		assert.equal(setModelCalls[0].provider, "openai");
		assert.equal(setModelCalls[0].id, "gpt-4o");
		assert.ok(notifications.some((n) => /Model changed.*reviewer.*\/review/.test(n.message)));

		const groupEntries = pi.appendedEntries.filter((e: any) => e.customType === "agenticoding-model-group-switch");
		assert.equal(groupEntries.length, 1, "should append one model-group-switch entry");
		assert.equal(groupEntries[0].data.command, "/review");
		assert.equal(groupEntries[0].data.groupName, "reviewer");
		assert.equal(groupEntries[0].data.provider, "openai");
		assert.equal(groupEntries[0].data.modelId, "gpt-4o");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("model-group-only frontmatter applies and records the group's effective thinking", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, {
		reviewer: { models: [{ provider: "openai", modelId: "gpt-4o", thinkingLevel: "high" }] },
	});
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
		const pi = await makeMockPI();
		const setThinkingCalls: string[] = [];
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const routedModel = mockModelWithThinking("openai", "gpt-4o", {
			off: null, minimal: "minimal", low: "low", medium: "medium", high: null,
		});
		const { ctx } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry([routedModel]),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(setThinkingCalls, ["medium"], "group thinking is clamped for the routed model");
		const entry = pi.appendedEntries.find((e: any) => e.customType === "agenticoding-model-group-switch");
		assert.equal(entry?.data.thinking, "medium", "entry records effective thinking");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("model-group frontmatter triggers model switch for /skill:name command", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { fast: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "quick", { "model-group": "fast" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry([mockModel("anthropic", "claude-sonnet")]),
		});

		pi.setCommands([makeSkillCommand("quick", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/skill:quick", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1);
		assert.equal(setModelCalls[0].provider, "anthropic");
		assert.ok(notifications.some((n) => /Model changed.*fast.*\/skill:quick/.test(n.message)));
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("unknown model-group in /skill:name frontmatter blocks execution before agent start", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "quick", { "model-group": "nonexistent" });
		const pi = await createTestHost();
		const setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makeSkillCommand("quick", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const result = await inputHandler({ text: "/skill:quick", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" }, "selection failure must prevent command expansion and agent start");
		assert.equal(setModelCalls.length, 0, "setModel should not be called");
		const error = notifications.find((notification) => notification.level === "error")?.message ?? "";
		assert.match(error, /nonexistent/);
		assert.match(error, /\/skill:quick/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("unknown model-group in frontmatter blocks execution with error", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "nonexistent" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const result = await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" }, "selection failure must prevent command expansion and agent start");
		assert.equal(setModelCalls.length, 0, "setModel should not be called");
		const error = notifications.find((n) => n.level === "error")?.message ?? "";
		assert.match(error, /nonexistent/);
		assert.match(error, /not defined/);
		assert.match(error, /reviewer/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("empty model-group (SpawnRouteError) blocks execution with error", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { empty: { models: [] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "empty" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const result = await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(setModelCalls.length, 0);
		assert.match(notifications.find((n) => n.level === "error")?.message ?? "", /empty/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("headless session does not inherit model-group changes", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;

		pi.setCommands([makePromptCommand("review", filePath)]);
		await inputHandler({ text: "/review", source: "interactive" }, { hasUI: false } as any);

		assert.equal(setModelCalls.length, 0, "setModel should not be called in headless");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("no model-group frontmatter is a silent no-op", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { readonly: true });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 0, "setModel should not be called when no model-group frontmatter");
		assert.ok(!notifications.some((n) => /Model changed/.test(n.message)));
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("invalid model-group value produces warning notification", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 0, "setModel should not be called for invalid model-group");
		assert.ok(notifications.some((n) => /model-group.*non-empty/.test(n.message)), "should warn about invalid model-group");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

function mockModelWithThinking(provider: string, id: string, thinkingLevelMap?: Record<string, string | null>): any {
	return { provider, id, reasoning: true, thinkingLevelMap };
}

async function makeMockPI() {
	const pi = await createTestHost();
	pi.setModel = async (_model: any) => true;
	pi.setThinkingLevel = (_level: any) => {};
	pi.getThinkingLevel = () => "medium";
	return pi;
}

type SetModelBehavior = "success" | "false" | "reject";

async function makeTrackedPI(behavior: SetModelBehavior) {
	const pi = await makeMockPI();
	const modelCalls: any[] = [];
	const thinkingCalls: string[] = [];
	pi.setModel = async (model: any) => {
		modelCalls.push(model);
		if (behavior === "reject") throw new Error("setModel rejected");
		return behavior !== "false";
	};
	pi.setThinkingLevel = (level: string) => thinkingCalls.push(level);
	return { pi, modelCalls, thinkingCalls };
}

async function executePromptInput(pi: any, ctx: any, streamingBehavior?: "steer" | "followUp") {
	await pi.handlers.get("session_start")!.at(-1)!({ reason: "load" }, ctx);
	const input = pi.handlers.get("input")![0];
	return input({ text: "/review", source: "interactive", streamingBehavior }, ctx);
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

function hasModelSelectionEntry(pi: any): boolean {
	const types = new Set([
		"agenticoding-model-switch",
		"agenticoding-model-group-switch",
		"agenticoding-thinking-change",
	]);
	return pi.appendedEntries.some((entry: any) => types.has(entry.customType));
}

// ── Explicit model frontmatter tests ──────────────────────────────

test("explicit model frontmatter switches model", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called once");
		assert.equal(setModelCalls[0].provider, "openai");
		assert.equal(setModelCalls[0].id, "gpt-4o");
		assert.ok(notifications.some((n) => /Model switched.*openai.*gpt-4o.*\/review/.test(n.message)));

		const switchEntries = pi.appendedEntries.filter((e: any) => e.customType === "agenticoding-model-switch");
		assert.equal(switchEntries.length, 1, "should append one model-switch entry");
		assert.equal(switchEntries[0].data.command, "/review");
		assert.equal(switchEntries[0].data.provider, "openai");
		assert.equal(switchEntries[0].data.modelId, "gpt-4o");
		assert.equal(switchEntries[0].data.thinking, null);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("explicit model with thinking sets both model and thinking level", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "high" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		let setThinkingCalls: string[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		pi.getThinkingLevel = () => "medium";
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry([mockModelWithThinking("openai", "gpt-4o", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" })]),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called once");
		assert.equal(setModelCalls[0].id, "gpt-4o");
		assert.equal(setThinkingCalls.length, 1, "setThinkingLevel should be called once");
		assert.equal(setThinkingCalls[0], "high");
		assert.ok(notifications.some((n) => /Model switched.*openai.*gpt-4o/.test(n.message)));
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("explicit model without thinking does not change thinking level", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		let setThinkingCalls: string[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		pi.getThinkingLevel = () => "medium";
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called");
		assert.equal(setModelCalls[0].id, "gpt-4o");
		assert.equal(setThinkingCalls.length, 0, "setThinkingLevel should NOT be called");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("explicit model applies while invalid thinking is reported", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "ultra" });
		const pi = await makeMockPI();
		const setModelCalls: any[] = [];
		const setThinkingCalls: string[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "valid model should still be applied");
		assert.equal(setThinkingCalls.length, 0, "invalid thinking must not be applied");
		const warnings = notifications.filter((n) => n.level === "warning");
		assert.equal(warnings.length, 1, "invalid thinking should produce one warning");
		assert.match(warnings[0]?.message ?? "", /\`thinking\`/);
		const issues = pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-frontmatter-issue");
		assert.equal(issues.length, 1, "invalid thinking should produce one issue entry");
		assert.equal(issues[0]?.data.type, "command");
		assert.equal(issues[0]?.data.issue.kind, "invalid-thinking-value");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("valid model applies when model-group frontmatter is invalid", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "" });
		const pi = await makeMockPI();
		const setModelCalls: any[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		const [inputHandler] = pi.handlers.get("input")!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		const result = await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "continue" });
		assert.deepEqual(setModelCalls.map((model) => model.id), ["gpt-4o"]);
		const warnings = notifications.filter((notification) => notification.level === "warning");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]?.message ?? "", /`model-group`/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("explicit model + model-group warns and uses explicit model", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "reviewer" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called once");
		assert.equal(setModelCalls[0].id, "gpt-4o", "explicit model should win over model-group");
		assert.ok(notifications.some((n) => /reviewer.*overridden/.test(n.message)), "should warn about override");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("explicit model + model-group + thinking uses explicit model and thinking, warns about override", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "reviewer", thinking: "high" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		let setThinkingCalls: string[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		pi.getThinkingLevel = () => "medium";
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry([mockModelWithThinking("openai", "gpt-4o", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" })]),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called once");
		assert.equal(setModelCalls[0].id, "gpt-4o", "explicit model should win");
		assert.equal(setThinkingCalls.length, 1, "setThinkingLevel should be called");
		assert.equal(setThinkingCalls[0], "high", "thinking from frontmatter should be applied");
		assert.ok(notifications.some((n) => /reviewer.*overridden/.test(n.message)), "should warn about group override");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("model-group + thinking overrides group thinking level", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer", thinking: "low" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		let setThinkingCalls: string[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		pi.getThinkingLevel = () => "medium";
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry([mockModelWithThinking("openai", "gpt-4o", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" })]),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 1, "setModel should be called once");
		assert.equal(setModelCalls[0].id, "gpt-4o", "model should come from group");
		assert.equal(setThinkingCalls.length, 1, "setThinkingLevel should be called once");
		assert.equal(setThinkingCalls[0], "low", "thinking should come from frontmatter, not group");
		assert.ok(notifications.some((n) => /Model changed.*reviewer.*\/review/.test(n.message)), "should notify about group change");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("thinking only frontmatter sets thinking level without changing model", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { thinking: "high" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		let setThinkingCalls: string[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		pi.getThinkingLevel = () => "medium";
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const currentModel = mockModelWithThinking("openai", "gpt-parent", { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" });
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: currentModel,
			modelRegistry: mockRegistry([currentModel]),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 0, "setModel should NOT be called");
		assert.equal(setThinkingCalls.length, 1, "setThinkingLevel should be called");
		assert.equal(setThinkingCalls[0], "high");
		assert.ok(notifications.some((n) => /Thinking level set.*high.*\/review/.test(n.message)));

		const thinkingEntries = pi.appendedEntries.filter((e: any) => e.customType === "agenticoding-thinking-change");
		assert.equal(thinkingEntries.length, 1, "should append one thinking-change entry");
		assert.equal(thinkingEntries[0].data.command, "/review");
		assert.equal(thinkingEntries[0].data.thinking, "high");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("unknown model in frontmatter blocks execution", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "unknown/no-such-model" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const result = await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.equal(setModelCalls.length, 0, "setModel should not be called");
		assert.match(notifications.find((n) => n.level === "error")?.message ?? "", /unknown\/no-such-model.*not found/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("model switch failure blocks explicit model selection", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
		const pi = await makeMockPI();
		pi.setModel = async () => false as any; // Simulate setModel failure
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const result = await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.match(notifications.find((n) => n.level === "error")?.message ?? "", /failed to switch/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("unauthenticated model in registry blocks explicit model selection", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
		const pi = await makeMockPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			// Model exists in registry but has no configured auth
			modelRegistry: mockRegistry([mockModel("openai", "gpt-4o")], new Set()),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const result = await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.deepEqual(result, { action: "handled" });
		assert.match(notifications.find((n) => n.level === "error")?.message ?? "", /no API key/);
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("invalid model format in frontmatter produces warning", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "not-valid-format" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setModelCalls.length, 0, "setModel should not be called for invalid model format");
		assert.ok(notifications.some((n) => /`model`.*`<provider>\/<model-id>`/.test(n.message)), "should warn about invalid model format");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("invalid thinking value produces warning", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { thinking: "ultra" });
		const pi = await makeMockPI();
		let setThinkingCalls: string[] = [];
		pi.setThinkingLevel = (level: string) => { setThinkingCalls.push(level); };
		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);

		assert.equal(setThinkingCalls.length, 0, "setThinkingLevel should NOT be called for invalid thinking");
		assert.ok(notifications.some((n) => /`thinking`.*off, minimal, low/.test(n.message)), "should warn about invalid thinking");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));

test("explicit model frontmatter is ignored in headless session", async () => withTemp(async ({ cwd }) => {
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
		const pi = await makeMockPI();
		let setModelCalls: any[] = [];
		pi.setModel = async (model: any) => { setModelCalls.push(model); return true; };
		const [inputHandler] = pi.handlers.get("input")!;

		pi.setCommands([makePromptCommand("review", filePath)]);
		await inputHandler({ text: "/review", source: "interactive" }, { hasUI: false } as any);

		assert.equal(setModelCalls.length, 0, "setModel should not be called in headless");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));


test("model-group toggle does not affect readonly state", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});

		pi.setCommands([makePromptCommand("review", filePath)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(setModelCalls.length, 1, "model should be switched");
		const readonlyEntries = pi.appendedEntries.filter((e: any) => e.customType === "agenticoding-readonly");
		assert.equal(readonlyEntries.length, 0, "readonly state should not be affected");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
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
		assert.deepEqual(run.result, { action: "handled" });
		assert.equal(run.modelCalls.length, 0);
		assert.equal(run.thinkingCalls.length, 0);
		assert.ok(run.notifications.some((item) => item.level === "warning"));
		assert.equal(hasModelSelectionEntry(run.pi), false);
	}
}));

test("embedded-slash prompt and skill tokens do not apply model-selection frontmatter", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
	const skillDir = await tmpDir();
	try {
		const cases = [
			{ text: "/review/typo", command: "prompt" as const, frontmatter: { model: "openai/gpt-4o", thinking: "high" } },
			{ text: "/skill:review/typo", command: "skill" as const, frontmatter: { "model-group": "reviewer", thinking: "high" } },
		];
		for (const scenario of cases) {
			const filePath = await writeSkillMd(skillDir, `${scenario.command}-review`, scenario.frontmatter);
			const pi = await makeMockPI();
			const modelCalls: any[] = [];
			const thinkingCalls: string[] = [];
			pi.setModel = async (model: any) => { modelCalls.push(model); return true; };
			pi.setThinkingLevel = (thinking: string) => thinkingCalls.push(thinking);
			const [inputHandler] = pi.handlers.get("input")!;
			const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
			const { ctx } = makeNotifyCtx({
				cwd,
				model: mockModel("openai", "gpt-parent"),
				modelRegistry: mockRegistry(),
			});
			const name = `${scenario.command}-review`;
			pi.setCommands([scenario.command === "prompt" ? makePromptCommand(name, filePath) : makeSkillCommand(name, filePath)]);
			await sessionStartHandler({ reason: "load" }, ctx);

			const result = await inputHandler({ text: scenario.text.replace("review", name), source: "interactive" }, ctx);
			assert.deepEqual(result, { action: "continue" });
			assert.deepEqual(modelCalls, []);
			assert.deepEqual(thinkingCalls, []);
			assert.equal(hasModelSelectionEntry(pi), false);
		}
	} finally {
		await rm(skillDir, { recursive: true, force: true });
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
		assert.deepEqual(run.result, { action: "handled" });
		assert.match(run.notifications.find((item) => item.level === "error")?.message ?? "", /failed to switch/);
		assert.equal(hasModelSelectionEntry(run.pi), false);
	}
}));

test("model-group commands are applied during their input preflight", async () => withTemp(async ({ cwd }) => {
	writeModelGroupsConfig(cwd, {
		reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] },
		fast: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] },
	});
	const skillDir = await tmpDir();
	try {
		const fp1 = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
		const fp2 = await writeSkillMd(skillDir, "quick", { "model-group": "fast" });
		const pi = await createTestHost();
		let setModelCalls: any[] = [];
		(pi as any).setModel = async (model: any) => { setModelCalls.push(model); return true; };

		const [inputHandler] = pi.handlers.get("input")!;
		const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
		const { ctx } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry([
				mockModel("openai", "gpt-4o"),
				mockModel("anthropic", "claude-sonnet"),
			]),
		});

		pi.setCommands([makePromptCommand("review", fp1), makePromptCommand("quick", fp2)]);
		await sessionStartHandler({ reason: "load" }, ctx);
		const reviewResult = await inputHandler({ text: "/review", source: "interactive" }, ctx);
		const quickResult = await inputHandler({ text: "/quick", source: "interactive" }, ctx);

		assert.deepEqual(reviewResult, { action: "continue" });
		assert.deepEqual(quickResult, { action: "continue" });
		assert.equal(setModelCalls.length, 2, "each command is selected before its agent turn");
		assert.equal(setModelCalls[0].id, "gpt-4o");
		assert.equal(setModelCalls[1].id, "claude-sonnet");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));
