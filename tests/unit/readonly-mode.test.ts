import { expect, test } from "vitest";
import { SessionManager, type ContextUsage, type ExtensionFactory, type ExtensionRunner, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import registerSchematic from "../../index.js";
import { assertPresent } from "../assertions.js";
import { createRunner } from "../support/runner.js";
import { realTheme } from "../support/theme.js";

type ContextMessage = Awaited<ReturnType<ExtensionRunner["emitContext"]>>[number];

const USAGE_AT_40_PERCENT: ContextUsage = { tokens: 80000, percent: 40, contextWindow: 200000 };

/**
 * The shipped extension on a runner with the recording UI (none when `headless`), an idle session at `usage`,
 * loaded after the `before` extension when one is given.
 */
async function createReadonlyRunner(options: { headless?: boolean; usage?: ContextUsage; before?: ExtensionFactory } = {}) {
	let idle = true;
	const cwd = process.cwd();
	const fixture = await createRunner({
		cwd,
		mode: options.headless === true ? "print" : "tui",
		sessionManager: SessionManager.inMemory(cwd),
		ui: options.headless === true ? undefined : { theme: realTheme },
		context: { getContextUsage: () => options.usage, isIdle: () => idle },
		activeTools: [],
		factories: options.before === undefined ? undefined : [options.before, registerSchematic],
	});
	const { runner } = fixture;
	return {
		fixture,
		setIdle: (next: boolean) => {
			idle = next;
		},
		runCommand: async (name: string, args = "") => {
			await fixture.command(name).handler(args, runner.createCommandContext());
		},
		toolCall: (toolName: string, input: Record<string, unknown>) => runner.emitToolCall({ type: "tool_call", toolCallId: toolName, toolName, input }),
		context: () => runner.emitContext([]),
	};
}

/** The messages in `messages` whose text content matches `pattern`. */
function textMessagesMatching(messages: ContextMessage[], pattern: RegExp): ContextMessage[] {
	return messages.filter((message) => message.role === "custom" && typeof message.content === "string" && pattern.test(message.content));
}

/** The content of every readonly nudge in `messages`. */
function readonlyNudgeContents(messages: ContextMessage[]): unknown[] {
	return messages.flatMap((message) => (message.role === "custom" && message.customType === "pi-schematic-readonly-nudge" ? [message.content] : []));
}

test("readonly toggle on blocks write, edit, powershell and handoff and leaves read alone", async () => {
	const readonly = await createReadonlyRunner();

	await readonly.runCommand("readonly");

	expect((await readonly.toolCall("write", { path: "/tmp/x", content: "x" }))?.block).toBe(true);
	expect((await readonly.toolCall("edit", { path: "/tmp/x", edits: [] }))?.block).toBe(true);
	expect(await readonly.toolCall("powershell", { command: "Get-ChildItem" })).toStrictEqual({
		block: true,
		reason: "Readonly mode: powershell blocked until the user disables readonly. Do not run PowerShell or other shells through another tool.",
	});
	expect((await readonly.toolCall("handoff", { task: "pivot" }))?.block).toBe(true);
	expect(await readonly.toolCall("read", { path: "/tmp/x" })).toBeUndefined();
});

test("readonly toggle off restores write, powershell and handoff access", async () => {
	const readonly = await createReadonlyRunner();

	await readonly.runCommand("readonly");
	await readonly.runCommand("readonly");

	expect(await readonly.toolCall("write", { path: "/tmp/x", content: "x" })).toBeUndefined();
	expect(await readonly.toolCall("powershell", { command: "Get-ChildItem" })).toBeUndefined();
	expect(await readonly.toolCall("handoff", { task: "pivot" })).toBeUndefined();
});

test("readonly toggle is a no-op in headless mode", async () => {
	const readonly = await createReadonlyRunner({ headless: true });

	await readonly.runCommand("readonly");

	expect(await readonly.toolCall("write", { path: "/tmp/x", content: "x" })).toBeUndefined();
	expect(readonly.fixture.host.appendedEntries.filter((entry) => entry.customType === "pi-schematic-readonly")).toStrictEqual([]);
});

test("readonly shortcut only toggles while idle", async () => {
	const readonly = await createReadonlyRunner();
	const { runner } = readonly.fixture;
	const shortcut = runner.getShortcuts(getKeybindings().getResolvedBindings()).get("ctrl+shift+r");
	assertPresent(shortcut, "the extension registers the readonly shortcut");

	readonly.setIdle(false);
	await shortcut.handler(runner.createContext());
	expect(await readonly.toolCall("write", { path: "/tmp/x", content: "x" })).toBeUndefined();

	readonly.setIdle(true);
	await shortcut.handler(runner.createContext());
	expect((await readonly.toolCall("write", { path: "/tmp/x", content: "x" }))?.block).toBe(true);
});

test("readonly toggle delivers an activation nudge via context hook", async () => {
	const readonly = await createReadonlyRunner({ usage: USAGE_AT_40_PERCENT });

	await readonly.runCommand("readonly");

	const [readonlyNudge] = textMessagesMatching(await readonly.context(), /readonly/i);
	assertPresent(readonlyNudge, "context hook should deliver a readonly activation nudge");
	expect(readonlyNudge.role).toBe("custom");
	expect(readonlyNudge).toHaveProperty("display", false);
});

test("readonly toggle off delivers a deactivation nudge via context hook", async () => {
	const readonly = await createReadonlyRunner({ usage: USAGE_AT_40_PERCENT });

	await readonly.runCommand("readonly");
	await readonly.runCommand("readonly");

	expect(readonlyNudgeContents(await readonly.context())).toStrictEqual([
		"[readonly] disabled — write, edit, handoff, and bash writes are now fully available, as is powershell where it is active. Context at 40% — if the work changed topics, you can handoff now.",
	]);
});

test("toggling readonly on with a pending handoff notifies that the successor resumes in readonly", async () => {
	const readonly = await createReadonlyRunner();
	await readonly.runCommand("handoff", "continue the review");

	await readonly.runCommand("readonly");

	expect(readonly.fixture.ui.notifications.slice(-2)).toStrictEqual([
		{ message: "Pending handoff updated — the fresh context will resume in readonly mode.", type: "info" },
		{
			message:
				"[readonly] enabled — write/edit/powershell blocked; handoff needs explicit /handoff or an eligible human topic boundary; bash writes/deletions outside temp blocked",
			type: "info",
		},
	]);
});

test("toggling readonly off with a pending handoff notifies that the successor resumes writable", async () => {
	const readonly = await createReadonlyRunner();
	await readonly.runCommand("handoff", "continue the review");
	await readonly.runCommand("readonly");

	await readonly.runCommand("readonly");

	expect(readonly.fixture.ui.notifications.slice(-2)).toStrictEqual([
		{ message: "Pending handoff readonly continuation cleared — the fresh context will not resume in readonly mode.", type: "info" },
		{
			message: "[readonly] disabled — write, edit, handoff, and bash writes are now fully available, as is powershell where it is active.",
			type: "info",
		},
	]);
});

// ── Bash commands another extension replaced ────────────

/** An extension whose `tool_call` handler replaces the bash command, after pi validated it, with `command`. */
function replacingBashCommand(command: unknown): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			Reflect.set(event.input, "command", command);
		});
	};
}

