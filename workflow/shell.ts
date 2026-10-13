// WHY: `workflow.shell` must behave exactly like pi's own bash tool. Instead of
// hand-rolling a shell wrapper on `pi.exec` (raw env, no sanitize, no tree-kill),
// the host reuses pi's exported `createBashToolDefinition`: it resolves the shell
// (`shellPath`), injects pi's `getShellEnv`, sanitizes/truncates output, persists
// the full output to a temp file, and kills the whole process tree on abort/timeout.
// The readonly guard is the same one the tool_call hook uses, policy in one place.
import type { ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyReadonlyBashGuard } from "../readonly-bash.js";
import { registeredState } from "../process-state.js";
import { messageOf } from "./errors.js";
import type { ShellOptions, ShellResult } from "./types.js";

/** The subset of pi's bash tool result the runner maps; structural so tests inject easily. */
export interface ShellToolResult {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	isError?: boolean;
	structuredContent?: {
		output: string;
		truncated: boolean;
		full_output_path?: string;
		exit_code: number;
		wall_time_seconds: number;
	};
}

export interface ShellRunOptions {
	signal: AbortSignal;
	/** Timeout in seconds, matching pi's bash tool. */
	timeout?: number;
	/** Streaming display snapshots, so the live activity widget can render progress. */
	onUpdate?: (display: string) => void;
}

/** Injected seam: production runs pi's bash tool; tests swap in a fake. */
export type ShellRun = (command: string, options: ShellRunOptions) => Promise<ShellToolResult>;

export interface ShellRunnerDeps {
	cwd: string;
	signal: AbortSignal;
	isReadonly: () => boolean;
	/** Explicit shell from pi settings; undefined uses pi's resolution order. */
	shellPath?: string;
	/** Live command context: supplies PI_* session env to pi's bash tool. */
	ctx?: ExtensionCommandContext;
	/** Streaming display snapshots from pi's bash tool. */
	onOutput?: (display: string) => void;
	/** Test seam. Production builds pi's bash tool definition. */
	run?: ShellRun;
}

export function blockedShellResult(reason: string): ShellResult {
	return { ok: false, exitCode: null, output: reason, display: reason, truncated: false, killed: false };
}

function displayOf(outcome: ShellToolResult): string {
	return (outcome.content ?? [])
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n");
}

/** Map pi's bash tool result onto the workflow's wire contract. */
function toShellResult(outcome: ShellToolResult): ShellResult {
	const display = displayOf(outcome);
	const structured = outcome.structuredContent;
	if (!structured) {
		return { ok: !outcome.isError, exitCode: outcome.isError ? 1 : 0, output: display, display, truncated: false, killed: false };
	}
	return {
		ok: !outcome.isError,
		exitCode: structured.exit_code,
		output: structured.output,
		display,
		truncated: structured.truncated,
		killed: false,
		...(structured.full_output_path ? { fullOutputPath: structured.full_output_path } : {}),
		wallTimeSeconds: structured.wall_time_seconds,
	};
}

/** Run one command through pi's bash tool, adopting its shell resolution and environment. */
function piBashRun(deps: ShellRunnerDeps): ShellRun {
	const definition = createBashToolDefinition(deps.cwd, { shellPath: deps.shellPath });
	return (command, options) =>
		definition.execute(
			"workflow-shell",
			{ command, ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) },
			options.signal,
			options.onUpdate
				? (partial: { content?: ReadonlyArray<{ type?: string; text?: string }> }) => {
						const text = partial.content?.[0]?.text;
						if (typeof text === "string") options.onUpdate?.(text);
					}
				: undefined,
			// The bash tool only reads ExtensionContext fields (cwd, model, sessionManager,
			// thinkingLevel); the command context supplies all of them.
			deps.ctx as unknown as ExtensionToolContext,
		) as Promise<ShellToolResult>;
}

/** Process-isolated e2e hosts cannot inject host deps (the extension factory owns them),
 * so they gate the real shell through this seam. registeredState, not a module global:
 * jiti can load this file twice per process and every copy must see the same fake
 * (see process-state.ts). One process per e2e test, so a set fake never leaks. */
const TEST_SHELL_RUN = registeredState<{ run: ShellRun | null }>("pi-schematic.workflow-shell-test-run", () => ({ run: null }));

export function setShellRunForTests(run: ShellRun | null): void {
	TEST_SHELL_RUN.run = run;
}

/** pi kills the process on timeout and throws without aborting our signal. The bash tool
 * definition rethrows the low-level `timeout:<seconds>` as
 * `Command timed out after <n> seconds`, appended after any partial output (`appendStatus`
 * in core/tools/bash.js), so the status is the last line, not the whole message. A spawn
 * failure that merely mentions "timed out" must not match. */
export function isTimeoutMessage(message: string): boolean {
	return /Command timed out after \d+ seconds$/.test(message);
}

async function executeShell(deps: ShellRunnerDeps, command: string, options: ShellOptions): Promise<ShellResult> {
	const run = deps.run ?? TEST_SHELL_RUN.run ?? piBashRun(deps);
	try {
		return toShellResult(await run(command, { signal: deps.signal, timeout: options.timeout, onUpdate: deps.onOutput }));
	} catch (error) {
		// Abort/timeout/spawn failures surface as a failed ShellResult, never a rejected handle:
		// the workflow decides what to do, and the message stays visible in `output`.
		const message = messageOf(error);
		return { ok: false, exitCode: null, output: message, display: message, truncated: false, killed: deps.signal.aborted || isTimeoutMessage(message) };
	}
}

async function runShell(deps: ShellRunnerDeps, command: unknown, options: ShellOptions): Promise<ShellResult> {
	if (typeof command !== "string" || !command.trim()) throw new Error("workflow.shell requires a non-empty command");
	const guard =
		deps.isReadonly() || options.readonly
			? applyReadonlyBashGuard(command, deps.cwd)
			: ({ action: "allow" } as const);
	if (guard.action === "block") return blockedShellResult(guard.reason);
	const effective = guard.action === "sandbox" ? guard.sandboxedCommand : command;
	return executeShell(deps, effective, options);
}

/** Bind the effect dependencies once; the returned closure is the `workflow.shell` handle. */
export function createShellRunner(deps: ShellRunnerDeps): (command: unknown, options?: ShellOptions) => Promise<ShellResult> {
	return (command, options = {}) => runShell(deps, command, options);
}
