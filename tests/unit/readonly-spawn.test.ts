import { expect, onTestFinished, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	READONLY_CHILD_AUTHORITY_NOTE,
	READONLY_SANDBOX_BLOCK_NOTICE,
	READONLY_WRITE_EDIT_SUMMARY,
	READONLY_INVALID_BASH_COMMAND_REASON,
} from "../../notifications.js";
import {
	buildChildToolNames,
	createReadonlyChildBashTool,
	filterReadonlyToolNames,
} from "../../spawn/index.js";
import { expectSuffix } from "../assertions.js";
import { applyReadonlyBashGuard } from "../../readonly-bash.js";
import { canUseOsSandbox, quoteShellArgument } from "../../os-sandbox.js";
import { isRecord, createToolContext, runRealChildInvocation, SANDBOX_DENIAL_PHRASES, textOf, tmpDir } from "./helpers.js";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

// ── Tool filtering ───────────────────────────────────────────────────

test("filterReadonlyToolNames removes write, edit, and powershell in readonly mode", () => {
	const tools = ["read", "bash", "write", "edit", "powershell", "notebook_read"];
	const filtered = filterReadonlyToolNames(tools, true);
	expect(filtered).not.toContain("write");
	expect(filtered).not.toContain("edit");
	expect(filtered).not.toContain("powershell");
	expect(filtered).toContain("read");
	expect(filtered).toContain("bash");
	expect(filtered).toContain("notebook_read");
});

test("filterReadonlyToolNames preserves all tools when readonly is off", () => {
	const tools = ["read", "bash", "write", "edit", "powershell"];
	expect(filterReadonlyToolNames(tools, false)).toStrictEqual(tools);
});

// ── Child tool names ─────────────────────────────────────────────────

test("buildChildToolNames excludes spawn and handoff from inherited tools", () => {
	const parentTools = ["read", "bash", "write", "edit", "spawn", "handoff"];
	const result = buildChildToolNames(parentTools, []);
	expect(result).not.toContain("spawn");
	expect(result).not.toContain("handoff");
	expect(result).toContain("read");
	expect(result).toContain("bash");
	expect(result).toContain("write");
});

// ── Readonly prompt constants ────────────────────────────────────────

test("readonly child authority note communicates readonly inheritance", () => {
	expect(READONLY_CHILD_AUTHORITY_NOTE).toMatch(/inherit readonly authority/i);
});

test("readonly write/edit summary communicates blocked mutations", () => {
	expect(READONLY_WRITE_EDIT_SUMMARY).toMatch(/\[readonly\] write\/edit\/powershell blocked/i);
	expect(READONLY_WRITE_EDIT_SUMMARY).toMatch(/bash writes\/deletions outside temp blocked/i);
});

// ── Readonly bash guard ──────────────────────────────────────────────

test.each([undefined, null, 42, { command: "ls" }])("readonly bash guard rejects non-string commands: %s", (command) => {
	const result = applyReadonlyBashGuard(command, process.cwd());
	const reason: unknown = expect.stringMatching(new RegExp(READONLY_INVALID_BASH_COMMAND_REASON));
	expect(result, `expected block for ${String(command)}`).toMatchObject({ action: "block", reason });
});

test("readonly bash guard blocks non-temp writes and allows temp writes", () => {
	const outsideTemp = path.join(os.homedir(), `readonly-child-test-${process.pid}-${Date.now()}`);
	const insideTemp = path.join(os.tmpdir(), `readonly-child-test-${Date.now()}`);
	const cwd = process.cwd();

	const blockResult = applyReadonlyBashGuard(`touch ${outsideTemp}`, cwd);
	const reason: unknown = expect.stringMatching(/Readonly mode:/);
	expect(blockResult).toMatchObject({ action: "block", reason });

	const tempResult = applyReadonlyBashGuard(`touch ${insideTemp} && rm ${insideTemp}`, cwd);
	expect(tempResult.action, "temp dir writes should not be blocked").not.toBe("block");
});

// ── Readonly child bash tool ─────────────────────────────────────────

function outsideTempPath(label: string): string {
	const target = path.join(os.homedir(), `readonly-child-${label}-${process.pid}-${Date.now()}`);
	onTestFinished(() => { fs.rmSync(target, { force: true }); });
	return target;
}

function runChildBash(
	command: string,
	options: { timeout?: number; signal?: AbortSignal; onUpdate?: (update: { content: { type: string; text?: string }[] }) => void } = {},
) {
	// Without a ctx, pi's bash tool skips the session environment, which these tests do not need;
	// pi types `ctx` as required.
	return createReadonlyChildBashTool(process.cwd())
		.execute("child-bash", { command, timeout: options.timeout }, options.signal, options.onUpdate, undefined as unknown as ExtensionToolContext);
}

