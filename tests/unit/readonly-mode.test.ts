import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { registerReadonlyPI, makeReadonlyUICtx } from "./helpers.js";

test("readonly toggle on blocks write, edit, handoff, and bash mutations", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const ctx = makeReadonlyUICtx();

	await pi.commands.get("readonly").handler("", ctx as any);

	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
	assert.equal((await toolCall({ toolName: "edit", input: { path: "/tmp/x", edits: [] } }, {})).block, true);
	assert.equal((await toolCall({ toolName: "handoff", input: { task: "pivot" } }, {})).block, true);
	assert.equal((await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/workspace" })).block, true);
	assert.equal(await toolCall({ toolName: "bash", input: { command: `rm ${os.tmpdir()}/x` } }, { cwd: "/workspace" }), undefined);
	assert.equal(await toolCall({ toolName: "read", input: { path: "/tmp/x" } }, {}), undefined);
});

test("readonly toggle off restores write, handoff, and bash access", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const ctx = makeReadonlyUICtx();

	await pi.commands.get("readonly").handler("", ctx as any);
	await pi.commands.get("readonly").handler("", ctx as any);

	assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
	assert.equal(await toolCall({ toolName: "handoff", input: { task: "pivot" } }, {}), undefined);
	assert.equal(await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/workspace" }), undefined);
});

test("readonly toggle is a no-op in headless mode", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const [inputHandler] = pi.handlers.get("input")!;
	const [beforeStartHandler] = pi.handlers.get("before_agent_start")!;

	// Toggle readonly via the command handler with hasUI: false.
	// The handler guards on ctx.hasUI — in headless mode the toggle
	// is a no-op, preserving the contract: readonly is a TUI-only feature.
	await pi.commands.get("readonly").handler("", {
		hasUI: false,
		getContextUsage: () => null,
	} as any);

	await inputHandler({ text: "/review", source: "interactive" }, {
		hasUI: false,
		getContextUsage: () => null,
	} as any);
	await beforeStartHandler({
		systemPrompt: "",
		systemPromptOptions: { skills: [] },
	}, {
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		getContextUsage: () => null,
	} as any);

	// Write should remain unblocked for both manual and deferred readonly paths.
	assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);
});

test("readonly shortcut only toggles while idle", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const shortcut = pi.shortcuts.get("ctrl+shift+r");
	assert.ok(shortcut);

	await shortcut.handler({ ...makeReadonlyUICtx(), isIdle: () => false } as any);
	assert.equal(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}), undefined);

	await shortcut.handler({ ...makeReadonlyUICtx(), isIdle: () => true } as any);
	assert.equal((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block, true);
});

test("readonly toggle delivers an activation nudge via context hook", async () => {
	const { pi } = await registerReadonlyPI();
	const [contextHook] = pi.handlers.get("context")!;

	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

	const result = await contextHook(
		{ messages: [] },
		{ getContextUsage: () => ({ percent: 40 }) },
	);
	const readonlyNudge = result.messages.find((message: any) => /readonly/i.test(message.content ?? ""));
	assert.ok(readonlyNudge, "context hook should deliver a readonly activation nudge");
	assert.equal(readonlyNudge.role, "custom");
	assert.equal(readonlyNudge.display, false);
});

test("readonly toggle off delivers a deactivation nudge via context hook", async () => {
	const { pi } = await registerReadonlyPI();
	const [contextHook] = pi.handlers.get("context")!;

	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);

	const result = await contextHook(
		{ messages: [] },
		{ getContextUsage: () => ({ percent: 40 }) },
	);
	const readonlyNudge = result.messages.find((message: any) => /readonly|turned off|disabled/i.test(message.content ?? ""));
	assert.ok(readonlyNudge, "context hook should deliver a readonly deactivation nudge");
	assert.match(readonlyNudge.content, /readonly/i);
	assert.match(readonlyNudge.content, /off|disabled|turned off/i);
});
