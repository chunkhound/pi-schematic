import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { appendSandboxBlockNoticeToResult, canUseOsSandbox, quoteShellArgument, wrapCommandWithOsSandbox, wrapWithBwrap } from "../../os-sandbox.js";
import { bashResult } from "../unit/helpers.js";
import { expectSuffix } from "../assertions.js";

const NOTICE_SUFFIX =
	"\n\n[readonly mode] If this command failed on a write outside the OS temp dir, the OS sandbox blocked it.\nUse /readonly to disable, or write within the OS temp dir.";

const SANDBOX_TIMEOUT_MS = 20_000;

function hasPosixShell(): boolean {
	if (process.platform === "win32") {
		return false;
	}
	try {
		execFileSync("/bin/sh", ["-c", "true"], { stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

interface RunResult {
	stdout: Buffer;
	stderr: Buffer;
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * Run a command the way pi's bash tool spawns it: `<shell> -c`, stdin at
 * /dev/null, separate pipes, its own process group.
 */
function runLikePi(command: string, shell = "/bin/bash"): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(shell, ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, signal });
		});
	});
}

/** Run `command` like pi and assert that it exits 0. */
async function runLikePiOk(command: string): Promise<RunResult> {
	const run = await runLikePi(command);
	expect(run.code, run.stderr.toString()).toBe(0);
	return run;
}

async function runSandboxedAndPlain(command: string): Promise<{ sandboxed: RunResult; plain: RunResult }> {
	return { sandboxed: await runLikePi(wrapCommandWithOsSandbox(command)), plain: await runLikePi(command) };
}

