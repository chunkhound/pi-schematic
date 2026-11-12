import { expect, test } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import {
	appendSandboxBlockNotice,
	appendSandboxBlockNoticeToResult,
	buildMacProfile,
	canUseOsSandbox,
	quoteShellArgument,
	wrapCommandWithOsSandbox,
	wrapWithBwrap,
	wrapWithSandboxExec,
} from "../../os-sandbox.js";
import { READONLY_SANDBOX_BLOCK_NOTICE } from "../../notifications.js";
import { resolveRealPath } from "../../resolve-path.js";
import { bashResult, SANDBOX_DENIAL_PHRASES } from "./helpers.js";
import { assertPresent, expectSuffix } from "../assertions.js";

const NOTICE_SUFFIX = `\n\n${READONLY_SANDBOX_BLOCK_NOTICE}`;

function hasPosixShell(): boolean {
	if (process.platform === "win32") return false;
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

const SANDBOX_TIMEOUT_MS = 20_000;

/** A blocked write's error on the current host, or `undefined` on a platform without a sandbox. */
const HOST_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform];
const HOST_DENIAL_OUTPUT = HOST_DENIAL_PHRASE === undefined ? undefined : `bash: /outside: ${HOST_DENIAL_PHRASE}`;
/** Every platform's denial phrase except the current host's, so it never matches by default. */
const OTHER_DENIAL_OUTPUT = `bash: /outside: ${Object.entries(SANDBOX_DENIAL_PHRASES)
	.filter(([platform]) => platform !== process.platform)
	.map(([, phrase]) => phrase)
	.join("; ")}`;

// ── Block notice ────────────────────────────────────────────────

// A row without a platform uses the default, the current host.
for (const { platform, output } of [
	{ platform: "darwin", output: "bash: /outside: Operation not permitted" },
	{ platform: "darwin", output: "Error: EPERM: operation not permitted, open '/outside'" },
	{ platform: "linux", output: "bash: /outside: Read-only file system" },
	{ platform: "linux", output: "Error: EROFS: read-only file system, open '/outside'" },
	...(HOST_DENIAL_OUTPUT === undefined ? [] : [{ platform: undefined, output: HOST_DENIAL_OUTPUT }]),
] as { platform?: NodeJS.Platform; output: string }[]) {
	test(`appends the block notice to a failed ${platform ?? "current-platform"} result reporting "${output}"`, () => {
		const result = bashResult(output);

		const noticed = appendSandboxBlockNoticeToResult(result, platform);

		expect(noticed).toStrictEqual({
			content: [{ type: "text", text: `${output}\n\nCommand exited with code 1${NOTICE_SUFFIX}` }],
			structuredContent: { output: `${output}${NOTICE_SUFFIX}`, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
		});
	});
}

for (const { name, platform, output, isError } of [
	{ name: "Permission denied on darwin", platform: "darwin", output: "bash: /outside: Permission denied", isError: true },
	{ name: "Permission denied on linux", platform: "linux", output: "bash: /outside: Permission denied", isError: true },
	{ name: "the linux phrase on darwin", platform: "darwin", output: "bash: /outside: Read-only file system", isError: true },
	{ name: "the darwin phrase on linux", platform: "linux", output: "bash: /outside: Operation not permitted", isError: true },
	{ name: "a successful result with the darwin phrase", platform: "darwin", output: "bash: /outside: Operation not permitted", isError: false },
	{ name: "both phrases on win32", platform: "win32", output: "bash: /outside: Operation not permitted; Read-only file system", isError: true },
	{ name: "another platform's phrase on the current platform", platform: undefined, output: OTHER_DENIAL_OUTPUT, isError: true },
] as { name: string; platform?: NodeJS.Platform; output: string; isError: boolean }[]) {
	test(`appends no block notice for ${name}`, () => {
		expect(appendSandboxBlockNoticeToResult(bashResult(output, isError), platform)).toBe(undefined);
	});
}

test("appends no block notice to a result whose isError is unset", () => {
	const { isError: _isError, ...result } = bashResult("bash: /outside: Operation not permitted");

	expect(appendSandboxBlockNoticeToResult(result, "darwin")).toBe(undefined);
});

test("block notice leaves the input result unchanged", () => {
	const result = bashResult("bash: /outside: Operation not permitted");
	const before = structuredClone(result);

	appendSandboxBlockNoticeToResult(result, "darwin");

	expect(result).toStrictEqual(before);
});

test("block notice goes after the last text block only", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [
			{ type: "text", text: "bash: /outside: Operation not permitted" },
			{ type: "text", text: "Command exited with code 1" },
		],
		isError: true,
	}, "darwin");

	expect(noticed?.content).toStrictEqual([
		{ type: "text", text: "bash: /outside: Operation not permitted" },
		{ type: "text", text: `Command exited with code 1${NOTICE_SUFFIX}` },
	]);
});

