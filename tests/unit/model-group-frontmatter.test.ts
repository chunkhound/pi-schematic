/**
 * Model-group frontmatter tests.
 *
 * Exercises the full pipeline through the loaded extension: session start loads the
 * Model Groups, then the input preflight applies the command's model selection.
 */

import { expect, onTestFinished, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSyntheticSourceInfo, SessionManager, type ProviderConfig, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelGroupDef } from "../../model-groups/types.js";
import { assertPresent } from "../assertions.js";
import { createModelRegistry } from "../support/model-registry.js";
import { createRunner, type AppendedEntry, type Notification, type RunnerFixture } from "../support/runner.js";
import { realTheme } from "../support/theme.js";
import { testProvider, type TestChatModel } from "./model-groups-helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** The provider of the current model and of most frontmatter models; registered with auth. */
const OPENAI = "mg-openai";

/** A reasoning model's thinking levels without `high`, so `high` clamps to `medium`. */
const NO_HIGH: Model<Api>["thinkingLevelMap"] = { off: null, minimal: "minimal", low: "low", medium: "medium", high: null };
const ALL_LEVELS: Model<Api>["thinkingLevelMap"] = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" };

type SetModelBehavior = "success" | "false" | "reject";

interface CommandSpec {
	/** The command name without a `skill:` prefix; also the frontmatter file's name. */
	name: string;
	source: "prompt" | "skill";
	frontmatter: Record<string, unknown>;
}

interface HarnessOptions {
	commands: CommandSpec[];
	/** Project Model Groups, written as a version 2 config. */
	groups?: Record<string, ModelGroupDef>;
	/** The models of the authenticated `mg-openai` provider; `gpt-parent` and `gpt-4o` by default. */
	models?: TestChatModel[];
	/** Further providers besides `mg-openai`. */
	providers?: Record<string, ProviderConfig>;
	/** The id of the current `mg-openai` model. */
	currentModel?: string;
	setModel?: SetModelBehavior;
	/** Without a UI the context is headless. */
	headless?: boolean;
}

interface Harness {
	fixture: RunnerFixture;
	modelCalls: Model<Api>[];
	thinkingCalls: ModelThinkingLevel[];
	notifications: () => readonly Notification[];
	entries: (customType: string) => AppendedEntry[];
	input: (text: string, streamingBehavior?: "steer" | "followUp") => ReturnType<RunnerFixture["runner"]["emitInput"]>;
}

function writeFrontmatterFile(dir: string, name: string, frontmatter: Record<string, unknown>): string {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	const filePath = path.join(dir, `${name}.md`);
	fs.writeFileSync(filePath, `---\n${fm}\n---\n\nBody content.\n`);
	return filePath;
}

function slashCommand(dir: string, { name, source, frontmatter }: CommandSpec): SlashCommandInfo {
	const filePath = writeFrontmatterFile(dir, `${source}-${name}`, frontmatter);
	return {
		name: source === "skill" ? `skill:${name}` : name,
		source,
		description: "Test prompt",
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
	};
}

/**
 * The shipped extension in TUI mode over a fresh project whose Model Groups and commands come from
 * `options`, after session start. `pi.setModel` and `pi.setThinkingLevel` record their calls, and
 * the current thinking level is `medium`.
 */
