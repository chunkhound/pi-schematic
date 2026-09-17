/**
 * Readonly frontmatter integration tests.
 *
 * Exercises the full pipeline:
 *   input queue → before_agent_start → consumePendingReadonlyCommands
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerReadonlyPI, makeReadonlyUICtx, tmpDir, withTempHome } from "./helpers.js";

async function writePrompt(dir: string, name: string, readonly: boolean): Promise<string> {
	const filePath = join(dir, `${name}.md`);
	await writeFile(filePath, `---\nreadonly: ${readonly}\ndescription: "Test"\n---\n\nBody content.\n`);
	return filePath;
}

function makeBeforeStartCtx(cwd = process.cwd()) {
	return {
		...makeReadonlyUICtx(),
		cwd,
		isProjectTrusted: () => true,
	};
}

function makeNotifyBeforeStartCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		ctx: {
			...makeReadonlyUICtx({
				ui: {
					notify: (message: string, level: string) => { notifications.push({ message, level }); },
					theme: { fg: (_name: string, text: string) => text },
					setStatus: () => {},
					setWidget: () => {},
				},
			}),
			cwd: process.cwd(),
			isProjectTrusted: () => true,
		},
		notifications,
	};
}

function makeResolvedCommand(name: string, filePath: string, source: "prompt" | "builtin" | "skill" = "prompt") {
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
): Promise<{ toolCall: ReturnType<typeof registerReadonlyPI>["toolCall"]; pi: ReturnType<typeof registerReadonlyPI>["pi"] }> {
	const dir = await tmpDir();
	const filePath = await writePrompt(dir, name, readonly);
	const { pi, toolCall } = registerReadonlyPI();
	const [inputHandler] = pi.handlers.get("input")!;
	const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
	const ctx = makeBeforeStartCtx();
	pi.setCommands([makePromptCommand(name, filePath)]);
	await inputHandler({ text, source: "interactive" }, ctx);
	await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);
	await rm(dir, { recursive: true, force: true });
	return { pi, toolCall };
}

test("single /name input activates readonly frontmatter", async () => {
	const { toolCall } = await runPromptToggle("/my-prompt", true);
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
});

test("readonly: false frontmatter keeps readonly disabled and stays silent when already disabled", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "safe-prompt", false);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const [contextHook] = pi.handlers.get("context")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("safe-prompt", filePath)]);

		await inputHandler({ text: "/safe-prompt", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
		assert.equal(notifications.length, 0);
		const contextResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 40 }) });
		assert.equal(contextResult.messages.find((message: any) => /readonly/i.test(message.content ?? "")), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("suffixed /name command activates readonly frontmatter", async () => {
	const { toolCall } = await runPromptToggle("/review:1", true, "review:1");
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
});

test("dotted /name command activates readonly frontmatter", async () => {
	const { toolCall } = await runPromptToggle("/review.pr", true, "review.pr");
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
});

test("embedded-slash prompt and skill tokens do not apply readonly frontmatter", async () => {
	const cases = [
		{ text: "/review/typo", type: "prompt" as const },
		{ text: "/skill:review/typo", type: "skill" as const },
	];
	for (const scenario of cases) {
		const dir = await tmpDir();
		try {
			const filePath = await writePrompt(dir, "review", true);
			const { pi, toolCall } = registerReadonlyPI();
			const [inputHandler] = pi.handlers.get("input")!;
			const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
			const ctx = makeBeforeStartCtx();
			if (scenario.type === "prompt") pi.setCommands([makePromptCommand("review", filePath)]);

			const result = await inputHandler({ text: scenario.text, source: "interactive" }, ctx);
			assert.deepEqual(result, { action: "continue" });
			await beforeStartHandler({
				systemPrompt: "",
				systemPromptOptions: { skills: scenario.type === "skill" ? [makeSkill("review", filePath)] : [] },
			}, ctx);
			assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
			assert.equal(pi.appendedEntries.some((entry: any) => entry.customType === "agenticoding-readonly"), false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("unknown /command without frontmatter produces no toggle", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	const [inputHandler] = pi.handlers.get("input")!;
	const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "/nonexistent-cmd", source: "interactive" }, ctx);
	await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

	assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
});

test("unknown /command does not delay the next valid prompt frontmatter toggle", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "review", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("review", filePath)]);

		await inputHandler({ text: "/nonexistent-cmd", source: "interactive" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		const entries = pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-readonly");
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.data.enabled, true);
		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("before_agent_start skips readonly cache population while no slash-command toggle is pending", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken.md");
		await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
		const { pi } = registerReadonlyPI();
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("broken", filePath)]);

		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-frontmatter-issue"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});


test("input handler queues a prompt command even when the registry is unavailable until before_agent_start", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "late-review", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();

		await inputHandler({ text: "/late-review", source: "interactive" }, ctx);
		pi.setCommands([makePromptCommand("late-review", filePath)]);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("late-resolved non-prompt /name does not inherit readonly from a same-named prompt file", async () => {
	const workspace = await tmpDir();
	try {
		const promptDir = join(workspace, ".pi", "prompts");
		await mkdir(promptDir, { recursive: true });
		const promptPath = await writePrompt(promptDir, "shared", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx(workspace);

		await inputHandler({ text: "/shared", source: "interactive" }, ctx);
		pi.setCommands([makeResolvedCommand("shared", promptPath, "builtin")]);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("known non-prompt /name already present in the registry does not enqueue a deferred toggle", async () => {
	const workspace = await tmpDir();
	try {
		const promptDir = join(workspace, ".pi", "prompts");
		await mkdir(promptDir, { recursive: true });
		const promptPath = await writePrompt(promptDir, "shared-known", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx(workspace);

		pi.setCommands([makeResolvedCommand("shared-known", promptPath, "builtin")]);
		await inputHandler({ text: "/shared-known", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("headless /name frontmatter stays a no-op through the deferred pipeline", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "headless-review", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		pi.setCommands([makePromptCommand("headless-review", filePath)]);

		await inputHandler({ text: "/headless-review", source: "interactive" }, {
			hasUI: false,
			getContextUsage: () => null,
		} as any);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, {
			hasUI: false,
			cwd: process.cwd(),
			isProjectTrusted: () => false,
			getContextUsage: () => null,
		} as any);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extension input stays a no-op when hasUI is false", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "headless-extension", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		pi.setCommands([makePromptCommand("headless-extension", filePath)]);

		await inputHandler({ text: "/headless-extension", source: "extension" }, {
			hasUI: false,
			getContextUsage: () => null,
		} as any);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, {
			hasUI: false,
			cwd: process.cwd(),
			isProjectTrusted: () => false,
			getContextUsage: () => null,
		} as any);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extension plain text without a slash stays a no-op", async () => {
	const { pi, toolCall } = registerReadonlyPI();
	const [inputHandler] = pi.handlers.get("input")!;
	const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
	const ctx = makeBeforeStartCtx();

	await inputHandler({ text: "continue", source: "extension" }, ctx);
	await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

	assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
	assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
});

test("unresolved /name uses trusted cwd/.pi/prompts frontmatter via deferred fallback", async () => {
	const workspace = await tmpDir();
	try {
		const promptDir = join(workspace, ".pi", "prompts");
		await mkdir(promptDir, { recursive: true });
		await writePrompt(promptDir, "fallback-only", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx(workspace);

		await inputHandler({ text: "/fallback-only", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly")?.data.enabled, true);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});


test("unresolved /name uses ~/.pi/agent/prompts frontmatter via deferred fallback", async () => {
	await withTempHome(async (homeDir) => {
		const workspace = await tmpDir();
		try {
			const promptDir = join(homeDir, ".pi", "agent", "prompts");
			await mkdir(promptDir, { recursive: true });
			await writePrompt(promptDir, "global-fallback", true);
			const { pi, toolCall } = registerReadonlyPI();
			const [inputHandler] = pi.handlers.get("input")!;
			const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
			const ctx = makeBeforeStartCtx(workspace);

			await inputHandler({ text: "/global-fallback", source: "interactive" }, ctx);
			await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

			assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
			assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly")?.data.enabled, true);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

test("queued slash + extension message preserves the first pending command", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "my-prompt", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("my-prompt", filePath)]);

		await inputHandler({ text: "/my-prompt", source: "interactive" }, ctx);
		await inputHandler({ text: "continue", source: "extension" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("streaming readonly frontmatter is blocked without a delayed toggle", async () => {
	const cases = [
		{ readonly: true, streamingBehavior: "steer" as const, type: "prompt" as const },
		{ readonly: true, streamingBehavior: "followUp" as const, type: "skill" as const },
		{ readonly: false, streamingBehavior: "steer" as const, type: "skill" as const },
		{ readonly: false, streamingBehavior: "followUp" as const, type: "prompt" as const },
	];
	for (const scenario of cases) {
		const dir = await tmpDir();
		try {
			const targetPath = await writePrompt(dir, "target", scenario.readonly);
			const { pi, toolCall } = registerReadonlyPI();
			const [inputHandler] = pi.handlers.get("input")!;
			const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
			const { ctx, notifications } = makeNotifyBeforeStartCtx();
			const commands = [scenario.type === "skill" ? makeSkillCommand("target", targetPath) : makePromptCommand("target", targetPath)];
			if (!scenario.readonly) {
				const initialPath = await writePrompt(dir, "initial", true);
				commands.push(makePromptCommand("initial", initialPath));
			}
			pi.setCommands(commands);

			if (!scenario.readonly) {
				await inputHandler({ text: "/initial", source: "interactive" }, ctx);
				await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);
			}
			const readonlyEntries = pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-readonly").length;

			const text = scenario.type === "skill" ? "/skill:target" : "/target";
			const result = await inputHandler({ text, source: "interactive", streamingBehavior: scenario.streamingBehavior }, ctx);
			assert.deepEqual(result, { action: "handled" });
			assert.equal(Boolean((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block), !scenario.readonly);
			assert.equal(pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-readonly").length, readonlyEntries);
			assert.match(notifications.at(-1)?.message ?? "", /readonly frontmatter requires an idle agent/i);

			await inputHandler({ text: "unrelated prompt", source: "interactive" }, ctx);
			await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);
			assert.equal(Boolean((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block), !scenario.readonly);
			assert.equal(pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-readonly").length, readonlyEntries);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("queued slash commands are consumed FIFO across before_agent_start calls", async () => {
	const dir = await tmpDir();
	try {
		const filePathA = await writePrompt(dir, "cmd-a", true);
		const filePathB = await writePrompt(dir, "cmd-b", false);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([
			makePromptCommand("cmd-a", filePathA),
			makePromptCommand("cmd-b", filePathB),
		]);

		await inputHandler({ text: "/cmd-a", source: "interactive" }, ctx);
		await inputHandler({ text: "/cmd-b", source: "interactive" }, ctx);

		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);
		assert.equal(pi.appendedEntries.at(-1)?.data.enabled, true, "first before_agent_start should consume /cmd-a");
		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);

		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);
		assert.equal(pi.appendedEntries.at(-1)?.data.enabled, false, "second before_agent_start should consume /cmd-b");
		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("non-prompt slash commands do not delay the next prompt frontmatter toggle", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "review", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("review", filePath)]);

		await inputHandler({ text: "/notebook", source: "interactive" }, ctx);
		await inputHandler({ text: "/review", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		const entries = pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-readonly");
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.data.enabled, true);
		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/skill:name activates readonly from skill frontmatter", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "my-skill", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();

		await inputHandler({ text: "/skill:my-skill", source: "interactive" }, ctx);
		await beforeStartHandler({
			systemPrompt: "",
			systemPromptOptions: { skills: [makeSkill("my-skill", filePath)] },
		}, ctx);

		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/skill:name preserves dotted skill names for readonly frontmatter", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "review.pr", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();

		await inputHandler({ text: "/skill:review.pr", source: "interactive" }, ctx);
		await beforeStartHandler({
			systemPrompt: "",
			systemPromptOptions: { skills: [makeSkill("review.pr", filePath)] },
		}, ctx);

		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readonly success notifications use the exact slash-command source", async () => {
	const dir = await tmpDir();
	try {
		const promptPath = await writePrompt(dir, "shared", true);
		const skillPath = await writePrompt(dir, "shared-skill", false);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("shared", promptPath)]);

		await inputHandler({ text: "/shared", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [makeSkill("shared", skillPath)] } }, ctx);
		assert.match(notifications.at(-1)?.message ?? "", /\/shared/);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /\/skill:shared/);

		await inputHandler({ text: "/skill:shared", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [makeSkill("shared", skillPath)] } }, ctx);
		assert.match(notifications.at(-1)?.message ?? "", /\/skill:shared/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("invalid /prompt readonly value records a warning for the prompt source", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken-prompt.md");
		await writeFile(filePath, `---\nreadonly: "yes"\ndescription: "Broken"\n---\n\nBody content.\n`);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("broken-prompt", filePath)]);

		await inputHandler({ text: "/broken-prompt", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-frontmatter-issue");
		assert.equal(pi.appendedEntries.at(-1)?.data.type, "command");
		assert.match(notifications.at(-1)?.message ?? "", /\/broken-prompt/);
		assert.match(notifications.at(-1)?.message ?? "", /`readonly` frontmatter must be `true` or `false`/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("invalid /skill:name readonly value records a warning for the skill source", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken-skill.md");
		await writeFile(filePath, `---\nreadonly: "yes"\ndescription: "Broken"\n---\n\nBody content.\n`);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();

		await inputHandler({ text: "/skill:broken-skill", source: "interactive" }, ctx);
		await beforeStartHandler({
			systemPrompt: "",
			systemPromptOptions: { skills: [makeSkill("broken-skill", filePath)] },
		}, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-frontmatter-issue");
		assert.equal(pi.appendedEntries.at(-1)?.data.type, "skill");
		assert.match(notifications.at(-1)?.message ?? "", /\/skill:broken-skill/);
		assert.match(notifications.at(-1)?.message ?? "", /`readonly` frontmatter must be `true` or `false`/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("unreadable /prompt frontmatter records a warning for the prompt source", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "dir-prompt.md");
		await mkdir(filePath, { recursive: true });
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("dir-prompt", filePath)]);

		await inputHandler({ text: "/dir-prompt", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-frontmatter-issue");
		assert.equal(pi.appendedEntries.at(-1)?.data.type, "command");
		assert.match(notifications.at(-1)?.message ?? "", /\/dir-prompt/);
		assert.match(notifications.at(-1)?.message ?? "", /prompt\/skill file could not be read/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("unreadable /skill:name frontmatter records a warning for the skill source", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "dir-skill.md");
		await mkdir(filePath, { recursive: true });
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();

		await inputHandler({ text: "/skill:dir-skill", source: "interactive" }, ctx);
		await beforeStartHandler({
			systemPrompt: "",
			systemPromptOptions: { skills: [makeSkill("dir-skill", filePath)] },
		}, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-frontmatter-issue");
		assert.equal(pi.appendedEntries.at(-1)?.data.type, "skill");
		assert.match(notifications.at(-1)?.message ?? "", /\/skill:dir-skill/);
		assert.match(notifications.at(-1)?.message ?? "", /prompt\/skill file could not be read/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("invalid queued frontmatter warns and the next valid queued command still toggles readonly", async () => {
	const dir = await tmpDir();
	try {
		const brokenPath = join(dir, "broken-then-valid.md");
		await writeFile(brokenPath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
		const validPath = await writePrompt(dir, "valid-after-broken", true);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([
			makePromptCommand("broken-then-valid", brokenPath),
			makePromptCommand("valid-after-broken", validPath),
		]);

		await inputHandler({ text: "/broken-then-valid", source: "interactive" }, ctx);
		await inputHandler({ text: "/valid-after-broken", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(pi.appendedEntries.at(-2)?.customType, "agenticoding-frontmatter-issue");
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-readonly");
		assert.equal(pi.appendedEntries.at(-1)?.data.enabled, true);
		assert.match(notifications.at(-2)?.message ?? "", /`readonly` frontmatter must be `true` or `false`/);
		assert.match(notifications.at(-1)?.message ?? "", /Readonly mode enabled/);
		assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("prompt without readonly frontmatter stays a silent no-op through the deferred pipeline", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "no-readonly.md");
		await writeFile(filePath, `---\ndescription: "No readonly"\n---\n\nBody content.\n`);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("no-readonly", filePath)]);

		await inputHandler({ text: "/no-readonly", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-frontmatter-issue"), undefined);
		assert.equal(notifications.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("skill without readonly frontmatter stays a silent no-op through the deferred pipeline", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "no-readonly-skill.md");
		await writeFile(filePath, `---\ndescription: "No readonly"\n---\n\nBody content.\n`);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();

		await inputHandler({ text: "/skill:no-readonly-skill", source: "interactive" }, ctx);
		await beforeStartHandler({
			systemPrompt: "",
			systemPromptOptions: { skills: [makeSkill("no-readonly-skill", filePath)] },
		}, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-frontmatter-issue"), undefined);
		assert.equal(notifications.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/readonly bypasses deferred frontmatter lookup", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "readonly.md");
		await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("readonly", filePath)]);

		await inputHandler({ text: "/readonly", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-frontmatter-issue"), undefined);
		assert.equal(notifications.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/handoff bypasses deferred frontmatter lookup", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "handoff.md");
		await writeFile(filePath, `---\nreadonly: "yes"\n---\n\nBody content.\n`);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("handoff", filePath)]);

		await inputHandler({ text: "/handoff continue", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-frontmatter-issue"), undefined);
		assert.equal(notifications.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("/notebook bypasses deferred frontmatter lookup", async () => {
	const workspace = await tmpDir();
	try {
		const promptDir = join(workspace, ".pi", "prompts");
		await mkdir(promptDir, { recursive: true });
		await writeFile(join(promptDir, "notebook.md"), `---\nreadonly: "yes"\n---\n\nBody content.\n`);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();

		await inputHandler({ text: "/notebook", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, {
			...ctx,
			cwd: workspace,
			isProjectTrusted: () => true,
		});

		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-readonly"), undefined);
		assert.equal(pi.appendedEntries.find((entry: any) => entry.customType === "agenticoding-frontmatter-issue"), undefined);
		assert.equal(notifications.length, 0);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("malformed /prompt frontmatter records a parse warning for the prompt source", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken-yaml-prompt.md");
		await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();
		pi.setCommands([makePromptCommand("broken-yaml-prompt", filePath)]);

		await inputHandler({ text: "/broken-yaml-prompt", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-frontmatter-issue");
		assert.match(notifications.at(-1)?.message ?? "", /\/broken-yaml-prompt/);
		assert.match(notifications.at(-1)?.message ?? "", /frontmatter could not be parsed/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("malformed /skill:name frontmatter records a parse warning for the skill source", async () => {
	const dir = await tmpDir();
	try {
		const filePath = join(dir, "broken-yaml-skill.md");
		await writeFile(filePath, `---\nreadonly: [\n---\n\nBody content.\n`);
		const { pi, toolCall } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const { ctx, notifications } = makeNotifyBeforeStartCtx();

		await inputHandler({ text: "/skill:broken-yaml-skill", source: "interactive" }, ctx);
		await beforeStartHandler({
			systemPrompt: "",
			systemPromptOptions: { skills: [makeSkill("broken-yaml-skill", filePath)] },
		}, ctx);

		assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-frontmatter-issue");
		assert.equal(pi.appendedEntries.at(-1)?.data.type, "skill");
		assert.match(notifications.at(-1)?.message ?? "", /\/skill:broken-yaml-skill/);
		assert.match(notifications.at(-1)?.message ?? "", /frontmatter could not be parsed/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("deferred readonly enable emits a one-shot context nudge", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "nudge-on", true);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const [contextHook] = pi.handlers.get("context")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("nudge-on", filePath)]);

		await inputHandler({ text: "/nudge-on", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		const firstResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 20 }) });
		assert.equal(firstResult.messages.filter((message: any) => message.customType === "agenticoding-readonly-nudge").length, 1);
		assert.match(firstResult.messages.find((message: any) => message.customType === "agenticoding-readonly-nudge")?.content ?? "", /\[readonly\]/);

		const secondResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 20 }) });
		assert.equal(secondResult?.messages?.find((message: any) => message.customType === "agenticoding-readonly-nudge"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("deferred readonly disable emits a one-shot context nudge", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "nudge-off", false);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const [contextHook] = pi.handlers.get("context")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("nudge-off", filePath)]);
		await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

		await inputHandler({ text: "/nudge-off", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		const firstResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 40 }) });
		assert.equal(firstResult.messages.filter((message: any) => message.customType === "agenticoding-readonly-nudge").length, 1);
		assert.match(firstResult.messages.find((message: any) => message.customType === "agenticoding-readonly-nudge")?.content ?? "", /\[readonly\] disabled/);

		const secondResult = await contextHook({ messages: [] }, { getContextUsage: () => ({ percent: 40 }) });
		assert.equal(secondResult?.messages?.filter((message: any) => message.customType === "agenticoding-readonly-nudge").length ?? 0, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("one readonly entry is appended per consumed queued toggle", async () => {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, "prompt-a", true);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();
		pi.setCommands([makePromptCommand("prompt-a", filePath)]);

		await inputHandler({ text: "/prompt-a", source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		const entries = pi.appendedEntries.filter((entry: any) => entry.customType === "agenticoding-readonly");
		assert.equal(entries.length, 1);
		assert.equal(entries[0].data.enabled, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

async function assertHandoffAlignment(name: string, readonly: boolean, direction: string): Promise<void> {
	const dir = await tmpDir();
	try {
		const filePath = await writePrompt(dir, name, readonly);
		const { pi } = registerReadonlyPI();
		const [inputHandler] = pi.handlers.get("input")!;
		const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;
		const ctx = makeBeforeStartCtx();

		await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
		await pi.commands.get("handoff").handler(direction, {
			...makeReadonlyUICtx(),
			isIdle: () => true,
		} as any);

		pi.setCommands([makePromptCommand(name, filePath)]);
		await inputHandler({ text: `/${name}`, source: "interactive" }, ctx);
		await beforeStartHandler({ systemPrompt: "", systemPromptOptions: { skills: [] } }, ctx);

		assert.equal(pi.appendedEntries.at(-1)?.customType, "agenticoding-readonly");
		assert.equal(pi.appendedEntries.at(-1)?.data.enabled, readonly);

		// The live context hook renders the pending-handoff nudge from the toggled
		// readonly mode, so the nudge can never go stale like a frozen summary would.
		const [contextHandler] = pi.handlers.get("context")!;
		const result = await contextHandler(
			{ messages: [{ role: "user", content: "continue", timestamp: 1 }] },
			makeReadonlyUICtx({ getContextUsage: () => ({ tokens: 50000, percent: 25, contextWindow: 200000 }) }),
		);
		const nudge = result.messages.filter((message: any) => message.customType === "agenticoding-watchdog").at(-1);
		assert.ok(nudge, "the context hook must deliver a pending-handoff watchdog nudge");
		if (readonly) {
			assert.match(nudge.content, /temporary handoff exception active/);
			assert.match(nudge.content, /fresh context resumes in readonly mode/i);
		} else {
			assert.match(nudge.content, /successor receives the instruction verbatim/i);
			assert.doesNotMatch(nudge.content, /temporary handoff exception/);
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
