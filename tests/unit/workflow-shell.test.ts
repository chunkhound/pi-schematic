// WAIVER: no public handle for raw bash-result mapping; excepted per AGENTS.md. Wire contract: docs/workflows.md
// Internal characterization tests: the runner maps pi's bash tool result onto the
// workflow wire contract and never executes when the readonly guard blocks.
import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	expect(blockedShellResult("readonly")).toStrictEqual({
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
	const run = createShellRunner(
		deps({
			run: async (command, options) => {
				seen = { command, timeout: options.timeout };
				return structured("full output", { exit_code: 0, truncated: true, full_output_path: "/tmp/pi-bash.log", wall_time_seconds: 1.5 });
			},
		}),
	);
	const result = await run("npm test", { timeout: 30 });
	expect(seen).toStrictEqual({ command: "npm test", timeout: 30 });
	expect(result).toStrictEqual({
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
	const run = createShellRunner(
		deps({
			run: async () => ({
				content: [{ type: "text", text: "boom" }],
				isError: true,
				structuredContent: { output: "boom", truncated: false, exit_code: 2, wall_time_seconds: 0.1 },
			}),
		}),
	);
	const result = await run("false");
	expect(result.ok).toBe(false);
	expect(result.exitCode).toBe(2);
	expect(result.output).toBe("boom");
});

test("createShellRunner maps an aborted run to killed and keeps the message visible", async () => {
	const controller = new AbortController();
	controller.abort();
	const run = createShellRunner(
		deps({
			signal: controller.signal,
			run: async () => {
				throw new Error("Command aborted");
			},
		}),
	);
	const result = await run("sleep 100");
	expect(result.ok).toBe(false);
	expect(result.killed).toBe(true);
	expect(result.exitCode).toBeNull();
	expect(result.output).toMatch(/aborted/);
});

test("isTimeoutMessage matches whole-second timeout texts", () => {
	expect(isTimeoutMessage("Command timed out after 1 seconds")).toBe(true);
	expect(isTimeoutMessage("Command timed out after 300 seconds")).toBe(true);
	expect(isTimeoutMessage("Command timed out after 0.01 seconds")).toBe(true);
	expect(isTimeoutMessage("Command timed out after 1.5 seconds")).toBe(true);
});

test("isTimeoutMessage matches timeout texts with prepended partial output", () => {
	// appendStatus prepends the partial output, so the status is the last line of the message.
	expect(isTimeoutMessage("partial output\n\nCommand timed out after 1 seconds")).toBe(true);
	expect(isTimeoutMessage("line1\nline2\n\nCommand timed out after 300 seconds")).toBe(true);
});

test("isTimeoutMessage rejects low-level and malformed timeout texts", () => {
	// The low-level `timeout:<n>` is rethrown by the bash definition, so it must not match.
	expect(isTimeoutMessage("timeout:1")).toBe(false);
	expect(isTimeoutMessage("Command timed out after seconds")).toBe(false);
	expect(isTimeoutMessage("spawn failure: request timed out")).toBe(false);
});

test("isTimeoutMessage rejects non-timeout failures", () => {
	expect(isTimeoutMessage("Command aborted")).toBe(false);
	expect(isTimeoutMessage("spawn failure: no such file")).toBe(false);
	expect(isTimeoutMessage("spawn failure: Command timed out after 5 seconds")).toBe(false);
});

test("createShellRunner reports a timed-out run as killed", async () => {
	const run = createShellRunner(
		deps({
			run: async () => {
				// pi's bash definition rethrows the low-level timeout as this user-facing text.
				throw new Error("Command timed out after 1 seconds");
			},
		}),
	);
	const result = await run("sleep 100", { timeout: 1 });
	expect(result.ok).toBe(false);
	expect(result.killed, "pi's timeout kills the process without aborting our signal").toBe(true);
	expect(result.exitCode).toBeNull();
});

test("a timed-out run that produced partial output still reports killed", async () => {
	const run = createShellRunner(
		deps({
			run: async () => {
				// appendStatus prepends the command's output before the timeout status.
				throw new Error("building...\n\nCommand timed out after 200 seconds");
			},
		}),
	);
	const result = await run("sleep 100", { timeout: 200 });
	expect(result.ok).toBe(false);
	expect(result.killed, "partial output must not hide the timeout classification").toBe(true);
	expect(result.exitCode).toBeNull();
	expect(result.output).toMatch(/Command timed out after 200 seconds/);
});

test("pi's real bash tool classifies a timeout as killed", { timeout: 15_000 }, async () => {
	// Drives the real bash tool (no `run` seam, no stubbed matcher): the production
	// `timeout:n` rethrow produces the message `isTimeoutMessage` must recognise.
	const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-shell-"));
	try {
		const result = await createShellRunner(deps({ cwd }))("sleep 10", { timeout: 1 });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBeNull();
		expect(result.killed, "killed is the shell timeout classification the host maps to time-limit").toBe(true);
		expect(isTimeoutMessage(result.output), "the real pi message matches the real matcher").toBe(true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("createShellRunner forwards streaming display snapshots", async () => {
	const seen: string[] = [];
	const run = createShellRunner(
		deps({
			onOutput: (display) => seen.push(display),
			run: async (_command, options) => {
				options.onUpdate?.("first");
				options.onUpdate?.("first\nsecond");
				return structured("first\nsecond");
			},
		}),
	);
	await run("printf");
	expect(seen).toStrictEqual(["first", "first\nsecond"]);
});

test("createShellRunner applies the readonly guard to one call without a posture change", async () => {
	let executed = 0;
	const run = createShellRunner(
		deps({
			run: async () => {
				executed += 1;
				return structured("");
			},
		}),
	);
	const result = await run("npm install lodash", { readonly: true });
	expect(result.ok).toBe(false);
	expect(result.exitCode).toBeNull();
	expect(executed).toBe(0);
});