async function frontmatterHarness(options: HarnessOptions): Promise<Harness> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-group-frontmatter-"));
	onTestFinished(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	const cwd = path.join(root, "project");
	const commandDir = path.join(root, "commands");
	fs.mkdirSync(commandDir, { recursive: true });
	const configPath = path.join(cwd, ".pi", "pi-schematic", "model-groups.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ version: 2, groups: options.groups ?? {} }), "utf8");
	const commands = options.commands.map((command) => slashCommand(commandDir, command));
	const modelRegistry = await createModelRegistry({
		[OPENAI]: testProvider(
			options.models ?? [
				{ id: "gpt-parent", reasoning: true },
				{ id: "gpt-4o", reasoning: true },
			],
			{ auth: true },
		),
		...options.providers,
	});
	const currentModel = modelRegistry.find(OPENAI, options.currentModel ?? "gpt-parent");
	assertPresent(currentModel, "the registry resolves the current model");
	const modelCalls: Model<Api>[] = [];
	const thinkingCalls: ModelThinkingLevel[] = [];
	const behavior = options.setModel ?? "success";
	const fixture = await createRunner({
		cwd,
		agentDir: path.join(root, "agent"),
		mode: "tui",
		sessionManager: SessionManager.inMemory(cwd),
		modelRegistry,
		context: { getModel: () => currentModel, isProjectTrusted: () => true, getContextUsage: () => undefined },
		...(options.headless === true ? {} : { ui: { theme: realTheme, addAutocompleteProvider: () => undefined } }),
		activeTools: [],
		actions: {
			getCommands: () => commands,
			setModel: (model: Model<Api>) => {
				modelCalls.push(model);
				return behavior === "reject" ? Promise.reject(new Error("setModel rejected")) : Promise.resolve(behavior === "success");
			},
			setThinkingLevel: (level) => {
				thinkingCalls.push(level);
			},
			getThinkingLevel: () => "medium",
		},
	});
	await fixture.runner.emit({ type: "session_start", reason: "startup" });
	return {
		fixture,
		modelCalls,
		thinkingCalls,
		notifications: () => fixture.ui.notifications,
		entries: (customType) => fixture.host.appendedEntries.filter((entry) => entry.customType === customType),
		input: (text, streamingBehavior) => fixture.runner.emitInput(text, undefined, "interactive", streamingBehavior),
	};
}

function messages(harness: Harness): string[] {
	return harness.notifications().map(({ message }) => message);
}

function firstError(harness: Harness): string {
	return harness.notifications().find(({ type }) => type === "error")?.message ?? "";
}

function modelSelectionEntries(harness: Harness): AppendedEntry[] {
	const types = new Set(["pi-schematic-model-switch", "pi-schematic-model-group-switch", "pi-schematic-thinking-change"]);
	return harness.fixture.host.appendedEntries.filter((entry) => types.has(entry.customType));
}

const reviewPrompt = (frontmatter: Record<string, unknown>): CommandSpec[] => [{ name: "review", source: "prompt", frontmatter }];
const reviewerGroup = { reviewer: { models: [{ provider: OPENAI, modelId: "gpt-4o" }] } };

// ── Tests ─────────────────────────────────────────────────────────────

test("model-group frontmatter triggers model switch for /name command", async () => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt({ "model-group": "reviewer" }) });

	const result = await harness.input("/review");

	expect(result).toStrictEqual({ action: "continue" });
	expect(
		harness.modelCalls.map((model) => `${model.provider}/${model.id}`),
		"setModel should be called once",
	).toStrictEqual(["mg-openai/gpt-4o"]);
	expect(messages(harness)).toContainEqual(expect.stringMatching(/Model changed.*reviewer.*\/review/));
	expect(harness.entries("pi-schematic-model-group-switch"), "should append one model-group-switch entry").toMatchObject([
		{ data: { command: "/review", groupName: "reviewer", provider: "mg-openai", modelId: "gpt-4o" } },
	]);
});

test("model-group-only frontmatter applies and records the group's effective thinking", async () => {
	const harness = await frontmatterHarness({
		groups: { reviewer: { models: [{ provider: OPENAI, modelId: "gpt-4o", thinkingLevel: "high" }] } },
		models: [
			{ id: "gpt-parent", reasoning: true },
			{ id: "gpt-4o", reasoning: true, thinkingLevelMap: NO_HIGH },
		],
		commands: reviewPrompt({ "model-group": "reviewer" }),
	});

	await harness.input("/review");

	expect(harness.thinkingCalls, "group thinking is clamped for the routed model").toStrictEqual(["medium"]);
	expect(harness.entries("pi-schematic-model-group-switch"), "entry records effective thinking").toMatchObject([{ data: { thinking: "medium" } }]);
});

test("model-group frontmatter triggers model switch for /skill:name command", async () => {
	const harness = await frontmatterHarness({
		groups: { fast: { models: [{ provider: "mg-anthropic", modelId: "claude-sonnet" }] } },
		providers: { "mg-anthropic": testProvider([{ id: "claude-sonnet", reasoning: true }], { auth: true }) },
		commands: [{ name: "quick", source: "skill", frontmatter: { "model-group": "fast" } }],
	});

	await harness.input("/skill:quick");

	expect(harness.modelCalls.map((model) => model.provider)).toStrictEqual(["mg-anthropic"]);
	expect(messages(harness)).toContainEqual(expect.stringMatching(/Model changed.*fast.*\/skill:quick/));
});