test.skipIf(process.platform !== "linux" || !canUseOsSandbox())("bwrap executes a quoted bind path without shell injection", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-quote'-"));
	const target = path.join(dir, "result.txt");
	try {
		await runLikePiOk(wrapWithBwrap(`printf wrapped > ${quoteShellArgument(target)}`, dir));
		expect(fs.readFileSync(target, "utf8")).toBe("wrapped");
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

test.skipIf(!hasPosixShell())("quoteShellArgument round-trips through a POSIX shell", () => {
	for (const raw of ["normal", "spaces", "dollar$ign", "backtick`", "line1\nline2", "'mixed' quotes", "'"]) {
		const quoted = quoteShellArgument(raw);
		const result = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8", timeout: 2000 });
		expect(result, `quoteShellArgument(${JSON.stringify(raw)}) should round-trip`).toBe(raw);
	}
});

// ── Behavioral contract: observable sandbox effects ──────────────

for (const { name, write } of [
	{ name: "a shell redirect", write: (target: string) => `echo blocked > ${quoteShellArgument(target)}` },
	{
		name: "node writeFileSync",
		write: (target: string) =>
			`${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(`require("fs").writeFileSync(${JSON.stringify(target)}, "blocked")`)}`,
	},
]) {
	test.skipIf(!canUseOsSandbox())(
		`sandbox blocks ${name} outside temp`,
		async () => {
			const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${randomUUID()}`);
			try {
				const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

				expect(run.code).not.toBe(0);
				expect(fs.existsSync(outsidePath), "outside temp file should not be created").toBe(false);
			} finally {
				fs.rmSync(outsidePath, { force: true });
			}
		},
		SANDBOX_TIMEOUT_MS,
	);

	test.skipIf(!canUseOsSandbox())(
		`the failed result of ${name} the sandbox blocked gets the block notice`,
		async () => {
			const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${randomUUID()}`);
			try {
				const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

				const noticed = appendSandboxBlockNoticeToResult(bashResult(`${run.stdout.toString()}${run.stderr.toString()}`));

				const firstBlock = noticed?.content[0];
				expect(firstBlock?.type, JSON.stringify(noticed)).toBe("text");
				if (firstBlock?.type !== "text") {
					expect.unreachable();
				}
				expectSuffix(firstBlock.text, NOTICE_SUFFIX);
			} finally {
				fs.rmSync(outsidePath, { force: true });
			}
		},
		SANDBOX_TIMEOUT_MS,
	);
}

test.skipIf(!canUseOsSandbox())(
	"sandbox allows writes inside temp",
	async () => {
		const insideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-sandbox-"));
		const insidePath = path.join(insideDir, "inside.txt");
		try {
			await runLikePiOk(wrapCommandWithOsSandbox(`echo allowed > "${insidePath}"`));
			expect(fs.readFileSync(insidePath, "utf8").trim(), "sandbox should allow temp writes").toBe("allowed");
		} finally {
			try {
				fs.rmSync(insideDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandboxed command runs under the shell that launched the sandbox",
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-bash-"));
		const linkedBash = path.join(dir, "bash");
		try {
			fs.symlinkSync("/bin/bash", linkedBash);

			const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), linkedBash);

			expect(run.code, run.stderr.toString()).toBe(0);
			expect(run.stdout.toString()).toBe(`${linkedBash}\n`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandboxed command launched from /bin/sh runs under /bin/sh",
	async () => {
		const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), "/bin/sh");

		expect(run.code, run.stderr.toString()).toBe(0);
		expect(run.stdout.toString()).toBe("/bin/sh\n");
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox() || !fs.existsSync("/bin/zsh"))(
	"sandboxed command launched from zsh runs under zsh",
	async () => {
		const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), "/bin/zsh");

		expect(run.code, run.stderr.toString()).toBe(0);
		expect(run.stdout.toString()).toBe("/bin/zsh\n");
	},
	SANDBOX_TIMEOUT_MS,
);

for (const reader of ["cat", "read x", "head -1"]) {
	test.skipIf(!canUseOsSandbox())(
		`sandboxed ${reader} on pi's /dev/null stdin behaves as unsandboxed`,
		async () => {
			const { sandboxed, plain } = await runSandboxedAndPlain(`${reader}; echo after; false`);

			expect(sandboxed).toStrictEqual(plain);
			expect(sandboxed.stdout.toString()).toBe("after\n");
			expect(sandboxed.code).toBe(1);
		},
		SANDBOX_TIMEOUT_MS,
	);
}

for (const { command, bytes } of [
	{ command: String.raw`printf 'a\n\n\n'`, bytes: "a\n\n\n" },
	{ command: "printf -- -n", bytes: "-n" },
	{ command: String.raw`printf 'a\0b'`, bytes: "a\0b" },
]) {
	test.skipIf(!canUseOsSandbox())(
		`sandboxed ${command} writes the same bytes as unsandboxed`,
		async () => {
			const { sandboxed, plain } = await runSandboxedAndPlain(command);

			expect(sandboxed).toStrictEqual(plain);
			expect(sandboxed.stdout).toStrictEqual(Buffer.from(bytes));
		},
		SANDBOX_TIMEOUT_MS,
	);
}

test.skipIf(!canUseOsSandbox())(
	"sandboxed output to stderr reaches stderr, not stdout",
	async () => {
		const { sandboxed, plain } = await runSandboxedAndPlain("echo to-stderr >&2");

		expect(sandboxed).toStrictEqual(plain);
		expect(sandboxed.stdout.length).toBe(0);
		expect(sandboxed.stderr.toString()).toBe("to-stderr\n");
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandboxed trailing backslash prints as unsandboxed",
	async () => {
		// The output differs between bash versions, so it is compared with the
		// unsandboxed run rather than with a literal.
		const { sandboxed, plain } = await runSandboxedAndPlain("echo hi \\");

		expect(sandboxed).toStrictEqual(plain);
		expect(sandboxed.code).toBe(0);
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandboxed output streams while the command runs",
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-stream-"));
		const flag = path.join(dir, "flag");
		// The command waits for the flag, which the test creates only after the
		// first chunk arrived. Buffered output would never deliver that chunk
		// early, so the wait would run out (about 10 s) and print "timeout".
		const command =
			`printf first; i=0; while [ ! -e ${quoteShellArgument(flag)} ]; do ` +
			`if [ "$i" -ge 100 ]; then printf timeout; break; fi; sleep 0.1; i=$((i + 1)); done; printf second`;
		try {
			const stdout = await new Promise<string>((resolve, reject) => {
				const child = spawn("/bin/bash", ["-c", wrapCommandWithOsSandbox(command)], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
				const chunks: Buffer[] = [];
				child.stdout.on("data", (chunk: Buffer) => {
					if (chunks.length === 0) {
						fs.writeFileSync(flag, "");
					}
					chunks.push(chunk);
				});
				child.on("error", reject);
				child.on("close", () => {
					resolve(Buffer.concat(chunks).toString());
				});
			});

			expect(stdout).toBe("firstsecond");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandboxed stray closing brace is the same syntax error as unsandboxed",
	async () => {
		const { sandboxed, plain } = await runSandboxedAndPlain("echo one; } ; echo two");

		expect(plain.code).not.toBe(0);
		expect(sandboxed).toStrictEqual(plain);
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandbox allows writes to /dev/null",
	async () => {
		// CONTRACT: /dev/null redirects are always allowed (not a real write)
		const run = await runLikePi(wrapCommandWithOsSandbox("echo discard > /dev/null"));
		expect(run.code, run.stderr.toString()).toBe(0);
	},
	SANDBOX_TIMEOUT_MS,
);

test.skipIf(!canUseOsSandbox())(
	"sandbox allows writes through a symlinked temp path",
	async () => {
		const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-real-"));
		const linkDir = path.join(os.tmpdir(), `pi-readonly-link-${randomUUID()}`);
		try {
			// Create symlink to mimic /tmp → /private/tmp on macOS
			fs.symlinkSync(realDir, linkDir);
			const insidePath = path.join(linkDir, "via-symlink.txt");

			await runLikePiOk(wrapCommandWithOsSandbox(`echo symlink-works > "${insidePath}"`));
			expect(fs.readFileSync(insidePath, "utf8").trim(), "sandbox should allow writes through symlinks to temp").toBe("symlink-works");
		} finally {
			try {
				fs.rmSync(linkDir, { force: true });
			} catch {
				/* best-effort cleanup */
			}
			try {
				fs.rmSync(realDir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
	},
	SANDBOX_TIMEOUT_MS,
);
