import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import {
	buildMacProfile,
	buildWritableBindsFromRoots,
	canUseOsSandbox,
	quoteShellArgument,
	SANDBOX_DENIAL_NEEDLES,
	wrapCommandWithOsSandbox,
	wrapWithBwrap,
} from "../../os-sandbox.js";
import { applyReadonlyBashGuard } from "../../readonly-bash.js";
import { READONLY_SANDBOX_BLOCK_NOTICE } from "../../notifications.js";
import { resolveRealPath } from "../../resolve-path.js";
import { TEMP_WRITE_ROOTS } from "../../temp-dir.js";
import { FIXTURE_MARKER, sweepStaleFixtures } from "./fixture-sweep.js";

// SIGKILL/CI-cancellation skips t.after cleanup and leaks fixture dirs into the repo root
// (cwd-based bases below) and the OS temp dir; sweep both at startup instead of masking
// them in .gitignore.
sweepStaleFixtures(process.cwd(), "pi-readonly-sandbox-");
sweepStaleFixtures(os.tmpdir(), "pi-readonly-sandbox-");

const sandboxAvailable = canUseOsSandbox();
const sandboxOptions = { skip: sandboxAvailable ? false : "OS sandbox cannot launch on this host" };
const linuxOptions = { skip: process.platform === "linux" ? sandboxOptions.skip : "requires Linux bubblewrap" };
const macOptions = { skip: process.platform === "darwin" ? sandboxOptions.skip : "requires macOS Seatbelt" };

function hasPosixShell(): boolean {
	if (process.platform === "win32") return false;
	try {
		execFileSync("/bin/sh", ["-c", "true"], { stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

function tempFixture(t: TestContext, base = os.tmpdir()): string {
	const dir = fs.mkdtempSync(path.join(base, "pi-readonly-sandbox-"));
	fs.writeFileSync(path.join(dir, FIXTURE_MARKER), "");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Fixture dir listing without the ownership marker the sweeper requires. */
function fixtureEntries(dir: string): string[] {
	return fs.readdirSync(dir).filter((entry) => entry !== FIXTURE_MARKER);
}

function runBash(command: string): string {
	return execFileSync("/bin/bash", ["-c", command], { encoding: "utf8", timeout: 5000 });
}

function runSandbox(command: string, wrapper = wrapCommandWithOsSandbox): string {
	return runBash(wrapper(command));
}

function assertSandboxBlocked(command: string): void {
	// Built from the production needles so the oracle cannot drift. EACCES
	// ("Permission denied") is never matched: an ordinary command can fail that way
	// for its own reasons, and the oracle must not be looser than the matcher.
	const denial = new RegExp(SANDBOX_DENIAL_NEEDLES.join("|"));
	assert.throws(() => runSandbox(command), denial);
}

function assertWriteAllowed(target: string, wrapper = wrapCommandWithOsSandbox): void {
	runSandbox(`printf allowed > ${quoteShellArgument(target)}`, wrapper);
	assert.equal(fs.readFileSync(target, "utf8"), "allowed");
}

function assertWriteBlocked(target: string): void {
	assertSandboxBlocked(`printf blocked > ${quoteShellArgument(target)}`);
	assert.equal(fs.existsSync(target), false);
}

test("enforcement CI requires a functioning OS sandbox", () => {
	if (process.env.REQUIRE_OS_SANDBOX === "1") {
		assert.equal(sandboxAvailable, true, "required OS sandbox cannot launch; enforcement tests must not skip");
	}
});

test("wrapped command blocks non-temp writes and allows temp writes", sandboxOptions, (t) => {
	assertWriteBlocked(path.join(tempFixture(t, process.cwd()), "blocked.txt"));
	assertWriteAllowed(path.join(tempFixture(t), "allowed.txt"));
});

const outsideMutations = {
	overwrite: (target: string) => `printf changed > ${target}`,
	truncate: (target: string) => `: > ${target}`,
	delete: (target: string) => `rm ${target}`,
	rename: (target: string, destination: string) => `mv ${target} ${destination}`,
};

for (const [operation, command] of Object.entries(outsideMutations)) {
	test(`sandbox preserves an existing non-temp file against ${operation}`, sandboxOptions, (t) => {
		const outside = tempFixture(t, process.cwd());
		const target = path.join(outside, "existing.txt");
		const destination = path.join(outside, "renamed.txt");
		fs.writeFileSync(target, "original contents\n");
		assertSandboxBlocked(command(quoteShellArgument(target), quoteShellArgument(destination)));
		assert.equal(fs.readFileSync(target, "utf8"), "original contents\n");
		assert.equal(fs.existsSync(destination), false);
	});
}

function guardedGit(repo: string, args: string): void {
	assertGuardedSuccess(`git -C ${quoteShellArgument(repo)} ${args}`, repo);
}

function integrationEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, CDPATH: "" };
	for (const name of Object.keys(env)) {
		if (name.startsWith("GIT_") || ["OLDPWD", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(name)) delete env[name];
	}
	return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
}

function setEnvironment(env: NodeJS.ProcessEnv, names: string[]): void {
	for (const name of names) {
		if (env[name] === undefined) delete process.env[name];
		else process.env[name] = env[name];
	}
}

function classifyWithIntegrationEnv(command: string, cwd: string) {
	const env = integrationEnv();
	const names = [...new Set([...Object.keys(process.env), ...Object.keys(env)])];
	const saved = { ...process.env };
	try {
		setEnvironment(env, names);
		return applyReadonlyBashGuard(command, cwd);
	} finally {
		setEnvironment(saved, names);
	}
}

function executeGuarded(command: string, cwd: string, beforeLaunch = () => {}) {
	const result = classifyWithIntegrationEnv(command, cwd);
	assert.equal(result.action, "sandbox", command);
	assert.ok("sandboxedCommand" in result);
	beforeLaunch();
	const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", result.sandboxedCommand], {
		cwd, env: integrationEnv(), encoding: "utf8", timeout: 10000,
	});
	assert.ifError(execution.error);
	assert.equal(execution.signal, null, execution.stderr);
	return execution;
}

function assertGuardedSuccess(command: string, cwd: string): string {
	const result = executeGuarded(command, cwd);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(result.stdout.includes(READONLY_SANDBOX_BLOCK_NOTICE), false);
	return result.stdout;
}

function readGit(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8", timeout: 5000,
		env: integrationEnv(),
	});
}

