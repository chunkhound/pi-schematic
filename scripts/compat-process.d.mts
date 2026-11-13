import type { SpawnSyncReturns } from "node:child_process";

interface RunCheckedOptions {
	cwd?: string;
	capture?: boolean;
	env?: NodeJS.ProcessEnv;
}

interface NpmInvocationOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	execPath?: string;
}

type NpmOptions = RunCheckedOptions & NpmInvocationOptions;

interface RetryOptions {
	retries?: number;
	baseMs?: number;
}

/** Repository root for a script under ./scripts, from the script's import.meta.url. */
export declare function repoRootFromScript(importMetaUrl: string): string;

/** Runs a subprocess and throws with its invocation, status, signal and captured output when it fails; only a captured run returns its output. */
export declare function runChecked(command: string, args: string[], options: RunCheckedOptions & { capture: true }): SpawnSyncReturns<string>;
export declare function runChecked(command: string, args: string[], options?: RunCheckedOptions & { capture?: false }): SpawnSyncReturns<null>;

/** True when npm_execpath points to a real npm CLI JS file. */
export declare function isValidNpmExecpath(npmExecpath: string | undefined): boolean;

/** Shell-free npm command and arguments, including for Windows' npm.cmd installations. */
export declare function npmInvocation(args: string[], options?: NpmInvocationOptions): { command: string; args: string[] };

/** Runs npm in cwd through runChecked. */
export declare function runNpm(cwd: string, args: string[], options: NpmOptions & { capture: true }): SpawnSyncReturns<string>;
export declare function runNpm(cwd: string, args: string[], options?: NpmOptions & { capture?: false }): SpawnSyncReturns<null>;

/** runNpm retried with exponential backoff; rejects with the last failure once the retries run out. */
export declare function runNpmWithRetry(
	cwd: string,
	args: string[],
	options: NpmOptions & { capture: true },
	retryOptions?: RetryOptions,
): Promise<SpawnSyncReturns<string>>;
export declare function runNpmWithRetry(
	cwd: string,
	args: string[],
	options?: NpmOptions & { capture?: false },
	retryOptions?: RetryOptions,
): Promise<SpawnSyncReturns<null>>;

export {};
