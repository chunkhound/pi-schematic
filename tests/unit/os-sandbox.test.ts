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
import { bashResult, SANDBOX_DENIAL_PHRASES } from "./helpers.js";

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
	assert.equal(run.code, 0, run.stderr.toString());
	return run;
}

async function runSandboxedAndPlain(command: string): Promise<{ sandboxed: RunResult; plain: RunResult }> {
	return { sandboxed: await runLikePi(wrapCommandWithOsSandbox(command)), plain: await runLikePi(command) };
}

const sandboxRuntime = { skip: !canUseOsSandbox(), timeout: 20_000 };

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
	{ name: "both phrases on win32", platform: "win32", output: "bash: /outside: Operation not permitted; Read-only file system", isError: true },
	{ name: "another platform's phrase on the current platform", platform: undefined, output: OTHER_DENIAL_OUTPUT, isError: true },
] as { name: string; platform?: NodeJS.Platform; output: string; isError: boolean }[]) {
	test(`appends no block notice for ${name}`, () => {
		assert.equal(appendSandboxBlockNoticeToResult(bashResult(output, isError), platform), undefined);
	});
}

test("appends no block notice to a result whose isError is unset", () => {
	const { isError: _isError, ...result } = bashResult("bash: /outside: Operation not permitted");

	assert.equal(appendSandboxBlockNoticeToResult(result, "darwin"), undefined);
});

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

	assert.deepEqual(noticed?.content, [
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

		assert.deepEqual(noticed?.content, [{ type: "text", text: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}` }]);
		assert.equal(noticed?.structuredContent, structuredContent);
		assert.deepEqual(noticed?.structuredContent, before);
	});
}

// A row without a platform uses the default, the current host.
for (const { platform, message } of [
	{ platform: "linux", message: "Error: EROFS: read-only file system, open '/outside'" },
	...(HOST_DENIAL_OUTPUT === undefined ? [] : [{ platform: undefined, message: HOST_DENIAL_OUTPUT }]),
] as { platform?: NodeJS.Platform; message: string }[]) {
	test(`text block notice appends the notice on ${platform ?? "the current platform"} to "${message}"`, () => {
		assert.equal(appendSandboxBlockNotice(message, platform), `${message}${NOTICE_SUFFIX}`);
	});
}

for (const { name, platform, message } of [
	{ name: "Permission denied", platform: "darwin", message: "bash: /outside: Permission denied" },
	{ name: "the other platform's phrase", platform: "linux", message: "Error: EPERM: operation not permitted" },
	{ name: "another platform's phrase on the current platform", platform: undefined, message: OTHER_DENIAL_OUTPUT },
] as { name: string; platform?: NodeJS.Platform; message: string }[]) {
	test(`text block notice appends nothing for ${name}`, () => {
		assert.equal(appendSandboxBlockNotice(message, platform), undefined);
	});
}

// ── Wrapper shape ───────────────────────────────────────────────

test(`sandbox wrappers pass the command as one quoted argument to "$0" -c with nothing added`, () => {
	const command = `printf '%s\\n' "it's quoted"\necho second line`;

	for (const wrapped of [wrapWithSandboxExec(command), wrapWithBwrap(command)]) {
		assert.ok(wrapped.endsWith(` "$0" -c ${quoteShellArgument(command)}`), wrapped);
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

test("bwrap executes a quoted bind path without shell injection", { skip: process.platform !== "linux" || !canUseOsSandbox() }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-quote'-"));
	const target = path.join(dir, "result.txt");
	try {
		await runLikePiOk(wrapWithBwrap(`printf wrapped > ${quoteShellArgument(target)}`, dir));
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

test("quoteShellArgument round-trips through a POSIX shell", { skip: !hasPosixShell() }, () => {
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
	test(`sandbox blocks ${name} outside temp`, sandboxRuntime, async () => {
		const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${process.pid}-${Date.now()}`);
		try {
			const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

			assert.notEqual(run.code, 0);
			assert.equal(fs.existsSync(outsidePath), false, "outside temp file should not be created");
		} finally {
			fs.rmSync(outsidePath, { force: true });
		}
	});

	test(`the failed result of ${name} the sandbox blocked gets the block notice`, sandboxRuntime, async () => {
		const outsidePath = path.join(os.homedir(), `.pi-readonly-outside-${process.pid}-${Date.now()}`);
		try {
			const run = await runLikePi(wrapCommandWithOsSandbox(write(outsidePath)));

			const noticed = appendSandboxBlockNoticeToResult(bashResult(`${run.stdout}${run.stderr}`));

			assert.ok(noticed?.content[0]?.type === "text" && noticed.content[0].text.endsWith(NOTICE_SUFFIX), JSON.stringify(noticed));
		} finally {
			fs.rmSync(outsidePath, { force: true });
		}
	});
}