test.each([
	{
		text: "/review",
		command: { name: "review", source: "prompt" },
		error: "Cannot execute `/review`: Model Group `nonexistent` error — Model Group 'nonexistent' is not defined. Available groups: reviewer.",
	},
	{
		text: "/skill:quick",
		command: { name: "quick", source: "skill" },
		error: "Cannot execute `/skill:quick`: Model Group `nonexistent` error — Model Group 'nonexistent' is not defined. Available groups: reviewer.",
	},
] as const)("unknown model-group in frontmatter blocks execution with error: $text", async ({ text, command, error }) => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: [{ ...command, frontmatter: { "model-group": "nonexistent" } }] });

	const result = await harness.input(text);

	expect(result, "selection failure must prevent command expansion and agent start").toStrictEqual({ action: "handled" });
	expect(harness.modelCalls, "setModel should not be called").toHaveLength(0);
	expect(firstError(harness)).toBe(error);
});

test("empty model-group (SpawnRouteError) blocks execution with error", async () => {
	const harness = await frontmatterHarness({ groups: { empty: { models: [] } }, commands: reviewPrompt({ "model-group": "empty" }) });

	const result = await harness.input("/review");

	expect(result).toStrictEqual({ action: "handled" });
	expect(harness.modelCalls).toHaveLength(0);
	expect(firstError(harness)).toBe("Cannot execute `/review`: Model Group `empty` error — Model Group 'empty' has no model entries.");
});

test.each([
	{ label: "model-group", frontmatter: { "model-group": "reviewer" } },
	{ label: "explicit model", frontmatter: { model: "mg-openai/gpt-4o" } },
])("headless session does not apply model-selection frontmatter: $label", async ({ frontmatter }) => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt(frontmatter), headless: true });

	await harness.input("/review");

	expect(harness.modelCalls, "setModel should not be called in headless").toHaveLength(0);
});

test("model-group frontmatter without readonly leaves readonly mode unchanged", async () => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt({ "model-group": "reviewer" }) });

	await harness.input("/review");
	await harness.fixture.runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, harness.fixture.systemPromptOptions());

	expect(harness.modelCalls.map((model) => model.id)).toStrictEqual(["gpt-4o"]);
	expect(harness.entries("pi-schematic-readonly")).toStrictEqual([]);
});

test("each model-group command selects its own group's model", async () => {
	const harness = await frontmatterHarness({
		groups: { ...reviewerGroup, fast: { models: [{ provider: "mg-anthropic", modelId: "claude-sonnet" }] } },
		providers: { "mg-anthropic": testProvider([{ id: "claude-sonnet", reasoning: true }], { auth: true }) },
		commands: [
			{ name: "review", source: "prompt", frontmatter: { "model-group": "reviewer" } },
			{ name: "quick", source: "prompt", frontmatter: { "model-group": "fast" } },
		],
	});

	await harness.input("/review");
	await harness.input("/quick");

	expect(harness.modelCalls.map((model) => `${model.provider}/${model.id}`)).toStrictEqual(["mg-openai/gpt-4o", "mg-anthropic/claude-sonnet"]);
});

test("no model-group frontmatter is a silent no-op", async () => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt({ readonly: true }) });

	await harness.input("/review");

	expect(harness.modelCalls, "setModel should not be called when no model-group frontmatter").toHaveLength(0);
	expect(messages(harness)).not.toContainEqual(expect.stringMatching(/Model changed/));
});

test("invalid model-group value produces warning notification", async () => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt({ "model-group": "" }) });

	await harness.input("/review");

	expect(harness.modelCalls, "setModel should not be called for invalid model-group").toHaveLength(0);
	expect(messages(harness), "should warn about invalid model-group").toContainEqual(expect.stringMatching(/model-group.*non-empty/));
});

// ── Explicit model frontmatter tests ──────────────────────────────

test("explicit model frontmatter switches model", async () => {
	const harness = await frontmatterHarness({ commands: reviewPrompt({ model: "mg-openai/gpt-4o" }) });

	await harness.input("/review");

	expect(
		harness.modelCalls.map((model) => `${model.provider}/${model.id}`),
		"setModel should be called once",
	).toStrictEqual(["mg-openai/gpt-4o"]);
	expect(harness.thinkingCalls, "without thinking frontmatter the thinking level is not changed").toStrictEqual([]);
	expect(messages(harness)).toContainEqual(expect.stringMatching(/Model switched.*openai.*gpt-4o.*\/review/));
	expect(
		harness.entries("pi-schematic-model-switch").map(({ data }) => data),
		"should append one model-switch entry",
	).toStrictEqual([{ command: "/review", provider: "mg-openai", modelId: "gpt-4o", thinking: null }]);
});

