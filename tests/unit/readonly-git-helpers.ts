import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBashCommand, type Verdict } from "../../readonly-bash.js";
import { FIXTURE_MARKER, sweepStaleFixtures } from "./fixture-sweep.js";

// Shared fixtures for the readonly git suites. Outside-temp fixtures (os.homedir()) are
// intentional — they prove writes there are blocked, so these suites cannot run under the
// extension's own readonly sandbox (EPERM). Suites gate on capabilities instead of failing.
// Captured at load: tests mutate HOME and os.homedir() follows it on POSIX.
const hostHome = os.homedir();
sweepStaleFixtures(os.tmpdir(), "readonly-git-");
sweepStaleFixtures(hostHome, "readonly-git-");

export const outside = path.join(hostHome, "readonly-git-outside");
export const quote = (value: string) => JSON.stringify(value);

export function check(command: string, cwd: string, allowed: boolean): void {
	const verdict = classifyBashCommand(command, cwd);
	// Surface the reason: a fail-closed probe must not read as a policy block.
	assert.equal(verdict.ok, allowed, verdict.ok ? command : `${command}\nblocked: ${verdict.reason}`);
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Overlay that makes `git` resolve to the shim; one source for in-process and child runs. */
function gitShimEnvironment(bin: string, markers: Record<string, string>): NodeJS.ProcessEnv {
	return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, ...markers };
}

