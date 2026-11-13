/**
 * Readonly frontmatter integration tests.
 *
 * Exercises the full pipeline:
 *   input queue → before_agent_start → consumePendingReadonlyCommands
 */

import { beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BeforeAgentStartEvent, ExtensionCommandContext, ExtensionContext, InputEvent, SlashCommandSource } from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	callHandlers,
	createCommandContext,
	createExtensionContext,
	createUIContext,
	makeReadonlyUICtx,
	registerReadonlyPI,
	testWithDir,
	tmpDir,
	withTempHome,
	type ToolCall,
} from "./helpers.js";
import { createBeforeAgentStartEvent, getCommand, getHandler, getHostRecords, type AppendedEntry, type TestPI } from "./test-host.js";
import { assertPresent } from "../assertions.js";

// pi's agent directory holds global prompts; an empty one keeps an exported
// PI_CODING_AGENT_DIR, or a populated ~/.pi/agent/prompts, out of every test.
let isolatedAgentDir: string;
beforeAll(async () => {
	isolatedAgentDir = await tmpDir();
	return () => rm(isolatedAgentDir, { recursive: true, force: true });
});
beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", isolatedAgentDir);
});

// The extension registers one input and one before_agent_start handler.
function frontmatterHandlers(pi: TestPI) {
	return {
		inputHandler: (event: Omit<InputEvent, "type">, ctx: ExtensionContext) => getHandler(pi, "input")({ type: "input", ...event }, ctx),
		beforeStartHandler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => getHandler(pi, "before_agent_start")(event, ctx),
	};
}

// A context for the input and before_agent_start handlers: without UI unless overridden, no context
// usage and no model registry, so the handlers load no model groups.
function handlerContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return createExtensionContext({ getContextUsage: () => undefined, modelRegistry: undefined, ...overrides });
}

/**
 * The result of the one context handler. The contexts here report partial usage,
 * which `ExtensionContext` does not admit, so the handler runs through callHandlers.
 */
async function runContextHandler(pi: TestPI, event: unknown, ctx: unknown): Promise<{ messages: Record<string, unknown>[] } | undefined> {
	const [result] = await callHandlers(pi, "context", event, ctx);
	if (result === undefined) {return undefined;}
	if (!isRecord(result) || !Array.isArray(result.messages)) {throw new Error("The context handler returned something other than messages.");}
	const messages: unknown[] = result.messages;
	if (!messages.every(isRecord)) {throw new Error("The context handler returned a message that is not an object.");}
	return { messages };
}

/** The `field` member of an appended entry's data; the extension writes every entry's data as an object. */
function dataField(entry: AppendedEntry | undefined, field: string): unknown {
	if (entry === undefined) {return undefined;}
	if (!isRecord(entry.data)) {throw new Error(`The "${entry.customType}" entry's data is not an object.`);}
	return entry.data[field];
}

/** A UI command context whose notifications, statuses and widgets go nowhere, with no context usage. */
function uiCommandContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	return createCommandContext({
		hasUI: true,
		ui: createUIContext({ notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }),
		getContextUsage: () => undefined,
		...overrides,
	});
}