test("explicit model with thinking sets both model and thinking level", async () => {
	const harness = await frontmatterHarness({
		models: [
			{ id: "gpt-parent", reasoning: true },
			{ id: "gpt-4o", reasoning: true, thinkingLevelMap: ALL_LEVELS },
		],
		commands: reviewPrompt({ model: "mg-openai/gpt-4o", thinking: "high" }),
	});

	await harness.input("/review");

	expect(
		harness.modelCalls.map((model) => model.id),
		"setModel should be called once",
	).toStrictEqual(["gpt-4o"]);
	expect(harness.thinkingCalls, "setThinkingLevel should be called once").toStrictEqual(["high"]);
	expect(messages(harness)).toContainEqual(expect.stringMatching(/Model switched.*openai.*gpt-4o/));
});

test("explicit model applies while invalid thinking is reported", async () => {
	const harness = await frontmatterHarness({ commands: reviewPrompt({ model: "mg-openai/gpt-4o", thinking: "ultra" }) });

	await harness.input("/review");

	expect(harness.modelCalls, "valid model should still be applied").toHaveLength(1);
	expect(harness.thinkingCalls, "invalid thinking must not be applied").toHaveLength(0);
	const warnings = harness.notifications().filter(({ type }) => type === "warning");
	expect(warnings, "invalid thinking should produce one warning").toHaveLength(1);
	expect(warnings[0]?.message ?? "").toMatch(/`thinking`/);
	expect(harness.entries("pi-schematic-frontmatter-issue"), "invalid thinking should produce one issue entry").toMatchObject([
		{ data: { type: "command", issue: { kind: "invalid-thinking-value" } } },
	]);
});

test("valid model applies when model-group frontmatter is invalid", async () => {
	const harness = await frontmatterHarness({ commands: reviewPrompt({ model: "mg-openai/gpt-4o", "model-group": "" }) });

	const result = await harness.input("/review");

	expect(result).toStrictEqual({ action: "continue" });
	expect(harness.modelCalls.map((model) => model.id)).toStrictEqual(["gpt-4o"]);
	const warnings = harness.notifications().filter(({ type }) => type === "warning");
	expect(warnings).toHaveLength(1);
	expect(warnings[0]?.message ?? "").toMatch(/`model-group`/);
});

test("explicit model + model-group warns and uses explicit model", async () => {
	const harness = await frontmatterHarness({
		groups: { reviewer: { models: [{ provider: "mg-anthropic", modelId: "claude-sonnet" }] } },
		providers: { "mg-anthropic": testProvider([{ id: "claude-sonnet", reasoning: true }], { auth: true }) },
		commands: reviewPrompt({ model: "mg-openai/gpt-4o", "model-group": "reviewer" }),
	});

	await harness.input("/review");

	expect(
		harness.modelCalls.map((model) => model.id),
		"explicit model should win over model-group",
	).toStrictEqual(["gpt-4o"]);
	expect(messages(harness), "should warn about override").toContainEqual(expect.stringMatching(/reviewer.*overridden/));
});

test("explicit model + model-group + thinking applies the frontmatter thinking to the explicit model", async () => {
	const harness = await frontmatterHarness({
		groups: { reviewer: { models: [{ provider: "mg-anthropic", modelId: "claude-sonnet" }] } },
		providers: { "mg-anthropic": testProvider([{ id: "claude-sonnet", reasoning: true }], { auth: true }) },
		models: [
			{ id: "gpt-parent", reasoning: true },
			{ id: "gpt-4o", reasoning: true, thinkingLevelMap: ALL_LEVELS },
		],
		commands: reviewPrompt({ model: "mg-openai/gpt-4o", "model-group": "reviewer", thinking: "high" }),
	});

	await harness.input("/review");

	expect(harness.modelCalls.map((model) => model.id)).toStrictEqual(["gpt-4o"]);
	expect(harness.thinkingCalls).toStrictEqual(["high"]);
});

test("model-group + thinking overrides group thinking level", async () => {
	const harness = await frontmatterHarness({
		groups: { reviewer: { models: [{ provider: OPENAI, modelId: "gpt-4o", thinkingLevel: "high" }] } },
		models: [
			{ id: "gpt-parent", reasoning: true },
			{ id: "gpt-4o", reasoning: true, thinkingLevelMap: ALL_LEVELS },
		],
		commands: reviewPrompt({ "model-group": "reviewer", thinking: "low" }),
	});

	await harness.input("/review");

	expect(
		harness.modelCalls.map((model) => model.id),
		"model should come from group",
	).toStrictEqual(["gpt-4o"]);
	expect(harness.thinkingCalls, "thinking should come from frontmatter, not group").toStrictEqual(["low"]);
	expect(harness.entries("pi-schematic-model-group-switch"), "the entry records the frontmatter level").toMatchObject([{ data: { thinking: "low" } }]);
	expect(messages(harness), "should notify about group change").toContainEqual(expect.stringMatching(/Model changed.*reviewer.*\/review/));
});

