/**
 * Model-group frontmatter integration tests.
 *
 * Exercises the full pipeline:
 *   input preflight → model selection → optional before_agent_start readonly handling
 */

import { expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { __setModelGroupsFsForTests, modelGroupsPath } from "../../model-groups/store.js";
import { makeReadonlyUICtx, tmpDir, theme } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost } from "./test-host.js";
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

		expect(setModelCalls.length, "setModel should be called once").toBe(1);
		expect(setModelCalls[0].provider).toBe("openai");
		expect(setModelCalls[0].id).toBe("gpt-4o");
		expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model changed.*reviewer.*\/review/));

		const groupEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-model-group-switch");
		expect(groupEntries.length, "should append one model-group-switch entry").toBe(1);
		expect(groupEntries[0].data.command).toBe("/review");
		expect(groupEntries[0].data.groupName).toBe("reviewer");
		expect(groupEntries[0].data.provider).toBe("openai");
		expect(groupEntries[0].data.modelId).toBe("gpt-4o");
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

		expect(setThinkingCalls, "group thinking is clamped for the routed model").toStrictEqual(["medium"]);
		const entry = pi.appendedEntries.find((e: any) => e.customType === "pi-schematic-model-group-switch");
		expect(entry?.data.thinking, "entry records effective thinking").toBe("medium");
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

		expect(setModelCalls).toHaveLength(1);
		expect(setModelCalls[0].provider).toBe("anthropic");
		expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model changed.*fast.*\/skill:quick/));
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

		expect(result, "selection failure must prevent command expansion and agent start").toStrictEqual({ action: "handled" });
		expect(setModelCalls.length, "setModel should not be called").toBe(0);
		const error = notifications.find((notification) => notification.level === "error")?.message ?? "";
		expect(error).toMatch(/nonexistent/);
		expect(error).toMatch(/\/skill:quick/);
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

		expect(result, "selection failure must prevent command expansion and agent start").toStrictEqual({ action: "handled" });
		expect(setModelCalls.length, "setModel should not be called").toBe(0);
		const error = notifications.find((n) => n.level === "error")?.message ?? "";
		expect(error).toMatch(/nonexistent/);
		expect(error).toMatch(/not defined/);
		expect(error).toMatch(/reviewer/);
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

		expect(result).toStrictEqual({ action: "handled" });
		expect(setModelCalls).toHaveLength(0);
		expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/empty/);
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

		expect(setModelCalls.length, "setModel should not be called in headless").toBe(0);
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

		expect(setModelCalls.length, "setModel should not be called when no model-group frontmatter").toBe(0);
		expect(notifications.map((n) => n.message)).not.toContainEqual(expect.stringMatching(/Model changed/));
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

		expect(setModelCalls.length, "setModel should not be called for invalid model-group").toBe(0);
		expect(notifications.map((n) => n.message), "should warn about invalid model-group").toContainEqual(expect.stringMatching(/model-group.*non-empty/));
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

