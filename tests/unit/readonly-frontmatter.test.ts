/**
 * Readonly frontmatter integration tests.
 *
 * Exercises the full pipeline:
 *   input queue → before_agent_start → consumePendingReadonlyCommands
 */

import { expect, onTestFinished, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createSyntheticSourceInfo,
	SessionManager,
	type ContextUsage,
	type ExtensionRunner,
	type InputSource,
	type Skill,
	type SlashCommandInfo,
	type SlashCommandSource,
} from "@earendil-works/pi-coding-agent";
import { testWithDir, tmpDir, withTempHome } from "../support/temp.js";
import { assertPresent, isRecord } from "../assertions.js";
import { createRunner, type AppendedEntry, type RunnerFixture } from "../support/runner.js";
import { realTheme } from "../support/theme.js";

type ContextMessage = Awaited<ReturnType<ExtensionRunner["emitContext"]>>[number];

/** A context usage at `percent` of a 200 000-token window. */
function usageAt(percent: number): ContextUsage {
	return { tokens: percent * 2000, percent, contextWindow: 200000 };
}

interface FrontmatterRunner {
	fixture: RunnerFixture;
	/** Replace what `pi.getCommands()` reports. */
	setCommands: (commands: SlashCommandInfo[]) => void;
	setUsage: (usage: ContextUsage | undefined) => void;
	input: (text: string, source?: InputSource, streamingBehavior?: "steer" | "followUp") => ReturnType<ExtensionRunner["emitInput"]>;
	beforeAgentStart: (skills?: Skill[]) => Promise<void>;
	runCommand: (name: string, args?: string) => Promise<void>;
	/** Resolves to the `write` call's block result, or undefined when nothing blocks it. */
	writeCall: () => ReturnType<ExtensionRunner["emitToolCall"]>;
	readonlyEntries: () => AppendedEntry[];
	context: () => Promise<ContextMessage[]>;
}

/**
 * The shipped extension on a runner at `cwd` with the recording UI, an idle in-memory session, a
 * trusted project, no model and the commands the test sets.
 */
async function createFrontmatterRunner(options: { cwd?: string; agentDir?: string } = {}): Promise<FrontmatterRunner> {
	const cwd = options.cwd ?? process.cwd();
	let commands: SlashCommandInfo[] = [];
	let usage: ContextUsage | undefined;
	const fixture = await createRunner({
		cwd,
		mode: "tui",
		sessionManager: SessionManager.inMemory(cwd),
		ui: { theme: realTheme },
		context: { getModel: () => undefined, getContextUsage: () => usage, isProjectTrusted: () => true, isIdle: () => true },
		actions: { getCommands: () => commands },
		activeTools: [],
		agentDir: options.agentDir,
	});
	const { runner, host } = fixture;
	return {
		fixture,
		setCommands: (next) => {
			commands = next;
		},
		setUsage: (next) => {
			usage = next;
		},
		input: (text, source = "interactive", streamingBehavior) => runner.emitInput(text, undefined, source, streamingBehavior),
		beforeAgentStart: async (skills = []) => {
			await runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, fixture.systemPromptOptions({ skills }));
		},
		runCommand: async (name, args = "") => {
			await fixture.command(name).handler(args, runner.createCommandContext());
		},
		writeCall: () => runner.emitToolCall({ type: "tool_call", toolCallId: "write", toolName: "write", input: { path: "/tmp/x", content: "x" } }),
		readonlyEntries: () => host.appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly"),
		context: () => runner.emitContext([]),
	};
}

/** The `field` member of an appended entry's data; the extension writes every entry's data as an object. */
function dataField(entry: AppendedEntry | undefined, field: string): unknown {
	if (entry === undefined) {
		return undefined;
	}
	if (!isRecord(entry.data)) {
		throw new Error(`The "${entry.customType}" entry's data is not an object.`);
	}
	return entry.data[field];
}