test("thinking only frontmatter sets thinking level without changing model", async () => {
	const harness = await frontmatterHarness({
		models: [{ id: "gpt-parent", reasoning: true, thinkingLevelMap: ALL_LEVELS }],
		commands: reviewPrompt({ thinking: "high" }),
	});

	await harness.input("/review");

	expect(harness.modelCalls, "setModel should NOT be called").toHaveLength(0);
	expect(harness.thinkingCalls, "setThinkingLevel should be called").toStrictEqual(["high"]);
	expect(messages(harness)).toContainEqual(expect.stringMatching(/Thinking level set.*high.*\/review/));
	expect(
		harness.entries("pi-schematic-thinking-change").map(({ data }) => data),
		"should append one thinking-change entry",
	).toStrictEqual([{ command: "/review", thinking: "high" }]);
});

test("unknown model in frontmatter blocks execution", async () => {
	const harness = await frontmatterHarness({ commands: reviewPrompt({ model: "unknown/no-such-model" }) });

	const result = await harness.input("/review");

	expect(result).toStrictEqual({ action: "handled" });
	expect(harness.modelCalls, "setModel should not be called").toHaveLength(0);
	expect(firstError(harness)).toMatch(/unknown\/no-such-model.*not found/);
});

test("unauthenticated model in registry blocks explicit model selection", async () => {
	const harness = await frontmatterHarness({
		// The model exists in the registry, but its provider has no configured auth.
		providers: { "mg-noauth": testProvider([{ id: "gpt-4o", reasoning: true }], { auth: false }) },
		commands: reviewPrompt({ model: "mg-noauth/gpt-4o" }),
	});

	const result = await harness.input("/review");

	expect(result).toStrictEqual({ action: "handled" });
	expect(firstError(harness)).toMatch(/no API key/);
});

test("invalid model format in frontmatter produces warning", async () => {
	const harness = await frontmatterHarness({ commands: reviewPrompt({ model: "not-valid-format" }) });

	await harness.input("/review");

	expect(harness.modelCalls, "setModel should not be called for invalid model format").toHaveLength(0);
	expect(messages(harness), "should warn about invalid model format").toContainEqual(expect.stringMatching(/`model`.*`<provider>\/<model-id>`/));
});

test("invalid thinking value produces warning", async () => {
	const harness = await frontmatterHarness({ commands: reviewPrompt({ thinking: "ultra" }) });

	await harness.input("/review");

	expect(harness.thinkingCalls, "setThinkingLevel should NOT be called for invalid thinking").toHaveLength(0);
	expect(messages(harness), "should warn about invalid thinking").toContainEqual(expect.stringMatching(/`thinking`.*off, minimal, low/));
});

test.each([
	{ label: "explicit model while steering", frontmatter: { model: "mg-openai/gpt-4o" }, streamingBehavior: "steer" as const },
	{ label: "model-group as a follow-up", frontmatter: { "model-group": "reviewer" }, streamingBehavior: "followUp" as const },
	{ label: "thinking while steering", frontmatter: { thinking: "high" }, streamingBehavior: "steer" as const },
])("streaming blocks model selection without mutation: $label", async ({ frontmatter, streamingBehavior }) => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt(frontmatter) });

	const result = await harness.input("/review", streamingBehavior);

	expect(result).toStrictEqual({ action: "handled" });
	expect(harness.modelCalls).toHaveLength(0);
	expect(harness.thinkingCalls).toHaveLength(0);
	expect(harness.notifications().map(({ type }) => type)).toContain("warning");
	expect(modelSelectionEntries(harness)).toStrictEqual([]);
});

