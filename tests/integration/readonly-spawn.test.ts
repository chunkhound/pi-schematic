import { expect, onTestFinished, test } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createReadonlyChildBashTool } from "../../spawn/index.js";
import { expectSuffix, isRecord } from "../assertions.js";
import { applyReadonlyBashGuard } from "../../readonly-bash.js";
import { canUseOsSandbox, quoteShellArgument } from "../../os-sandbox.js";
import { SANDBOX_DENIAL_PHRASES } from "../support/sandbox.js";
import { tmpDir } from "../support/temp.js";
import { textOf } from "../support/tool-result.js";
import { createRunner } from "../support/runner.js";
import { runRealChildInvocation } from "../support/real-child.js";

const BLOCK_NOTICE =
	"[readonly mode] If this command failed on a write outside the OS temp dir, the OS sandbox blocked it.\nUse /readonly to disable, or write within the OS temp dir.";

function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
	expect(result.status).toBe("fulfilled");
	if (result.status !== "fulfilled") {
		expect.unreachable();
	}
	return result.value;
}

function rejectionError(result: PromiseSettledResult<unknown>): Error {
	expect(result.status).toBe("rejected");
	if (result.status !== "rejected") {
		expect.unreachable();
	}
	const reason: unknown = result.reason;
	if (!(reason instanceof Error)) {
		expect.unreachable("the blocked call must reject with an Error");
	}
	return reason;
}

// The details and first content block of a spawn tool result.
function spawnResultParts(result: unknown): { details: Record<string, unknown>; first: Record<string, unknown> } {
	if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.content)) {
		throw new Error("The spawn result has no details or content.");
	}
	const first: unknown = result.content[0];
	if (!isRecord(first)) {
		throw new Error("The spawn result has no first content block.");
	}
	return { details: result.details, first };
}

// The structured output and exit code of a child bash result.
function structuredBashResult(structured: unknown): { output: string; exit_code: number } {
	if (!isRecord(structured) || typeof structured.output !== "string" || typeof structured.exit_code !== "number") {
		throw new Error("The child bash result has no structured output and exit code.");
	}
	return { output: structured.output, exit_code: structured.exit_code };
}

// ── Readonly child bash tool ─────────────────────────────────────────

/**
 * A tool context from the runner fixture whose `ctx.cwd` is `cwd`. The child bash tool reads the
 * session id, model and thinking level from it, so the fixture binds those and loads no extension.
 */
async function childToolContext(cwd: string = process.cwd()): Promise<ExtensionToolContext> {
	const { runner } = await createRunner({
		cwd,
		mode: "tui",
		factories: [],
		sessionManager: SessionManager.inMemory(cwd),
		context: { getModel: () => undefined },
		actions: { getThinkingLevel: () => "off" },
	});
	return runner.createToolContext("child-bash", undefined);
}

function outsideTempPath(label: string): string {
	const target = path.join(os.homedir(), `readonly-child-${label}-${randomUUID()}`);
	onTestFinished(() => {
		fs.rmSync(target, { force: true });
	});
	return target;
}

async function runChildBash(
	command: string,
	options: { timeout?: number; signal?: AbortSignal; onUpdate?: (update: { content: { type: string; text?: string }[] }) => void } = {},
) {
	// The tool context runs the command in the process directory, the tool's own cwd.
	return createReadonlyChildBashTool(process.cwd()).execute(
		"child-bash",
		{ command, timeout: options.timeout },
		options.signal,
		options.onUpdate,
		await childToolContext(),
	);
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
			if (textOf(update).toLowerCase().includes(marker.toLowerCase())) {
				controller.abort();
			}
		},
	});
}

const SANDBOX_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform] ?? "";
const skipWithoutDenialPhrase = SANDBOX_DENIAL_PHRASES[process.platform] === undefined;

test.skipIf(!canUseOsSandbox())("sandboxed child bash write outside temp returns the readonly block notice", async () => {
	const target = outsideTempPath("write");
	const result = await runChildBash(nodeCommand(`require("fs").writeFileSync(${JSON.stringify(target)}, "x")`));

	expect(result.isError).toBe(true);
	expect(textOf(result), textOf(result)).toContain(BLOCK_NOTICE);
	const structured = structuredBashResult(result.structuredContent);
	expectSuffix(structured.output, `\n\n${BLOCK_NOTICE}`);
	expect(structured.exit_code).toBe(1);
	expect(target, "the sandbox must block the write").not.toSatisfy(fs.existsSync);
});

test.skipIf(!canUseOsSandbox())(
	"sandboxed child bash error carrying a sandbox denial gets the readonly block notice",
	async () => {
		const target = outsideTempPath("abort");
		const command = nodeCommand(
			`try { require("fs").writeFileSync(${JSON.stringify(target)}, "x") } catch (error) { console.log(error.message) } setInterval(() => {}, 1000)`,
		);

		await expect(runChildBashUntil(command, SANDBOX_DENIAL_PHRASE)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toMatch(/Command aborted/);
			expectSuffix(error.message, BLOCK_NOTICE);
			return true;
		});
		expect(target, "the sandbox must block the write").not.toSatisfy(fs.existsSync);
	},
	40_000,
);

