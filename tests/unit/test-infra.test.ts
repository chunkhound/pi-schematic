// Tests for the test infrastructure itself: the shared Node and git child runners, the compat lane
// check that every file on its unit list exists and belongs to the unit project, the run-wide config
// that keeps parameterized test titles whole, and the prefix and suffix assertion helpers.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { expectPrefix, expectSuffix } from "../assertions.js";
import { REPO_ROOT, REPO_ROOT_URL } from "../paths.js";
import { runGit, spawnNode } from "./spawn-node.js";

interface CompatCurrentModule {
	assertCompatTestFiles: (files: string[]) => void;
	COMPAT_UNIT_FILES: string[];
}

// The script is plain JavaScript, so its exports arrive untyped: the check must be a function and the
// unit list an array of strings.
function assertCompatCurrentModule(value: unknown): asserts value is CompatCurrentModule {
	if (typeof value !== "object" || value === null) {throw new Error("scripts/test-compat-current.mjs did not load as a module.");}
	if (typeof Reflect.get(value, "assertCompatTestFiles") !== "function") {
		throw new Error('scripts/test-compat-current.mjs does not export a function "assertCompatTestFiles".');
	}
	const files: unknown = Reflect.get(value, "COMPAT_UNIT_FILES");
	if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
		throw new Error('scripts/test-compat-current.mjs does not export "COMPAT_UNIT_FILES" as an array of strings.');
	}
}

const compatCurrent: unknown = await import(new URL("scripts/test-compat-current.mjs", REPO_ROOT_URL).href);
assertCompatCurrentModule(compatCurrent);
const { assertCompatTestFiles, COMPAT_UNIT_FILES } = compatCurrent;

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
		const startedAt = performance.now();
		const child = 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 10_000)';
		expect(() => spawnNode(["--eval", child], { cwd: REPO_ROOT, timeoutMs: 500 })).toThrow(
			/^Node child process did not exit within 500 ms/,
		);
		expect(performance.now() - startedAt).toBeLessThan(5_000);
	});

	test("throws the spawn error for a working directory that does not exist", () => {
		const missingCwd = join(REPO_ROOT, "missing-directory-for-spawn-node");
		expect(() => spawnNode(["--version"], { cwd: missingCwd })).toThrow(/ENOENT/);
	});
});

describe("runGit", () => {
	test("throws the exit status and stderr for a git command that fails", () => {
		expect(() => runGit(["rev-parse", "--verify", "refs/heads/missing-branch-for-run-git"], { cwd: REPO_ROOT })).toThrow(
			/^git rev-parse --verify refs\/heads\/missing-branch-for-run-git exited with status 128; stderr: fatal: Needed a single revision/,
		);
	});

	test("throws a spawn error for a working directory that does not exist", () => {
		const missingCwd = join(REPO_ROOT, "missing-directory-for-run-git");
		expect(() => runGit(["--version"], { cwd: missingCwd })).toThrow(/^git --version failed to spawn: .*ENOENT/);
	});
});

describe("compat lane test files", () => {
	test("every file on the unit list exists and belongs to the unit project", () => {
		expect(() => { assertCompatTestFiles(COMPAT_UNIT_FILES); }).not.toThrow();
	});

	test("a list naming a missing file fails with that file's path", () => {
		expect(() => { assertCompatTestFiles(["tests/unit/spawn.test.ts", "tests/unit/missing.test.ts"]); }).toThrow(
			new Error("The compat lane lists test files that do not exist: tests/unit/missing.test.ts"),
		);
	});

	test("a list naming an existing file outside the project fails with that file's path", () => {
		expect(() => { assertCompatTestFiles(["tests/unit/spawn.test.ts", "tests/e2e/basic.test.ts"]); }).toThrow(
			new Error("The compat lane lists test files outside the unit project: tests/e2e/basic.test.ts"),
		);
	});

	test("a list naming an existing non-test file inside the project fails with that file's path", () => {
		expect(() => { assertCompatTestFiles(["tests/unit/spawn.test.ts", "tests/unit/helpers.ts"]); }).toThrow(
			new Error("The compat lane lists test files outside the unit project: tests/unit/helpers.ts"),
		);
	});
});

describe("expectPrefix and expectSuffix", () => {
	const whole = "hello world";
	const helpers = [
		{ name: "expectPrefix", check: expectPrefix, match: "hello", mismatch: "world", otherCase: "HELLO", padded: " hello" },
		{ name: "expectSuffix", check: expectSuffix, match: "world", mismatch: "hello", otherCase: "WORLD", padded: "world " },
	];

	describe.for(helpers)("$name", ({ check, match, mismatch, otherCase, padded }) => {
		test.for([
			{ title: "a matching part", part: match },
			{ title: "an empty part", part: "" },
			{ title: "a part equal to the whole string", part: whole },
		])("passes on $title", ({ part }) => {
			expect(() => {
				check(whole, part);
			}).not.toThrow();
		});

		test("fails on a non-matching part, printing the full string before the comparison", () => {
			expect(() => {
				check(whole, mismatch);
			}).toThrow(new RegExp(`^${whole}: expected '${match}' to be '${mismatch}'`));
		});

		test("fails on a part that differs only in letter case", () => {
			expect(() => {
				check(whole, otherCase);
			}).toThrow();
		});

		test("fails on a part that differs only in surrounding whitespace", () => {
			expect(() => {
				check(whole, padded);
			}).toThrow();
		});

		test("fails on a string shorter than the part, comparing the whole string", () => {
			expect(() => {
				check("hi", whole);
			}).toThrow(new RegExp(`^hi: expected 'hi' to be '${whole}'`));
		});

		test("prints the caller's message on its own line before the full string", () => {
			expect(() => {
				check(whole, mismatch, "the greeting");
			}).toThrow(new RegExp(`^the greeting\\n${whole}: expected '${match}' to be '${mismatch}'`));
		});
	});

	// A suffix longer than the string but shorter than twice its length is the case where an unclamped
	// negative start index wraps around and compares a cut-off tail.
	test("expectSuffix compares the whole string for a suffix longer than it but shorter than twice its length", () => {
		expect(() => {
			expectSuffix("abcdef", "xxabcdef");
		}).toThrow(/^abcdef: expected 'abcdef' to be 'xxabcdef'/);
	});
});

const LONG_TITLE_VALUE = "a parameter value well past the forty-character default title limit";

// A `$name` placeholder is the form the limit cuts; a string row printed through `%s` is never cut.
test.each([{ value: LONG_TITLE_VALUE }])("keeps a long test.each title whole: $value", ({ value }) => {
	expect(value.length).toBeGreaterThan(40);
	expect(expect.getState().currentTestName).toBe(`keeps a long test.each title whole: ${LONG_TITLE_VALUE}`);
});