/** The text content of every custom message in `messages`. */
function customTexts(messages: ContextMessage[]): string[] {
	return messages.flatMap((message) => (message.role === "custom" && typeof message.content === "string" ? [message.content] : []));
}

/** The custom messages of `customType` in `messages`. */
function customMessages(messages: ContextMessage[], customType: string): ContextMessage[] {
	return messages.filter((message) => message.role === "custom" && message.customType === customType);
}

/** The text content of a custom message; throws when it has none. */
function contentText(message: ContextMessage | undefined): string {
	if (message?.role !== "custom" || typeof message.content !== "string") {
		throw new Error("The message is not a custom message with text content.");
	}
	return message.content;
}

async function writePrompt(dir: string, name: string, readonly: boolean): Promise<string> {
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\nreadonly: ${String(readonly)}\ndescription: "Test"\n---\n\nBody content.\n`);
	return filePath;
}

function makeResolvedCommand(name: string, filePath: string, source: SlashCommandSource = "prompt"): SlashCommandInfo {
	return {
		name,
		source,
		description: "Test prompt",
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test", scope: "temporary", origin: "top-level" }),
	};
}

function makePromptCommand(name: string, filePath: string) {
	return makeResolvedCommand(name, filePath, "prompt");
}

function makeSkillCommand(name: string, filePath: string) {
	return makeResolvedCommand(`skill:${name}`, filePath, "skill");
}

function makeSkill(name: string, filePath: string): Skill {
	return {
		name,
		description: "Test skill",
		filePath,
		baseDir: "",
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test", scope: "temporary", origin: "top-level" }),
		disableModelInvocation: false,
	};
}

async function runPromptToggle(text: string, readonly: boolean, name = text.slice(1)): Promise<FrontmatterRunner> {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, name, readonly);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand(name, filePath)]);
	await frontmatter.input(text);
	await frontmatter.beforeAgentStart();
	return frontmatter;
}

test("single /name input activates readonly frontmatter", async () => {
	const frontmatter = await runPromptToggle("/my-prompt", true);
	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("readonly: false frontmatter keeps readonly disabled and stays silent when already disabled", async ({ dir }) => {
	const filePath = await writePrompt(dir, "safe-prompt", false);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("safe-prompt", filePath)]);

	await frontmatter.input("/safe-prompt");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
	expect(frontmatter.fixture.ui.notifications).toHaveLength(0);
	frontmatter.setUsage(usageAt(40));
	expect(customTexts(await frontmatter.context()).filter((content) => /readonly/i.test(content))).toStrictEqual([]);
});

test("suffixed /name command activates readonly frontmatter", async () => {
	const frontmatter = await runPromptToggle("/review:1", true, "review:1");
	expect((await frontmatter.writeCall())?.block).toBe(true);
});

test("dotted /name command activates readonly frontmatter", async () => {
	const frontmatter = await runPromptToggle("/review.pr", true, "review.pr");
	expect((await frontmatter.writeCall())?.block).toBe(true);
});

test.each([
	{ text: "/review/typo", commands: (filePath: string) => [makePromptCommand("review", filePath)], skills: (): Skill[] => [] },
	{ text: "/skill:review/typo", commands: (): SlashCommandInfo[] => [], skills: (filePath: string) => [makeSkill("review", filePath)] },
])("embedded-slash prompt and skill tokens do not apply readonly frontmatter: $text", async (scenario) => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, "review", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands(scenario.commands(filePath));

	const result = await frontmatter.input(scenario.text);
	expect(result).toStrictEqual({ action: "continue" });
	await frontmatter.beforeAgentStart(scenario.skills(filePath));
	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

test("unknown /command without frontmatter produces no toggle", async () => {
	const frontmatter = await createFrontmatterRunner();

	await frontmatter.input("/nonexistent-cmd");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
});

testWithDir("unknown /command does not delay the next valid prompt frontmatter toggle", async ({ dir }) => {
	const filePath = await writePrompt(dir, "review", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("review", filePath)]);

	await frontmatter.input("/nonexistent-cmd");
	await frontmatter.input("/review");
	await frontmatter.beforeAgentStart();

	const entries = frontmatter.readonlyEntries();
	expect(entries).toHaveLength(1);
	expect(dataField(entries[0], "enabled")).toBe(true);
	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("input handler queues a prompt command even when the registry is unavailable until before_agent_start", async ({ dir }) => {
	const filePath = await writePrompt(dir, "late-review", true);
	const frontmatter = await createFrontmatterRunner();

	await frontmatter.input("/late-review");
	frontmatter.setCommands([makePromptCommand("late-review", filePath)]);
	await frontmatter.beforeAgentStart();

	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("late-resolved non-prompt /name does not inherit readonly from a same-named prompt file", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	const promptPath = await writePrompt(promptDir, "shared", true);
	const frontmatter = await createFrontmatterRunner({ cwd: workspace });

	await frontmatter.input("/shared");
	frontmatter.setCommands([makeResolvedCommand("shared", promptPath, "extension")]);
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

testWithDir("known non-prompt /name already present in the registry does not enqueue a deferred toggle", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	const promptPath = await writePrompt(promptDir, "shared-known", true);
	const frontmatter = await createFrontmatterRunner({ cwd: workspace });

	frontmatter.setCommands([makeResolvedCommand("shared-known", promptPath, "extension")]);
	await frontmatter.input("/shared-known");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

testWithDir("headless /name input queues no readonly toggle", async ({ dir }) => {
	const filePath = await writePrompt(dir, "headless-review", true);
	const frontmatter = await createFrontmatterRunner();
	const { runner } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("headless-review", filePath)]);

	// Only the input runs without a UI; a headless before_agent_start would drop a queued toggle itself.
	const ui = runner.getUIContext();
	runner.setUIContext(undefined, "print");
	await frontmatter.input("/headless-review");
	runner.setUIContext(ui, "tui");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

test("extension-sourced /name input with UI queues no readonly toggle", async () => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, "extension-review", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("extension-review", filePath)]);

	await frontmatter.input("/extension-review", "extension");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

test("headless before_agent_start drops a slash-command toggle queued with UI", async () => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, "dropped-review", true);
	const frontmatter = await createFrontmatterRunner();
	const { runner } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("dropped-review", filePath)]);
	await frontmatter.input("/dropped-review");

	// The UI goes away for one run and comes back: pi's runner derives `ctx.hasUI` from the bound UI.
	const ui = runner.getUIContext();
	runner.setUIContext(undefined, "tui");
	await frontmatter.beforeAgentStart();
	runner.setUIContext(ui, "tui");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

test("extension plain text without a slash stays a no-op", async () => {
	const frontmatter = await createFrontmatterRunner();

	await frontmatter.input("continue", "extension");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
});

testWithDir("unresolved /name uses trusted cwd/.pi/prompts frontmatter via deferred fallback", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	await writePrompt(promptDir, "fallback-only", true);
	const frontmatter = await createFrontmatterRunner({ cwd: workspace });

	await frontmatter.input("/fallback-only");
	await frontmatter.beforeAgentStart();

	expect((await frontmatter.writeCall())?.block).toBe(true);
	expect(dataField(frontmatter.readonlyEntries()[0], "enabled")).toBe(true);
});

testWithDir("unresolved /name uses ~/.pi/agent/prompts frontmatter via deferred fallback", async ({ dir: workspace }) => {
	await withTempHome(async (homeDir) => {
		const agentDir = join(homeDir, ".pi", "agent");
		const promptDir = join(agentDir, "prompts");
		await mkdir(promptDir, { recursive: true });
		await writePrompt(promptDir, "global-fallback", true);
		const frontmatter = await createFrontmatterRunner({ cwd: workspace, agentDir });

		await frontmatter.input("/global-fallback");
		await frontmatter.beforeAgentStart();

		expect((await frontmatter.writeCall())?.block).toBe(true);
		expect(dataField(frontmatter.readonlyEntries()[0], "enabled")).toBe(true);
	});
});

testWithDir("queued slash + extension message preserves the first pending command", async ({ dir }) => {
	const filePath = await writePrompt(dir, "my-prompt", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("my-prompt", filePath)]);

	await frontmatter.input("/my-prompt");
	await frontmatter.input("continue", "extension");
	await frontmatter.beforeAgentStart();

	expect((await frontmatter.writeCall())?.block).toBe(true);
});

test.each([
	{ streamingBehavior: "steer" as const, type: "prompt", command: makePromptCommand, text: "/target" },
	{ streamingBehavior: "followUp" as const, type: "skill", command: makeSkillCommand, text: "/skill:target" },
])("streaming readonly: true frontmatter is refused without a delayed toggle: $streamingBehavior $type", async (scenario) => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const targetPath = await writePrompt(dir, "target", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([scenario.command("target", targetPath)]);

	const result = await frontmatter.input(scenario.text, "interactive", scenario.streamingBehavior);
	expect(result).toStrictEqual({ action: "handled" });
	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toHaveLength(0);
	expect(frontmatter.fixture.ui.notifications.at(-1)?.message ?? "").toMatch(/readonly frontmatter requires an idle agent/i);

	await frontmatter.input("unrelated prompt");
	await frontmatter.beforeAgentStart();
	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toHaveLength(0);
});

test.each([
	{ streamingBehavior: "steer" as const, type: "skill", command: makeSkillCommand, text: "/skill:target" },
	{ streamingBehavior: "followUp" as const, type: "prompt", command: makePromptCommand, text: "/target" },
])("streaming readonly: false frontmatter is refused without a delayed toggle: $streamingBehavior $type", async (scenario) => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const targetPath = await writePrompt(dir, "target", false);
	const initialPath = await writePrompt(dir, "initial", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([scenario.command("target", targetPath), makePromptCommand("initial", initialPath)]);
	await frontmatter.input("/initial");
	await frontmatter.beforeAgentStart();

	const result = await frontmatter.input(scenario.text, "interactive", scenario.streamingBehavior);
	expect(result).toStrictEqual({ action: "handled" });
	expect((await frontmatter.writeCall())?.block).toBe(true);
	expect(frontmatter.readonlyEntries()).toHaveLength(1);
	expect(frontmatter.fixture.ui.notifications.at(-1)?.message ?? "").toMatch(/readonly frontmatter requires an idle agent/i);

	await frontmatter.input("unrelated prompt");
	await frontmatter.beforeAgentStart();
	expect((await frontmatter.writeCall())?.block).toBe(true);
	expect(frontmatter.readonlyEntries()).toHaveLength(1);
});

testWithDir("queued slash commands are consumed FIFO across before_agent_start calls", async ({ dir }) => {
	const filePathA = await writePrompt(dir, "cmd-a", true);
	const filePathB = await writePrompt(dir, "cmd-b", false);
	const frontmatter = await createFrontmatterRunner();
	const { host } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("cmd-a", filePathA), makePromptCommand("cmd-b", filePathB)]);

	await frontmatter.input("/cmd-a");
	await frontmatter.input("/cmd-b");

	await frontmatter.beforeAgentStart();
	expect(dataField(host.appendedEntries.at(-1), "enabled"), "first before_agent_start should consume /cmd-a").toBe(true);
	expect((await frontmatter.writeCall())?.block).toBe(true);

	await frontmatter.beforeAgentStart();
	expect(dataField(host.appendedEntries.at(-1), "enabled"), "second before_agent_start should consume /cmd-b").toBe(false);
	expect(await frontmatter.writeCall()).toBeUndefined();
});

testWithDir("non-prompt slash commands do not delay the next prompt frontmatter toggle", async ({ dir }) => {
	const filePath = await writePrompt(dir, "review", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("review", filePath)]);

	await frontmatter.input("/notebook");
	await frontmatter.input("/review");
	await frontmatter.beforeAgentStart();

	const entries = frontmatter.readonlyEntries();
	expect(entries).toHaveLength(1);
	expect(dataField(entries[0], "enabled")).toBe(true);
	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("/skill:name activates readonly from skill frontmatter", async ({ dir }) => {
	const filePath = await writePrompt(dir, "my-skill", true);
	const frontmatter = await createFrontmatterRunner();

	await frontmatter.input("/skill:my-skill");
	await frontmatter.beforeAgentStart([makeSkill("my-skill", filePath)]);

	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("/skill:name preserves dotted skill names for readonly frontmatter", async ({ dir }) => {
	const filePath = await writePrompt(dir, "review.pr", true);
	const frontmatter = await createFrontmatterRunner();

	await frontmatter.input("/skill:review.pr");
	await frontmatter.beforeAgentStart([makeSkill("review.pr", filePath)]);

	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("readonly success notifications use the exact slash-command source", async ({ dir }) => {
	const promptPath = await writePrompt(dir, "shared", true);
	const skillPath = await writePrompt(dir, "shared-skill", false);
	const frontmatter = await createFrontmatterRunner();
	const { notifications } = frontmatter.fixture.ui;
	frontmatter.setCommands([makePromptCommand("shared", promptPath)]);

	await frontmatter.input("/shared");
	await frontmatter.beforeAgentStart([makeSkill("shared", skillPath)]);
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/shared/);
	expect(notifications.at(-1)?.message ?? "").not.toMatch(/\/skill:shared/);

	await frontmatter.input("/skill:shared");
	await frontmatter.beforeAgentStart([makeSkill("shared", skillPath)]);
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/skill:shared/);
});

testWithDir("invalid /prompt readonly value records a warning for the prompt source", async ({ dir }) => {
	const filePath = join(dir, "broken-prompt.md");
	await writeFile(filePath, `---\nreadonly: "yes"\ndescription: "Broken"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("broken-prompt", filePath)]);

	await frontmatter.input("/broken-prompt");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(host.appendedEntries.at(-1), "type")).toBe("command");
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/\/broken-prompt/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/`readonly` frontmatter must be `true` or `false`/);
});