test("readonly guard and real sandbox allow Git mutations in a temp repository", sandboxOptions, (t) => {
	const repo = tempFixture(t);
	guardedGit(repo, "init --quiet");
	const file = path.join(repo, "file.txt");
	fs.writeFileSync(file, "staged contents\n");
	guardedGit(repo, "add file.txt");
	assert.equal(readGit(repo, "show", ":file.txt"), "staged contents\n");
	assert.equal(fs.readFileSync(file, "utf8"), "staged contents\n");
});

for (const changeDirectory of ["cd", "pushd"]) {
	test(`readonly guard executes ${changeDirectory} with relative writes and Git in temp`, sandboxOptions, (t) => {
		const outside = tempFixture(t, process.cwd());
		const repo = tempFixture(t);
		const command = `${changeDirectory} ${quoteShellArgument(repo)} && printf staged > file.txt && git init --quiet && git add file.txt`;
		assertGuardedSuccess(command, outside);
		assert.equal(fs.readFileSync(path.join(repo, "file.txt"), "utf8"), "staged");
		assert.equal(readGit(repo, "show", ":file.txt"), "staged");
		assert.deepEqual(fixtureEntries(outside), []);
	});
}

test("readonly guard preserves an inert heredoc through the sandbox", sandboxOptions, (t) => {
	const outside = tempFixture(t, process.cwd());
	const target = path.join(outside, "must-not-execute.txt");
	const body = `cd ${quoteShellArgument(outside)}\nprintf changed > ${quoteShellArgument(target)}\ngit init --quiet`;
	assert.equal(assertGuardedSuccess(`cat <<'INERT_DATA'\n${body}\nINERT_DATA`, outside), `${body}\n`);
	assert.deepEqual(fixtureEntries(outside), []);
});