const OUTSIDE_TEMP_WRITE = `touch ${homedir()}/pi-schematic-readonly-probe`;

test.for<{ label: string; command: unknown }>([
	{ label: "a one-element array", command: [OUTSIDE_TEMP_WRITE] },
	{ label: "an object with a toString method", command: { toString: () => OUTSIDE_TEMP_WRITE } },
	{ label: "a number", command: 42 },
	{ label: "undefined", command: undefined },
])("readonly blocks a bash call whose command an earlier extension replaced with $label", async ({ command }) => {
	const readonly = await createReadonlyRunner({ before: replacingBashCommand(command) });
	await readonly.runCommand("readonly");

	expect(await readonly.toolCall("bash", { command: "ls" })).toStrictEqual({
		block: true,
		reason: "Readonly mode: command blocked.\nReason: bash command input must be a string\nCommand: <invalid input>",
	});
});

// ── Sandbox block notice on failed bash results ────────────

const SANDBOX_DENIAL_PHRASES: Partial<Record<NodeJS.Platform, string>> = { darwin: "Operation not permitted", linux: "Read-only file system" };
const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform];

test.skipIf(SANDBOX_DENIAL_PHRASE === undefined)("a failed bash result for an id that was never sandboxed gets no notice", async () => {
	assertPresent(SANDBOX_DENIAL_PHRASE, `no sandbox denial phrase for ${process.platform}`);
	const output = `touch: x: ${SANDBOX_DENIAL_PHRASE}`;
	const readonly = await createReadonlyRunner();
	await readonly.runCommand("readonly");
	const event: ToolResultEvent = {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "never-called",
		input: { command: "ls" },
		details: undefined,
		content: [{ type: "text", text: `${output}\n\nCommand exited with code 1` }],
		structuredContent: { output, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
		isError: true,
	};

	expect(await readonly.fixture.runner.emitToolResult(event)).toBeUndefined();
});
