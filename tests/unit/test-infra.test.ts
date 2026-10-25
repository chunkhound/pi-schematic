// Tests for the test infrastructure itself: the shared Node child runner, the node:test runner
// script, and the run-wide config that keeps parameterized test titles whole.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO_ROOT } from "../paths.js";
import { spawnNode } from "./spawn-node.js";

describe("spawnNode", () => {
	test("throws a timeout error for a child that outlives its deadline", () => {
		expect(() => spawnNode(["--eval", "setTimeout(() => {}, 60_000)"], { cwd: REPO_ROOT, timeoutMs: 500 })).toThrow(
			/^Node child process did not exit within 500 ms/,
		);
	});

	// Windows has no POSIX signals: a process killing itself with SIGKILL exits with a status, not a signal.
	test.skipIf(process.platform === "win32")("throws a signal error for a child killed by a signal", () => {
		expect(() => spawnNode(["--eval", 'process.kill(process.pid, "SIGKILL")'], { cwd: REPO_ROOT })).toThrow(
			/^Node child process was killed by SIGKILL/,
		);
	});

	// The child would exit on its own after 10 s; the deadline must not wait for it.
	test.skipIf(process.platform === "win32")("kills a child that catches SIGTERM instead of waiting it out", () => {
		const startedAt = Date.now();
		const child = 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 10_000)';
		expect(() => spawnNode(["--eval", child], { cwd: REPO_ROOT, timeoutMs: 500 })).toThrow(
			/^Node child process did not exit within 500 ms/,
		);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	test("throws the spawn error for a working directory that does not exist", () => {
		const missingCwd = join(REPO_ROOT, "missing-directory-for-spawn-node");
		expect(() => spawnNode(["--version"], { cwd: missingCwd })).toThrow(/ENOENT/);
	});
});

describe("run-node-test", () => {
	// A Vitest file named next to node:test files would otherwise be dropped from the node:test run
	// while the other files keep the run green.
	test("refuses a Vitest file named by its path", () => {
		const result = spawnNode(
			["scripts/run-node-test.mjs", "tests/unit/thinking-levels.test.ts", "tests/unit/time-format.test.ts"],
			{ cwd: REPO_ROOT },
		);
		expect(result.stderr).toMatch(/tests\/unit\/thinking-levels\.test\.ts runs on Vitest/);
	});
});

const LONG_TITLE_VALUE = "a parameter value well past the forty-character default title limit";

// A `$name` placeholder is the form the limit cuts; a string row printed through `%s` is never cut.
test.each([{ value: LONG_TITLE_VALUE }])("keeps a long test.each title whole: $value", ({ value }) => {
	expect(value.length).toBeGreaterThan(40);
	expect(expect.getState().currentTestName).toBe(`keeps a long test.each title whole: ${LONG_TITLE_VALUE}`);
});