test("sandbox allows writes inside temp", sandboxRuntime, async () => {
	const insideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-sandbox-"));
	const insidePath = path.join(insideDir, "inside.txt");
	try {
		await runLikePiOk(wrapCommandWithOsSandbox(`echo allowed > "${insidePath}"`));
		assert.equal(fs.readFileSync(insidePath, "utf8").trim(), "allowed", "sandbox should allow temp writes");
	} finally {
		try { fs.rmSync(insideDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});

test("sandboxed command runs under the shell that launched the sandbox", sandboxRuntime, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-bash-"));
	const linkedBash = path.join(dir, "bash");
	try {
		fs.symlinkSync("/bin/bash", linkedBash);

		const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), linkedBash);

		assert.equal(run.code, 0, run.stderr.toString());
		assert.equal(run.stdout.toString(), `${linkedBash}\n`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("sandboxed command launched from /bin/sh runs under /bin/sh", sandboxRuntime, async () => {
	const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), "/bin/sh");

	assert.equal(run.code, 0, run.stderr.toString());
	assert.equal(run.stdout.toString(), "/bin/sh\n");
});

test("sandboxed command launched from zsh runs under zsh", { ...sandboxRuntime, skip: sandboxRuntime.skip || !fs.existsSync("/bin/zsh") }, async () => {
	const run = await runLikePi(wrapCommandWithOsSandbox('echo "$0"'), "/bin/zsh");

	assert.equal(run.code, 0, run.stderr.toString());
	assert.equal(run.stdout.toString(), "/bin/zsh\n");
});

for (const reader of ["cat", "read x", "head -1"]) {
	test(`sandboxed ${reader} on pi's /dev/null stdin behaves as unsandboxed`, sandboxRuntime, async () => {
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

test("sandboxed output streams while the command runs", sandboxRuntime, async () => {
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

		assert.equal(stdout, "firstsecond");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("sandboxed stray closing brace is the same syntax error as unsandboxed", sandboxRuntime, async () => {
	const { sandboxed, plain } = await runSandboxedAndPlain("echo one; } ; echo two");

	assert.notEqual(plain.code, 0);
	assert.deepEqual(sandboxed, plain);
});

test("sandbox allows writes to /dev/null", sandboxRuntime, async () => {
	// CONTRACT: /dev/null redirects are always allowed (not a real write)
	await runLikePiOk(wrapCommandWithOsSandbox("echo discard > /dev/null"));
});

test("sandbox allows writes through a symlinked temp path", sandboxRuntime, async () => {
	const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-readonly-real-"));
	const linkDir = path.join(os.tmpdir(), `pi-readonly-link-${Date.now()}`);
	try {
		// Create symlink to mimic /tmp → /private/tmp on macOS
		fs.symlinkSync(realDir, linkDir);
		const insidePath = path.join(linkDir, "via-symlink.txt");

		await runLikePiOk(wrapCommandWithOsSandbox(`echo symlink-works > "${insidePath}"`));
		assert.equal(fs.readFileSync(insidePath, "utf8").trim(), "symlink-works", "sandbox should allow writes through symlinks to temp");
	} finally {
		try { fs.rmSync(linkDir, { force: true }); } catch { /* best-effort cleanup */ }
		try { fs.rmSync(realDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
	}
});