testWithDir("invalid /skill:name readonly value records a warning for the skill source", async ({ dir }) => {
	const filePath = join(dir, "broken-skill.md");
	await writeFile(filePath, `---\nreadonly: "yes"\ndescription: "Broken"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;

	await frontmatter.input("/skill:broken-skill");
	await frontmatter.beforeAgentStart([makeSkill("broken-skill", filePath)]);

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(host.appendedEntries.at(-1), "type")).toBe("skill");
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/\/skill:broken-skill/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/`readonly` frontmatter must be `true` or `false`/);
});

testWithDir("unreadable /prompt frontmatter records a warning for the prompt source", async ({ dir }) => {
	const filePath = join(dir, "dir-prompt.md");
	await mkdir(filePath, { recursive: true });
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("dir-prompt", filePath)]);

	await frontmatter.input("/dir-prompt");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(host.appendedEntries.at(-1), "type")).toBe("command");
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/\/dir-prompt/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/prompt\/skill file could not be read/);
});

testWithDir("unreadable /skill:name frontmatter records a warning for the skill source", async ({ dir }) => {
	const filePath = join(dir, "dir-skill.md");
	await mkdir(filePath, { recursive: true });
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;

	await frontmatter.input("/skill:dir-skill");
	await frontmatter.beforeAgentStart([makeSkill("dir-skill", filePath)]);

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(host.appendedEntries.at(-1), "type")).toBe("skill");
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/\/skill:dir-skill/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/prompt\/skill file could not be read/);
});

testWithDir("invalid queued frontmatter warns and the next valid queued command still toggles readonly", async ({ dir }) => {
	const brokenPath = join(dir, "broken-then-valid.md");
	await writeFile(brokenPath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const validPath = await writePrompt(dir, "valid-after-broken", true);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("broken-then-valid", brokenPath), makePromptCommand("valid-after-broken", validPath)]);

	await frontmatter.input("/broken-then-valid");
	await frontmatter.input("/valid-after-broken");
	await frontmatter.beforeAgentStart();

	expect(host.appendedEntries.at(-2)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-readonly");
	expect(dataField(host.appendedEntries.at(-1), "enabled")).toBe(true);
	expect(ui.notifications.at(-2)?.message ?? "").toMatch(/`readonly` frontmatter must be `true` or `false`/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/Readonly mode enabled/);
	expect((await frontmatter.writeCall())?.block).toBe(true);
});

testWithDir("prompt without readonly frontmatter stays a silent no-op through the deferred pipeline", async ({ dir }) => {
	const filePath = join(dir, "no-readonly.md");
	await writeFile(filePath, `---\ndescription: "No readonly"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("no-readonly", filePath)]);

	await frontmatter.input("/no-readonly");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
	expect(host.appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(ui.notifications).toHaveLength(0);
});

