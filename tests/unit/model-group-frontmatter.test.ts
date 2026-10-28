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
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { __setModelGroupsFsForTests, modelGroupsPath } from "../../model-groups/store.js";
import { makeReadonlyUICtx, tmpDir, theme } from "./helpers.js";
import { createBeforeAgentStartEvent, createTestHost, type AppendedEntry } from "./test-host.js";
import { takeWorkflowRuntime } from "../../workflow/coordinator.js";
import { withTemp } from "./model-groups-helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────

function mockModel(provider: string, id: string): any {
	return { provider, id, reasoning: true };
}

function mockRegistry(models: any[] = [mockModel("openai", "gpt-4o")], authenticated = new Set(models.map((m) => `${m.provider}:${m.id}`))): any {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: any) => authenticated.has(`${m.provider}:${m.id}`),
	};
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

function makeNotifyCtx(overrides: Record<string, unknown> = {}) {
	const notifications: { message: string; level: string }[] = [];
	const ctx = {
		...makeReadonlyUICtx({
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
				theme,
				setStatus: () => {},
				setWidget: () => {},
				addAutocompleteProvider: () => {},
			},
		}),
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		...overrides,
	};
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

function makeSkillCommand(name: string, filePath: string): SlashCommandInfo {
	return { ...makePromptCommand(`skill:${name}`, filePath), source: "skill" };
}

