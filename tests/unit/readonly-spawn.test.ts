import test from "node:test";
import assert from "node:assert/strict";
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
import { applyReadonlyBashGuard } from "../../readonly-bash.js";
import { canUseOsSandbox, quoteShellArgument } from "../../os-sandbox.js";
import { runRealChildInvocation, SANDBOX_DENIAL_PHRASES, textOf, tmpDir } from "./helpers.js";

// ── Tool filtering ───────────────────────────────────────────────────

test("filterReadonlyToolNames removes write, edit, and powershell in readonly mode", () => {
	const tools = ["read", "bash", "write", "edit", "powershell", "notebook_read"];
	const filtered = filterReadonlyToolNames(tools, true);
	assert.equal(filtered.includes("write"), false);
	assert.equal(filtered.includes("edit"), false);
	assert.equal(filtered.includes("powershell"), false);
	assert.equal(filtered.includes("read"), true);
	assert.equal(filtered.includes("bash"), true);
	assert.equal(filtered.includes("notebook_read"), true);
});

test("filterReadonlyToolNames preserves all tools when readonly is off", () => {
	const tools = ["read", "bash", "write", "edit", "powershell"];
	assert.deepEqual(filterReadonlyToolNames(tools, false), tools);
});

// ── Child tool names ─────────────────────────────────────────────────

test("buildChildToolNames excludes spawn and handoff from inherited tools", () => {
	const parentTools = ["read", "bash", "write", "edit", "spawn", "handoff"];
	const result = buildChildToolNames(parentTools, []);
	assert.equal(result.includes("spawn"), false);
	assert.equal(result.includes("handoff"), false);
	assert.equal(result.includes("read"), true);
	assert.equal(result.includes("bash"), true);
	assert.equal(result.includes("write"), true);
});

// ── Readonly prompt constants ────────────────────────────────────────

test("readonly child authority note communicates readonly inheritance", () => {
	assert.match(READONLY_CHILD_AUTHORITY_NOTE, /inherit readonly authority/i);
});

test("readonly write/edit summary communicates blocked mutations", () => {
	assert.match(READONLY_WRITE_EDIT_SUMMARY, /\[readonly\] write\/edit\/powershell blocked/i);
	assert.match(READONLY_WRITE_EDIT_SUMMARY, /bash writes\/deletions outside temp blocked/i);
});

// ── Readonly bash guard ──────────────────────────────────────────────

test("readonly bash guard rejects non-string commands", () => {
	const cwd = process.cwd();
	for (const command of [undefined, null, 42, { command: "ls" }]) {
		const result = applyReadonlyBashGuard(command, cwd);
		assert.equal(result.action, "block", `expected block for ${String(command)}`);
		assert.match(result.reason, new RegExp(READONLY_INVALID_BASH_COMMAND_REASON));
	}
});

test("readonly bash guard blocks non-temp writes and allows temp writes", () => {
	const outsideTemp = path.join(os.homedir(), `readonly-child-test-${process.pid}-${Date.now()}`);
	const insideTemp = path.join(os.tmpdir(), `readonly-child-test-${Date.now()}`);
	const cwd = process.cwd();

	const blockResult = applyReadonlyBashGuard(`touch ${outsideTemp}`, cwd);
	assert.equal(blockResult.action, "block");
	assert.match(blockResult.reason, /Readonly mode:/);

	const tempResult = applyReadonlyBashGuard(`touch ${insideTemp} && rm ${insideTemp}`, cwd);
	assert.notEqual(tempResult.action, "block", "temp dir writes should not be blocked");
});

// ── Readonly child bash tool ─────────────────────────────────────────

function outsideTempPath(label: string): string {
	return path.join(os.homedir(), `readonly-child-${label}-${process.pid}-${Date.now()}`);
}

// No ctx: pi's bash tool then skips the session environment, which these tests do not need.
function runChildBash(
	command: string,
	options: { timeout?: number; signal?: AbortSignal; onUpdate?: (update: { content: { type: string; text?: string }[] }) => void } = {},
) {
	return createReadonlyChildBashTool(process.cwd())
		.execute("child-bash", { command, timeout: options.timeout }, options.signal, options.onUpdate as any, undefined as any);
}

