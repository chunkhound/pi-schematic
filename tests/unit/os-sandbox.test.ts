import test from "node:test";
import assert from "node:assert/strict";
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

/** Build a result shaped like pi's bash tool result for a command that exited with code 1. */
function bashResult(output: string, isError = true) {
	return {
		content: [{ type: "text" as const, text: `${output}\n\nCommand exited with code 1` }],
		structuredContent: { output, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
		isError,
	};
}

interface RunResult {
	stdout: Buffer;
	stderr: Buffer;
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** Run a command the way pi's bash tool spawns it: `/bin/bash -c`, stdin at /dev/null, separate pipes. */
function runLikePi(command: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
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

async function runSandboxedAndPlain(command: string): Promise<{ sandboxed: RunResult; plain: RunResult }> {
	return { sandboxed: await runLikePi(wrapCommandWithOsSandbox(command)), plain: await runLikePi(command) };
}

const sandboxRuntime = { skip: !canUseOsSandbox(), timeout: 20_000 };

// ── Block notice ────────────────────────────────────────────────

for (const { platform, output } of [
	{ platform: "darwin", output: "bash: /outside: Operation not permitted" },
	{ platform: "darwin", output: "Error: EPERM: operation not permitted, open '/outside'" },
	{ platform: "linux", output: "bash: /outside: Read-only file system" },
	{ platform: "linux", output: "Error: EROFS: read-only file system, open '/outside'" },
] as const) {
	test(`appends the block notice to a failed ${platform} result reporting "${output}"`, () => {
		const result = bashResult(output);

		const noticed = appendSandboxBlockNoticeToResult(result, platform);

		assert.deepEqual(noticed, {
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
	{ name: "the darwin phrase on win32", platform: "win32", output: "bash: /outside: Operation not permitted", isError: true },
	{ name: "the linux phrase on win32", platform: "win32", output: "bash: /outside: Read-only file system", isError: true },
] as const) {
	test(`appends no block notice for ${name}`, () => {
		assert.equal(appendSandboxBlockNoticeToResult(bashResult(output, isError), platform), undefined);
	});
}

test("block notice leaves the input result unchanged", () => {
	const result = bashResult("bash: /outside: Operation not permitted");
	const before = structuredClone(result);

	appendSandboxBlockNoticeToResult(result, "darwin");

	assert.deepEqual(result, before);
});

test("block notice goes after the last text block only", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [
			{ type: "text", text: "bash: /outside: Operation not permitted" },
			{ type: "text", text: "Command exited with code 1" },
		],
		isError: true,
	}, "darwin");

	assert.deepEqual(noticed?.content, [
		{ type: "text", text: "bash: /outside: Operation not permitted" },
		{ type: "text", text: `Command exited with code 1${NOTICE_SUFFIX}` },
	]);
});

test("block notice returns an absent structured content as undefined", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
		isError: true,
	}, "darwin");

	assert.deepEqual(noticed, {
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

	assert.deepEqual(noticed?.structuredContent, { output: null, exit_code: 1 });
});

test("block notice adds a text block when the phrase is only in the structured output", () => {
	const noticed = appendSandboxBlockNoticeToResult({
		content: [],
		structuredContent: { output: "bash: /outside: Operation not permitted", exit_code: 1 },
		isError: true,
	}, "darwin");

	assert.deepEqual(noticed, {
		content: [{ type: "text", text: READONLY_SANDBOX_BLOCK_NOTICE }],
		structuredContent: { output: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}`, exit_code: 1 },
	});
});

test("block notice on a result defaults to the current platform", () => {
	const result = bashResult("Operation not permitted; Read-only file system");

	assert.deepEqual(appendSandboxBlockNoticeToResult(result), appendSandboxBlockNoticeToResult(result, process.platform));
});

test("text block notice appends the notice to text with the platform phrase", () => {
	const message = "Error: EROFS: read-only file system, open '/outside'";

	assert.equal(appendSandboxBlockNotice(message, "linux"), `${message}${NOTICE_SUFFIX}`);
});

for (const { name, platform, message } of [
	{ name: "Permission denied", platform: "darwin", message: "bash: /outside: Permission denied" },
	{ name: "the other platform's phrase", platform: "linux", message: "Error: EPERM: operation not permitted" },
	{ name: "win32", platform: "win32", message: "Error: EPERM: operation not permitted" },
] as const) {
	test(`text block notice appends nothing for ${name}`, () => {
		assert.equal(appendSandboxBlockNotice(message, platform), undefined);
	});
}

test("text block notice defaults to the current platform", () => {
	const message = "Operation not permitted; Read-only file system";

	assert.equal(appendSandboxBlockNotice(message), appendSandboxBlockNotice(message, process.platform));
});

// ── Wrapper shape ───────────────────────────────────────────────

test("sandbox wrappers pass the command to bash -c as one quoted argument and add nothing else", () => {
	const command = `printf '%s\\n' "it's quoted"\necho second line`;

	for (const wrapped of [wrapWithSandboxExec(command), wrapWithBwrap(command)]) {
		assert.ok(wrapped.endsWith(` /bin/bash -c ${quoteShellArgument(command)}`), wrapped);
		assert.equal(wrapped.includes("<<"), false, wrapped);
		assert.equal(wrapped.includes(READONLY_SANDBOX_BLOCK_NOTICE), false, wrapped);
		assert.equal(wrapped.includes("2>&1"), false, wrapped);
	}
});

// ── buildMacProfile invariants ──────────────────────────────────

test("buildMacProfile rejects paths containing quotes", () => {
	assert.throws(() => buildMacProfile("/tmp/evil'"), /contain.*quote/);
	assert.throws(() => buildMacProfile('/tmp/evil"'), /contain.*quote/);
});

test("quotes dynamic Linux sandbox paths for the outer shell", () => {
	const tempPath = "/tmp/readonly' ; echo injected; #";
	const canonicalPath = resolveRealPath(tempPath);
	const quotedPath = quoteShellArgument(canonicalPath);
	const wrapped = wrapWithBwrap("true", tempPath);

	assert.equal(quoteShellArgument("a'b"), `'a'"'"'b'`);
	assert.ok(wrapped.includes(`--bind ${quotedPath} ${quotedPath}`));
	assert.equal(wrapped.includes(`--bind "${canonicalPath}" "${canonicalPath}"`), false);
});

test("bwrap executes a quoted bind path without shell injection", { skip: process.platform !== "linux" || !canUseOsSandbox() }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-quote'-"));
	const target = path.join(dir, "result.txt");
	try {
		execFileSync(
			"/bin/bash",
			["-c", wrapWithBwrap(`printf wrapped > ${quoteShellArgument(target)}`, dir)],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(fs.readFileSync(target, "utf8"), "wrapped");
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

test("quoteShellArgument emits POSIX single-quoted arguments", () => {
	// POSIX shell single-quote invariant: input is wrapped in single quotes.
	// Embedded single quotes close, quote, and reopen the outer argument.
	assert.equal(quoteShellArgument(""), "''");
	assert.equal(quoteShellArgument("normal"), "'normal'");
	assert.equal(quoteShellArgument("'"), `''"'"''`);
});

test("quoteShellArgument round-trips through a POSIX shell", () => {
	if (!hasPosixShell()) return;

	for (const raw of ["normal", "spaces", "dollar$ign", "backtick`", "line1\nline2", "'mixed' quotes", "'"]) {
		const quoted = quoteShellArgument(raw);
		const result = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8", timeout: 2000 });
		assert.equal(result, raw, `quoteShellArgument(${JSON.stringify(raw)}) should round-trip`);
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
	test(`sandbox blocks ${name} outside temp and the failed result gets the block notice`, sandboxRuntime, async () => {
		const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${process.pid}-${Date.now()}`);
		try {
			const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

			assert.notEqual(run.code, 0);
			assert.equal(fs.existsSync(outsidePath), false, "outside temp file should not be created");
			const noticed = appendSandboxBlockNoticeToResult(bashResult(`${run.stdout}${run.stderr}`));
			assert.ok(noticed?.content[0]?.type === "text" && noticed.content[0].text.endsWith(NOTICE_SUFFIX), JSON.stringify(noticed));
		} finally {
			fs.rmSync(outsidePath, { force: true });
		}
	});
}

test("sandbox allows writes inside temp", sandboxRuntime, () => {
	const insideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-sandbox-"));
	const insidePath = path.join(insideDir, "inside.txt");
	try {
		execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(`echo allowed > "${insidePath}"`)], { encoding: "utf8", timeout: 5000 });
		assert.equal(fs.readFileSync(insidePath, "utf8").trim(), "allowed", "sandbox should allow temp writes");
	} finally {
		try { fs.rmSync(insideDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

for (const reader of ["cat", "read x", "head -1"]) {
	test(`sandboxed ${reader} reads stdin as unsandboxed and the commands after it run`, sandboxRuntime, async () => {
		const { sandboxed, plain } = await runSandboxedAndPlain(`${reader}; echo after; false`);

		assert.deepEqual(sandboxed, plain);
		assert.equal(sandboxed.stdout.toString(), "after\n");
		assert.equal(sandboxed.code, 1);
	});
}

for (const { command, bytes } of [
	{ command: String.raw`printf 'a\n\n\n'`, bytes: "a\n\n\n" },
	{ command: "printf -- -n", bytes: "-n" },
	{ command: String.raw`printf 'a\0b'`, bytes: "a\0b" },
]) {
	test(`sandboxed ${command} writes the same bytes as unsandboxed`, sandboxRuntime, async () => {
		const { sandboxed, plain } = await runSandboxedAndPlain(command);

		assert.deepEqual(sandboxed, plain);
		assert.deepEqual(sandboxed.stdout, Buffer.from(bytes));
	});
}

test("sandboxed output to stderr reaches stderr, not stdout", sandboxRuntime, async () => {
	const { sandboxed, plain } = await runSandboxedAndPlain("echo to-stderr >&2");

	assert.deepEqual(sandboxed, plain);
	assert.equal(sandboxed.stdout.length, 0);
	assert.equal(sandboxed.stderr.toString(), "to-stderr\n");
});

test("sandboxed trailing backslash prints as unsandboxed", sandboxRuntime, async () => {
	// The output differs between bash versions, so it is compared with the
	// unsandboxed run rather than with a literal.
	const { sandboxed, plain } = await runSandboxedAndPlain("echo hi \\");

	assert.deepEqual(sandboxed, plain);
	assert.equal(sandboxed.code, 0);
});

test("sandboxed stray closing brace is the same syntax error as unsandboxed", sandboxRuntime, async () => {
	const { sandboxed, plain } = await runSandboxedAndPlain("echo one; } ; echo two");

	assert.notEqual(plain.code, 0);
	assert.equal(sandboxed.code, plain.code);
	assert.deepEqual(sandboxed.stdout, plain.stdout);
});

test("sandbox allows writes to /dev/null", sandboxRuntime, () => {
	// CONTRACT: /dev/null redirects are always allowed (not a real write)
	execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox('echo discard > /dev/null')], { encoding: "utf8", timeout: 5000 });
});

test("sandbox allows writes through a symlinked temp path", sandboxRuntime, () => {
	const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-real-"));
	const linkDir = path.join(os.tmpdir(), `pi-readonly-link-${Date.now()}`);
	try {
		// Create symlink to mimic /tmp → /private/tmp on macOS
		fs.symlinkSync(realDir, linkDir);
		const insidePath = path.join(linkDir, "via-symlink.txt");

		execFileSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(`echo symlink-works > "${insidePath}"`)], { encoding: "utf8", timeout: 5000 });
		assert.equal(fs.readFileSync(insidePath, "utf8").trim(), "symlink-works", "sandbox should allow writes through symlinks to temp");
	} finally {
		try { fs.rmSync(linkDir, { force: true }); } catch { /* best-effort cleanup */ }
		try { fs.rmSync(realDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});