testWithDir("skill without readonly frontmatter stays a silent no-op through the deferred pipeline", async ({ dir }) => {
	const filePath = join(dir, "no-readonly-skill.md");
	await writeFile(filePath, `---\ndescription: "No readonly"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;

	await frontmatter.input("/skill:no-readonly-skill");
	await frontmatter.beforeAgentStart([makeSkill("no-readonly-skill", filePath)]);

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
	expect(host.appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(ui.notifications).toHaveLength(0);
});

testWithDir("/readonly bypasses deferred frontmatter lookup", async ({ dir }) => {
	const filePath = join(dir, "readonly.md");
	await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("readonly", filePath)]);

	await frontmatter.input("/readonly");
	await frontmatter.beforeAgentStart();

	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
	expect(host.appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(ui.notifications).toHaveLength(0);
});

testWithDir("/handoff bypasses deferred frontmatter lookup", async ({ dir }) => {
	const filePath = join(dir, "handoff.md");
	await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("handoff", filePath)]);

	await frontmatter.input("/handoff continue");
	await frontmatter.beforeAgentStart();

	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
	expect(host.appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(ui.notifications).toHaveLength(0);
});

testWithDir("/notebook bypasses deferred frontmatter lookup", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	await writeFile(join(promptDir, "notebook.md"), `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner({ cwd: workspace });
	const { host, ui } = frontmatter.fixture;

	await frontmatter.input("/notebook");
	await frontmatter.beforeAgentStart();

	expect(frontmatter.readonlyEntries()).toStrictEqual([]);
	expect(host.appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(ui.notifications).toHaveLength(0);
});

testWithDir("malformed /prompt frontmatter records a parse warning for the prompt source", async ({ dir }) => {
	const filePath = join(dir, "broken-yaml-prompt.md");
	await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;
	frontmatter.setCommands([makePromptCommand("broken-yaml-prompt", filePath)]);

	await frontmatter.input("/broken-yaml-prompt");
	await frontmatter.beforeAgentStart();

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(host.appendedEntries.at(-1), "type")).toBe("command");
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/\/broken-yaml-prompt/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/frontmatter could not be parsed/);
});

