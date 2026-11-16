// Temp directories and HOME or agent-directory isolation for tests that read or write files under
// pi's global paths.

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { test as base } from "vitest";
import { AGENT_DIR_ENV_KEY } from "../paths.js";

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, key);
	} else {
		process.env[key] = value;
	}
}

/** A fresh directory under the OS temp directory; the caller removes it. */
export async function tmpDir(): Promise<string> {
	return mkdtemp(join(os.tmpdir(), "pi-test-"));
}

/**
 * `test` with a `dir` fixture: a fresh temp directory, created only for tests
 * that take `dir` and removed after the test, also when a check failed.
 */
export const testWithDir = base.extend<{ dir: string }>({
	dir: async ({}, use) => {
		const dir = await tmpDir();
		await use(dir);
		await rm(dir, { recursive: true, force: true });
	},
});

// pi resolves its agent directory from PI_CODING_AGENT_DIR before HOME, so the home helpers clear
// it; otherwise an exported variable redirects global paths away from the temp home.
/** Point HOME (and USERPROFILE) at `home` and clear the agent-directory variable; returns the restore function. */
export function setTempHome(home: string): () => void {
	const snapshot = new Map<(typeof HOME_ENV_KEYS)[number], string | undefined>(HOME_ENV_KEYS.map((key) => [key, process.env[key]]));
	const previousAgentDir = process.env[AGENT_DIR_ENV_KEY];
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.HOMEDRIVE;
	delete process.env.HOMEPATH;
	Reflect.deleteProperty(process.env, AGENT_DIR_ENV_KEY);
	return () => {
		for (const key of HOME_ENV_KEYS) {
			restoreEnv(key, snapshot.get(key));
		}
		restoreEnv(AGENT_DIR_ENV_KEY, previousAgentDir);
	};
}

/** Run `run` with HOME at a fresh temp directory, which is removed afterwards. */
export async function withTempHome<T>(run: (homeDir: string) => T | Promise<T>): Promise<T> {
	const homeDir = await tmpDir();
	const restore = setTempHome(homeDir);
	try {
		return await run(homeDir);
	} finally {
		restore();
		await rm(homeDir, { recursive: true, force: true });
	}
}

/** Nest inside `withTempHome`, not around it: `withTempHome` clears `PI_CODING_AGENT_DIR` for its run. */
export async function withTempAgentDir<T>(run: (agentDir: string) => T | Promise<T>): Promise<T> {
	const previousAgentDir = process.env[AGENT_DIR_ENV_KEY];
	const agentDir = await tmpDir();
	process.env[AGENT_DIR_ENV_KEY] = agentDir;
	try {
		return await run(agentDir);
	} finally {
		restoreEnv(AGENT_DIR_ENV_KEY, previousAgentDir);
		await rm(agentDir, { recursive: true, force: true });
	}
}