async function writePrompt(dir: string, name: string, readonly: boolean): Promise<string> {
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\nreadonly: ${readonly}\ndescription: "Test"\n---\n\nBody content.\n`);
	return filePath;
}

function makeBeforeStartCtx(cwd = process.cwd()): ExtensionContext {
	return handlerContext({
		hasUI: true,
		ui: createUIContext({ notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }),
		cwd,
		isProjectTrusted: () => true,
	});
}

function makeNotifyBeforeStartCtx() {
	const notifications: { message: string; level: string | undefined }[] = [];
	return {
		ctx: handlerContext({
			hasUI: true,
			ui: createUIContext({
				notify: (message, level) => { notifications.push({ message, level }); },
				setStatus: vi.fn(),
				setWidget: vi.fn(),
			}),
			isProjectTrusted: () => true,
		}),
		notifications,
	};
}

function makeResolvedCommand(name: string, filePath: string, source: SlashCommandSource = "prompt") {
	return {
		name,
		source,
		description: "Test prompt",
		sourceInfo: { path: filePath, source: "test", scope: "temporary" as const, origin: "top-level" as const },
	};
}

function makePromptCommand(name: string, filePath: string) {
	return makeResolvedCommand(name, filePath, "prompt");
}

function makeSkillCommand(name: string, filePath: string) {
	return makeResolvedCommand(`skill:${name}`, filePath, "skill");
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

async function runPromptToggle(
	text: string,
	readonly: boolean,
	name = text.slice(1),
): Promise<{ toolCall: ToolCall; pi: TestPI }> {
	const dir = await tmpDir();
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	const filePath = await writePrompt(dir, name, readonly);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand(name, filePath)]);
	await inputHandler({ text, source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);
	return { pi, toolCall };
}

test("single /name input activates readonly frontmatter", async () => {
	const { toolCall } = await runPromptToggle("/my-prompt", true);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("readonly: false frontmatter keeps readonly disabled and stays silent when already disabled", async ({ dir }) => {
	const filePath = await writePrompt(dir, "safe-prompt", false);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const contextHook = (event: unknown, ctx: unknown) => runContextHandler(pi, event, ctx);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("safe-prompt", filePath)]);

	await inputHandler({ text: "/safe-prompt", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
	expect(notifications).toHaveLength(0);
	const contextResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 40 }) });
	assertPresent(contextResult, "the context hook must return the messages");
	expect(contextResult.messages.find((message) => typeof message.content === "string" && /readonly/i.test(message.content))).toBeUndefined();
});

test("suffixed /name command activates readonly frontmatter", async () => {
	const { toolCall } = await runPromptToggle("/review:1", true, "review:1");
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

test("dotted /name command activates readonly frontmatter", async () => {
	const { toolCall } = await runPromptToggle("/review.pr", true, "review.pr");
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("embedded-slash prompt and skill tokens do not apply readonly frontmatter", async ({ dir }) => {
	const cases = [
		{ text: "/review/typo", type: "prompt" as const },
		{ text: "/skill:review/typo", type: "skill" as const },
	];
	for (const scenario of cases) {
		const caseDir = await mkdtemp(join(dir, "case-"));
		const filePath = await writePrompt(caseDir, "review", true);
		const { pi, toolCall } = await registerReadonlyPI();
		const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
		const ctx = makeBeforeStartCtx();
		if (scenario.type === "prompt") {pi.setCommands([makePromptCommand("review", filePath)]);}

		const result = await inputHandler({ text: scenario.text, source: "interactive" }, ctx);
		expect(result).toStrictEqual({ action: "continue" });
		await beforeStartHandler(createBeforeAgentStartEvent({ skills: scenario.type === "skill" ? [makeSkill("review", filePath)] : [] }), ctx);
		expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
		expect(getHostRecords(pi).appendedEntries).not.toContainEqual(expect.objectContaining({ customType: "pi-schematic-readonly" }));
	}
});

test("unknown /command without frontmatter produces no toggle", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "/nonexistent-cmd", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
});

testWithDir("unknown /command does not delay the next valid prompt frontmatter toggle", async ({ dir }) => {
	const filePath = await writePrompt(dir, "review", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("review", filePath)]);

	await inputHandler({ text: "/nonexistent-cmd", source: "interactive" }, ctx);
	await inputHandler({ text: "/review", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	const entries = getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly");
	expect(entries).toHaveLength(1);
	expect(dataField(entries[0], "enabled")).toBe(true);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("before_agent_start skips readonly cache population while no slash-command toggle is pending", async ({ dir }) => {
	const filePath = join(dir, "broken.md");
	await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const { pi } = await registerReadonlyPI();
	const { beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("broken", filePath)]);

	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
});


testWithDir("input handler queues a prompt command even when the registry is unavailable until before_agent_start", async ({ dir }) => {
	const filePath = await writePrompt(dir, "late-review", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "/late-review", source: "interactive" }, ctx);
	pi.setCommands([makePromptCommand("late-review", filePath)]);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("late-resolved non-prompt /name does not inherit readonly from a same-named prompt file", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	const promptPath = await writePrompt(promptDir, "shared", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx(workspace);

	await inputHandler({ text: "/shared", source: "interactive" }, ctx);
	pi.setCommands([makeResolvedCommand("shared", promptPath, "extension")]);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
});

testWithDir("known non-prompt /name already present in the registry does not enqueue a deferred toggle", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	const promptPath = await writePrompt(promptDir, "shared-known", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx(workspace);

	pi.setCommands([makeResolvedCommand("shared-known", promptPath, "extension")]);
	await inputHandler({ text: "/shared-known", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
});

testWithDir("headless /name frontmatter stays a no-op through the deferred pipeline", async ({ dir }) => {
	const filePath = await writePrompt(dir, "headless-review", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	pi.setCommands([makePromptCommand("headless-review", filePath)]);

	await inputHandler({ text: "/headless-review", source: "interactive" }, handlerContext());
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), handlerContext({ isProjectTrusted: () => false }));

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
});

testWithDir("extension input stays a no-op when hasUI is false", async ({ dir }) => {
	const filePath = await writePrompt(dir, "headless-extension", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	pi.setCommands([makePromptCommand("headless-extension", filePath)]);

	await inputHandler({ text: "/headless-extension", source: "extension" }, handlerContext());
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), handlerContext({ isProjectTrusted: () => false }));

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
});

test("extension plain text without a slash stays a no-op", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "continue", source: "extension" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
});

testWithDir("unresolved /name uses trusted cwd/.pi/prompts frontmatter via deferred fallback", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	await writePrompt(promptDir, "fallback-only", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx(workspace);

	await inputHandler({ text: "/fallback-only", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
	expect(dataField(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly"), "enabled")).toBe(true);
});


testWithDir("unresolved /name uses ~/.pi/agent/prompts frontmatter via deferred fallback", async ({ dir: workspace }) => {
	await withTempHome(async (homeDir) => {
		const promptDir = join(homeDir, ".pi", "agent", "prompts");
		await mkdir(promptDir, { recursive: true });
		await writePrompt(promptDir, "global-fallback", true);
		const { pi, toolCall } = await registerReadonlyPI();
		const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
		const ctx = makeBeforeStartCtx(workspace);

		await inputHandler({ text: "/global-fallback", source: "interactive" }, ctx);
		await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

		expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
		expect(dataField(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly"), "enabled")).toBe(true);
	});
});

testWithDir("queued slash + extension message preserves the first pending command", async ({ dir }) => {
	const filePath = await writePrompt(dir, "my-prompt", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("my-prompt", filePath)]);

	await inputHandler({ text: "/my-prompt", source: "interactive" }, ctx);
	await inputHandler({ text: "continue", source: "extension" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("streaming readonly frontmatter is blocked without a delayed toggle", async ({ dir }) => {
	const cases = [
		{ readonly: true, streamingBehavior: "steer" as const, type: "prompt" as const },
		{ readonly: true, streamingBehavior: "followUp" as const, type: "skill" as const },
		{ readonly: false, streamingBehavior: "steer" as const, type: "skill" as const },
		{ readonly: false, streamingBehavior: "followUp" as const, type: "prompt" as const },
	];
	for (const scenario of cases) {
		const caseDir = await mkdtemp(join(dir, "case-"));
		const targetPath = await writePrompt(caseDir, "target", scenario.readonly);
		const { pi, toolCall } = await registerReadonlyPI();
		const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		const commands = [scenario.type === "skill" ? makeSkillCommand("target", targetPath) : makePromptCommand("target", targetPath)];
		if (!scenario.readonly) {
			const initialPath = await writePrompt(caseDir, "initial", true);
			commands.push(makePromptCommand("initial", initialPath));
		}
		pi.setCommands(commands);

		if (!scenario.readonly) {
			await inputHandler({ text: "/initial", source: "interactive" }, ctx);
			await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);
		}
		const readonlyEntries = getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly").length;

		const text = scenario.type === "skill" ? "/skill:target" : "/target";
		const result = await inputHandler({ text, source: "interactive", streamingBehavior: scenario.streamingBehavior }, ctx);
		expect(result).toStrictEqual({ action: "handled" });
		expect(Boolean((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block)).toBe(!scenario.readonly);
		expect(getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly")).toHaveLength(readonlyEntries);
		expect(notifications.at(-1)?.message ?? "").toMatch(/readonly frontmatter requires an idle agent/i);

		await inputHandler({ text: "unrelated prompt", source: "interactive" }, ctx);
		await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);
		expect(Boolean((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block)).toBe(!scenario.readonly);
		expect(getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly")).toHaveLength(readonlyEntries);
	}
});

testWithDir("queued slash commands are consumed FIFO across before_agent_start calls", async ({ dir }) => {
	const filePathA = await writePrompt(dir, "cmd-a", true);
	const filePathB = await writePrompt(dir, "cmd-b", false);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([
		makePromptCommand("cmd-a", filePathA),
		makePromptCommand("cmd-b", filePathB),
	]);

	await inputHandler({ text: "/cmd-a", source: "interactive" }, ctx);
	await inputHandler({ text: "/cmd-b", source: "interactive" }, ctx);

	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "enabled"), "first before_agent_start should consume /cmd-a").toBe(true);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);

	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "enabled"), "second before_agent_start should consume /cmd-b").toBe(false);
	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
});

testWithDir("non-prompt slash commands do not delay the next prompt frontmatter toggle", async ({ dir }) => {
	const filePath = await writePrompt(dir, "review", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("review", filePath)]);

	await inputHandler({ text: "/notebook", source: "interactive" }, ctx);
	await inputHandler({ text: "/review", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	const entries = getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly");
	expect(entries).toHaveLength(1);
	expect(dataField(entries[0], "enabled")).toBe(true);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("/skill:name activates readonly from skill frontmatter", async ({ dir }) => {
	const filePath = await writePrompt(dir, "my-skill", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "/skill:my-skill", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("my-skill", filePath)] }), ctx);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("/skill:name preserves dotted skill names for readonly frontmatter", async ({ dir }) => {
	const filePath = await writePrompt(dir, "review.pr", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "/skill:review.pr", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("review.pr", filePath)] }), ctx);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("readonly success notifications use the exact slash-command source", async ({ dir }) => {
	const promptPath = await writePrompt(dir, "shared", true);
	const skillPath = await writePrompt(dir, "shared-skill", false);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("shared", promptPath)]);

	await inputHandler({ text: "/shared", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("shared", skillPath)] }), ctx);
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/shared/);
	expect(notifications.at(-1)?.message ?? "").not.toMatch(/\/skill:shared/);

	await inputHandler({ text: "/skill:shared", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("shared", skillPath)] }), ctx);
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/skill:shared/);
});

testWithDir("invalid /prompt readonly value records a warning for the prompt source", async ({ dir }) => {
	const filePath = join(dir, "broken-prompt.md");
	await writeFile(filePath, `---\nreadonly: "yes"\ndescription: "Broken"\n---\n\nBody content.\n`);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("broken-prompt", filePath)]);

	await inputHandler({ text: "/broken-prompt", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "type")).toBe("command");
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/broken-prompt/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/`readonly` frontmatter must be `true` or `false`/);
});

testWithDir("invalid /skill:name readonly value records a warning for the skill source", async ({ dir }) => {
	const filePath = join(dir, "broken-skill.md");
	await writeFile(filePath, `---\nreadonly: "yes"\ndescription: "Broken"\n---\n\nBody content.\n`);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();

	await inputHandler({ text: "/skill:broken-skill", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("broken-skill", filePath)] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "type")).toBe("skill");
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/skill:broken-skill/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/`readonly` frontmatter must be `true` or `false`/);
});

testWithDir("unreadable /prompt frontmatter records a warning for the prompt source", async ({ dir }) => {
	const filePath = join(dir, "dir-prompt.md");
	await mkdir(filePath, { recursive: true });
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("dir-prompt", filePath)]);

	await inputHandler({ text: "/dir-prompt", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "type")).toBe("command");
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/dir-prompt/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/prompt\/skill file could not be read/);
});

testWithDir("unreadable /skill:name frontmatter records a warning for the skill source", async ({ dir }) => {
	const filePath = join(dir, "dir-skill.md");
	await mkdir(filePath, { recursive: true });
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();

	await inputHandler({ text: "/skill:dir-skill", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("dir-skill", filePath)] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "type")).toBe("skill");
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/skill:dir-skill/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/prompt\/skill file could not be read/);
});

testWithDir("invalid queued frontmatter warns and the next valid queued command still toggles readonly", async ({ dir }) => {
	const brokenPath = join(dir, "broken-then-valid.md");
	await writeFile(brokenPath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const validPath = await writePrompt(dir, "valid-after-broken", true);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([
		makePromptCommand("broken-then-valid", brokenPath),
		makePromptCommand("valid-after-broken", validPath),
	]);

	await inputHandler({ text: "/broken-then-valid", source: "interactive" }, ctx);
	await inputHandler({ text: "/valid-after-broken", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(getHostRecords(pi).appendedEntries.at(-2)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-readonly");
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "enabled")).toBe(true);
	expect(notifications.at(-2)?.message ?? "").toMatch(/`readonly` frontmatter must be `true` or `false`/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/Readonly mode enabled/);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

testWithDir("prompt without readonly frontmatter stays a silent no-op through the deferred pipeline", async ({ dir }) => {
	const filePath = join(dir, "no-readonly.md");
	await writeFile(filePath, `---\ndescription: "No readonly"\n---\n\nBody content.\n`);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("no-readonly", filePath)]);

	await inputHandler({ text: "/no-readonly", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(notifications).toHaveLength(0);
});

testWithDir("skill without readonly frontmatter stays a silent no-op through the deferred pipeline", async ({ dir }) => {
	const filePath = join(dir, "no-readonly-skill.md");
	await writeFile(filePath, `---\ndescription: "No readonly"\n---\n\nBody content.\n`);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();

	await inputHandler({ text: "/skill:no-readonly-skill", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("no-readonly-skill", filePath)] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(notifications).toHaveLength(0);
});

testWithDir("/readonly bypasses deferred frontmatter lookup", async ({ dir }) => {
	const filePath = join(dir, "readonly.md");
	await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("readonly", filePath)]);

	await inputHandler({ text: "/readonly", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(notifications).toHaveLength(0);
});

testWithDir("/handoff bypasses deferred frontmatter lookup", async ({ dir }) => {
	const filePath = join(dir, "handoff.md");
	await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("handoff", filePath)]);

	await inputHandler({ text: "/handoff continue", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(notifications).toHaveLength(0);
});

testWithDir("/notebook bypasses deferred frontmatter lookup", async ({ dir: workspace }) => {
	const promptDir = join(workspace, ".pi", "prompts");
	await mkdir(promptDir, { recursive: true });
	await writeFile(join(promptDir, "notebook.md"), `---\nreadonly: "yes"\n---\n\nBody content.\n`);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();

	await inputHandler({ text: "/notebook", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), {
		...ctx,
		cwd: workspace,
		isProjectTrusted: () => true,
	});

	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-readonly")).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.find((entry) => entry.customType === "pi-schematic-frontmatter-issue")).toBeUndefined();
	expect(notifications).toHaveLength(0);
});

testWithDir("malformed /prompt frontmatter records a parse warning for the prompt source", async ({ dir }) => {
	const filePath = join(dir, "broken-yaml-prompt.md");
	await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();
	pi.setCommands([makePromptCommand("broken-yaml-prompt", filePath)]);

	await inputHandler({ text: "/broken-yaml-prompt", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/broken-yaml-prompt/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/frontmatter could not be parsed/);
});

testWithDir("malformed /skill:name frontmatter records a parse warning for the skill source", async ({ dir }) => {
	const filePath = join(dir, "broken-yaml-skill.md");
	await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
	const { pi, toolCall } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const { ctx, notifications } = makeNotifyBeforeStartCtx();

	await inputHandler({ text: "/skill:broken-yaml-skill", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [makeSkill("broken-yaml-skill", filePath)] }), ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-frontmatter-issue");
	expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "type")).toBe("skill");
	expect(notifications.at(-1)?.message ?? "").toMatch(/\/skill:broken-yaml-skill/);
	expect(notifications.at(-1)?.message ?? "").toMatch(/frontmatter could not be parsed/);
});

testWithDir("deferred readonly enable emits a one-shot context nudge", async ({ dir }) => {
	const filePath = await writePrompt(dir, "nudge-on", true);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const contextHook = (event: unknown, ctx: unknown) => runContextHandler(pi, event, ctx);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("nudge-on", filePath)]);

	await inputHandler({ text: "/nudge-on", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	const firstResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 20 }) });
	expect(firstResult?.messages.filter((message) => message.customType === "pi-schematic-readonly-nudge")).toHaveLength(1);
	expect(firstResult?.messages.find((message) => message.customType === "pi-schematic-readonly-nudge")?.content ?? "").toMatch(/\[readonly\]/);

	const secondResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 20 }) });
	expect(secondResult?.messages.find((message) => message.customType === "pi-schematic-readonly-nudge")).toBeUndefined();
});

testWithDir("deferred readonly disable emits a one-shot context nudge", async ({ dir }) => {
	const filePath = await writePrompt(dir, "nudge-off", false);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const contextHook = (event: unknown, ctx: unknown) => runContextHandler(pi, event, ctx);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("nudge-off", filePath)]);
	await getCommand(pi, "readonly").handler("", uiCommandContext());

	await inputHandler({ text: "/nudge-off", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	const firstResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 40 }) });
	expect(firstResult?.messages.filter((message) => message.customType === "pi-schematic-readonly-nudge")).toHaveLength(1);
	expect(firstResult?.messages.find((message) => message.customType === "pi-schematic-readonly-nudge")?.content ?? "").toMatch(/\[readonly\] disabled/);

	const secondResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 40 }) });
	expect(secondResult?.messages.filter((message) => message.customType === "pi-schematic-readonly-nudge").length ?? 0).toBe(0);
});

testWithDir("one readonly entry is appended per consumed queued toggle", async ({ dir }) => {
	const filePath = await writePrompt(dir, "prompt-a", true);
	const { pi } = await registerReadonlyPI();
	const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand("prompt-a", filePath)]);

	await inputHandler({ text: "/prompt-a", source: "interactive" }, ctx);
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

	const entries = getHostRecords(pi).appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly");
	expect(entries).toHaveLength(1);
	expect(dataField(entries[0], "enabled")).toBe(true);
});

async function assertHandoffAlignment(name: string, readonly: boolean, direction: string): Promise<void> {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, name, readonly);
		const { pi } = await registerReadonlyPI();
		const { inputHandler, beforeStartHandler } = frontmatterHandlers(pi);
		const ctx = makeBeforeStartCtx();

		await getCommand(pi, "readonly").handler("", uiCommandContext());
		await getCommand(pi, "handoff").handler(direction, uiCommandContext({ isIdle: () => true }));

		pi.setCommands([makePromptCommand(name, filePath)]);
		await inputHandler({ text: `/${name}`, source: "interactive" }, ctx);
		await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), ctx);

		expect(getHostRecords(pi).appendedEntries.at(-1)?.customType).toBe("pi-schematic-readonly");
		expect(dataField(getHostRecords(pi).appendedEntries.at(-1), "enabled")).toBe(readonly);

		// The live context hook renders the pending-handoff nudge from the toggled
		// readonly mode, so the nudge can never go stale like a frozen summary would.
		const contextHandler = (event: unknown, ctx: unknown) => runContextHandler(pi, event, ctx);
		const result = await contextHandler(
			{ messages: [{ role: "user", content: "continue", timestamp: 1 }] },
			makeReadonlyUICtx({
				ui: createUIContext({ notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }),
				getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }),
			}),
		);
		const nudge = result?.messages.filter((message) => message.customType === "pi-schematic-watchdog").at(-1);
		assertPresent(nudge, "the context hook must deliver a pending-handoff watchdog nudge");
		if (readonly) {
			expect(nudge.content).toMatch(/temporary handoff exception active/);
			expect(nudge.content).toMatch(/fresh context resumes in readonly mode/i);
		} else {
			expect(nudge.content).toMatch(/successor receives the instruction verbatim/i);
			expect(nudge.content).not.toMatch(/temporary handoff exception/);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("frontmatter toggle drives pending handoff nudge: readonly true", async () => {
	await assertHandoffAlignment("review-prompt", true, "continue review");
});

test("frontmatter toggle drives pending handoff nudge: readonly false", async () => {
	await assertHandoffAlignment("safe-prompt", false, "continue work");
});
