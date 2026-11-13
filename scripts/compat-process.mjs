import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the repository root from a script under ./scripts. */
export function repoRootFromScript(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

function formatInvocation(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(" ");
}

// Keep CI logs bounded; failure.txt receives the same truncated diagnostics.
function truncateOutput(value, limit = 8192) {
  if (!value) {return "";}
  return value.length > limit ? `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]` : value;
}

/** Run a subprocess and fail with launch/status/signal and captured-output context. */
export function runChecked(command, args, options = {}) {
  const { cwd, capture = false, env = process.env } = options;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error || result.signal || result.status !== 0) {
    const diagnostics = [
      `invocation: ${formatInvocation(command, args)}`,
      `cwd: ${cwd ?? process.cwd()}`,
      `error.stack: ${result.error?.stack ?? "none"}`,
      `status: ${String(result.status)}`,
      `signal: ${String(result.signal)}`,
      `stdout:\n${truncateOutput(result.stdout ?? "")}`,
      `stderr:\n${truncateOutput(result.stderr ?? "")}`,
    ].join("\n");
    throw new Error(diagnostics);
  }
  return result;
}

/** Resolve to the absolute npm CLI JS path, or undefined when not a real npm CLI file. */
function resolveNpmExecpath(npmExecpath) {
  if (!npmExecpath) {return undefined;}
  const resolved = isAbsolute(npmExecpath) ? npmExecpath : resolve(npmExecpath);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) {return undefined;}
  const base = basename(resolved, ".js").toLowerCase();
  return base === "npm-cli" || base === "npm" ? resolved : undefined;
}

/** True when npm_execpath points to a real npm CLI JS file (not a binary or another tool). */
export function isValidNpmExecpath(npmExecpath) {
  return resolveNpmExecpath(npmExecpath) !== undefined;
}

/** Build a shell-free npm invocation, including Windows' npm.cmd installations. */
export function npmInvocation(args, options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    execPath = process.execPath,
  } = options;
  const npmExecpath = resolveNpmExecpath(env.npm_execpath);
  if (npmExecpath) {
    return { command: execPath, args: [npmExecpath, ...args] };
  }
  if (platform !== "win32") {
    return { command: "npm", args };
  }

  const npmCli = resolve(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCli)) {
    return { command: execPath, args: [npmCli, ...args] };
  }
  throw new Error(
    `Unable to locate npm CLI beside ${execPath}; invoke this compatibility check through its npm script.`,
  );
}

export function runNpm(cwd, args, options = {}) {
  const invocation = npmInvocation(args, options);
  return runChecked(invocation.command, invocation.args, { cwd, ...options });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry runNpm with exponential backoff for transient registry failures.
 * Retries on any non-zero status/signal/error (including permanent 404s) —
 * worst case ~5.6s backoff per call (800+1600+3200), ~22s for 4 calls in
 * the current compat lane; failure artifacts retain bounded output, so rerun
 * locally when the truncated subprocess tail is needed.
 */
export async function runNpmWithRetry(cwd, args, options = {}, retryOptions = {}) {
  const { retries = 3, baseMs = 800 } = retryOptions;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return runNpm(cwd, args, options);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {break;}
      await sleep(baseMs * 2 ** attempt);
    }
  }
  throw lastError;
}
