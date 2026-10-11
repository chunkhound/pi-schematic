import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
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
	assert.equal(classifyBashCommand(command, cwd).ok, allowed, command);
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
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

// POSIX bash semantics and literal POSIX temp paths exist only off Windows.
export const posixHost = process.platform !== "win32";

// WHY one gate for every missing capability: a skipped tool check would report green in the
// CI lane that demands these tests really ran, exactly like the sandbox case above.
// `posixOnly` keeps the POSIX-scoped REQUIRE condition: a Windows runner skips even when
// CI demands outside-temp fixtures really run, since it has neither bash nor POSIX paths.
export function capabilityGate(name: string, reason: string, posixOnly = false): void {
	const required = posixOnly ? outsideWritesRequired && posixHost : outsideWritesRequired;
	if (required) test(name, () => assert.fail(`${reason}; REQUIRE_OUTSIDE_TEMP_WRITES=1 forbids skipping`));
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