test.each([
	{ text: "/prompt-review/typo", command: { name: "prompt-review", source: "prompt", frontmatter: { model: "mg-openai/gpt-4o", thinking: "high" } } },
	{ text: "/skill:skill-review/typo", command: { name: "skill-review", source: "skill", frontmatter: { "model-group": "reviewer", thinking: "high" } } },
] as const)("embedded-slash prompt and skill tokens do not apply model-selection frontmatter: $text", async ({ text, command }) => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: [{ ...command, frontmatter: { ...command.frontmatter } }] });

	const result = await harness.input(text);

	expect(result).toStrictEqual({ action: "continue" });
	expect(harness.modelCalls).toStrictEqual([]);
	expect(harness.thinkingCalls).toStrictEqual([]);
	expect(modelSelectionEntries(harness)).toStrictEqual([]);
});

test.each([
	{ label: "explicit model, setModel false", frontmatter: { model: "mg-openai/gpt-4o" }, behavior: "false" as const },
	{ label: "explicit model, setModel rejects", frontmatter: { model: "mg-openai/gpt-4o" }, behavior: "reject" as const },
	{ label: "model-group, setModel false", frontmatter: { "model-group": "reviewer" }, behavior: "false" as const },
	{ label: "model-group, setModel rejects", frontmatter: { "model-group": "reviewer" }, behavior: "reject" as const },
])("setModel failures block explicit and group selection without success entries: $label", async ({ frontmatter, behavior }) => {
	const harness = await frontmatterHarness({ groups: reviewerGroup, commands: reviewPrompt(frontmatter), setModel: behavior });

	const result = await harness.input("/review");

	expect(result).toStrictEqual({ action: "handled" });
	expect(firstError(harness)).toMatch(/failed to switch/);
	expect(modelSelectionEntries(harness)).toStrictEqual([]);
});

// ── Clamped thinking levels ───────────────────────────────────────

test("explicit model frontmatter records the thinking level clamped to the model", async () => {
	const harness = await frontmatterHarness({
		models: [
			{ id: "gpt-parent", reasoning: true },
			{ id: "gpt-4o", reasoning: true, thinkingLevelMap: NO_HIGH },
		],
		commands: reviewPrompt({ model: "mg-openai/gpt-4o", thinking: "high" }),
	});

	await harness.input("/review");

	expect(harness.thinkingCalls).toStrictEqual(["medium"]);
	expect(harness.entries("pi-schematic-model-switch").map(({ data }) => data)).toStrictEqual([
		{ command: "/review", provider: "mg-openai", modelId: "gpt-4o", thinking: "medium" },
	]);
});

test("model-group frontmatter records the thinking level clamped to the routed model", async () => {
	const harness = await frontmatterHarness({
		groups: reviewerGroup,
		models: [
			{ id: "gpt-parent", reasoning: true },
			{ id: "gpt-4o", reasoning: true, thinkingLevelMap: NO_HIGH },
		],
		commands: reviewPrompt({ "model-group": "reviewer", thinking: "high" }),
	});

	await harness.input("/review");

	expect(harness.entries("pi-schematic-model-group-switch")).toMatchObject([{ data: { groupName: "reviewer", thinking: "medium" } }]);
});

test("thinking only frontmatter records and announces the level clamped to the current model", async () => {
	const harness = await frontmatterHarness({
		models: [{ id: "gpt-parent", reasoning: true, thinkingLevelMap: NO_HIGH }],
		commands: reviewPrompt({ thinking: "high" }),
	});

	await harness.input("/review");

	expect(harness.entries("pi-schematic-thinking-change").map(({ data }) => data)).toStrictEqual([{ command: "/review", thinking: "medium" }]);
	expect(harness.notifications()).toContainEqual({ message: "Thinking level set to medium via `/review` frontmatter", type: "info" });
});

test.each([
	{ defined: 0, names: [], error: "Cannot execute `/review`: Model Group `missing` error — Model Group 'missing' is not defined." },
	{
		defined: 5,
		names: ["a", "b", "c", "d", "e"],
		error: "Cannot execute `/review`: Model Group `missing` error — Model Group 'missing' is not defined. Available groups: a, b, c, d, e.",
	},
	{
		defined: 6,
		names: ["a", "b", "c", "d", "e", "f"],
		error: "Cannot execute `/review`: Model Group `missing` error — Model Group 'missing' is not defined. Run /model-groups to see all available groups.",
	},
])("unknown model-group hint for $defined defined groups", async ({ names, error }) => {
	const harness = await frontmatterHarness({
		groups: Object.fromEntries(names.map((name) => [name, { models: [{ provider: OPENAI, modelId: "gpt-4o" }] }])),
		commands: reviewPrompt({ "model-group": "missing" }),
	});

	await harness.input("/review");

	expect(firstError(harness)).toBe(error);
});