/** Data of an appended entry, typed for compact access. */
function entryData(entry: AppendedEntry | undefined): Record<string, unknown> {
	if (entry === undefined) {
		throw new Error("No appended entry.");
	}
	return entry.data as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────

test("model-group frontmatter triggers model switch for /name command", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(setModelCalls.length).toBe(1); // "setModel should be called once";
			expect(setModelCalls[0].provider).toBe("openai");
			expect(setModelCalls[0].id).toBe("gpt-4o");
			expect(notifications.some((n) => /Model changed.*reviewer.*\/review/.test(n.message))).toBe(true);

			const groupEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-model-group-switch");
			expect(groupEntries.length).toBe(1); // "should append one model-group-switch entry";
			expect(entryData(groupEntries[0]).command).toBe("/review");
			expect(entryData(groupEntries[0]).groupName).toBe("reviewer");
			expect(entryData(groupEntries[0]).provider).toBe("openai");
			expect(entryData(groupEntries[0]).modelId).toBe("gpt-4o");
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("model-group-only frontmatter applies and records the group's effective thinking", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, {
			reviewer: { models: [{ provider: "openai", modelId: "gpt-4o", thinkingLevel: "high" }] },
		});
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
			const pi = await makeMockPI();
			const setThinkingCalls: string[] = [];
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
			const [inputHandler] = pi.handlers.get("input")!;
			const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
			const routedModel = mockModelWithThinking("openai", "gpt-4o", {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: null,
			});
			const { ctx } = makeNotifyCtx({
				cwd,
				model: mockModel("openai", "gpt-parent"),
				modelRegistry: mockRegistry([routedModel]),
			});

			pi.setCommands([makePromptCommand("review", filePath)]);
			await sessionStartHandler({ reason: "load" }, ctx);
			await inputHandler({ text: "/review", source: "interactive" }, ctx);

			expect(setThinkingCalls).toStrictEqual(["medium"]); // "group thinking is clamped for the routed model";
			const entry = pi.appendedEntries.find((e: any) => e.customType === "pi-schematic-model-group-switch");
			expect(entry ? entryData(entry).thinking : undefined).toBe("medium"); // "entry records effective thinking";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("model-group frontmatter triggers model switch for /skill:name command", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { fast: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "quick", { "model-group": "fast" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(setModelCalls.length).toBe(1);
			expect(setModelCalls[0].provider).toBe("anthropic");
			expect(notifications.some((n) => /Model changed.*fast.*\/skill:quick/.test(n.message))).toBe(true);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("unknown model-group in /skill:name frontmatter blocks execution before agent start", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "quick", { "model-group": "nonexistent" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(result).toStrictEqual({ action: "handled" }); // "selection failure must prevent command expansion and agent start";
			expect(setModelCalls.length).toBe(0); // "setModel should not be called";
			const error = notifications.find((notification) => notification.level === "error")?.message ?? "";
			expect(error).toMatch(/nonexistent/);
			expect(error).toMatch(/\/skill:quick/);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("unknown model-group in frontmatter blocks execution with error", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "nonexistent" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(result).toStrictEqual({ action: "handled" }); // "selection failure must prevent command expansion and agent start";
			expect(setModelCalls.length).toBe(0); // "setModel should not be called";
			const error = notifications.find((n) => n.level === "error")?.message ?? "";
			expect(error).toMatch(/nonexistent/);
			expect(error).toMatch(/not defined/);
			expect(error).toMatch(/reviewer/);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("empty model-group (SpawnRouteError) blocks execution with error", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { empty: { models: [] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "empty" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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
			expect(setModelCalls.length).toBe(0);
			expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/empty/);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("headless session does not inherit model-group changes", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

			const [inputHandler] = pi.handlers.get("input")!;

			pi.setCommands([makePromptCommand("review", filePath)]);
			await inputHandler({ text: "/review", source: "interactive" }, { hasUI: false });

			expect(setModelCalls.length).toBe(0); // "setModel should not be called in headless";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("no model-group frontmatter is a silent no-op", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { readonly: true });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(setModelCalls.length).toBe(0); // "setModel should not be called when no model-group frontmatter";
			expect(!notifications.some((n) => n.message.includes("Model changed"))).toBe(true);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("invalid model-group value produces warning notification", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(setModelCalls.length).toBe(0); // "setModel should not be called for invalid model-group";
			expect(notifications.some((n) => /model-group.*non-empty/.test(n.message))).toBe(true); // "should warn about invalid model-group";
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
		if (behavior === "reject") {
			throw new Error("setModel rejected");
		}
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

async function runPromptInput(cwd: string, frontmatter: Record<string, unknown>, behavior: SetModelBehavior, streamingBehavior?: "steer" | "followUp") {
	const dir = await tmpDir();
	try {
		const filePath = await writeSkillMd(dir, "review", frontmatter);
		const tracked = await makeTrackedPI(behavior);
		const { ctx, notifications } = makeNotifyCtx({
			cwd,
			model: mockModel("openai", "gpt-parent"),
			modelRegistry: mockRegistry(),
		});
		tracked.pi.setCommands([makePromptCommand("review", filePath)]);
		const result = await executePromptInput(tracked.pi, ctx, streamingBehavior);
		return { ...tracked, notifications, result };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function hasModelSelectionEntry(pi: any): boolean {
	const types = new Set(["pi-schematic-model-switch", "pi-schematic-model-group-switch", "pi-schematic-thinking-change"]);
	return pi.appendedEntries.some((entry: any) => types.has(entry.customType));
}

// ── Explicit model frontmatter tests ──────────────────────────────

test("explicit model frontmatter switches model", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
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

			expect(setModelCalls.length).toBe(1); // "setModel should be called once";
			expect(setModelCalls[0].provider).toBe("openai");
			expect(setModelCalls[0].id).toBe("gpt-4o");
			expect(notifications.some((n) => /Model switched.*openai.*gpt-4o.*\/review/.test(n.message))).toBe(true);

			const switchEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-model-switch");
			expect(switchEntries.length).toBe(1); // "should append one model-switch entry";
			expect(entryData(switchEntries[0]).command).toBe("/review");
			expect(entryData(switchEntries[0]).provider).toBe("openai");
			expect(entryData(switchEntries[0]).modelId).toBe("gpt-4o");
			expect(entryData(switchEntries[0]).thinking).toBeNull();
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("explicit model with thinking sets both model and thinking level", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "high" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			const setThinkingCalls: string[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setModelCalls.length).toBe(1); // "setModel should be called once";
			expect(setModelCalls[0].id).toBe("gpt-4o");
			expect(setThinkingCalls.length).toBe(1); // "setThinkingLevel should be called once";
			expect(setThinkingCalls[0]).toBe("high");
			expect(notifications.some((n) => /Model switched.*openai.*gpt-4o/.test(n.message))).toBe(true);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("explicit model without thinking does not change thinking level", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			const setThinkingCalls: string[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setModelCalls.length).toBe(1); // "setModel should be called";
			expect(setModelCalls[0].id).toBe("gpt-4o");
			expect(setThinkingCalls.length).toBe(0); // "setThinkingLevel should NOT be called";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("explicit model applies while invalid thinking is reported", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", thinking: "ultra" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			const setThinkingCalls: string[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setModelCalls.length).toBe(1); // "valid model should still be applied";
			expect(setThinkingCalls.length).toBe(0); // "invalid thinking must not be applied";
			const warnings = notifications.filter((n) => n.level === "warning");
			expect(warnings.length).toBe(1); // "invalid thinking should produce one warning";
			expect(warnings[0]?.message ?? "").toMatch(/\`thinking\`/);
			const issues = pi.appendedEntries.filter((entry: any) => entry.customType === "pi-schematic-frontmatter-issue");
			expect(issues.length).toBe(1); // "invalid thinking should produce one issue entry";
			expect(entryData(issues[0]).type).toBe("command");
			expect((entryData(issues[0]).issue as { kind: string }).kind).toBe("invalid-thinking-value");
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("valid model applies when model-group frontmatter is invalid", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
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
			expect(warnings.length).toBe(1);
			expect(warnings[0]?.message ?? "").toMatch(/`model-group`/);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("explicit model + model-group warns and uses explicit model", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "reviewer" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
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

			expect(setModelCalls.length).toBe(1); // "setModel should be called once";
			expect(setModelCalls[0].id).toBe("gpt-4o"); // "explicit model should win over model-group";
			expect(notifications.some((n) => /reviewer.*overridden/.test(n.message))).toBe(true); // "should warn about override";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("explicit model + model-group + thinking uses explicit model and thinking, warns about override", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o", "model-group": "reviewer", thinking: "high" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			const setThinkingCalls: string[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setModelCalls.length).toBe(1); // "setModel should be called once";
			expect(setModelCalls[0].id).toBe("gpt-4o"); // "explicit model should win";
			expect(setThinkingCalls.length).toBe(1); // "setThinkingLevel should be called";
			expect(setThinkingCalls[0]).toBe("high"); // "thinking from frontmatter should be applied";
			expect(notifications.some((n) => /reviewer.*overridden/.test(n.message))).toBe(true); // "should warn about group override";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("model-group + thinking overrides group thinking level", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer", thinking: "low" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			const setThinkingCalls: string[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setModelCalls.length).toBe(1); // "setModel should be called once";
			expect(setModelCalls[0].id).toBe("gpt-4o"); // "model should come from group";
			expect(setThinkingCalls.length).toBe(1); // "setThinkingLevel should be called once";
			expect(setThinkingCalls[0]).toBe("low"); // "thinking should come from frontmatter, not group";
			expect(notifications.some((n) => /Model changed.*reviewer.*\/review/.test(n.message))).toBe(true); // "should notify about group change";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("thinking only frontmatter sets thinking level without changing model", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { thinking: "high" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			const setThinkingCalls: string[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setModelCalls.length).toBe(0); // "setModel should NOT be called";
			expect(setThinkingCalls.length).toBe(1); // "setThinkingLevel should be called";
			expect(setThinkingCalls[0]).toBe("high");
			expect(notifications.some((n) => /Thinking level set.*high.*\/review/.test(n.message))).toBe(true);

			const thinkingEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-thinking-change");
			expect(thinkingEntries.length).toBe(1); // "should append one thinking-change entry";
			expect(entryData(thinkingEntries[0]).command).toBe("/review");
			expect(entryData(thinkingEntries[0]).thinking).toBe("high");
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("unknown model in frontmatter blocks execution", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "unknown/no-such-model" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
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
			expect(setModelCalls.length).toBe(0); // "setModel should not be called";
			expect(notifications.find((n) => n.level === "error")?.message ?? "").toMatch(/unknown\/no-such-model.*not found/);
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("model switch failure blocks explicit model selection", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
			const pi = await makeMockPI();
			pi.setModel = async () => false; // Simulate setModel failure
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

test("unauthenticated model in registry blocks explicit model selection", async () =>
	withTemp(async ({ cwd }) => {
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

test("invalid model format in frontmatter produces warning", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "not-valid-format" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
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

			expect(setModelCalls.length).toBe(0); // "setModel should not be called for invalid model format";
			expect(notifications.some((n) => /`model`.*`<provider>\/<model-id>`/.test(n.message))).toBe(true); // "should warn about invalid model format";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("invalid thinking value produces warning", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { thinking: "ultra" });
			const pi = await makeMockPI();
			const setThinkingCalls: string[] = [];
			pi.setThinkingLevel = (level: string) => {
				setThinkingCalls.push(level);
			};
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

			expect(setThinkingCalls.length).toBe(0); // "setThinkingLevel should NOT be called for invalid thinking";
			expect(notifications.some((n) => /`thinking`.*off, minimal, low/.test(n.message))).toBe(true); // "should warn about invalid thinking";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("explicit model frontmatter is ignored in headless session", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { model: "openai/gpt-4o" });
			const pi = await makeMockPI();
			const setModelCalls: any[] = [];
			pi.setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};
			const [inputHandler] = pi.handlers.get("input")!;

			pi.setCommands([makePromptCommand("review", filePath)]);
			await inputHandler({ text: "/review", source: "interactive" }, { hasUI: false });

			expect(setModelCalls.length).toBe(0); // "setModel should not be called in headless";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("model-group toggle does not affect readonly state", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const skillDir = await tmpDir();
		try {
			const filePath = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

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

			expect(setModelCalls.length).toBe(1); // "model should be switched";
			const readonlyEntries = pi.appendedEntries.filter((e: any) => e.customType === "pi-schematic-readonly");
			expect(readonlyEntries.length).toBe(0); // "readonly state should not be affected";
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("streaming blocks model selection without mutation", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, { reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] } });
		const cases = [
			{ frontmatter: { model: "openai/gpt-4o" }, streamingBehavior: "steer" as const },
			{ frontmatter: { "model-group": "reviewer" }, streamingBehavior: "followUp" as const },
			{ frontmatter: { thinking: "high" }, streamingBehavior: "steer" as const },
		];
		for (const scenario of cases) {
			const run = await runPromptInput(cwd, scenario.frontmatter, "success", scenario.streamingBehavior);
			expect(run.result).toStrictEqual({ action: "handled" });
			expect(run.modelCalls.length).toBe(0);
			expect(run.thinkingCalls.length).toBe(0);
			expect(run.notifications.some((item) => item.level === "warning")).toBe(true);
			expect(hasModelSelectionEntry(run.pi)).toBe(false);
		}
	}));

test("embedded-slash prompt and skill tokens do not apply model-selection frontmatter", async () =>
	withTemp(async ({ cwd }) => {
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
				pi.setModel = async (model: any) => {
					modelCalls.push(model);
					return true;
				};
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
				expect(hasModelSelectionEntry(pi)).toBe(false);
			}
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("setModel failures block explicit and group selection without success entries", async () =>
	withTemp(async ({ cwd }) => {
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
			expect(hasModelSelectionEntry(run.pi)).toBe(false);
		}
	}));

test("model-group commands are applied during their input preflight", async () =>
	withTemp(async ({ cwd }) => {
		writeModelGroupsConfig(cwd, {
			reviewer: { models: [{ provider: "openai", modelId: "gpt-4o" }] },
			fast: { models: [{ provider: "anthropic", modelId: "claude-sonnet" }] },
		});
		const skillDir = await tmpDir();
		try {
			const fp1 = await writeSkillMd(skillDir, "review", { "model-group": "reviewer" });
			const fp2 = await writeSkillMd(skillDir, "quick", { "model-group": "fast" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

			const [inputHandler] = pi.handlers.get("input")!;
			const sessionStartHandler = pi.handlers.get("session_start")!.at(-1)!;
			const { ctx } = makeNotifyCtx({
				cwd,
				model: mockModel("openai", "gpt-parent"),
				modelRegistry: mockRegistry([mockModel("openai", "gpt-4o"), mockModel("anthropic", "claude-sonnet")]),
			});

			pi.setCommands([makePromptCommand("review", fp1), makePromptCommand("quick", fp2)]);
			await sessionStartHandler({ reason: "load" }, ctx);
			const reviewResult = await inputHandler({ text: "/review", source: "interactive" }, ctx);
			const quickResult = await inputHandler({ text: "/quick", source: "interactive" }, ctx);

			expect(reviewResult).toStrictEqual({ action: "continue" });
			expect(quickResult).toStrictEqual({ action: "continue" });
			expect(setModelCalls.length).toBe(2); // "each command is selected before its agent turn";
			expect(setModelCalls[0].id).toBe("gpt-4o");
			expect(setModelCalls[1].id).toBe("claude-sonnet");
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));

test("suppressed input causes no frontmatter side effects; release restores them", async () =>
	withTemp(async ({ cwd }) => {
		const skillDir = await tmpDir();
		try {
			const quietPath = await writeSkillMd(skillDir, "quiet", { readonly: true });
			const loudPath = await writeSkillMd(skillDir, "loud", { model: "openai/gpt-4o" });
			const pi = await createTestHost();
			const setModelCalls: any[] = [];
			(pi as any).setModel = async (model: any) => {
				setModelCalls.push(model);
				return true;
			};

			const [inputHandler] = pi.handlers.get("input")!;
			const sessionId = "suppression-contract";
			const { ctx, notifications } = makeNotifyCtx({
				cwd,
				model: mockModel("openai", "gpt-parent"),
				modelRegistry: mockRegistry(),
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => [],
					getLeafId: () => null,
					getEntries: () => [],
				},
			});
			pi.setCommands([makeSkillCommand("quiet", quietPath), makeSkillCommand("loud", loudPath)]);
			// Real dispatch order: every session_start handler runs, and the workflow
			// publisher exposes the extension's live state for the assertions below.
			for (const handler of pi.handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
			const binding = takeWorkflowRuntime(sessionId);
			expect(binding).not.toBeNull(); // "session_start publishes the live runtime";
			const live = binding!.state;

			// While a run suppresses input the flag stands in for its installed handler
			// (the subscribe path raising it is pinned in tests/e2e/workflow-command.test.ts).
			live.inputSuppressed = true;
			const baseline = notifications.length;
			expect(await inputHandler({ text: "/skill:quiet", source: "interactive" }, ctx)).toStrictEqual({ action: "continue" });
			expect(await inputHandler({ text: "/skill:loud", source: "interactive" }, ctx)).toStrictEqual({ action: "continue" });
			expect(live.pendingReadonlyCommands.length).toBe(0); // "suppressed input queues no readonly toggle";
			expect(setModelCalls.length).toBe(0); // "suppressed input switches no model";
			expect(notifications.length).toBe(baseline); // "suppressed input notifies nothing";

			// After the run releases suppression the same submissions apply again.
			live.inputSuppressed = false;
			await inputHandler({ text: "/skill:quiet", source: "interactive" }, ctx);
			expect(live.pendingReadonlyCommands).toStrictEqual([{ type: "skill", name: "quiet" }]);
			await inputHandler({ text: "/skill:loud", source: "interactive" }, ctx);
			expect(setModelCalls.length).toBe(1); // "released input routes the model again";
			expect(setModelCalls[0].id).toBe("gpt-4o");
		} finally {
			await rm(skillDir, { recursive: true, force: true });
		}
	}));
