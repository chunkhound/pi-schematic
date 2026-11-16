import { expect, onTestFinished, test } from "vitest";
import { SessionManager, type BashToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { canUseOsSandbox } from "../../os-sandbox.js";
import { assertPresent, expectSuffix } from "../assertions.js";
import { createRunner, type RunnerFixture } from "../support/runner.js";
import { SANDBOX_DENIAL_PHRASES } from "../support/sandbox.js";
import { realTheme } from "../support/theme.js";
import { textOf } from "../support/tool-result.js";

const SANDBOX_BLOCK_NOTICE =
	"[readonly mode] If this command failed on a write outside the OS temp dir, the OS sandbox blocked it.\nUse /readonly to disable, or write within the OS temp dir.";

const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform];
const hasOsSandbox = canUseOsSandbox();

/** The shipped extension on a runner at `cwd` with the recording UI, over `session`. */
function createReadonlyRunner(cwd: string, session = SessionManager.inMemory(cwd)) {
	return createRunner({
		cwd,
		mode: "tui",
		sessionManager: session,
		ui: { theme: realTheme, addAutocompleteProvider: () => undefined },
		context: { getContextUsage: () => undefined, isIdle: () => true, isProjectTrusted: () => false },
		activeTools: [],
	});
}

/** Run `/readonly` on `fixture`. */
async function toggleReadonly(fixture: RunnerFixture): Promise<void> {
	await fixture.command("readonly").handler("", fixture.runner.createCommandContext());
}

/** A bash `tool_call` event for `command`. */
function bashCall(command: string, toolCallId = "bash"): BashToolCallEvent {
	return { type: "tool_call", toolCallId, toolName: "bash", input: { command } };
}

test("readonly toggle on blocks a bash mutation outside temp and allows one inside temp", async () => {
	const fixture = await createReadonlyRunner(process.cwd());
	const { runner } = fixture;

	await toggleReadonly(fixture);

	expect((await runner.emitToolCall(bashCall("rm -rf /")))?.block).toBe(true);
	expect(await runner.emitToolCall(bashCall(`rm ${os.tmpdir()}/x`))).toBeUndefined();
});

test("readonly toggle off leaves bash commands untouched", async () => {
	const fixture = await createReadonlyRunner(process.cwd());
	const { runner } = fixture;
	await toggleReadonly(fixture);
	await toggleReadonly(fixture);
	const event = bashCall("rm -rf /");

	const result = await runner.emitToolCall(event);

	expect(result).toBeUndefined();
	expect(event.input).toStrictEqual({ command: "rm -rf /" });
});

test("a blocked bash command returns the reason built from the classifier verdict", async () => {
	const fixture = await createReadonlyRunner(process.cwd());
	const { runner } = fixture;
	await toggleReadonly(fixture);

	const result = await runner.emitToolCall(bashCall("touch /etc/x"));

	expect(result).toStrictEqual({
		block: true,
		reason: "Readonly mode: command blocked.\nReason: touch blocked outside temp dir: /etc/x\nCommand: touch /etc/x",
	});
});

test.skipIf(!hasOsSandbox)("a sandboxed bash command is rewritten to the sandbox wrapper", async () => {
	const fixture = await createReadonlyRunner(process.cwd());
	const { runner } = fixture;
	await toggleReadonly(fixture);
	const event = bashCall("ls");

	const result = await runner.emitToolCall(event);

	expect(result).toBeUndefined();
	expect(event.input.command).not.toBe("ls");
	expectSuffix(event.input.command, ` "$0" -c 'ls'`);
});

test.runIf(!hasOsSandbox)("an allowed bash command without an OS sandbox passes unchanged", async () => {
	const fixture = await createReadonlyRunner(process.cwd());
	const { runner } = fixture;
	await toggleReadonly(fixture);
	const event = bashCall("ls");

	const result = await runner.emitToolCall(event);

	expect(result).toBeUndefined();
	expect(event.input).toStrictEqual({ command: "ls" });
});