/** Return `command` after checking that the readonly guard sandboxes it rather than blocking it. */
function sandboxed(command: string): string {
	expect(applyReadonlyBashGuard(command, process.cwd()).action, command).toBe("sandbox");
	return command;
}

/** A sandboxed `node -e` command; the script reaches node as one shell-quoted argument. */
function nodeCommand(script: string): string {
	return sandboxed(`${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(script)}`);
}

/**
 * Run a command that never exits on its own, aborting it once its streamed output
 * contains `marker` (case-insensitive). The 20-second bash timeout only ends a run
 * whose output never shows the marker, which then fails on "Command timed out".
 */
function runChildBashUntil(command: string, marker: string) {
	const controller = new AbortController();
	return runChildBash(command, {
		timeout: 20,
		signal: controller.signal,
		onUpdate: (update) => {
			if (textOf(update).toLowerCase().includes(marker.toLowerCase())) {controller.abort();}
		},
	});
}

const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform] ?? "";
const skipWithoutDenialPhrase = SANDBOX_DENIAL_PHRASES[process.platform] === undefined;

test.skipIf(!canUseOsSandbox())("sandboxed child bash write outside temp returns the readonly block notice", async () => {
	const target = outsideTempPath("write");
	const result = await runChildBash(nodeCommand(`require("fs").writeFileSync(${JSON.stringify(target)}, "x")`));

	expect(result.isError).toBe(true);
	expect(textOf(result), textOf(result)).toContain(READONLY_SANDBOX_BLOCK_NOTICE);
	const structured = result.structuredContent;
	if (!isRecord(structured) || typeof structured.output !== "string" || typeof structured.exit_code !== "number") {
		throw new Error("The child bash result has no structured output and exit code.");
	}
	expectSuffix(structured.output, `\n\n${READONLY_SANDBOX_BLOCK_NOTICE}`);
	expect(structured.exit_code).toBe(1);
	expect(target, "the sandbox must block the write").not.toSatisfy(fs.existsSync);
});

test.skipIf(!canUseOsSandbox())("sandboxed child bash error carrying a sandbox denial gets the readonly block notice", async () => {
	const target = outsideTempPath("abort");
	const command = nodeCommand(
		`try { require("fs").writeFileSync(${JSON.stringify(target)}, "x") } catch (error) { console.log(error.message) } setInterval(() => {}, 1000)`,
	);

	await expect(runChildBashUntil(command, SANDBOX_DENIAL_PHRASE)).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/Command aborted/);
		expectSuffix(error.message, READONLY_SANDBOX_BLOCK_NOTICE);
		return true;
	});
	expect(target, "the sandbox must block the write").not.toSatisfy(fs.existsSync);
}, 40_000);

test.skipIf(!canUseOsSandbox())("sandboxed child bash success returns its output without the notice", async () => {
	const result = await runChildBash("echo readonly-child-ok");

	expect(result.isError).toBeUndefined();
	expect(textOf(result)).toBe("readonly-child-ok\n");
});

test.skipIf(!canUseOsSandbox())("sandboxed child bash failure without a sandbox denial returns no notice", async () => {
	const result = await runChildBash("echo plain-failure; exit 3");

	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/plain-failure[\s\S]*Command exited with code 3$/);
	expect(textOf(result)).not.toContain(READONLY_SANDBOX_BLOCK_NOTICE);
});

test.skipIf(!canUseOsSandbox())("sandboxed child bash error without a sandbox denial is rethrown without the notice", async () => {
	const command = sandboxed("echo plain-abort-marker; while :; do sleep 1; done");

	await expect(runChildBashUntil(command, "plain-abort-marker")).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/Command aborted/);
		expect(error.message, error.message).not.toContain(READONLY_SANDBOX_BLOCK_NOTICE);
		return true;
	});
}, 40_000);

test("child bash call the readonly guard blocks throws the block reason", async () => {
	const target = outsideTempPath("blocked");

	await expect(runChildBash(`touch ${quoteShellArgument(target)}`)).rejects.toThrow(/Readonly mode:/);
	expect(target).not.toSatisfy(fs.existsSync);
});

test.skipIf(skipWithoutDenialPhrase)("child bash call the readonly guard blocks gets no block notice when its command names the denial phrase", async () => {
	const target = outsideTempPath("blocked-phrase");
	await expect(runChildBash(`echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(target)}`)).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/Readonly mode:/);
		expect(error.message, error.message).toContain(SANDBOX_DENIAL_PHRASE);
		expect(error.message, error.message).not.toContain(READONLY_SANDBOX_BLOCK_NOTICE);
		return true;
	});
});

