import { expect, test } from "vitest";
import os from "node:os";
import { READONLY_POWERSHELL_BLOCK_REASON, READONLY_SANDBOX_BLOCK_NOTICE } from "../../notifications.js";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { canUseOsSandbox } from "../../os-sandbox.js";
import {
	bashResult,
	callHandlers,
	createCommandContext,
	emitAll,
	registerReadonlyPI,
	SANDBOX_DENIAL_PHRASES,
	textOf,
	uiCommandContext,
} from "./helpers.js";
import { createBeforeAgentStartEvent, getCommand, getShortcut, type TestPI } from "./test-host.js";
import { assertPresent, expectSuffix, isRecord } from "../assertions.js";

// The tool_result handler returns a patch of the result or nothing.
function assertToolResultEventResult(value: unknown): asserts value is ToolResultEventResult | undefined {
	if (value === undefined) {return;}
	if (!isRecord(value) || (value.content !== undefined && !Array.isArray(value.content)) || (value.isError !== undefined && typeof value.isError !== "boolean")) {
		throw new Error("The tool_result handler returned something other than a tool_result result.");
	}
}

/**
 * The messages the one context handler returned. The contexts here report usage with a percent only,
 * which `ContextUsage` does not admit, so the handler runs untyped through callHandlers.
 */
async function contextMessages(pi: TestPI, event: unknown, ctx: unknown): Promise<Record<string, unknown>[]> {
	const [result] = await callHandlers(pi, "context", event, ctx);
	if (!isRecord(result) || !Array.isArray(result.messages)) {throw new Error("The context handler returned no messages.");}
	const messages: unknown[] = result.messages;
	if (!messages.every(isRecord)) {throw new Error("The context handler returned a message that is not an object.");}
	return messages;
}

test("readonly toggle on blocks write, edit, powershell, handoff, and bash mutations", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const ctx = uiCommandContext();

	await getCommand(pi, "readonly").handler("", ctx);

	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
	expect((await toolCall({ toolName: "edit", input: { path: "/tmp/x", edits: [] } }, {}))?.block).toBe(true);
	const powershell = await toolCall({ toolName: "powershell", input: { command: "Get-ChildItem" } }, {});
	expect(powershell?.block).toBe(true);
	expect(powershell?.reason).toBe(READONLY_POWERSHELL_BLOCK_REASON);
	expect((await toolCall({ toolName: "handoff", input: { task: "pivot" } }, {}))?.block).toBe(true);
	expect((await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/workspace" }))?.block).toBe(true);
	expect(await toolCall({ toolName: "bash", input: { command: `rm ${os.tmpdir()}/x` } }, { cwd: "/workspace" })).toBeUndefined();
	expect(await toolCall({ toolName: "read", input: { path: "/tmp/x" } }, {})).toBeUndefined();
});

test("readonly toggle off restores write, powershell, handoff, and bash access", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const ctx = uiCommandContext();

	await getCommand(pi, "readonly").handler("", ctx);
	await getCommand(pi, "readonly").handler("", ctx);

	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
	expect(await toolCall({ toolName: "powershell", input: { command: "Get-ChildItem" } }, {})).toBeUndefined();
	expect(await toolCall({ toolName: "handoff", input: { task: "pivot" } }, {})).toBeUndefined();
	expect(await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/workspace" })).toBeUndefined();
});

test("readonly toggle is a no-op in headless mode", async () => {
	const { pi, toolCall } = await registerReadonlyPI();

	// Toggle readonly via the command handler with hasUI: false.
	// The handler guards on ctx.hasUI — in headless mode the toggle
	// is a no-op, preserving the contract: readonly is a TUI-only feature.
	await getCommand(pi, "readonly").handler("", createCommandContext({ getContextUsage: () => undefined }));

	// These contexts have no `modelRegistry`, which `ExtensionContext` requires, so the one
	// input and before_agent_start handlers run through emitAll.
	await emitAll(pi, "input", { text: "/review", source: "interactive" }, {
		hasUI: false,
		getContextUsage: () => null,
	});
	await emitAll(pi, "before_agent_start", createBeforeAgentStartEvent({ skills: [] }), {
		hasUI: false,
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		getContextUsage: () => null,
	});

	// Write should remain unblocked for both manual and deferred readonly paths.
	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();
});

test("readonly shortcut only toggles while idle", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	const shortcut = getShortcut(pi, "ctrl+shift+r");

	await shortcut.handler(uiCommandContext({ isIdle: () => false }));
	expect(await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {})).toBeUndefined();

	await shortcut.handler(uiCommandContext({ isIdle: () => true }));
	expect((await toolCall({ toolName: "write", input: { path: "/tmp/x", content: "x" } }, {}))?.block).toBe(true);
});

test("readonly toggle delivers an activation nudge via context hook", async () => {
	const { pi } = await registerReadonlyPI();

	await getCommand(pi, "readonly").handler("", uiCommandContext());

	const messages = await contextMessages(
		pi,
		{ messages: [] },
		{ getContextUsage: () => ({ percent: 40 }) },
	);
	const readonlyNudge = messages.find((message) => typeof message.content === "string" && /readonly/i.test(message.content));
	assertPresent(readonlyNudge, "context hook should deliver a readonly activation nudge");
	expect(readonlyNudge.role).toBe("custom");
	expect(readonlyNudge.display).toBe(false);
});

test("readonly toggle off delivers a deactivation nudge via context hook", async () => {
	const { pi } = await registerReadonlyPI();

	await getCommand(pi, "readonly").handler("", uiCommandContext());
	await getCommand(pi, "readonly").handler("", uiCommandContext());

	const messages = await contextMessages(
		pi,
		{ messages: [] },
		{ getContextUsage: () => ({ percent: 40 }) },
	);
	const readonlyNudge = messages.find((message) => typeof message.content === "string" && /readonly|turned off|disabled/i.test(message.content));
	assertPresent(readonlyNudge, "context hook should deliver a readonly deactivation nudge");
	expect(readonlyNudge.content).toMatch(/readonly/i);
	expect(readonlyNudge.content).toMatch(/off|disabled|turned off/i);
});

// ── Sandbox block notice on failed sandboxed bash results ────────────

const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform];
const skipWithoutSandbox = !canUseOsSandbox();

async function registerReadonlyBash() {
	const { pi, toolCall } = await registerReadonlyPI();
	await getCommand(pi, "readonly").handler("", uiCommandContext());
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
			assertToolResultEventResult(result);
			return result;
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
	expectSuffix(textOf({ content: result.content }), READONLY_SANDBOX_BLOCK_NOTICE);
});