testWithDir("malformed /skill:name frontmatter records a parse warning for the skill source", async ({ dir }) => {
	const filePath = join(dir, "broken-yaml-skill.md");
	await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
	const frontmatter = await createFrontmatterRunner();
	const { host, ui } = frontmatter.fixture;

	await frontmatter.input("/skill:broken-yaml-skill");
	await frontmatter.beforeAgentStart([makeSkill("broken-yaml-skill", filePath)]);

	expect(await frontmatter.writeCall()).toBeUndefined();
	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(host.appendedEntries.at(-1), "type")).toBe("skill");
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/\/skill:broken-yaml-skill/);
	expect(ui.notifications.at(-1)?.message ?? "").toMatch(/frontmatter could not be parsed/);
});

test("deferred readonly enable emits a one-shot context nudge", async () => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, "nudge-on", true);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("nudge-on", filePath)]);

	await frontmatter.input("/nudge-on");
	await frontmatter.beforeAgentStart();

	frontmatter.setUsage(usageAt(20));
	const firstNudges = customMessages(await frontmatter.context(), "pi-schematic-readonly-nudge");
	expect(firstNudges).toHaveLength(1);
	expect(contentText(firstNudges[0])).toMatch(/\[readonly\]/);

	expect(customMessages(await frontmatter.context(), "pi-schematic-readonly-nudge")).toStrictEqual([]);
});