test("readonly guard preserves failed cd status and prevents an outside relative write", sandboxOptions, (t) => {
	const outside = tempFixture(t, process.cwd());
	const missing = path.join(tempFixture(t), "missing");
	const changeDirectory = `cd ${quoteShellArgument(missing)}`;
	const result = executeGuarded(`${changeDirectory} && printf changed > blocked.txt`, outside);
	assert.notEqual(result.status, 0);
	assert.match(result.stdout + result.stderr, /No such file or directory/);
	// A failed cd leaves the outside cwd intact; an unconditional write must be rejected before launch.
	const blocked = applyReadonlyBashGuard(`${changeDirectory}; printf changed > blocked.txt`, outside);
	assert.equal(blocked.action, "block");
	assert.ok("reason" in blocked);
	assert.match(blocked.reason, /Readonly mode: command blocked/);
	assert.deepEqual(fixtureEntries(outside), []);
});

test("returned sandbox command blocks a relative outside write after its cd target disappears", sandboxOptions, (t) => {
	const outside = tempFixture(t, process.cwd());
	const destination = tempFixture(t);
	const command = `cd ${quoteShellArgument(destination)}; printf changed > blocked.txt`;
	// The filesystem can change after classification; only the kernel can enforce this race.
	const result = executeGuarded(command, outside, () => fs.rmSync(destination, { recursive: true, force: true }));
	assert.notEqual(result.status, 0);
	assert.ok(result.stdout.includes(READONLY_SANDBOX_BLOCK_NOTICE), result.stdout + result.stderr);
	assert.match(result.stdout + result.stderr, /No such file or directory/);
	assert.deepEqual(fixtureEntries(outside), []);
});

test("buildMacProfile rejects paths containing quotes", () => {
	assert.throws(() => buildMacProfile("/tmp/evil'"), /contain.*quote/);
	assert.throws(() => buildMacProfile('/tmp/evil"'), /contain.*quote/);
});

test("macOS profile writable roots match the shared temp-root policy", () => {
	const profile = buildMacProfile("/tmp/pi-shared-root");
	for (const root of TEMP_WRITE_ROOTS) {
		assert.ok(profile.includes(`(subpath "${root}")`), `profile should allow writes under ${root}`);
	}
});

test("POSIX scratch roots are excluded on Windows", () => {
	// /tmp would resolve to a drive-root path (C:\tmp) on Windows, opening a real
	// location to the classifier-only L2 layer.
	assert.equal(TEMP_WRITE_ROOTS.includes("/tmp"), process.platform !== "win32");
	assert.equal(TEMP_WRITE_ROOTS.includes("/private/tmp"), process.platform === "darwin");
});

test("quotes dynamic Linux sandbox paths for the outer shell", (t) => {
	const root = tempFixture(t);
	const tempPath = path.join(root, "readonly' ; echo injected; #");
	fs.mkdirSync(tempPath);
	const canonicalPath = resolveRealPath(tempPath);
	const quotedPath = quoteShellArgument(canonicalPath);
	const wrapped = wrapWithBwrap("true", tempPath);
	assert.ok(wrapped.includes(`--bind ${quotedPath} ${quotedPath}`));
	assert.equal(wrapped.includes(`--bind "${canonicalPath}" "${canonicalPath}"`), false);
});

test("Linux binds shared existing roots once and omits absent roots", () => {
	const wrapped = wrapWithBwrap("true");
	for (const root of new Set(TEMP_WRITE_ROOTS.map(resolveRealPath))) {
		const quoted = quoteShellArgument(root);
		const bind = `--bind ${quoted} ${quoted}`;
		assert.equal(wrapped.split(bind).length - 1, fs.existsSync(root) ? 1 : 0, root);
	}
	assert.equal(wrapped.includes("--tmpfs /tmp"), false, "host scratch files remain visible");
});

test("Linux shared writable roots preserve observable host writes", linuxOptions, (t) => {
	for (const root of new Set(TEMP_WRITE_ROOTS.map(resolveRealPath))) {
		if (fs.existsSync(root)) assertWriteAllowed(path.join(tempFixture(t, root), "shared.txt"));
	}
});

test("macOS shared writable roots preserve observable host writes through aliases", macOptions, (t) => {
	for (const root of TEMP_WRITE_ROOTS) {
		if (fs.existsSync(root)) assertWriteAllowed(path.join(tempFixture(t, root), "shared.txt"));
	}
});