test("block notice keeps a non-text block in place and goes after the last text block", () => {
	const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };

	const noticed = appendSandboxBlockNoticeToResult({
		content: [
			{ type: "text", text: "bash: /outside: Operation not permitted" },
			image,
			{ type: "text", text: "Command exited with code 1" },
		],
		isError: true,
	}, "darwin");

	expect(noticed?.content).toStrictEqual([
		{ type: "text", text: "bash: /outside: Operation not permitted" },
		image,
		{ type: "text", text: `Command exited with code 1${NOTICE_SUFFIX}` },
	]);
});

test("block notice returns an absent structured content as undefined", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
		isError: true,
	}, "darwin");

	expect(noticed).toStrictEqual({
		content: [{ type: "text", text: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}` }],
		structuredContent: undefined,
	});
});

test("block notice keeps structured content without a string output as it is", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
		structuredContent: { output: null, exit_code: 1 },
		isError: true,
	}, "darwin");

	expect(noticed?.structuredContent).toStrictEqual({ output: null, exit_code: 1 });
});

test("block notice adds a text block when the phrase is only in the structured output", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [],
		structuredContent: { output: "bash: /outside: Operation not permitted", exit_code: 1 },
		isError: true,
	}, "darwin");

	expect(noticed).toStrictEqual({
		content: [{ type: "text", text: READONLY_SANDBOX_BLOCK_NOTICE }],
		structuredContent: { output: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}`, exit_code: 1 },
	});
});