function modelSelectionEntries(pi: any): any[] {
	const types = new Set([
		"pi-schematic-model-switch",
		"pi-schematic-model-group-switch",
		"pi-schematic-thinking-change",
	]);
	return pi.appendedEntries.filter((entry: any) => types.has(entry.customType));
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

		expect(setModelCalls.length, "setModel should be called once").toBe(1);
		expect(setModelCalls[0].provider).toBe("openai");
		expect(setModelCalls[0].id).toBe("gpt-4o");
		expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model switched.*openai.*gpt-4o.*\/review/));

		const switchEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-model-switch");
		expect(switchEntries.length, "should append one model-switch entry").toBe(1);
		expect(switchEntries[0].data.command).toBe("/review");
		expect(switchEntries[0].data.provider).toBe("openai");
		expect(switchEntries[0].data.modelId).toBe("gpt-4o");
		expect(switchEntries[0].data.thinking).toBeNull();
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

		expect(setModelCalls.length, "setModel should be called once").toBe(1);
		expect(setModelCalls[0].id).toBe("gpt-4o");
		expect(setThinkingCalls.length, "setThinkingLevel should be called once").toBe(1);
		expect(setThinkingCalls[0]).toBe("high");
		expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Model switched.*openai.*gpt-4o/));
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

		expect(setModelCalls.length, "setModel should be called").toBe(1);
		expect(setModelCalls[0].id).toBe("gpt-4o");
		expect(setThinkingCalls.length, "setThinkingLevel should NOT be called").toBe(0);
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

		expect(setModelCalls.length, "valid model should still be applied").toBe(1);
		expect(setThinkingCalls.length, "invalid thinking must not be applied").toBe(0);
		const warnings = notifications.filter((n) => n.level === "warning");
		expect(warnings.length, "invalid thinking should produce one warning").toBe(1);
		expect(warnings[0]?.message ?? "").toMatch(/\`thinking\`/);
		const issues = pi.appendedEntries.filter((entry: any) => entry.customType === "pi-schematic-frontmatter-issue");
		expect(issues.length, "invalid thinking should produce one issue entry").toBe(1);
		expect(issues[0]?.data.type).toBe("command");
		expect(issues[0]?.data.issue.kind).toBe("invalid-thinking-value");
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

		expect(result).toStrictEqual({ action: "continue" });
		expect(setModelCalls.map((model) => model.id)).toStrictEqual(["gpt-4o"]);
		const warnings = notifications.filter((notification) => notification.level === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message ?? "").toMatch(/`model-group`/);
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

		expect(setModelCalls.length, "setModel should be called once").toBe(1);
		expect(setModelCalls[0].id, "explicit model should win over model-group").toBe("gpt-4o");
		expect(notifications.map((n) => n.message), "should warn about override").toContainEqual(expect.stringMatching(/reviewer.*overridden/));
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

		expect(setModelCalls.length, "setModel should be called once").toBe(1);
		expect(setModelCalls[0].id, "explicit model should win").toBe("gpt-4o");
		expect(setThinkingCalls.length, "setThinkingLevel should be called").toBe(1);
		expect(setThinkingCalls[0], "thinking from frontmatter should be applied").toBe("high");
		expect(notifications.map((n) => n.message), "should warn about group override").toContainEqual(expect.stringMatching(/reviewer.*overridden/));
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

		expect(setModelCalls.length, "setModel should be called once").toBe(1);
		expect(setModelCalls[0].id, "model should come from group").toBe("gpt-4o");
		expect(setThinkingCalls.length, "setThinkingLevel should be called once").toBe(1);
		expect(setThinkingCalls[0], "thinking should come from frontmatter, not group").toBe("low");
		expect(notifications.map((n) => n.message), "should notify about group change").toContainEqual(expect.stringMatching(/Model changed.*reviewer.*\/review/));
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

		expect(setModelCalls.length, "setModel should NOT be called").toBe(0);
		expect(setThinkingCalls.length, "setThinkingLevel should be called").toBe(1);
		expect(setThinkingCalls[0]).toBe("high");
		expect(notifications.map((n) => n.message)).toContainEqual(expect.stringMatching(/Thinking level set.*high.*\/review/));

		const thinkingEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-thinking-change");
		expect(thinkingEntries.length, "should append one thinking-change entry").toBe(1);
		expect(thinkingEntries[0].data.command).toBe("/review");
		expect(thinkingEntries[0].data.thinking).toBe("high");
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

		expect(result).toStrictEqual({ action: "handled" });
		expect(setModelCalls.length, "setModel should not be called").toBe(0);
		expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/unknown\/no-such-model.*not found/);
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

		expect(result).toStrictEqual({ action: "handled" });
		expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/failed to switch/);
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

		expect(result).toStrictEqual({ action: "handled" });
		expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/no API key/);
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

		expect(setModelCalls.length, "setModel should not be called for invalid model format").toBe(0);
		expect(notifications.map((n) => n.message), "should warn about invalid model format").toContainEqual(expect.stringMatching(/`model`.*`<provider>\/<model-id>`/));
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

		expect(setThinkingCalls.length, "setThinkingLevel should NOT be called for invalid thinking").toBe(0);
		expect(notifications.map((n) => n.message), "should warn about invalid thinking").toContainEqual(expect.stringMatching(/`thinking`.*off, minimal, low/));
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

		expect(setModelCalls.length, "setModel should not be called in headless").toBe(0);
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
		await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

		expect(setModelCalls.length, "model should be switched").toBe(1);
		const readonlyEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-readonly");
		expect(readonlyEntries.length, "readonly state should not be affected").toBe(0);
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
		expect(run.result).toStrictEqual({ action: "handled" });
		expect(run.modelCalls).toHaveLength(0);
		expect(run.thinkingCalls).toHaveLength(0);
		expect(run.notifications.map((item) => item.level)).toContain("warning");
		expect(modelSelectionEntries(run.pi)).toStrictEqual([]);
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
			expect(result).toStrictEqual({ action: "continue" });
			expect(modelCalls).toStrictEqual([]);
			expect(thinkingCalls).toStrictEqual([]);
			expect(modelSelectionEntries(pi)).toStrictEqual([]);
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
		expect(run.result).toStrictEqual({ action: "handled" });
		expect(run.notifications.find((item) => item.level === "error")?.message ?? "").toMatch(/failed to switch/);
		expect(modelSelectionEntries(run.pi)).toStrictEqual([]);
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

		expect(reviewResult).toStrictEqual({ action: "continue" });
		expect(quickResult).toStrictEqual({ action: "continue" });
		expect(setModelCalls.length, "each command is selected before its agent turn").toBe(2);
		expect(setModelCalls[0].id).toBe("gpt-4o");
		expect(setModelCalls[1].id).toBe("claude-sonnet");
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}));