test("deferred readonly disable emits a one-shot context nudge", async () => {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, "nudge-off", false);
	const frontmatter = await createFrontmatterRunner();
	frontmatter.setCommands([makePromptCommand("nudge-off", filePath)]);
	await frontmatter.runCommand("readonly");

	await frontmatter.input("/nudge-off");
	await frontmatter.beforeAgentStart();

	frontmatter.setUsage(usageAt(40));
	const firstNudges = customMessages(await frontmatter.context(), "pi-schematic-readonly-nudge");
	expect(firstNudges).toHaveLength(1);
	expect(contentText(firstNudges[0])).toMatch(/\[readonly\] disabled/);

	expect(customMessages(await frontmatter.context(), "pi-schematic-readonly-nudge")).toHaveLength(0);
});

/**
 * Run the `name` prompt whose frontmatter sets `readonly` on a runner where a handoff is
 * already pending; resolves to the pending-handoff watchdog nudge the next context hook delivers.
 */
async function handoffNudgeAfterFrontmatter(frontmatter: FrontmatterRunner, name: string, readonly: boolean): Promise<string> {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, name, readonly);
	const { host } = frontmatter.fixture;

	frontmatter.setCommands([makePromptCommand(name, filePath)]);
	await frontmatter.input(`/${name}`);
	await frontmatter.beforeAgentStart();

	expect(host.appendedEntries.at(-1)?.customType).toBe("pi-schematic-readonly");
	expect(dataField(host.appendedEntries.at(-1), "enabled")).toBe(readonly);

	// The live context hook renders the pending-handoff nudge from the toggled
	// readonly mode, so the nudge can never go stale like a frozen summary would.
	frontmatter.setUsage({ tokens: 50000, percent: 25, contextWindow: 200000 });
	const nudge = customMessages(await frontmatter.fixture.runner.emitContext([{ role: "user", content: "continue", timestamp: 1 }]), "pi-schematic-watchdog").at(
		-1,
	);
	assertPresent(nudge, "the context hook must deliver a pending-handoff watchdog nudge");
	return contentText(nudge);
}

test("frontmatter toggle drives pending handoff nudge: readonly true", async () => {
	const frontmatter = await createFrontmatterRunner();
	await frontmatter.runCommand("handoff", "continue review");

	const nudge = await handoffNudgeAfterFrontmatter(frontmatter, "review-prompt", true);

	expect(nudge).toMatch(/temporary handoff exception active/);
	expect(nudge).toMatch(/fresh context resumes in readonly mode/i);
});

test("frontmatter toggle drives pending handoff nudge: readonly false", async () => {
	const frontmatter = await createFrontmatterRunner();
	await frontmatter.runCommand("readonly");
	await frontmatter.runCommand("handoff", "continue work");

	const nudge = await handoffNudgeAfterFrontmatter(frontmatter, "safe-prompt", false);

	expect(nudge).toMatch(/successor receives the instruction verbatim/i);
	expect(nudge).not.toMatch(/temporary handoff exception/);
});