/** Apply a shim overlay for this test and restore every touched variable afterwards. */
export function installGitShim(t: test.TestContext, bin: string, markers: Record<string, string>): void {
	const overlay = gitShimEnvironment(bin, markers);
	const saved = Object.fromEntries(Object.keys(overlay).map((name) => [name, process.env[name]]));
	Object.assign(process.env, overlay);
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

export interface GitProbeShim {
	bin: string;
	counter: string;
	/** Create one of these files to select the matching shim mode. */
	markerFiles: { failOnce: string; alwaysFail: string; slowOnce: string; slow: string; stubborn: string };
	/** Environment for a child classifier: shim PATH plus marker variables. */
	env: NodeJS.ProcessEnv;
	/** Marker variables for an in-process `installGitShim`. */
	markerEnvironment: Record<string, string>;
}

/**
 * Install a `git` shim that records every invocation and can fail, slow down, or ignore TERM.
 * WHY marker files: the classifier spawns `git` in its own process, so the test can only
 * steer it through the inherited environment. The counter byte is written before any mode,
 * so a killed child still proves it ran.
 */
export function writeGitProbeShim(root: string): GitProbeShim {
	const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const bin = path.join(root, "bin"), counter = path.join(root, "probes");
	const markerFiles = {
		failOnce: path.join(root, "fail-once"),
		alwaysFail: path.join(root, "always-fail"),
		slowOnce: path.join(root, "slow-once"),
		slow: path.join(root, "slow-probe"),
		stubborn: path.join(root, "stubborn-probe"),
	};
	mkdirSync(bin);
	writeFileSync(path.join(bin, "git"), probeShimScript(realGit), { mode: 0o755 });
	const markerEnvironment = {
		COUNTER_FILE: counter,
		FAIL_ONCE: markerFiles.failOnce,
		ALWAYS_FAIL: markerFiles.alwaysFail,
		SLOW_ONCE: markerFiles.slowOnce,
		SLOW_PROBE: markerFiles.slow,
		STUBBORN_PROBE: markerFiles.stubborn,
	};
	const env = { ...process.env, ...gitShimEnvironment(bin, markerEnvironment) };
	// A first run of a freshly written shim can exceed the probe budget on hosts that scan new
	// executables, so warm it before a test relies on its timing. The byte also proves the
	// shim fires: a classifier pass can legitimately spawn zero probes.
	execFileSync("git", ["--version"], { env, stdio: "ignore" });
	assert.ok(readFileSync(counter, "utf8").length > 0, "git PATH shim did not record a spawn");
	rmSync(counter, { force: true });
	return { bin, counter, markerFiles, env, markerEnvironment };
}

/** Sleeps keep stdout free, so a SIGKILLed shim never leaves an orphan holding the probe pipe. */
function probeShimScript(realGit: string): string {
	return `#!/bin/sh
if [ -n "$COUNTER_FILE" ]; then printf %s x >> "$COUNTER_FILE"; fi
if [ -e "$FAIL_ONCE" ]; then rm -f "$FAIL_ONCE"; kill -TERM $$; fi
if [ -e "$ALWAYS_FAIL" ]; then kill -TERM $$; fi
if [ -e "$SLOW_ONCE" ]; then rm -f "$SLOW_ONCE"; sleep 0.25 >/dev/null 2>&1; fi
if [ -e "$SLOW_PROBE" ]; then sleep 0.25 >/dev/null 2>&1; fi
if [ -e "$STUBBORN_PROBE" ]; then
	trap '' TERM
	i=0
	while [ "$i" -lt 300 ]; do sleep 0.1 >/dev/null 2>&1; i=$((i+1)); done
	exit 2
fi
exec ${JSON.stringify(realGit)} "$@"
`;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Run one classification in a child process under an outer watchdog.
 * WHY: config probes block inside `execFileSync`, so a same-process timer cannot interrupt a
 * hung child. Killing the blocking process is the only way to bound the test itself.
 * `elapsedMs` is the classification's own duration, excluding child startup.
 */
export function classifyWithWatchdog(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): { verdict: Verdict; elapsedMs: number } {
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "readonly-git-probe-child.ts");
	const started = Date.now();
	const result = spawnSync(process.execPath, ["--import", path.join(repoRoot, "register-loader.mjs"), runner, command, cwd], {
		cwd: repoRoot, env, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"],
	});
	const wallMs = Date.now() - started;
	// A timeout surfaces as ETIMEDOUT plus the kill signal; either means the classifier never returned.
	const failure = result.error ?? (result.signal ? new Error(`signal ${result.signal}`) : null);
	if (failure) throw new Error(`classifier child did not finish within ${timeoutMs} ms (${failure.message}) after ${wallMs} ms`);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as { verdict: Verdict; elapsedMs: number };
}

export function localEnvironment(name: string, value: string): string[] {
	const assignment = `${name}=${quote(value)}`;
	return [assignment, `env ${assignment}`];
}

export function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { timeout: 1000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function hasBash(): boolean {
	try {
		execFileSync("bash", ["-c", "true"], { timeout: 1000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Tool presence via the shell's own lookup: a tool's `-v` flag is not a presence probe
 * (chmod -v fails without an operand, rsync -v without a source). */
export function hasCommand(name: string): boolean {
	try {
		execFileSync("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name], { timeout: 2000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// Outside-temp fixtures are the point of these suites, so they cannot run under the
// extension's own readonly sandbox. Probe once and skip locally;
// REQUIRE_OUTSIDE_TEMP_WRITES=1 (CI) turns an unexpectedly sandboxed runner into a hard
// failure instead of a silent skip. `dir` defaults to the host home; suites whose
// outside fixture lives elsewhere (e.g. the shell suite probes process.cwd()) pass it in.
export function canWriteOutsideTemp(dir: string = os.homedir()): boolean {
	const probe = path.join(dir, `.readonly-shell-test-git-probe-${process.pid}`);
	try { writeFileSync(probe, ""); rmSync(probe); return true; }
	catch { return false; }
}

export const outsideWritable = canWriteOutsideTemp();
export const outsideWritesRequired = process.env.REQUIRE_OUTSIDE_TEMP_WRITES === "1";

// Real-tool differentials need tools only the provisioned Linux lane installs. Separate
// from REQUIRE_OUTSIDE_TEMP_WRITES: macOS CI has the filesystem capability but not GNU
// sed or dpkg-deb, so tool absence must skip there instead of failing.
export const realToolsRequired = process.env.REQUIRE_REAL_TOOLS === "1";

// POSIX bash semantics and literal POSIX temp paths exist only off Windows.
export const posixHost = process.platform !== "win32";

// WHY one gate for every missing capability: a skipped tool check would report green in the
// CI lane that demands these tests really ran, exactly like the sandbox case above.
// `posixOnly` keeps the POSIX-scoped REQUIRE condition: a Windows runner skips even when
// CI demands outside-temp fixtures really run, since it has neither bash nor POSIX paths.
export function capabilityRequired(posixOnly = false): boolean {
	return posixOnly ? outsideWritesRequired && posixHost : outsideWritesRequired;
}

export function capabilityGate(name: string, reason: string, posixOnly = false): void {
	if (capabilityRequired(posixOnly)) test(name, () => assert.fail(`${reason}; REQUIRE_OUTSIDE_TEMP_WRITES=1 forbids skipping`));
	else test(name, { skip: reason }, () => {});
}

// WHY per-test options instead of one file-level gate: a tripped file gate reports
// "skipped 1" for ~30 hidden tests, so one misspelled env var deletes the suite green.
// Every test takes gitSuiteOptions, keeping each regression individually visible.
function gitSuiteSkipReason(): string | null {
	if (!posixHost) return "POSIX bash and temp-path semantics required";
	if (!outsideWritable) return "cannot write outside temp";
	if (!hasBash() || !hasGit()) return "bash or git unavailable";
	return null;
}

export const gitSuiteSkipped: string | null = gitSuiteSkipReason();
export const gitSuiteOptions: test.TestOptions = gitSuiteSkipped ? { skip: gitSuiteSkipped } : {};

export function fixture(t: test.TestContext, base = os.tmpdir()): string {
	// Tests vary HOME; an outside fixture must remain anchored to the real host home.
	if (base === os.homedir()) base = hostHome;
	const root = mkdtempSync(path.join(base, "readonly-git-"));
	writeFileSync(path.join(root, FIXTURE_MARKER), "");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

export function repository(root: string): string {
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "--quiet");
	writeFileSync(path.join(repo, "file"), "initial\n");
	git(repo, "add", "file");
	git(repo, "-c", "user.name=Readonly Test", "-c", "user.email=readonly@example.invalid", "commit", "--quiet", "-m", "initial");
	return repo;
}

// Classifier config subprocesses must inherit the same hermetic environment as fixture Git.
export function installGitIsolation(clearHome = true): void {
	test.beforeEach((t) => {
		assert.ok("after" in t, "Git isolation requires per-test cleanup");
		const saved = Object.entries(process.env).filter(([name]) => isolatedEnvironment(name, clearHome));
		t.after(() => {
			clearGitEnvironment(clearHome);
			for (const [name, value] of saved) process.env[name] = value;
		});
		clearGitEnvironment(clearHome);
		// Redirecting global/system config into a temp fixture only holds when HOME also moves;
		// otherwise `git config --global` would still target the real (outside-temp) home.
		if (!clearHome) return;
		const root = fixture(t);
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		process.env.GIT_CONFIG_GLOBAL = path.join(root, "global-config");
		process.env.GIT_CONFIG_SYSTEM = path.join(root, "system-config");
	});
}

function isolatedEnvironment(name: string, clearHome: boolean): boolean {
	return name.startsWith("GIT_") || (clearHome && ["HOME", "XDG_CONFIG_HOME", "BASH_ENV", "ENV"].includes(name));
}

function clearGitEnvironment(clearHome: boolean): void {
	for (const name of Object.keys(process.env)) if (isolatedEnvironment(name, clearHome)) delete process.env[name];
}