test("bwrap executes a quoted bind path without shell injection", linuxOptions, (t) => {
	const root = tempFixture(t);
	const dir = path.join(root, "quote' ; touch injected; #");
	fs.mkdirSync(dir);
	assertWriteAllowed(path.join(dir, "result.txt"), (command) => wrapWithBwrap(command, dir));
	assert.equal(fs.existsSync(path.join(process.cwd(), "injected")), false);
});

test("bwrap resolves writable-root aliases without duplicate mounts", linuxOptions, (t) => {
	const dir = tempFixture(t);
	const alias = path.join(dir, "alias");
	fs.symlinkSync(dir, alias);
	assertWriteAllowed(path.join(alias, "result.txt"), (command) => wrapWithBwrap(command, alias));
});

test("bwrap absent optional roots do not break startup", linuxOptions, (t) => {
	const absent = path.join(tempFixture(t), "absent");
	assert.equal(runSandbox("printf running", (command) => wrapWithBwrap(command, absent)), "running\n");
	assert.equal(fs.existsSync(absent), false);
});

test("writable bind builder fails closed only when no live directory exists", (t) => {
	const live = tempFixture(t);
	const file = path.join(live, "file");
	fs.writeFileSync(file, "x");
	assert.throws(() => buildWritableBindsFromRoots([]), /no writable temp root/);
	assert.throws(() => buildWritableBindsFromRoots([file, path.join(live, "absent")]), /no writable temp root/);
	const binds = buildWritableBindsFromRoots([live, live, file]);
	assert.deepEqual(binds, [`--bind ${quoteShellArgument(live)} ${quoteShellArgument(live)}`]);
});

test("quoteShellArgument emits POSIX single-quoted arguments", () => {
	assert.equal(quoteShellArgument(""), "''");
	assert.equal(quoteShellArgument("normal"), "'normal'");
	assert.equal(quoteShellArgument("'"), `''"'"''`);
});

test("quoteShellArgument round-trips through a POSIX shell", { skip: hasPosixShell() ? false : "POSIX shell unavailable" }, () => {
	for (const raw of ["normal", "spaces", "dollar$ign", "backtick`", "line1\nline2", "'mixed' quotes", "'"]) {
		const result = execFileSync("/bin/sh", ["-c", `printf '%s' ${quoteShellArgument(raw)}`], { encoding: "utf8", timeout: 2000 });
		assert.equal(result, raw);
	}
});

test("sandbox allows writes to /dev/null", sandboxOptions, () => {
	runSandbox("echo discard > /dev/null");
});

test("sandbox allows writes through a symlinked temp path", sandboxOptions, (t) => {
	const root = tempFixture(t);
	const realDir = path.join(root, "real");
	const alias = path.join(root, "alias");
	fs.mkdirSync(realDir);
	fs.symlinkSync(realDir, alias);
	assertWriteAllowed(path.join(alias, "via-symlink.txt"));
});

test("sandbox blocks temp symlink escapes and traversal to non-temp paths", sandboxOptions, (t) => {
	const inside = tempFixture(t);
	const outside = tempFixture(t, process.cwd());
	const alias = path.join(inside, "escape");
	fs.symlinkSync(outside, alias);
	assertWriteBlocked(path.join(alias, "symlink.txt"));
	assertWriteBlocked(`${inside}/${path.relative(inside, outside)}/traversal.txt`);
});

test("sandbox prints the readonly block notice on a real denial", sandboxOptions, (t) => {
	const target = path.join(tempFixture(t, process.cwd()), "blocked.txt");
	const result = spawnSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(`printf blocked > ${quoteShellArgument(target)}`)], {
		encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, "sandbox must finish without a launch or timeout failure");
	assert.notEqual(result.status, null, "sandbox must return an exit status");
	assert.notEqual(result.status, 0);
	assert.ok(result.stdout.includes(READONLY_SANDBOX_BLOCK_NOTICE), result.stdout);
	assert.equal(fs.existsSync(target), false);
});

const ordinaryResults = [
	{ status: 7, output: "ordinary failure", command: "printf 'ordinary failure\\n'; exit 7" },
	{ status: 13, output: "Permission denied", command: "printf 'Permission denied\\n' >&2; exit 13" },
	{ status: 0, output: "Operation not permitted", command: "printf 'Operation not permitted\\n'" },
	{ status: 0, output: "Read-only file system", command: "printf 'Read-only file system\\n' >&2" },
];