test("the bash guard resolves relative paths against the context cwd", async () => {
	const tempCwd = await mkdtemp(join(os.tmpdir(), "pi-schematic-readonly-cwd-"));
	onTestFinished(() => rm(tempCwd, { recursive: true, force: true }));
	const inTemp = await createReadonlyRunner(tempCwd);
	await toggleReadonly(inTemp);
	const outsideTemp = await createReadonlyRunner("/workspace");
	await toggleReadonly(outsideTemp);

	expect(await inTemp.runner.emitToolCall(bashCall("touch x"))).toBeUndefined();
	expect(await outsideTemp.runner.emitToolCall(bashCall("touch x"))).toStrictEqual({
		block: true,
		reason: "Readonly mode: command blocked.\nReason: touch blocked outside temp dir: x\nCommand: touch x",
	});
});

// ── Sandbox block notice on failed sandboxed bash results ────────────

const skipWithoutSandbox = !hasOsSandbox;

async function registerReadonlyBash(session?: SessionManager) {
	assertPresent(SANDBOX_DENIAL_PHRASE, `no sandbox denial phrase for ${process.platform}`);
	const deniedOutput = `touch: x: ${SANDBOX_DENIAL_PHRASE}`;
	const fixture = await createReadonlyRunner(process.cwd(), session);
	const { runner } = fixture;
	await toggleReadonly(fixture);
	return {
		runner,
		deniedOutput,
		callBash: (toolCallId: string) => runner.emitToolCall(bashCall("ls", toolCallId)),
		result: (toolCallId: string, overrides: { toolName?: string; isError?: boolean } = {}) => {
			const event: ToolResultEvent = {
				type: "tool_result",
				toolName: "bash",
				toolCallId,
				input: { command: "ls" },
				details: undefined,
				content: [{ type: "text", text: `${deniedOutput}\n\nCommand exited with code 1` }],
				structuredContent: { output: deniedOutput, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
				isError: true,
				...overrides,
			};
			return runner.emitToolResult(event);
		},
	};
}

test.skipIf(skipWithoutSandbox)("a failed sandboxed bash result gets the sandbox block notice once", async () => {
	const bash = await registerReadonlyBash();

	await bash.callBash("call-1");
	const first = await bash.result("call-1");

	assertPresent(first?.content);
	expect(textOf({ content: first.content })).toBe(`${bash.deniedOutput}\n\nCommand exited with code 1\n\n${SANDBOX_BLOCK_NOTICE}`);
	expect(first.structuredContent).toStrictEqual({
		output: `${bash.deniedOutput}\n\n${SANDBOX_BLOCK_NOTICE}`,
		truncated: false,
		exit_code: 1,
		wall_time_seconds: 0.1,
	});
	expect(first.isError).toBe(true);
	expect(await bash.result("call-1")).toBeUndefined();
});

test.skipIf(skipWithoutSandbox)("a successful sandboxed bash result gets no notice", async () => {
	const bash = await registerReadonlyBash();

	await bash.callBash("call-1");

	expect(await bash.result("call-1", { isError: false })).toBeUndefined();
});

test.skipIf(skipWithoutSandbox)("a failed non-bash result for a sandboxed id gets no notice", async () => {
	const bash = await registerReadonlyBash();

	await bash.callBash("call-1");

	expect(await bash.result("call-1", { toolName: "read" })).toBeUndefined();
});

/** An in-memory session whose branch keeps readonly on, so only a dropped id can explain a missing notice. */
function readonlyOnSession(): SessionManager {
	const session = SessionManager.inMemory(process.cwd());
	session.appendCustomEntry("pi-schematic-readonly", { enabled: true });
	return session;
}

test.skipIf(skipWithoutSandbox)("a session start drops sandboxed ids whose result never arrived", async () => {
	const bash = await registerReadonlyBash(readonlyOnSession());
	await bash.callBash("before-start");
	await bash.runner.emit({ type: "session_start", reason: "resume" });

	const result = await bash.result("before-start");

	expect(result).toBeUndefined();
});

test.skipIf(skipWithoutSandbox)("a call sandboxed after a session start gets the notice", async () => {
	const bash = await registerReadonlyBash(readonlyOnSession());
	await bash.runner.emit({ type: "session_start", reason: "resume" });
	await bash.callBash("after-start");

	const result = await bash.result("after-start");

	assertPresent(result?.content);
	expectSuffix(textOf({ content: result.content }), SANDBOX_BLOCK_NOTICE);
});