/** Return `command` after checking that the readonly guard sandboxes it rather than blocking it. */
function sandboxed(command: string): string {
	assert.equal(applyReadonlyBashGuard(command, process.cwd()).action, "sandbox", command);
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
			if (textOf(update).toLowerCase().includes(marker.toLowerCase())) controller.abort();
		},
	});
}

const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform] ?? "";
const hasDenialPhrase = { skip: SANDBOX_DENIAL_PHRASES[process.platform] === undefined };

test("sandboxed child bash write outside temp returns the readonly block notice", { skip: !canUseOsSandbox() }, async () => {
	const target = outsideTempPath("write");
	try {
		const result = await runChildBash(nodeCommand(`require("fs").writeFileSync(${JSON.stringify(target)}, "x")`));

		assert.equal(result.isError, true);
		assert.ok(textOf(result).includes(READONLY_SANDBOX_BLOCK_NOTICE), textOf(result));
		const structured = result.structuredContent as { output: string; exit_code: number };
		assert.ok(structured.output.endsWith(`\n\n${READONLY_SANDBOX_BLOCK_NOTICE}`), structured.output);
		assert.equal(structured.exit_code, 1);
		assert.equal(fs.existsSync(target), false, "the sandbox must block the write");
	} finally {
		fs.rmSync(target, { force: true });
	}
});

test("sandboxed child bash error carrying a sandbox denial gets the readonly block notice", { skip: !canUseOsSandbox(), timeout: 40_000 }, async () => {
	const target = outsideTempPath("abort");
	try {
		const command = nodeCommand(
			`try { require("fs").writeFileSync(${JSON.stringify(target)}, "x") } catch (error) { console.log(error.message) } setInterval(() => {}, 1000)`,
		);

		await assert.rejects(runChildBashUntil(command, SANDBOX_DENIAL_PHRASE), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Command aborted/);
			assert.ok(error.message.endsWith(READONLY_SANDBOX_BLOCK_NOTICE), error.message);
			return true;
		});
		assert.equal(fs.existsSync(target), false, "the sandbox must block the write");
	} finally {
		fs.rmSync(target, { force: true });
	}
});

test("sandboxed child bash success returns its output without the notice", { skip: !canUseOsSandbox() }, async () => {
	const result = await runChildBash("echo readonly-child-ok");

	assert.equal(result.isError, undefined);
	assert.equal(textOf(result), "readonly-child-ok\n");
});

test("sandboxed child bash failure without a sandbox denial returns no notice", { skip: !canUseOsSandbox() }, async () => {
	const result = await runChildBash("echo plain-failure; exit 3");

	assert.equal(result.isError, true);
	assert.match(textOf(result), /plain-failure[\s\S]*Command exited with code 3$/);
	assert.equal(textOf(result).includes(READONLY_SANDBOX_BLOCK_NOTICE), false);
});

test("sandboxed child bash error without a sandbox denial is rethrown without the notice", { skip: !canUseOsSandbox(), timeout: 40_000 }, async () => {
	const command = sandboxed("echo plain-abort-marker; while :; do sleep 1; done");

	await assert.rejects(runChildBashUntil(command, "plain-abort-marker"), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Command aborted/);
		assert.equal(error.message.includes(READONLY_SANDBOX_BLOCK_NOTICE), false, error.message);
		return true;
	});
});

test("child bash call the readonly guard blocks throws the block reason", async () => {
	const target = outsideTempPath("blocked");

	try {
		await assert.rejects(runChildBash(`touch ${quoteShellArgument(target)}`), /Readonly mode:/);
		assert.equal(fs.existsSync(target), false);
	} finally {
		fs.rmSync(target, { force: true });
	}
});

test("child bash call the readonly guard blocks gets no block notice when its command names the denial phrase", hasDenialPhrase, async () => {
	const target = outsideTempPath("blocked-phrase");
	try {
		await assert.rejects(runChildBash(`echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(target)}`), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Readonly mode:/);
			assert.ok(error.message.includes(SANDBOX_DENIAL_PHRASE), error.message);
			assert.equal(error.message.includes(READONLY_SANDBOX_BLOCK_NOTICE), false, error.message);
			return true;
		});
	} finally {
		fs.rmSync(target, { force: true });
	}
});