test.skipIf(!canUseOsSandbox() || skipWithoutDenialPhrase)("child bash call the readonly guard blocks gets no block notice after a sandboxed call on the same tool", async () => {
	const target = outsideTempPath("blocked-after-sandboxed");
	const tool = createReadonlyChildBashTool(process.cwd());
	const run = (command: string) => tool.execute("child-bash", { command }, undefined, undefined, undefined as unknown as ExtensionToolContext);
	await run(sandboxed("echo sandboxed-first"));

	await expect(run(`echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(target)}`)).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/Readonly mode:/);
		expect(error.message, error.message).not.toContain(READONLY_SANDBOX_BLOCK_NOTICE);
		return true;
	});
});

test.skipIf(!canUseOsSandbox() || skipWithoutDenialPhrase)("concurrent child bash calls on one tool get the block notice only on the sandboxed call", async () => {
	const sandboxedTarget = outsideTempPath("concurrent-sandboxed");
	const blockedTarget = outsideTempPath("concurrent-blocked");
	const tool = createReadonlyChildBashTool(process.cwd());
	const run = (toolCallId: string, command: string) => tool.execute(toolCallId, { command }, undefined, undefined, undefined as unknown as ExtensionToolContext);
	const [sandboxedResult, blockedResult] = await Promise.allSettled([
		run("child-bash-sandboxed", nodeCommand(`require("fs").writeFileSync(${JSON.stringify(sandboxedTarget)}, "x")`)),
		run("child-bash-blocked", `echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(blockedTarget)}`),
	]);

	expect(sandboxedResult.status).toBe("fulfilled");
	if (sandboxedResult.status !== "fulfilled") {expect.unreachable();}
	expectSuffix(textOf(sandboxedResult.value), READONLY_SANDBOX_BLOCK_NOTICE);
	expect(blockedResult.status).toBe("rejected");
	if (blockedResult.status !== "rejected") {expect.unreachable();}
	const reason: unknown = blockedResult.reason;
	if (!(reason instanceof Error)) {expect.unreachable("the blocked call must reject with an Error");}
	expect(reason.message).toMatch(/Readonly mode:/);
	expect(reason.message, reason.message).not.toContain(READONLY_SANDBOX_BLOCK_NOTICE);
});

test.skipIf(!canUseOsSandbox() || skipWithoutDenialPhrase)("sandboxed child bash timeout after a sandbox denial gets the readonly block notice", async () => {
	const command = sandboxed(`echo '${SANDBOX_DENIAL_PHRASE}'; while :; do sleep 1; done`);

	await expect(runChildBash(command, { timeout: 1 })).rejects.toSatisfy((error: Error) => {
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/Command timed out after 1 seconds/);
		expectSuffix(error.message, READONLY_SANDBOX_BLOCK_NOTICE);
		return true;
	});
}, 20_000);

test("child bash call resolves a relative write against the execution cwd", async () => {
	const executionCwd = await tmpDir();
	// The tool's own cwd is outside temp, so classifying against it would block the write.
	const tool = createReadonlyChildBashTool(os.homedir());
	const ctx = createToolContext({ cwd: executionCwd });
	try {
		const result = await tool.execute("child-bash", { command: "touch relative-target" }, undefined, undefined, ctx);

		expect(result.isError, textOf(result)).toBeUndefined();
		expect(path.join(executionCwd, "relative-target")).toSatisfy(fs.existsSync);
	} finally {
		fs.rmSync(executionCwd, { recursive: true, force: true });
	}
});

// ── Integration ──────────────────────────────────────────────────────

test("real readonly child omits write/edit/powershell and blocks a non-temp bash write", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Attempt the requested bash command and report its result.",
		readonly: true,
		invokeReadonlyBash: true,
		cwdOutsideTemp: true,
		activeTools: ["read", "bash", "write", "edit", "powershell", "agentic_e2e_probe", "spawn", "handoff"],
	});

	const result: unknown = proof.result;
	if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.content)) {throw new Error("The spawn result has no details or content.");}
	const first: unknown = result.content[0];
	if (!isRecord(first)) {throw new Error("The spawn result has no first content block.");}
	expect(result.details.model).toBe(proof.modelId);
	expect(first.text).toMatch(/READONLY_BASH_BLOCKED/);
	expect(proof.bashWriteExists, "readonly child bash must not write to its cwd").toBe(false);
	expect(proof.observedToolSets).toHaveLength(2);
	for (const toolNames of proof.observedToolSets) {
		expect(toolNames).not.toContain("write");
		expect(toolNames).not.toContain("edit");
		expect(toolNames).not.toContain("powershell");
		expect(toolNames).not.toContain("spawn");
		expect(toolNames).not.toContain("handoff");
		expect(toolNames).toContain("bash");
	}
	expect(proof.outboundFetches, "offline real-child fixture attempted an outbound fetch").toStrictEqual([]);
});
