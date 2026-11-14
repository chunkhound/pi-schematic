// Runs a Node or git child process for a unit test. This module imports no test runner.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/** Default child deadline: below the unit testTimeout, so a hung child fails with its own message. */
export const CHILD_TIMEOUT_MS = 20_000;

export interface SpawnNodeOptions {
	cwd: string;
	/** Merged over the inherited environment, after NODE_OPTIONS is cleared. */
	env?: NodeJS.ProcessEnv;
	/** Module URL passed as `--import` before `args`, such as the register-loader URL. */
	loader?: string;
	timeoutMs?: number;
}

/**
 * Run `node ...args` to completion and return the result. NODE_OPTIONS is cleared so the runner's
 * own flags stay out of the child. Throws when the child outlives the deadline, dies from a signal,
 * or fails to spawn, since none of those leaves an exit status to assert on.
 */
export function spawnNode(args: readonly string[], options: SpawnNodeOptions): SpawnSyncReturns<string> {
	const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
	const argv = options.loader === undefined ? [...args] : ["--import", options.loader, ...args];
	const result = spawnSync(process.execPath, argv, {
		cwd: options.cwd,
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "", ...options.env },
		timeout: timeoutMs,
		// The timeout otherwise sends SIGTERM and waits, so a child that handles SIGTERM outlives it.
		killSignal: "SIGKILL",
	});
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the ErrnoException cast exposes the code property the ETIMEDOUT check reads
	const spawnError = result.error as NodeJS.ErrnoException | undefined;
	if (spawnError?.code === "ETIMEDOUT") {
		throw new Error(`Node child process did not exit within ${timeoutMs} ms (${spawnError.message})`);
	}
	if (result.signal !== null) {
		throw new Error(`Node child process was killed by ${result.signal}${spawnError ? ` (${spawnError.message})` : ""}`);
	}
	if (spawnError) {throw spawnError;}
	return result;
}

export interface RunGitOptions {
	cwd: string;
}

/**
 * Run `git ...args` to completion and return its stdout. Throws when git fails to spawn, outlives
 * the deadline, dies from a signal, or exits non-zero. The message names the command and, for a
 * spawn failure or timeout, the spawn error; for a signal or exit status, that and stderr. A signal
 * message also carries the spawn error when there is one, such as ENOBUFS for output beyond maxBuffer.
 */
export function runGit(args: readonly string[], options: RunGitOptions): string {
	const command = ["git", ...args].join(" ");
	const result = spawnSync("git", args, {
		cwd: options.cwd,
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
		// The timeout otherwise sends SIGTERM and waits, so a git process that handles SIGTERM outlives it.
		killSignal: "SIGKILL",
	});
	const spawnError = result.error;
	if (spawnError && "code" in spawnError && spawnError.code === "ETIMEDOUT") {
		throw new Error(`${command} did not exit within ${String(CHILD_TIMEOUT_MS)} ms (${spawnError.message})`, { cause: spawnError });
	}
	if (result.signal !== null) {
		throw new Error(`${command} was killed by ${result.signal}${spawnError ? ` (${spawnError.message})` : ""}; stderr: ${result.stderr}`);
	}
	if (spawnError) {
		throw new Error(`${command} failed to spawn: ${spawnError.message}`, { cause: spawnError });
	}
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${String(result.status)}; stderr: ${result.stderr}`);
	}
	return result.stdout;
}