for (const expected of ordinaryResults) {
	test(`sandbox preserves ordinary result ${expected.status}: ${expected.output}`, sandboxOptions, () => {
		const result = spawnSync("/bin/bash", ["-c", wrapCommandWithOsSandbox(expected.command)], {
			encoding: "utf8", timeout: 5000,
		});
		assert.ifError(result.error);
		assert.equal(result.status, expected.status);
		assert.equal(result.stdout, `${expected.output}\n`);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout.includes(READONLY_SANDBOX_BLOCK_NOTICE), false);
	});
}

function tempOverrideProbe(dir: string, enforce: boolean): { roots: string[]; temp: string } {
	const module = new URL("../../temp-dir.ts", import.meta.url).href;
	const sandbox = new URL("../../os-sandbox.ts", import.meta.url).href;
	const loader = new URL("../../register-loader.mjs", import.meta.url).href;
	const code = `import {TEMP_DIR,TEMP_WRITE_ROOTS} from ${JSON.stringify(module)};
		import {wrapCommandWithOsSandbox} from ${JSON.stringify(sandbox)};
		import {execFileSync} from 'node:child_process';
		if (${enforce}) execFileSync('/bin/bash',['-c',wrapCommandWithOsSandbox('printf override > "$TMPDIR/probe.txt"')]);
		process.stdout.write(JSON.stringify({roots:TEMP_WRITE_ROOTS,temp:TEMP_DIR}));`;
	const output = execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", code], {
		encoding: "utf8", timeout: 10000, env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
	});
	return JSON.parse(output);
}

test("temp overrides are canonicalized consistently across platforms", (t) => {
	const dir = tempFixture(t);
	const result = tempOverrideProbe(dir, false);
	assert.equal(result.temp, resolveRealPath(dir));
	assert.ok(result.roots.includes(dir));
});

test("sandbox honors a symlinked TMPDIR override", sandboxOptions, (t) => {
	const dir = tempFixture(t, process.cwd());
	const alias = path.join(tempFixture(t), "override");
	fs.symlinkSync(dir, alias);
	const result = tempOverrideProbe(alias, true);
	assert.equal(result.temp, resolveRealPath(dir));
	assert.equal(fs.readFileSync(path.join(dir, "probe.txt"), "utf8"), "override");
});

// ── Sandbox build-failure fail-closed (readonly-bash.ts:584-589) ─────────────

test("fail-closed: sandbox build throw blocks an otherwise-allowed command", macOptions, () => {
	// CONTRACT: the try/catch in applyReadonlyBashGuard must block — never "allow" —
	// when wrapCommandWithOsSandbox throws. On macOS the throw is triggered by
	// buildMacProfile rejecting a quote-containing TEMP_DIR (resolved from TMPDIR
	// at import time). `echo hello` passes L2 classification, so only the sandbox-
	// build throw decides the verdict.
	const loader = new URL("../../register-loader.mjs", import.meta.url).href;
	const readonlyBash = new URL("../../readonly-bash.ts", import.meta.url).href;
	const osSandbox = new URL("../../os-sandbox.ts", import.meta.url).href;
	const code = `import { applyReadonlyBashGuard } from ${JSON.stringify(readonlyBash)};` +
		`import { canUseOsSandbox } from ${JSON.stringify(osSandbox)};` +
		`const available = canUseOsSandbox();` +
		`const result = applyReadonlyBashGuard("echo hello", "/tmp");` +
		`process.stdout.write(JSON.stringify({ available, action: result.action, reason: result.reason }));`;
	const output = execFileSync(process.execPath, [
		"--import", loader,
		"--input-type=module", "-e", code,
	], {
		encoding: "utf8", timeout: 30000,
		env: { ...process.env, TMPDIR: "/tmp/evil'", TEMP: "/tmp/evil'", TMP: "/tmp/evil'" },
	});
	const result = JSON.parse(output);
	assert.equal(result.available, true, "sandbox must be available for the throw to reach the catch");
	assert.equal(result.action, "block");
	assert.match(result.reason, /sandbox unavailable/);
	assert.match(result.reason, /quote/);
});