test.skipIf(!canUseOsSandbox())("sandboxed child bash success returns its output without the notice", async () => {
	const result = await runChildBash("echo readonly-child-ok");

	expect(result.isError).toBeUndefined();
	expect(textOf(result)).toBe("readonly-child-ok\n");
});

test.skipIf(!canUseOsSandbox())("sandboxed child bash failure without a sandbox denial returns no notice", async () => {
	const result = await runChildBash("echo plain-failure; exit 3");

	expect(result.isError).toBe(true);
	expect(textOf(result)).toMatch(/plain-failure[\s\S]*Command exited with code 3$/);
	expect(textOf(result)).not.toContain(BLOCK_NOTICE);
});

test.skipIf(!canUseOsSandbox())(
	"sandboxed child bash error without a sandbox denial is rethrown without the notice",
	async () => {
		const command = sandboxed("echo plain-abort-marker; while :; do sleep 1; done");

		await expect(runChildBashUntil(command, "plain-abort-marker")).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toMatch(/Command aborted/);
			expect(error.message, error.message).not.toContain(BLOCK_NOTICE);
			return true;
		});
	},
	40_000,
);

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
		expect(error.message, error.message).not.toContain(BLOCK_NOTICE);
		return true;
	});
});

test.skipIf(!canUseOsSandbox() || skipWithoutDenialPhrase)(
	"child bash call the readonly guard blocks gets no block notice after a sandboxed call on the same tool",
	async () => {
		const target = outsideTempPath("blocked-after-sandboxed");
		const tool = createReadonlyChildBashTool(process.cwd());
		const ctx = await childToolContext();
		const run = (command: string) => tool.execute("child-bash", { command }, undefined, undefined, ctx);
		await run(sandboxed("echo sandboxed-first"));

		await expect(run(`echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(target)}`)).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toMatch(/Readonly mode:/);
			expect(error.message, error.message).not.toContain(BLOCK_NOTICE);
			return true;
		});
	},
);

test.skipIf(!canUseOsSandbox() || skipWithoutDenialPhrase)(
	"concurrent child bash calls on one tool get the block notice only on the sandboxed call",
	async () => {
		const sandboxedTarget = outsideTempPath("concurrent-sandboxed");
		const blockedTarget = outsideTempPath("concurrent-blocked");
		const tool = createReadonlyChildBashTool(process.cwd());
		const ctx = await childToolContext();
		const run = (toolCallId: string, command: string) => tool.execute(toolCallId, { command }, undefined, undefined, ctx);
		const [sandboxedResult, blockedResult] = await Promise.allSettled([
			run("child-bash-sandboxed", nodeCommand(`require("fs").writeFileSync(${JSON.stringify(sandboxedTarget)}, "x")`)),
			run("child-bash-blocked", `echo '${SANDBOX_DENIAL_PHRASE}' > ${quoteShellArgument(blockedTarget)}`),
		]);

		expectSuffix(textOf(fulfilledValue(sandboxedResult)), BLOCK_NOTICE);
		const reason = rejectionError(blockedResult);
		expect(reason.message).toMatch(/Readonly mode:/);
		expect(reason.message, reason.message).not.toContain(BLOCK_NOTICE);
	},
);

test.skipIf(!canUseOsSandbox() || skipWithoutDenialPhrase)(
	"sandboxed child bash timeout after a sandbox denial gets the readonly block notice",
	async () => {
		const command = sandboxed(`echo '${SANDBOX_DENIAL_PHRASE}'; while :; do sleep 1; done`);

		await expect(runChildBash(command, { timeout: 1 })).rejects.toSatisfy((error: Error) => {
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toMatch(/Command timed out after 1 seconds/);
			expectSuffix(error.message, BLOCK_NOTICE);
			return true;
		});
	},
	20_000,
);

test("child bash call resolves a relative write against the execution cwd", async () => {
	const executionCwd = await tmpDir();
	// The tool's own cwd is outside temp, so classifying against it would block the write.
	const tool = createReadonlyChildBashTool(os.homedir());
	try {
		const ctx = await childToolContext(executionCwd);
		const result = await tool.execute("child-bash", { command: "touch relative-target" }, undefined, undefined, ctx);

		expect(result.isError, textOf(result)).toBeUndefined();
		expect(path.join(executionCwd, "relative-target")).toSatisfy(fs.existsSync);
	} finally {
		fs.rmSync(executionCwd, { recursive: true, force: true });
	}
});

// ── Real child ───────────────────────────────────────────────────────

test("real readonly child omits write/edit/powershell and blocks a non-temp bash write", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Attempt the requested bash command and report its result.",
		readonly: true,
		invokeReadonlyBash: true,
		cwdOutsideTemp: true,
		activeTools: ["read", "bash", "write", "edit", "powershell", "agentic_e2e_probe", "spawn", "handoff"],
	});

	const { details, first } = spawnResultParts(proof.result);
	expect(details.model).toBe(proof.modelId);
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