for (const { name, structuredContent } of [
	{ name: "an array", structuredContent: ["bash: /outside: Operation not permitted"] },
	{ name: "a string", structuredContent: "bash: /outside: Operation not permitted" },
	{ name: "a number", structuredContent: 1 },
]) {
	test(`block notice keeps ${name} structured content as it is`, () => {
		const before = structuredClone(structuredContent);

		const noticed = appendSandboxBlockNoticeToResult({
			content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
			structuredContent,
			isError: true,
		}, "darwin");

		expect(noticed?.content).toStrictEqual([{ type: "text", text: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}` }]);
		expect(noticed?.structuredContent).toBe(structuredContent);
		expect(noticed?.structuredContent).toStrictEqual(before);
	});
}

// A row without a platform uses the default, the current host.
for (const { platform, message } of [
	{ platform: "linux", message: "Error: EROFS: read-only file system, open '/outside'" },
	...(HOST_DENIAL_OUTPUT === undefined ? [] : [{ platform: undefined, message: HOST_DENIAL_OUTPUT }]),
] as { platform?: NodeJS.Platform; message: string }[]) {
	test(`text block notice appends the notice on ${platform ?? "the current platform"} to "${message}"`, () => {
		expect(appendSandboxBlockNotice(message, platform)).toBe(`${message}${NOTICE_SUFFIX}`);
	});
}

for (const { name, platform, message } of [
	{ name: "Permission denied", platform: "darwin", message: "bash: /outside: Permission denied" },
	{ name: "the other platform's phrase", platform: "linux", message: "Error: EPERM: operation not permitted" },
	{ name: "another platform's phrase on the current platform", platform: undefined, message: OTHER_DENIAL_OUTPUT },
] as { name: string; platform?: NodeJS.Platform; message: string }[]) {
	test(`text block notice appends nothing for ${name}`, () => {
		expect(appendSandboxBlockNotice(message, platform)).toBe(undefined);
	});
}

// ── Wrapper shape ───────────────────────────────────────────────

test(`sandbox wrappers pass the command as one quoted argument to "$0" -c with nothing added`, () => {
	const command = `printf '%s\\n' "it's quoted"\necho second line`;

	for (const wrapped of [wrapWithSandboxExec(command), wrapWithBwrap(command)]) {
		expectSuffix(wrapped, ` "$0" -c ${quoteShellArgument(command)}`);
		expect(wrapped, wrapped).not.toContain("<<");
		expect(wrapped, wrapped).not.toContain(READONLY_SANDBOX_BLOCK_NOTICE);
		expect(wrapped, wrapped).not.toContain("2>&1");
	}
});

// ── buildMacProfile invariants ──────────────────────────────────

test("buildMacProfile rejects paths containing quotes", () => {
	expect(() => buildMacProfile("/tmp/evil'")).toThrow(/contain.*quote/);
	expect(() => buildMacProfile('/tmp/evil"')).toThrow(/contain.*quote/);
});

test("quotes dynamic Linux sandbox paths for the outer shell", () => {
	const tempPath = "/tmp/readonly' ; echo injected; #";
	const canonicalPath = resolveRealPath(tempPath);
	const quotedPath = quoteShellArgument(canonicalPath);
	const wrapped = wrapWithBwrap("true", tempPath);

	expect(quoteShellArgument("a'b")).toBe(`'a'"'"'b'`);
	expect(wrapped).toContain(`--bind ${quotedPath} ${quotedPath}`);
	expect(wrapped).not.toContain(`--bind "${canonicalPath}" "${canonicalPath}"`);
});

test.skipIf(process.platform !== "linux" || !canUseOsSandbox())("bwrap executes a quoted bind path without shell injection", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-quote'-"));
	const target = path.join(dir, "result.txt");
	try {
		await runLikePiOk(wrapWithBwrap(`printf wrapped > ${quoteShellArgument(target)}`, dir));
		expect(fs.readFileSync(target, "utf8")).toBe("wrapped");
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

test("quoteShellArgument emits POSIX single-quoted arguments", () => {
	// POSIX shell single-quote invariant: input is wrapped in single quotes.
	// Embedded single quotes close, quote, and reopen the outer argument.
	expect(quoteShellArgument("")).toBe("''");
	expect(quoteShellArgument("normal")).toBe("'normal'");
	expect(quoteShellArgument("'")).toBe(`''"'"''`);
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
		write: (target: string) => `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(`require("fs").writeFileSync(${JSON.stringify(target)}, "blocked")`)}`,
	},
]) {
	test.skipIf(!canUseOsSandbox())(`sandbox blocks ${name} outside temp`, async () => {
		const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${process.pid}-${Date.now()}`);
		try {
			const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

			expect(run.code).not.toBe(0);
			expect(fs.existsSync(outsidePath), "outside temp file should not be created").toBe(false);
		} finally {
			fs.rmSync(outsidePath, { force: true });
		}
	}, SANDBOX_TIMEOUT_MS);

	test.skipIf(!canUseOsSandbox())(`the failed result of ${name} the sandbox blocked gets the block notice`, async () => {
		const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${process.pid}-${Date.now()}`);
		try {
			const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

			const noticed = appendSandboxBlockNoticeToResult(bashResult(`${run.stdout}${run.stderr}`));

			assertPresent(noticed, "the sandbox block should produce a noticed result");
			const firstBlock = noticed.content[0];
			assertPresent(firstBlock, JSON.stringify(noticed));
			expect(firstBlock.type, JSON.stringify(noticed)).toBe("text");
			if (firstBlock.type !== "text") throw new Error(JSON.stringify(noticed));
			expectSuffix(firstBlock.text, NOTICE_SUFFIX, JSON.stringify(noticed));
		} finally {
			fs.rmSync(outsidePath, { force: true });
		}
	}, SANDBOX_TIMEOUT_MS);
}

test.skipIf(!canUseOsSandbox())("sandbox allows writes inside temp", async () => {
	const insideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-sandbox-"));
	const insidePath = path.join(insideDir, "inside.txt");
	try {
		await runLikePiOk(wrapCommandWithOsSandbox(`echo allowed > "${insidePath}"`));
		expect(fs.readFileSync(insidePath, "utf8").trim(), "sandbox should allow temp writes").toBe("allowed");
	} finally {
		try { fs.rmSync(insideDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandboxed command runs under the shell that launched the sandbox", async () => {
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
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandboxed command launched from /bin/sh runs under /bin/sh", async () => {
	const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), "/bin/sh");

	expect(run.code, run.stderr.toString()).toBe(0);
	expect(run.stdout.toString()).toBe("/bin/sh\n");
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox() || !fs.existsSync("/bin/zsh"))("sandboxed command launched from zsh runs under zsh", async () => {
	const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), "/bin/zsh");

	expect(run.code, run.stderr.toString()).toBe(0);
	expect(run.stdout.toString()).toBe("/bin/zsh\n");
}, SANDBOX_TIMEOUT_MS);

for (const reader of ["cat", "read x", "head -1"]) {
	test.skipIf(!canUseOsSandbox())(`sandboxed ${reader} on pi's /dev/null stdin behaves as unsandboxed`, async () => {
		const { sandboxed, plain } = await runSandboxedAndPlain(`${reader}; echo after; false`);

		expect(sandboxed).toStrictEqual(plain);
		expect(sandboxed.stdout.toString()).toBe("after\n");
		expect(sandboxed.code).toBe(1);
	}, SANDBOX_TIMEOUT_MS);
}