test("child bash call the readonly guard blocks gets no block notice after a sandboxed call on the same tool", { skip: !canUseOsSandbox() || SANDBOX_DENIAL_PHRASES[process.platform] === undefined }, async () => {
	const target = outsideTempPath("blocked-after-sandboxed");
	const tool = createReadonlyChildBashTool(process.cwd());
	const run = (command: string) => tool.execute("child-bash", { command }, undefined, undefined, undefined as any);
	try {
		await run(sandboxed("echo sandboxed-first"));

		await assert.rejects(run(`echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(target)}`), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Readonly mode:/);
			assert.equal(error.message.includes(READONLY_SANDBOX_BLOCK_NOTICE), false, error.message);
			return true;
		});
	} finally {
		fs.rmSync(target, { force: true });
	}
});

test("concurrent child bash calls on one tool get the block notice only on the sandboxed call", { skip: !canUseOsSandbox() || SANDBOX_DENIAL_PHRASES[process.platform] === undefined }, async () => {
	const sandboxedTarget = outsideTempPath("concurrent-sandboxed");
	const blockedTarget = outsideTempPath("concurrent-blocked");
	const tool = createReadonlyChildBashTool(process.cwd());
	const run = (toolCallId: string, command: string) => tool.execute(toolCallId, { command }, undefined, undefined, undefined as any);
	try {
		const [sandboxedResult, blockedResult] = await Promise.allSettled([
			run("child-bash-sandboxed", nodeCommand(`require("fs").writeFileSync(${JSON.stringify(sandboxedTarget)}, "x")`)),
			run("child-bash-blocked", `echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(blockedTarget)}`),
		]);

		assert.equal(sandboxedResult.status, "fulfilled");
		assert.ok(textOf(sandboxedResult.value).endsWith(READONLY_SANDBOX_BLOCK_NOTICE), textOf(sandboxedResult.value));
		assert.equal(blockedResult.status, "rejected");
		assert.ok(blockedResult.reason instanceof Error);
		assert.match(blockedResult.reason.message, /Readonly mode:/);
		assert.equal(blockedResult.reason.message.includes(READONLY_SANDBOX_BLOCK_NOTICE), false, blockedResult.reason.message);
	} finally {
		fs.rmSync(sandboxedTarget, { force: true });
		fs.rmSync(blockedTarget, { force: true });
	}
});

test("sandboxed child bash timeout after a sandbox denial gets the readonly block notice", { skip: !canUseOsSandbox() || hasDenialPhrase.skip, timeout: 20_000 }, async () => {
	const command = sandboxed(`echo '${SANDBOX_DENIAL_PHRASE}'; while :; do sleep 1; done`);

	await assert.rejects(runChildBash(command, { timeout: 1 }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Command timed out after 1 seconds/);
		assert.ok(error.message.endsWith(READONLY_SANDBOX_BLOCK_NOTICE), error.message);
		return true;
	});
});

test("child bash call resolves a relative write against the execution cwd", async () => {
	const executionCwd = await tmpDir();
	// The tool's own cwd is outside temp, so classifying against it would block the write.
	const tool = createReadonlyChildBashTool(os.homedir());
	const ctx = { cwd: executionCwd, sessionManager: { getSessionId: () => "readonly-child", getSessionFile: () => undefined } };
	try {
		const result = await tool.execute("child-bash", { command: "touch relative-target" }, undefined, undefined, ctx as any);

		assert.equal(result.isError, undefined, textOf(result));
		assert.equal(fs.existsSync(path.join(executionCwd, "relative-target")), true);
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

	assert.equal(proof.result.details.model, proof.modelId);
	assert.match(proof.result.content[0].text, /READONLY_BASH_BLOCKED/);
	assert.equal(proof.bashWriteExists, false, "readonly child bash must not write to its cwd");
	assert.ok(proof.observedToolSets.length > 0);
	for (const toolNames of proof.observedToolSets) {
		assert.equal(toolNames.includes("write"), false);
		assert.equal(toolNames.includes("edit"), false);
		assert.equal(toolNames.includes("powershell"), false);
		assert.equal(toolNames.includes("spawn"), false);
		assert.equal(toolNames.includes("handoff"), false);
		assert.equal(toolNames.includes("bash"), true);
	}
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});
