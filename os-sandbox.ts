/**
 * OS-level sandboxing for readonly-mode bash commands.
 *
 * Wraps bash commands to run inside an OS sandbox that denies filesystem
 * writes outside the OS temp dir. Uses platform-native sandbox mechanisms:
 *   macOS  → sandbox-exec with Seatbelt profile
 *   Linux  → bubblewrap (bwrap) if available
 *   Windows → not supported (returns command unchanged, classifyBashCommand applies)
 *
 * The wrapper passes the command to `/bin/bash -c` inside the sandbox and adds
 * nothing else: the command sees the same stdin, returns the same exit code and
 * streams the same output bytes to the same stdout and stderr as unsandboxed;
 * only the writes the sandbox denies differ. The wrapper prints no readonly
 * notice; appendSandboxBlockNotice and appendSandboxBlockNoticeToResult add it
 * to a failed command's error text or tool result.
 *
 * This replaces the best-effort command-pattern matching in classifyBashCommand
 * with actual kernel-enforced file-write blocking.
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { JsonObject } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import {
	READONLY_SANDBOX_BLOCK_NOTICE,
	buildReadonlySandboxPathError,
} from "./notifications.js";
import { TEMP_DIR } from "./temp-dir.js";
import { resolveRealPath } from "./resolve-path.js";

// ── Temp dir canonicalization ────────────────────────────────────

let _canonicalTempDir: string | undefined;

/** Get the canonical (symlink-resolved) temp dir path. */
function getCanonicalTempDir(): string {
	if (_canonicalTempDir === undefined) {
		_canonicalTempDir = resolveRealPath(TEMP_DIR);
	}
	return _canonicalTempDir;
}

// ── Platform detection ───────────────────────────────────────────

/**
 * Check whether we can use OS-level sandboxing on the current platform.
 * Returns true when sandbox-exec is available (macOS) or bwrap is installed (Linux).
 */
export function canUseOsSandbox(): boolean {
	const platform = process.platform;
	if (platform === "darwin") {
		return _hasSandboxExec();
	}
	if (platform === "linux") {
		return _hasBwrap();
	}

	return false;
}

let _bwrapResult: boolean | undefined;
let _sandboxExecResult: boolean | undefined;

