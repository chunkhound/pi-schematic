import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
	isValidNpmExecpath,
	npmInvocation,
	repoRootFromScript,
	runChecked,
	runNpm,
	runNpmWithRetry,
} from "../../scripts/compat-process.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readScript(name: string): string {
	return readFileSync(join(REPO_ROOT, "scripts", name), "utf8");
}

function writeFlakyNpmCli(tmpDir: string, failures: number): { cliPath: string; attemptsPath: string } {
	const attemptsPath = join(tmpDir, "attempts");
	const cliPath = join(tmpDir, "npm-cli.js");
	writeFileSync(cliPath, `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const attemptsPath = ${JSON.stringify(attemptsPath)};
const attempts = (existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) : 0) + 1;
writeFileSync(attemptsPath, String(attempts));
if (attempts <= ${failures}) { process.stderr.write("transient failure"); process.exit(17); }
process.stdout.write("fixture npm success");
`);
	return { cliPath, attemptsPath };
}

async function withFlakyNpm<T>(failures: number, test: (tmpDir: string, cliPath: string, attemptsPath: string) => Promise<T>): Promise<T> {
	const tmpDir = mkdtempSync(join(tmpdir(), "npm-retry-test-"));
	const { cliPath, attemptsPath } = writeFlakyNpmCli(tmpDir, failures);
	try {
		return await test(tmpDir, cliPath, attemptsPath);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

function retryFixtureNpm(tmpDir: string, cliPath: string) {
	return runNpmWithRetry(tmpDir, ["--version"], {
		capture: true,
		env: { npm_execpath: cliPath },
		execPath: process.execPath,
	}, { retries: 2, baseMs: 0 });
}

test("repoRootFromScript decodes native paths containing spaces", () => {
	const expectedRoot = resolve(tmpdir(), "compat repo with spaces");
	const scriptUrl = pathToFileURL(join(expectedRoot, "scripts", "check.mjs")).href;
	expect(repoRootFromScript(scriptUrl)).toBe(expectedRoot);
});

test("npmInvocation uses npm_execpath through the active Node executable", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "npm-invocation-test-"));
	const stubCli = join(tmpDir, "npm-cli.js");
	writeFileSync(stubCli, "// npm CLI stub");
	try {
		expect(
			npmInvocation(["ls", "--json"], {
				env: { npm_execpath: stubCli },
				platform: "win32",
				execPath: "/node install/node.exe",
			}),
		).toStrictEqual({
			command: "/node install/node.exe",
			args: [stubCli, "ls", "--json"],
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("isValidNpmExecpath rejects a nonexistent path", () => {
	expect(isValidNpmExecpath(join(tmpdir(), "does-not-exist", "npm-cli.js"))).toBe(false);
});

test("isValidNpmExecpath rejects a directory named like an npm CLI", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "npm-dir-test-"));
	const dirNamedCli = join(tmpDir, "npm-cli.js");
	mkdirSync(dirNamedCli);
	try {
		expect(isValidNpmExecpath(dirNamedCli), "a directory must not validate as an npm CLI file").toBe(false);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("npmInvocation resolves a relative npm_execpath to an absolute path", () => {
	const tmpDir = mkdtempSync(join(process.cwd(), "npm-rel-test-"));
	const stubCli = join(tmpDir, "npm-cli.js");
	writeFileSync(stubCli, "// npm CLI stub");
	try {
		const relPath = relative(process.cwd(), stubCli);
		expect(!isAbsolute(relPath), "sanity: constructed path is relative").toBe(true);
		const invocation = npmInvocation(["ls", "--json"], {
			env: { npm_execpath: relPath },
			platform: "win32",
			execPath: "/node install/node.exe",
		});
		expect(isAbsolute(invocation.args[0]), "resolved execpath is absolute").toBe(true);
		expect(invocation.args[0], "relative execpath is resolved against cwd").toBe(resolve(relPath));
		expect(invocation.command).toBe("/node install/node.exe");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("runNpm launches npm portably", () => {
	const result = runNpm(REPO_ROOT, ["--version"], { capture: true });
	expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
});

test("runNpmWithRetry returns on its first successful attempt", async () => {
	await withFlakyNpm(0, async (tmpDir, cliPath, attemptsPath) => {
		const result = await retryFixtureNpm(tmpDir, cliPath);
		expect(result.stdout).toBe("fixture npm success");
		expect(readFileSync(attemptsPath, "utf8")).toBe("1");
	});
});

test("runNpmWithRetry retries a transient npm failure", async () => {
	await withFlakyNpm(1, async (tmpDir, cliPath, attemptsPath) => {
		const result = await retryFixtureNpm(tmpDir, cliPath);
		expect(result.stdout).toBe("fixture npm success");
		expect(readFileSync(attemptsPath, "utf8")).toBe("2");
	});
});

test("runNpmWithRetry rethrows after exhausting its retry budget", async () => {
	await withFlakyNpm(3, async (tmpDir, cliPath, attemptsPath) => {
		await expect(retryFixtureNpm(tmpDir, cliPath)).rejects.toThrow(/status: 17/);
		expect(readFileSync(attemptsPath, "utf8")).toBe("3");
	});
});

test("runChecked reports process launch failures", () => {
	expect(
		() => runChecked("pi-schematic-command-that-does-not-exist", [], { cwd: REPO_ROOT, capture: true }),
	).toThrow(expect.toSatisfy((error: unknown) => {
		expect(String(error)).toMatch(/error\.stack:/);
		expect(String(error)).toMatch(/status: null/);
		return true;
	}));
});

test("runChecked reports nonzero status and captured output", () => {
	expect(
		() => runChecked(process.execPath, [
			"-e",
			"process.stdout.write('stdout sentinel'); process.stderr.write('stderr sentinel'); process.exit(7)",
		], { cwd: REPO_ROOT, capture: true }),
	).toThrow(expect.toSatisfy((error: unknown) => {
		expect(String(error)).toMatch(/status: 7/);
		expect(String(error)).toMatch(/stdout sentinel/);
		expect(String(error)).toMatch(/stderr sentinel/);
		return true;
	}));
});

test("runChecked truncates oversized diagnostic output", () => {
	const payload = "x".repeat(9000);
	expect(
		() => runChecked(process.execPath, ["-e", "process.stderr.write(process.env.PAYLOAD); process.exit(7)"], {
			cwd: REPO_ROOT,
			capture: true,
			env: { ...process.env, PAYLOAD: payload },
		}),
	).toThrow(expect.toSatisfy((error: unknown) => {
		expect(String(error)).toMatch(/\[truncated 808 chars\]/);
		expect(String(error)).not.toContain(payload);
		return true;
	}));
});

test("compatibility scripts use native roots and the shared npm runner", () => {
	for (const name of ["test-compat-current.mjs", "test-package-host.mjs"]) {
		const source = readScript(name);
		expect(source).not.toMatch(/\.pathname\b/);
		expect(source).not.toMatch(/spawnSync\(["']npm["']/);
		expect(source).toMatch(/runNpm/);
		expect(source).toMatch(/repoRootFromScript\(import\.meta\.url\)/);
	}
});