for (const { command, bytes } of [
	{ command: String.raw`printf 'a\n\n\n'`, bytes: "a\n\n\n" },
	{ command: "printf -- -n", bytes: "-n" },
	{ command: String.raw`printf 'a\0b'`, bytes: "a\0b" },
]) {
	test.skipIf(!canUseOsSandbox())(`sandboxed ${command} writes the same bytes as unsandboxed`, async () => {
		const { sandboxed, plain } = await runSandboxedAndPlain(command);

		expect(sandboxed).toStrictEqual(plain);
		expect(sandboxed.stdout).toStrictEqual(Buffer.from(bytes));
	}, SANDBOX_TIMEOUT_MS);
}

test.skipIf(!canUseOsSandbox())("sandboxed output to stderr reaches stderr, not stdout", async () => {
	const { sandboxed, plain } = await runSandboxedAndPlain("echo to-stderr >&2");

	expect(sandboxed).toStrictEqual(plain);
	expect(sandboxed.stdout.length).toBe(0);
	expect(sandboxed.stderr.toString()).toBe("to-stderr\n");
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandboxed trailing backslash prints as unsandboxed", async () => {
	// The output differs between bash versions, so it is compared with the
	// unsandboxed run rather than with a literal.
	const { sandboxed, plain } = await runSandboxedAndPlain("echo hi \\");

	expect(sandboxed).toStrictEqual(plain);
	expect(sandboxed.code).toBe(0);
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandboxed output streams while the command runs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-stream-"));
	const flag = path.join(dir, "flag");
	// The command waits for the flag, which the test creates only after the
	// first chunk arrived. Buffered output would never deliver that chunk
	// early, so the wait would run out (about 10 s) and print "timeout".
	const command = `printf first; i=0; while [ ! -e ${quoteShellArgument(flag)} ]; do `
		+ `if [ "$i" -ge 100 ]; then printf timeout; break; fi; sleep 0.1; i=$((i + 1)); done; printf second`;
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			const child = spawn("/bin/bash", ["-c", wrapCommandWithOsSandbox(command)], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
			const chunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => {
				if (chunks.length === 0) fs.writeFileSync(flag, "");
				chunks.push(chunk);
			});
			child.on("error", reject);
			child.on("close", () => resolve(Buffer.concat(chunks).toString()));
		});

		expect(stdout).toBe("firstsecond");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandboxed stray closing brace is the same syntax error as unsandboxed", async () => {
	const { sandboxed, plain } = await runSandboxedAndPlain("echo one; } ; echo two");

	expect(plain.code).not.toBe(0);
	expect(sandboxed).toStrictEqual(plain);
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandbox allows writes to /dev/null", async () => {
	// CONTRACT: /dev/null redirects are always allowed (not a real write)
	await runLikePiOk(wrapCommandWithOsSandbox("echo discard > /dev/null"));
}, SANDBOX_TIMEOUT_MS);

test.skipIf(!canUseOsSandbox())("sandbox allows writes through a symlinked temp path", async () => {
	const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-real-"));
	const linkDir = path.join(os.tmpdir(), `pi-readonly-link-${Date.now()}`);
	try {
		// Create symlink to mimic /tmp → /private/tmp on macOS
		fs.symlinkSync(realDir, linkDir);
		const insidePath = path.join(linkDir, "via-symlink.txt");

		await runLikePiOk(wrapCommandWithOsSandbox(`echo symlink-works > "${insidePath}"`));
		expect(fs.readFileSync(insidePath, "utf8").trim(), "sandbox should allow writes through symlinks to temp").toBe("symlink-works");
	} finally {
		try { fs.rmSync(linkDir, { force: true }); } catch { /* best-effort cleanup */ }
		try { fs.rmSync(realDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
}, SANDBOX_TIMEOUT_MS);
