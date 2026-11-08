import { expect, test } from "vitest";
import os from "node:os";
import { READONLY_POWERSHELL_BLOCK_REASON, READONLY_SANDBOX_BLOCK_NOTICE } from "../../notifications.js";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { canUseOsSandbox } from "../../os-sandbox.js";
import { bashResult, callHandlers, emitAll, registerReadonlyPI, makeReadonlyUICtx, SANDBOX_DENIAL_PHRASES, textOf } from "./helpers.js";
import { createBeforeAgentStartEvent } from "./test-host.js";
import { assertPresent } from "../assertions.js";

test("readonly toggle on blocks write, edit, powershell, handoff, and bash mutations", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const ctx = makeReadonlyUICtx();

	await pi.commands.get("readonly").handler("", ctx as any);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block).toBe(true);
	expect((await toolCall({ toolName: "edit", input: { path: "/tmp/x", edits: [] } }, {})).block).toBe(true);
	const powershell = await toolCall({ toolName: "powershell", input: { command: "Get-ChildItem" } }, {});
	expect(powershell.block).toBe(true);
	expect(powershell.reason).toBe(READONLY_POWERSHELL_BLOCK_REASON);
	expect((await toolCall({ toolName: "handoff", input: { task: "pivot" } }, {})).block).toBe(true);
	expect((await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/workspace" })).block).toBe(true);
	expect(await toolCall({ toolName: "bash", input: { command: `rm ${os.tmpdir()}/x` } }, { cwd: "/workspace" })).toBeUndefined();
	expect(await toolCall({ toolName: "read", input: { path: "/tmp/x" } }, {})).toBeUndefined();
});

test("readonly toggle off restores write, powershell, handoff, and bash access", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const ctx = makeReadonlyUICtx();

	await pi.commands.get("readonly").handler("", ctx as any);
	await pi.commands.get("readonly").handler("", ctx as any);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(await toolCall({ toolName: "powershell", input: { command: "Get-ChildItem" } }, {})).toBeUndefined();
	expect(await toolCall({ toolName: "handoff", input: { task: "pivot" } }, {})).toBeUndefined();
	expect(await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/workspace" })).toBeUndefined();
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
	await beforeStartHandler(createBeforeAgentStartEvent({ skills: [] }), {
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		getContextUsage: () => null,
	} as any);

	// Write should remain unblocked for both manual and deferred readonly paths.
	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
});

test("readonly shortcut only toggles while idle", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const shortcut = pi.shortcuts.get("ctrl+shift+r");
	assertPresent(shortcut);

	await shortcut.handler({ ...makeReadonlyUICtx(), isIdle: () => false } as any);
	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();

	await shortcut.handler({ ...makeReadonlyUICtx(), isIdle: () => true } as any);
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).block).toBe(true);
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
	assertPresent(readonlyNudge, "context hook should deliver a readonly activation nudge");
	expect(readonlyNudge.role).toBe("custom");
	expect(readonlyNudge.display).toBe(false);
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
	assertPresent(readonlyNudge, "context hook should deliver a readonly deactivation nudge");
	expect(readonlyNudge.content).toMatch(/readonly/i);
	expect(readonlyNudge.content).toMatch(/off|disabled|turned off/i);
});

// ── Sandbox block notice on failed sandboxed bash results ────────────

const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform];
const skipWithoutSandbox = !canUseOsSandbox();

async function registerReadonlyBash() {
	const { pi, toolCall } = await registerReadonlyPI();
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
	return {
		pi,
		callBash: (toolCallId: string) =>
			toolCall({ toolName: "bash", toolCallId, input: { command: "ls" } }, { cwd: "/workspace" }),
		result: async (toolCallId: string, overrides: { toolName?: string; isError?: boolean } = {}) => {
			const event: ToolResultEvent = {
				type: "tool_result",
				toolName: "bash",
				toolCallId,
				input: { command: "ls" },
				details: undefined,
				...bashResult(`touch: x: ${SANDBOX_DENIAL_PHRASE}`),
				...overrides,
			};
			const [result] = await callHandlers(pi, "tool_result", event, {});
			return result as ToolResultEventResult | undefined;
		},
	};
}

test.skipIf(skipWithoutSandbox)("a failed sandboxed bash result gets the sandbox block notice once", async () => {
	const bash = await registerReadonlyBash();

	await bash.callBash("call-1");
	const first = await bash.result("call-1");

	assertPresent(first?.content);
	expect(textOf({ content: first.content })).toBe(`touch: x: ${SANDBOX_DENIAL_PHRASE}\n\nCommand exited with code 1\n\n${READONLY_SANDBOX_BLOCK_NOTICE}`);
	expect(first.structuredContent).toStrictEqual({
		output: `touch: x: ${SANDBOX_DENIAL_PHRASE}\n\n${READONLY_SANDBOX_BLOCK_NOTICE}`,
		truncated: false,
		exit_code: 1,
		wall_time_seconds: 0.1,
	});
	expect(first).not.toHaveProperty("isError");
	expect(await bash.result("call-1")).toBeUndefined();
});

test.skipIf(skipWithoutSandbox)("a successful sandboxed bash result gets no notice", async () => {
	const bash = await registerReadonlyBash();

	await bash.callBash("call-1");

	expect(await bash.result("call-1", { isError: false })).toBeUndefined();
});

test.skipIf(SANDBOX_DENIAL_PHRASE === undefined)("a failed bash result for an id that was never sandboxed gets no notice", async () => {
	const bash = await registerReadonlyBash();

	expect(await bash.result("never-called")).toBeUndefined();
});

test.skipIf(skipWithoutSandbox)("a failed non-bash result for a sandboxed id gets no notice", async () => {
	const bash = await registerReadonlyBash();

	await bash.callBash("call-1");

	expect(await bash.result("call-1", { toolName: "read" })).toBeUndefined();
});

// The resumed branch keeps readonly on, so only a dropped id can explain a missing notice.
const READONLY_ON_BRANCH = [{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } }];

function resumeSession(pi: Awaited<ReturnType<typeof registerReadonlyBash>>["pi"]) {
	return emitAll(pi, "session_start", { reason: "resume" }, { hasUI: false, getContextUsage: () => null, sessionManager: { getBranch: () => READONLY_ON_BRANCH } });
}

test.skipIf(skipWithoutSandbox)("a session start drops sandboxed ids whose result never arrived", async () => {
	const bash = await registerReadonlyBash();
	await bash.callBash("before-start");
	await resumeSession(bash.pi);

	const result = await bash.result("before-start");

	expect(result).toBeUndefined();
});

test.skipIf(skipWithoutSandbox)("a call sandboxed after a session start gets the notice", async () => {
	const bash = await registerReadonlyBash();
	await resumeSession(bash.pi);
	await bash.callBash("after-start");

	const result = await bash.result("after-start");

	assertPresent(result?.content);
	expect(textOf({ content: result.content }).endsWith(READONLY_SANDBOX_BLOCK_NOTICE)).toBe(true);
});