function hasCommand(command: string): boolean {
	try {
		execSync(`command -v ${command}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function _hasBwrap(): boolean {
	if (_bwrapResult === undefined) {
		if (hasCommand("bwrap")) {
			// Quick functional test: can bwrap actually create a namespace?
			try {
				execSync("bwrap --ro-bind / / true 2>/dev/null", { stdio: "ignore", timeout: 2000 });
				_bwrapResult = true;
			} catch (e) {
				_bwrapResult = false;
			}
		} else {
			_bwrapResult = false;
		}
	}
	return _bwrapResult;
}

function _hasSandboxExec(): boolean {
	if (_sandboxExecResult === undefined) {
		if (hasCommand("sandbox-exec")) {
			// Quick functional test: can sandbox-exec actually enforce a profile?
			try {
				execSync("echo true | sandbox-exec -p '(version 1)(allow default)' /bin/bash 2>/dev/null",
					{ stdio: "ignore", timeout: 2000 });
				_sandboxExecResult = true;
			} catch (e) {
				_sandboxExecResult = false;
			}
		} else {
			_sandboxExecResult = false;
		}
	}
	return _sandboxExecResult;
}

// ── macOS: sandbox-exec ──────────────────────────────────────────

/**
 * Build a Seatbelt sandbox profile string for readonly mode.
 *
 * Pattern: allow everything by default, but deny all file writes except
 * to the canonical temp dir and /dev/null.
 *
 * Using (allow default) + write denies (permissive pattern) because
 * (deny default) + explicit read allows is fragile — system library
 * reads, dyld, and process execution are complex to enumerate and
 * vary across macOS versions. The permissive pattern keeps standard
 * tooling (node, npm, git, python, etc.) working while correctly
 * blocking all file writes outside the temp dir.
 */
export function buildMacProfile(tempDir: string): string {
	const canon = resolveRealPath(tempDir);
	const original = path.resolve(os.tmpdir()); // may have symlinks (e.g., /var -> /private/var)

	// Collect unique paths — both canonical and unresolved (symlink) forms.
	// Seatbelt subpath does NOT resolve symlinks, so we must include both.
	// Also include /tmp and /private/tmp because bash (on macOS) creates
	// heredoc temp files in /tmp regardless of $TMPDIR, so heredocs inside the
	// user's own command still need them.
	const writePaths = new Set<string>();
	writePaths.add(canon);
	if (original !== canon) writePaths.add(original);
	writePaths.add("/private/tmp");
	writePaths.add("/tmp");

	// Two distinct injection risks in the profile string:
	//  - Single quotes (') break out of the outer shell wrapper: sandbox-exec -p '${profile}'
	//  - Double quotes (") break Seatbelt (subpath "...") literal syntax
	for (const p of writePaths) {
		if (p.includes("'") || p.includes('"')) {
			throw new Error(buildReadonlySandboxPathError(p));
		}
	}

	const parts = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		'(allow file-write* (literal "/dev/null"))',
	];
	for (const p of writePaths) {
		parts.push(`(allow file-write* (subpath "${p}"))`);
	}
	return parts.join("");
}

/** Quote a dynamic argument for the outer bash that launches the sandbox. */
export function quoteShellArgument(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Build the `/bin/bash -c <quoted command>` tail that both sandbox wrappers run. */
function buildInnerBashInvocation(command: string): string {
	return `/bin/bash -c ${quoteShellArgument(command)}`;
}

/**
 * Wrap a bash command with sandbox-exec on macOS.
 *
 *   sandbox-exec -p '<profile>' /bin/bash -c '<command>'
 *
 * The command reaches the inner bash as its `-c` argument and nothing else
 * runs around it, so it keeps the caller's stdin, exit code, streamed stdout
 * and stderr, and output bytes; only writes the profile denies fail. All
 * descendants inherit the sandbox.
 */
export function wrapWithSandboxExec(command: string): string {
	const profile = buildMacProfile(getCanonicalTempDir());
	return `sandbox-exec -p '${profile}' ${buildInnerBashInvocation(command)}`;
}

// ── Linux: bubblewrap ────────────────────────────────────────────

/**
 * Wrap a bash command with bubblewrap on Linux.
 *
 *   bwrap <flags> /bin/bash -c '<command>'
 *
 * Like the sandbox-exec wrapper, the command keeps the caller's stdin, exit
 * code, streamed stdout and stderr, and output bytes; only writes outside the
 * temp dir fail. One accepted difference: a command killed by signal N reports
 * exit code 128+N rather than a signal, because bwrap exits with that code
 * instead of re-raising the signal.
 *
 * --ro-bind / /  makes entire root read-only
 * --tmpfs /tmp   then mounts writable tmpfs at /tmp (overrides ro-bind)
 * --bind <tmp> <tmp> binds the real temp dir writable into /tmp
 * --proc /proc, --dev /dev for proper /proc and /dev
 * --unshare-all --share-net for isolation while allowing network
 * --die-with-parent --new-session for clean termination
 */
export function wrapWithBwrap(command: string, tempDir: string = getCanonicalTempDir()): string {
	const canon = resolveRealPath(tempDir);
	const flags = [
		"--ro-bind / /",
		"--tmpfs /tmp",
		`--bind ${quoteShellArgument(canon)} ${quoteShellArgument(canon)}`,
		"--proc /proc",
		"--dev /dev",
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--new-session",
	];
	return `bwrap ${flags.join(" ")} ${buildInnerBashInvocation(command)}`;
}

// ── Block notice ─────────────────────────────────────────────────

/** Lowercase denial phrase each platform's sandbox puts in a blocked write's error. */
const SANDBOX_DENIAL_PHRASES: Partial<Record<NodeJS.Platform, string>> = {
	darwin: "operation not permitted",
	linux: "read-only file system",
};

const SANDBOX_BLOCK_NOTICE_SUFFIX = `\n\n${READONLY_SANDBOX_BLOCK_NOTICE}`;

function containsSandboxDenial(text: string, platform: NodeJS.Platform): boolean {
	const phrase = SANDBOX_DENIAL_PHRASES[platform];
	return phrase !== undefined && text.toLowerCase().includes(phrase);
}

/**
 * Return `text` with the readonly block notice appended as its own paragraph
 * when it contains the platform's sandbox denial phrase (case-insensitive), or
 * `undefined` when it does not. Platforms without a sandbox never match.
 */
export function appendSandboxBlockNotice(text: string, platform: NodeJS.Platform = process.platform): string | undefined {
	return containsSandboxDenial(text, platform) ? text + SANDBOX_BLOCK_NOTICE_SUFFIX : undefined;
}

/**
 * Return a failed tool result's `content` and `structuredContent` with the
 * readonly block notice appended, or `undefined` unless `isError` is true and
 * the platform's denial phrase occurs in a text block or in a string
 * `structuredContent.output`.
 *
 * The notice goes after the last text block (into a new text block when there
 * is none) and after a string `structuredContent.output`; every other field is
 * kept. The input is not mutated, and `isError` is not part of the return.
 */
export function appendSandboxBlockNoticeToResult(
	result: Pick<AgentToolResult, "content" | "structuredContent" | "isError">,
	platform: NodeJS.Platform = process.platform,
): Pick<AgentToolResult, "content" | "structuredContent"> | undefined {
	if (result.isError !== true) return undefined;

	const structured = result.structuredContent;
	const structuredObject = typeof structured === "object" && structured !== null && !Array.isArray(structured)
		? structured as JsonObject
		: undefined;
	const output = typeof structuredObject?.output === "string" ? structuredObject.output : undefined;
	const matched = result.content.some((block) => block.type === "text" && containsSandboxDenial(block.text, platform))
		|| (output !== undefined && containsSandboxDenial(output, platform));
	if (!matched) return undefined;

	let lastTextIndex = -1;
	result.content.forEach((block, index) => {
		if (block.type === "text") lastTextIndex = index;
	});
	const content = lastTextIndex === -1
		? [...result.content, { type: "text" as const, text: READONLY_SANDBOX_BLOCK_NOTICE }]
		: result.content.map((block, index) =>
			index === lastTextIndex && block.type === "text"
				? { ...block, text: block.text + SANDBOX_BLOCK_NOTICE_SUFFIX }
				: block);
	const structuredContent = output === undefined
		? structured
		: { ...structuredObject, output: output + SANDBOX_BLOCK_NOTICE_SUFFIX };
	return { content, structuredContent };
}

// ── Unified dispatch ─────────────────────────────────────────────

/**
 * Wrap a bash command string to run inside an OS-level filesystem sandbox.
 *
 * On macOS: wraps with sandbox-exec (native, no deps).
 * On Linux: wraps with bubblewrap if available.
 * On other platforms / when unavailable: returns command unchanged.
 *
 * The returned command must be passed to /bin/bash -c (or equivalent) for
 * execution — the shell tool handles this automatically.
 */
export function wrapCommandWithOsSandbox(command: string): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return wrapWithSandboxExec(command);
	}
	if (platform === "linux" && _hasBwrap()) {
		return wrapWithBwrap(command);
	}
	// No OS sandbox available — command unchanged, classifyBashCommand
	// fallback will handle it at the call site.
	return command;
}
