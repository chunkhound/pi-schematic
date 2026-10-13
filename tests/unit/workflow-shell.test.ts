// WAIVER: no public handle for raw bash-result mapping; excepted per AGENTS.md. Wire contract: docs/workflows.md
// Internal characterization tests: the runner maps pi's bash tool result onto the
// workflow wire contract and never executes when the readonly guard blocks.
import assert from "node:assert/strict";
import test from "node:test";
import { blockedShellResult, createShellRunner, isTimeoutMessage, type ShellRunnerDeps, type ShellToolResult } from "../../workflow/shell.js";

function deps(overrides: Partial<ShellRunnerDeps> = {}): ShellRunnerDeps {
	return { cwd: "/workspace", signal: new AbortController().signal, isReadonly: () => false, ...overrides };
}

function structured(output: string, extra: Partial<NonNullable<ShellToolResult["structuredContent"]>> = {}): ShellToolResult {
	return {
		content: [{ type: "text", text: output }],
		isError: false,
		structuredContent: { output, truncated: false, exit_code: 0, wall_time_seconds: 0.25, ...extra },
	};
}

test("blockedShellResult is a failure with a null exit code", () => {
	assert.deepEqual(blockedShellResult("readonly"), {
		ok: false,
		exitCode: null,
		output: "readonly",
		display: "readonly",
		truncated: false,
		killed: false,
	});
});

test("createShellRunner maps pi's structured output onto ShellResult", async () => {
	let seen: { command: string; timeout: number | undefined } | null = null;
	const run = createShellRunner(deps({
		run: async (command, options) => {
			seen = { command, timeout: options.timeout };
			return structured("full output", { exit_code: 0, truncated: true, full_output_path: "/tmp/pi-bash.log", wall_time_seconds: 1.5 });
		},
	}));
	const result = await run("npm test", { timeout: 30 });
	assert.deepEqual(seen, { command: "npm test", timeout: 30 });
	assert.deepEqual(result, {
		ok: true,
		exitCode: 0,
		output: "full output",
		display: "full output",
		truncated: true,
		killed: false,
		fullOutputPath: "/tmp/pi-bash.log",
		wallTimeSeconds: 1.5,
	});
});

test("createShellRunner reports a non-zero exit as a failed result, not a rejection", async () => {
	const run = createShellRunner(deps({
		run: async () => ({ content: [{ type: "text", text: "boom" }], isError: true, structuredContent: { output: "boom", truncated: false, exit_code: 2, wall_time_seconds: 0.1 } }),
	}));
	const result = await run("false");
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 2);
	assert.equal(result.output, "boom");
});

test("createShellRunner maps an aborted run to killed and keeps the message visible", async () => {
	const controller = new AbortController();
	controller.abort();
	const run = createShellRunner(deps({
		signal: controller.signal,
		run: async () => {
			throw new Error("Command aborted");
		},
	}));
	const result = await run("sleep 100");
	assert.equal(result.ok, false);
	assert.equal(result.killed, true);
	assert.equal(result.exitCode, null);
	assert.match(result.output, /aborted/);
});

test("isTimeoutMessage matches pi's stable timeout text only", () => {
	assert.equal(isTimeoutMessage("Command timed out after 1 seconds"), true);
	assert.equal(isTimeoutMessage("Command timed out after 300 seconds"), true);
	// appendStatus prepends the partial output, so the status is the last line of the message.
	assert.equal(isTimeoutMessage("partial output\n\nCommand timed out after 1 seconds"), true);
	assert.equal(isTimeoutMessage("line1\nline2\n\nCommand timed out after 300 seconds"), true);
	// The low-level `timeout:<n>` is rethrown by the bash definition, so it must not match.
	assert.equal(isTimeoutMessage("timeout:1"), false);
	assert.equal(isTimeoutMessage("Command timed out after seconds"), false);
	assert.equal(isTimeoutMessage("spawn failure: request timed out"), false);
	assert.equal(isTimeoutMessage("Command aborted"), false);
	assert.equal(isTimeoutMessage("spawn failure: no such file"), false);
});

test("createShellRunner reports a timed-out run as killed", async () => {
	const run = createShellRunner(deps({
		run: async () => {
			// pi's bash definition rethrows the low-level timeout as this user-facing text.
			throw new Error("Command timed out after 1 seconds");
		},
	}));
	const result = await run("sleep 100", { timeout: 1 });
	assert.equal(result.ok, false);
	assert.equal(result.killed, true, "pi's timeout kills the process without aborting our signal");
	assert.equal(result.exitCode, null);
});

test("a timed-out run that produced partial output still reports killed", async () => {
	const run = createShellRunner(deps({
		run: async () => {
			// appendStatus prepends the command's output before the timeout status.
			throw new Error("building...\n\nCommand timed out after 200 seconds");
		},
	}));
	const result = await run("sleep 100", { timeout: 200 });
	assert.equal(result.ok, false);
	assert.equal(result.killed, true, "partial output must not hide the timeout classification");
	assert.equal(result.exitCode, null);
	assert.match(result.output, /Command timed out after 200 seconds/);
});

test("createShellRunner forwards streaming display snapshots", async () => {
	const seen: string[] = [];
	const run = createShellRunner(deps({
		onOutput: (display) => seen.push(display),
		run: async (_command, options) => {
			options.onUpdate?.("first");
			options.onUpdate?.("first\nsecond");
			return structured("first\nsecond");
		},
	}));
	await run("printf");
	assert.deepEqual(seen, ["first", "first\nsecond"]);
});

test("createShellRunner applies the readonly guard to one call without a posture change", async () => {
	let executed = 0;
	const run = createShellRunner(deps({
		run: async () => {
			executed += 1;
			return structured("");
		},
	}));
	const result = await run("npm install lodash", { readonly: true });
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, null);
	assert.equal(executed, 0);
});
