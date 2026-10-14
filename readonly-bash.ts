import path from "node:path";
import os from "node:os";
import { globSync } from "node:fs";
import { canUseOsSandbox, wrapCommandWithOsSandbox } from "./os-sandbox.js";
import {
	buildReadonlyBashBlockReason,
	buildReadonlyPackageManagerBlockReason,
	READONLY_INVALID_BASH_COMMAND_REASON,
} from "./notifications.js";
import { resolveRealPath } from "./resolve-path.js";
import { TEMP_DIR } from "./temp-dir.js";

/**
 * Readonly bash guard.
 *
 * Contract: block filesystem writes/deletions outside the OS temp dir.
 * Non-mutating commands, unknown commands, and environment inheritance are
 * allowed. Process-level commands (kill, reboot, shutdown, systemctl, su)
 * are not filesystem mutations and are intentionally allowed.
 *
 * Package-manager mutations (npm install, pip install, etc.) are blocked
 * unconditionally regardless of target path — they write outside any single
 * directory (node_modules, site-packages, etc.) making temp-dir checking
 * meaningless.
 *
 * This is a best-effort command inspection layer, not a security sandbox.
 *
 * ## Known L2 limitations (no OS sandbox available)
 *
 * These bypasses are mitigated by L1 (OS sandbox) on macOS and Linux but
 * are effective on Windows or when sandbox tools are missing:
 *
 *   - **Interpreters with programmatic code** — `node -e`, `python3 -c`, etc.
 *     running code like `require('fs').writeFileSync(...)` are not checked.
 *     The classifier only parses shell command tokens, not JS/Python/Perl code.
 *   - **xargs with stdin-fed package managers** — `printf install | xargs npm`
 *     bypasses because `xargs npm` alone has no verb args. The pipe feeds
 *     `install` at runtime via stdin; only the OS sandbox blocks the writes.
 */

type Verdict =
	| { ok: true }
	| { ok: false; reason: string };

// TEMP_DIR is resolved in temp-dir.ts — imported above so both
// readonly-bash and os-sandbox use the same canonical temp dir.

const GIT_IMMUTABLE = new Set([
	"diff", "log", "show", "status", "blame", "grep",
	"ls-files", "ls-tree", "merge-tree", "format-patch",
	"rev-parse", "rev-list", "cat-file", "for-each-ref",
	"merge-base", "fsck", "range-diff", "shortlog", "name-rev",
	"describe", "var", "version",
]);

const GIT_MUTABLE = new Set([
	"add", "am", "apply", "checkout", "cherry-pick", "clean",
	"clone", "commit", "fetch", "init", "merge", "mv", "pull", "push",
	"rebase", "reset", "restore", "revert", "rm", "switch",
]);

const GIT_MIXED: Record<string, (sub: string) => boolean> = {
	reflog: (sub) => sub === "" || sub === "show" || sub.startsWith("show "),
	branch: (sub) =>
		sub === "" || sub === "-l" || sub === "--show-current" ||
		/^--?[a-zA-Z-]*list(?:[=\s]|$)/.test(sub),
	tag: (sub) => sub === "" || sub === "-l" || /^--?[a-zA-Z-]*list(?:[=\s]|$)/.test(sub),
	remote: (sub) => sub === "" || sub === "-v" || sub === "show" || sub === "get-url",
	config: (sub) =>
		sub === "" || sub === "-l" || sub === "--list" ||
		sub === "--get" || sub.startsWith("--get ") || sub.startsWith("--get="),
	notes: (sub) => sub === "list" || sub === "show",
	stash: (sub) => sub === "list" || sub === "show",
	bisect: (sub) => sub === "log" || sub === "view" || sub === "",
	worktree: (sub) => sub === "list",
	submodule: (sub) => sub === "status",
};

// Interpreters whose inline-execution flag is recursively classified.
// node -c = syntax check only (non-executing); node -e executes code.
const INTERPRETER_EXEC_FLAGS: Record<string, string[]> = {
	node: ["-e"],
	bash: ["-c"], sh: ["-c"], zsh: ["-c"], dash: ["-c"], ksh: ["-c"],
	python3: ["-c"], python: ["-c"],
	perl: ["-e"],
	ruby: ["-e"],
};

const INTERPRETERS = new Set(Object.keys(INTERPRETER_EXEC_FLAGS));

// Package managers are blocked unconditionally — they mutate system state
// outside any single directory (npm install writes to node_modules, pip
// installs to site-packages, etc.). Temp-dir path checking is not meaningful.
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "pip", "pip3", "pipx", "apt", "apt-get", "brew", "cargo", "gem", "yum", "dnf", "pacman", "choco"]);

// Shells whose command strings this classifier cannot parse are blocked
// unconditionally. Matched on the basename so Windows paths such as
// C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe are caught.
const UNPARSABLE_SHELLS = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe"]);


/**
 * Classify a bash command string for readonly mode.
 *
 * Splits the command into shell-operator-separated segments (&&, ||, ;, |, &, \n),
 * checks each segment for command substitutions ($(...), backticks), write redirects (>),
 * and filesystem mutations. Blocks if any target path resolves outside the OS temp dir.
 *
 * When OS-level sandboxing (canUseOsSandbox()) is available, this serves as a fallback —
 * the kernel-enforced sandbox enforces the same write-restriction policy.
 *
 * @param cmd - Raw bash command string (may contain multiple segments via &&, ;, |, etc.)
 * @param cwd - Working directory for relative path resolution (defaults to process.cwd())
 * @returns {ok: true} if allowed, or {ok: false, reason} with explanation
 */

export function classifyBashCommand(cmd: string, cwd: string = process.cwd(), depth: number = 0, shellVars: ReadonlyMap<string, string> = new Map()): Verdict {
	if (depth > 10) return { ok: false, reason: "recursion depth exceeded in command classification" };
	const localVars = new Map(shellVars);
	for (const rawSegment of splitUnquotedShellSegments(cmd)) {
		const segment = rawSegment.trim();
		if (!segment) continue;

		for (const subcommand of extractCommandSubstitutions(segment)) {
			const nested = classifyBashCommand(subcommand, cwd, depth + 1, localVars);
			if (!nested.ok) {
				return { ok: false, reason: `command substitution blocked: ${nested.reason}` };
			}
		}

		const redirectTarget = getUnsafeWriteRedirectTarget(segment, cwd, localVars);
		if (redirectTarget) {
			return { ok: false, reason: `write redirect blocked outside temp dir: ${redirectTarget}` };
		}

		const mutationReason = getFilesystemMutationReason(segment, cwd, depth, localVars);
		if (mutationReason) return { ok: false, reason: mutationReason };

		for (const [name, value] of getStandaloneShellAssignments(segment, cwd, localVars)) {
			localVars.set(name, value);
		}
	}

	return { ok: true };
}

/**
 * Classify a shell segment's filesystem mutation risk.
 *
 * Extracts the command and its targets, then blocks if any target
 * resolves outside the OS temp dir. Handles git, sudo, env, eval/exec,
 * interpreter inline execution flags (-c/-e), dd of=, sed -i,
 * find -exec/-delete, perl/ruby -pi, and package managers.
 * Command names are compared case-insensitively (normalized via .toLowerCase()).
 * Unknown commands return null (allowed).
 */
// ── Command-specific mutation classifiers (one per command, ≤15 lines each) ──

/** Strip subshell parens: (rm file) → rm file, then classify recursively. */
function classifySubshellSegment(segment: string, cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (!segment.startsWith("(") || !segment.endsWith(")")) return null;
	const inner = segment.slice(1, -1).trim();
	return inner ? getFilesystemMutationReason(inner, cwd, depth, shellVars) : null;
}

/** eval/exec: recursively classify the remaining argument string. */
function classifyEvalExec(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "eval" && command !== "exec") return null;
	const inner = tokens.slice(1).map(stripMatchingQuotes).join(" ");
	const nested = classifyBashCommand(inner, cwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** sudo: classify the command after sudo flags. */
function classifySudo(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "sudo") return null;
	const nested = classifyBashCommand(tokens.slice(findSudoCommandIndex(tokens)).join(" "), cwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** env: handle env prefix including -S/--split-string. */
function classifyEnv(command: string, segment: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "env") return null;
	if (tokens.length > 1) {
		const nested = classifyBashCommand(tokens.slice(1).join(" "), cwd, depth + 1, shellVars);
		return nested.ok ? null : nested.reason;
	}
	// env with only flags (e.g., env -S "cmd") — extract -S value
	const sMatch = segment.match(/\benv\b.*?(?:-S|--split-string)\s+/);
	if (!sMatch) return null;
	const afterS = segment.slice(sMatch.index! + sMatch[0].length).trim();
	const nested = classifyBashCommand(stripMatchingQuotes(afterS), cwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** PowerShell and cmd: block unconditionally — their syntax is not parsed. */
function classifyUnparsableShell(command: string): string | null {
	const shell = stripMatchingQuotes(command).split(/[\\/]/).pop()!;
	if (!UNPARSABLE_SHELLS.has(shell)) return null;
	return `${shell} blocked: readonly cannot inspect commands run through ${shell}`;
}

/** git: classify subcommand via three-tier allowlist (immutable/mutable/mixed). */
function classifyGit(command: string, tokens: string[]): string | null {
	if (command !== "git") return null;
	return isSafeGitCommand(tokens.slice(1).join(" ")) ? null : "mutable git command blocked outside temp dir";
}

/** Interpreters with inline-execution flags — classify inline code recursively. */
function classifyInterpreter(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (!INTERPRETERS.has(command)) return null;
	const args = tokens.slice(1);
	for (const flag of INTERPRETER_EXEC_FLAGS[command]) {
		const idx = args.indexOf(flag);
		if (idx === -1 || idx + 1 >= args.length) continue;
		const nested = classifyBashCommand(stripMatchingQuotes(args[idx + 1]), cwd, depth + 1, shellVars);
		if (!nested.ok) return `${command} ${flag} blocked: ${nested.reason}`;
	}
	return null;
}

/** dd of= target check. */
function classifyDdOutput(segment: string, cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	const ddMatch = segment.match(/\bof=([^\s]+)/);
	if (!ddMatch || isTempPath(ddMatch[1], cwd, shellVars)) return null;
	return `dd output blocked outside temp dir: ${stripMatchingQuotes(ddMatch[1])}`;
}

/** wget -P/--download-dir outside temp — block. No-flag case falls through to classifyGenericMutation. */
function classifyWget(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "wget") return null;
	const wArgs = tokens.slice(1);
	const hasOutputFlag = wArgs.some((a) => a === "-O" || a.startsWith("-O") || a === "--output-document" || a.startsWith("--output-document="));
	if (hasOutputFlag) return null;
	const outputDir = getWgetOutputDir(tokens);
	if (outputDir && !isTempPath(outputDir, cwd, shellVars)) return `wget download dir blocked outside temp dir: ${outputDir}`;
	return null;
}

/** curl -O/--remote-name writes to disk — block unless cwd is temp. */
function classifyCurl(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "curl") return null;
	const { hasRemoteName, outputDir } = getCurlWriteTargets(tokens);
	if (hasRemoteName && !isTempPath(outputDir ?? ".", cwd, shellVars)) {
		return "curl blocked outside temp dir: current directory (use -o /tmp/... to write to temp)";
	}
	return null;
}

/** xargs: classify the command xargs would run + block targetless mutation commands. */
function classifyXargs(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "xargs") return null;
	const xArgs = tokens.slice(1);
	const XARGS_FLAGS_WITH_VALUE = new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s"]);
	let cmdStart = 0;
	while (cmdStart < xArgs.length) {
		if (XARGS_FLAGS_WITH_VALUE.has(xArgs[cmdStart])) { cmdStart += 2; continue; }
		if (xArgs[cmdStart].startsWith("-")) { cmdStart++; continue; }
		break;
	}
	if (cmdStart >= xArgs.length) return null;
	const xTokens = xArgs.slice(cmdStart);
	const nested = classifyBashCommand(xTokens.join(" "), cwd, depth + 1, shellVars);
	if (!nested.ok) return nested.reason;
	const xCmd = xTokens[0]?.toLowerCase();
	if (xCmd && getMutationTargets(xCmd, xTokens) !== null) return `xargs ${xCmd} blocked: mutation command via xargs`;
	return null;
}

/** Generic mutation: extract targets via getMutationTargets, block non-temp paths. */
function classifyGenericMutation(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	const paths = getMutationTargets(command, tokens);
	if (!paths) return null;
	for (const target of paths) {
		if (!isTempPath(target, cwd, shellVars)) return `${command} blocked outside temp dir: ${stripMatchingQuotes(target)}`;
	}
	return null;
}

// ── Main dispatcher ─────────────────────────────────────────────────

function getFilesystemMutationReason(segment: string, cwd: string, depth: number = 0, shellVars: ReadonlyMap<string, string> = new Map()): string | null {
	const tokens = getCommandTokens(segment);
	const command = tokens[0]?.toLowerCase();
	if (!command) return null;

	return classifySubshellSegment(segment, cwd, depth, shellVars)
		?? classifyEvalExec(command, tokens, cwd, depth, shellVars)
		?? classifySudo(command, tokens, cwd, depth, shellVars)
		?? classifyEnv(command, segment, tokens, cwd, depth, shellVars)
		?? classifyUnparsableShell(command)
		?? classifyGit(command, tokens)
		?? classifyInterpreter(command, tokens, cwd, depth, shellVars)
		?? classifyDdOutput(segment, cwd, shellVars)
		?? classifyPackageManager(command, tokens)
		?? classifyWget(command, tokens, cwd, shellVars)
		?? classifyCurl(command, tokens, cwd, shellVars)
		?? classifyXargs(command, tokens, cwd, depth, shellVars)
		?? classifyGenericMutation(command, tokens, cwd, shellVars);
}

/** Package manager mutation: block unconditionally regardless of target path. */
function classifyPackageManager(command: string, tokens: string[]): string | null {
	if (!PACKAGE_MANAGERS.has(command)) return null;
	if (!isPackageMutation(tokens.slice(1))) return null;
	const args = tokens.slice(1).join(" ");
	return buildReadonlyPackageManagerBlockReason(command, args);
}

function skipFlagValues(args: string[], flagsWithValues: Set<string>): string[] {
	const result: string[] = [];
	let i = 0;
	while (i < args.length) {
		if (flagsWithValues.has(args[i])) {
			i += 2; // skip flag + value
		} else {
			result.push(args[i]);
			i++;
		}
	}
	return result;
}

function getCurlWriteTargets(tokens: string[]): { hasRemoteName: boolean; outputs: string[]; outputDir: string | null } {
	const cArgs = tokens.slice(1);
	const outputs: string[] = [];
	let hasRemoteName = false;
	let outputDir: string | null = null;
	for (let i = 0; i < cArgs.length; i++) {
		if (cArgs[i] === "--") break; // end of options; remaining args are URLs
		if ((cArgs[i] === "-o" || cArgs[i] === "--output") && cArgs[i + 1]) {
			outputs.push(cArgs[i + 1]);
			i++;
			continue;
		}
		if (cArgs[i] === "--output-dir" && cArgs[i + 1]) {
			outputDir = cArgs[i + 1];
			i++;
			continue;
		}
		if (cArgs[i].startsWith("--output=")) {
			outputs.push(cArgs[i].slice("--output=".length));
			continue;
		}
		if (cArgs[i].startsWith("--output-dir=")) {
			outputDir = cArgs[i].slice("--output-dir=".length);
			continue;
		}
		if (cArgs[i].startsWith("-o") && cArgs[i].length > 2 && !cArgs[i].startsWith("--")) {
			outputs.push(cArgs[i].slice(2));
			continue;
		}
		if (cArgs[i] === "-O" || cArgs[i] === "--remote-name" || cArgs[i] === "--remote-name-all") {
			hasRemoteName = true;
			continue;
		}
		if (isCurlShortFlagBundleWithRemoteName(cArgs[i])) {
			hasRemoteName = true;
			continue;
		}
	}
	return { hasRemoteName, outputs, outputDir };
}

const CURL_VALUE_SHORT_FLAGS = new Set([
	// All 27 value-consuming short flags per curl --help all.
	// A, b, u, X pre-existed; C, K fixed -CO/-KO; remaining cover -dO, -oO, etc.
	"A", "b", "u", "X",
	"C", "K", "y", "Y", "z",
	"c", "d", "D", "e", "E", "F", "h", "H", "m", "o",
	"P", "Q", "r", "t", "T", "U", "w", "x",
]);

function isCurlShortFlagBundleWithRemoteName(token: string): boolean {
	if (!token.startsWith("-") || token.startsWith("--") || token.length <= 2) return false;
	const flags = token.slice(1);
	if (!/^[A-Za-z]+$/.test(flags)) return false;
	for (const flag of flags) {
		if (flag === "O") return true;
		if (CURL_VALUE_SHORT_FLAGS.has(flag)) return false;
	}
	return false;
}

/**
 * Extract the download directory from wget flags (-P / --directory-prefix).
 * Returns null when no directory flag is present.
 */
function getWgetOutputDir(tokens: string[]): string | null {
	const wArgs = tokens.slice(1);
	for (let i = 0; i < wArgs.length; i++) {
		if (wArgs[i] === "--") break;
		if (wArgs[i] === "-P" && wArgs[i + 1]) {
			return wArgs[i + 1];
		}
		if (wArgs[i].startsWith("-P") && wArgs[i].length > 2) {
			return wArgs[i].slice(2);
		}
		if (wArgs[i] === "--directory-prefix" && wArgs[i + 1]) {
			return wArgs[i + 1];
		}
		if (wArgs[i].startsWith("--directory-prefix=")) {
			return wArgs[i].slice("--directory-prefix=".length);
		}
	}
	return null;
}

// ── Mutation target extractors (one per command group, ≤20 lines each) ──

function getRmTargets(tokens: string[]): string[] {
	return nonOptionArgs(skipFlagValues(tokens.slice(1), new Set(["-s", "-o", "--io-size"])));
}

function getTruncateTargets(tokens: string[]): string[] {
	return nonOptionArgs(skipFlagValues(tokens.slice(1), new Set(["-s", "-r", "--reference", "-o", "--io-size"])));
}

function getTouchTargets(tokens: string[]): string[] {
	return nonOptionArgs(skipFlagValues(tokens.slice(1), new Set(["-t", "-d", "-r"])));
}

function getChmodTargets(tokens: string[]): string[] {
	const args = nonOptionArgs(tokens.slice(1));
	return args.slice(1);
}

function getCpTargets(tokens: string[]): string[] {
	const args = nonOptionArgs(tokens.slice(1));
	return args.length > 0 ? [args[args.length - 1]] : [];
}

function getTeeTargets(tokens: string[]): string[] {
	return nonOptionArgs(tokens.slice(1));
}

function getPerlRubyTargets(tokens: string[]): string[] | null {
	if (!tokens.slice(1).some((arg) => /^-p?i/.test(arg))) return null;
	return nonOptionArgs(tokens.slice(1));
}

/** Strip -e/--expression flag-value pairs from sed tokens, tracking if any were found. */
function filterSedExpressionTokens(sedTokens: string[]): { filtered: string[]; hasExpression: boolean } {
	const filtered: string[] = [];
	let hasExpression = false;
	let ti = 0;
	while (ti < sedTokens.length) {
		if (sedTokens[ti] === "-e" || sedTokens[ti] === "--expression") {
			ti += 2; hasExpression = true;
		} else if (sedTokens[ti].startsWith("-e")) {
			ti += 1; hasExpression = true; // -e'expr' concatenated form
		} else if (sedTokens[ti].startsWith("--expression=")) {
			ti += 1; hasExpression = true;
		} else {
			filtered.push(sedTokens[ti]); ti++;
		}
	}
	return { filtered, hasExpression };
}

/** sed -i target extraction with -e/--expression and backup-extension handling. */
function getSedTargets(tokens: string[]): string[] | null {
	if (!tokens.slice(1).some((arg) => arg === "-i" || arg.startsWith("-i"))) return null;
	const { filtered, hasExpression } = filterSedExpressionTokens(tokens.slice(1));
	const args = nonOptionArgs(filtered);
	const extArg = args.length > 0 ? stripMatchingQuotes(args[0]) : "";
	const hasBackupExt = args.length > 0 && (extArg === "" || /^[a-zA-Z0-9._-]{1,10}$/.test(extArg));
	if (hasBackupExt) return hasExpression ? (extArg === "" ? args.slice(1) : args) : args.slice(2);
	return hasExpression ? args : args.slice(1);
}

/** wget target extraction from -O/--output-document flags. */
function getWgetTargets(tokens: string[]): string[] {
	const wArgs = tokens.slice(1);
	let outputTarget: string | null = null;
	for (let i = 0; i < wArgs.length; i++) {
		if (wArgs[i] === "-O" && wArgs[i + 1]) { outputTarget = wArgs[i + 1]; i++; continue; }
		if (wArgs[i].startsWith("-O") && wArgs[i].length > 2) { outputTarget = wArgs[i].slice(2); continue; }
		if (wArgs[i] === "--output-document" && wArgs[i + 1]) { outputTarget = wArgs[i + 1]; i++; continue; }
		if (wArgs[i].startsWith("--output-document=")) { outputTarget = wArgs[i].slice("--output-document=".length); }
	}
	if (outputTarget !== null) return stripMatchingQuotes(outputTarget) === "-" ? ["/dev/null"] : [outputTarget];
	const outputDir = getWgetOutputDir(tokens);
	if (outputDir !== null) return [outputDir];
	return ["."]; // safety net — unreachable via getFilesystemMutationReason
}

/** curl target extraction from -o/--output and -O/--remote-name flags. */
function getCurlTargets(tokens: string[]): string[] | null {
	const { hasRemoteName, outputs, outputDir } = getCurlWriteTargets(tokens);
	const mapped = outputs.map((o) => stripMatchingQuotes(o) === "-" ? "/dev/null" : o);
	const remoteNameTarget = outputDir ?? ".";
	if (mapped.length > 0) return hasRemoteName ? [...mapped, remoteNameTarget] : mapped;
	if (hasRemoteName) return [remoteNameTarget];
	return null;
}

// ── Main dispatcher ─────────────────────────────────────────────────

function getMutationTargets(command: string, tokens: string[]): string[] | null {
	switch (command) {
		case "rm": case "rmdir": case "unlink": case "mkdir": return getRmTargets(tokens);
		case "truncate": return getTruncateTargets(tokens);
		case "touch": return getTouchTargets(tokens);
		case "chmod": case "chown": case "chgrp": return getChmodTargets(tokens);
		case "cp": case "mv": case "install": case "ln": return getCpTargets(tokens);
		case "tee": return getTeeTargets(tokens);
		case "sed": return getSedTargets(tokens);
		case "perl": case "ruby": return getPerlRubyTargets(tokens);
		case "find": return getFindMutationTargets(tokens.slice(1));
		case "wget": return getWgetTargets(tokens);
		case "curl": return getCurlTargets(tokens);
		default: return null;
	}
}

function getFindMutationTargets(args: string[]): string[] | null {
	// Skip glob-pattern args (e.g., -name '*.txt') — these cannot be filesystem roots.
	const roots = args.filter((arg) => arg && !arg.startsWith("-") && !/[*?{}()\[\]~]/.test(arg));
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-delete") return roots.length > 0 ? roots : ["."];
		if (["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) return roots.length > 0 ? roots : ["."];
		if (["-fprintf", "-fprint", "-fprint0", "-fls"].includes(arg)) {
			const output = args[i + 1];
			return output ? [output] : ["."];
		}
	}
	return null;
}

function isPackageMutation(args: string[]): boolean {
	// Match individual tokens against known package-mutation verbs.
	// Token-level matching (vs. substring-on-joined-string) avoids false
	// positives when a path or argument contains a verb word (install-sh, etc.).
	const VERBS = new Set(["install", "uninstall", "update", "upgrade", "ci", "link", "publish", "add", "remove", "reinstall", "tap", "untap", "download", "build-dep", "i", "un", "ad", "rm", "up", "in", "rb"]);
	return args.some((a) => VERBS.has(a.toLowerCase()));
}

function findSudoCommandIndex(tokens: string[]): number {
	const FLAGS_WITH_VALUE = new Set(["-u", "-g", "-p", "-C", "-T", "-h"]);
	let i = 1;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === "--") return i + 1;
		if (!token.startsWith("-")) return i;
		if (FLAGS_WITH_VALUE.has(token)) i += 2;
		else i += 1;
	}
	return tokens.length;
}

/**
 * Extract the command tokens from a shell segment, stripping env-prefixes,
 * env-var assignments, and the `command` builtin wrapper.
 *
 * The `env` prefix is handled specially: env flags with values (-u, --unset,
 * -S, -g) consume the next token as their value, and env-var assignments
 * (KEY=value) before the real command are stripped.
 */
function getCommandTokens(segment: string): string[] {
	const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	let i = 0;

	if (tokens[i] === "env") {
		i++;
		// env -u VAR and -S "string" take a value — consume as flag-value pairs
		const ENV_FLAGS_WITH_VALUE = new Set(["-u", "--unset", "-S", "--split-string", "-g", "--group"]);
		while (i < tokens.length && tokens[i].startsWith("-")) {
			if (ENV_FLAGS_WITH_VALUE.has(tokens[i])) {
				i += 2; // skip flag + its value
			} else {
				i++; // valueless flag
			}
		}
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
		// Skip -- separator between env assignments and the command
		if (i < tokens.length && tokens[i] === "--") i++;
		if (i >= tokens.length) return ["env"];
	}

	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	if (tokens[i] === "command") i++;
	return tokens.slice(i);
}

function nonOptionArgs(args: string[]): string[] {
	const result: string[] = [];
	let stopOptions = false;
	for (const arg of args) {
		if (!stopOptions && arg === "--") {
			stopOptions = true;
			continue;
		}
		if (!stopOptions && arg.startsWith("-") && arg !== "-") continue;
		result.push(arg);
	}
	return result;
}

function isSafeGitCommand(rest: string): boolean {
	const trimmed = rest.trim();
	if (!trimmed) return false;

	const tokens = trimmed.split(/\s+/);
	const FLAGS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
	let subcommand = "";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (FLAGS_WITH_VALUE.has(token)) { i++; continue; }
		if (token.startsWith("-")) continue;
		subcommand = token;
		break;
	}

	if (!subcommand) return false;
	if (GIT_IMMUTABLE.has(subcommand)) return true;
	if (GIT_MUTABLE.has(subcommand)) return false;
	const mixed = GIT_MIXED[subcommand];
	if (!mixed) return false;
	const afterSub = trimmed.slice(trimmed.indexOf(subcommand) + subcommand.length).trim();
	return mixed(afterSub);
}

function stripMatchingQuotes(token: string): string {
	if (
		(token.startsWith('"') && token.endsWith('"')) ||
		(token.startsWith("'") && token.endsWith("'"))
	) {
		return token.slice(1, -1);
	}
	return token;
}

/**
 * Expand shell variable references ($VAR, ${VAR}) in a raw path string.
 * Looks up the variable name in the provided map first, then falls back
 * to process.env. Returns null if the path contains no variable reference
 * or the variable is unknown.
 */
function expandShellVariable(rawPath: string, shellVars: ReadonlyMap<string, string>, visited: Set<string> = new Set()): string | null {
	const braceMatch = rawPath.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:=)([^}]*))?\}(.*)$/);
	if (braceMatch) {
		const [, varName, operator, fallback = "", suffix] = braceMatch;
		if (visited.has(varName)) return null;
		visited.add(varName);
		const value = shellVars.get(varName) ?? process.env[varName];
		if (value !== undefined && value !== "") return value + suffix;
		if (operator === ":-" || operator === ":=") return fallback + suffix;
		return null;
	}
	const plainMatch = rawPath.match(/^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
	if (plainMatch) {
		const varName = plainMatch[1];
		if (visited.has(varName)) return null;
		visited.add(varName);
		const value = shellVars.get(varName) ?? process.env[varName];
		return value !== undefined && value !== "" ? value + plainMatch[2] : null;
	}
	return null;
}

/**
 * Extract standalone shell variable assignments from a segment.
 * Handles: VAR=value, export VAR=value, declare -r VAR=value, etc.
 * Declaration keywords (export/declare/typeset/local/readonly) and their
 * flags are skipped before looking for assignments.
 * Returns empty map if any non-keyword, non-flag token is not an assignment.
 * Special-cases $(mktemp) to a synthetic temp-dir path.
 */
function getStandaloneShellAssignments(segment: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map()): Map<string, string> {
	const assignments = new Map<string, string>();
	let tokens: string[] = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	if (tokens.length === 0) return assignments;

	// Skip declaration keywords and their flags (export -x, declare -r, etc.)
	const DECL_KEYWORDS = new Set(["export", "declare", "typeset", "local", "readonly"]);
	if (tokens.length > 0 && DECL_KEYWORDS.has(tokens[0]!)) {
		tokens = tokens.slice(1) as string[];
		// Skip flags after the keyword (e.g., declare -r -x VAR=val)
		while (tokens.length > 0 && tokens[0]!.startsWith("-")) {
			tokens = tokens.slice(1) as string[];
		}
	}
	for (let i = 0; i < tokens.length; i++) {
		const match = tokens[i]?.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		const [, name, initialRawValue] = match;
		let rawValue = initialRawValue;
		const quoteWrapped = rawValue.startsWith('"');
		const substitutionStart = quoteWrapped ? rawValue.slice(1) : rawValue;

		// Tokenization splits command substitutions on spaces. Rejoin a standalone
		// assignment value until the substitution closes so mktemp templates are visible.
		if (substitutionStart.startsWith("$(")) {
			let depth = 1;
			for (const ch of substitutionStart.slice(2)) {
				if (ch === "(") depth++;
				if (ch === ")") depth--;
			}
			while ((depth > 0 || (quoteWrapped && !rawValue.endsWith('"'))) && i + 1 < tokens.length) {
				rawValue += ` ${tokens[++i]}`;
				for (const ch of tokens[i]!) {
					if (ch === "(") depth++;
					if (ch === ")") depth--;
				}
			}
		} else if (substitutionStart.startsWith("`")) {
			while ((!rawValue.endsWith("`") || (quoteWrapped && !rawValue.endsWith('`"'))) && i + 1 < tokens.length) {
				rawValue += ` ${tokens[++i]}`;
			}
		}

		const value = stripMatchingQuotes(rawValue);
		const assignmentVars = new Map(shellVars);
		for (const [assignedName, assignedValue] of assignments) assignmentVars.set(assignedName, assignedValue);
		const syntheticMktempPath = getSafeMktempSyntheticPath(value, cwd, assignmentVars, name);
		if (syntheticMktempPath) {
			assignments.set(name, syntheticMktempPath);
			continue;
		}
		assignments.set(name, value);
	}
	return assignments;
}

function unwrapCommandSubstitution(rawValue: string): string | null {
	const normalized = stripMatchingQuotes(rawValue);
	if (normalized.startsWith("$(") && normalized.endsWith(")")) return normalized.slice(2, -1);
	if (normalized.startsWith("`") && normalized.endsWith("`")) return normalized.slice(1, -1);
	return null;
}

function getSafeMktempSyntheticPath(rawValue: string, cwd: string, shellVars: ReadonlyMap<string, string>, name: string): string | null {
	const innerCmd = unwrapCommandSubstitution(rawValue);
	if (!innerCmd) return null;

	const innerTokens = getCommandTokens(innerCmd);
	if (innerTokens[0] !== "mktemp") return null;

	let template: string | null = null;
	let tmpdirBase: string | null = null;
	const args = innerTokens.slice(1);

	for (let i = 0; i < args.length; i++) {
		const arg = stripMatchingQuotes(args[i]!);
		if (!arg) continue;
		if (arg === "--") {
			template = stripMatchingQuotes(args[i + 1] ?? "");
			break;
		}
		if (arg === "-p") {
			tmpdirBase = stripMatchingQuotes(args[i + 1] ?? "");
			if (!tmpdirBase) return null;
			i++;
			continue;
		}
		if (arg.startsWith("-p") && arg.length > 2) {
			tmpdirBase = stripMatchingQuotes(arg.slice(2));
			continue;
		}
		if (arg === "-t") {
			if (process.platform !== "darwin") return null;
			template = stripMatchingQuotes(args[i + 1] ?? "");
			if (!template) return null;
			tmpdirBase = TEMP_DIR;
			i++;
			continue;
		}
		if (arg.startsWith("-t") && arg.length > 2) {
			if (process.platform !== "darwin") return null;
			template = stripMatchingQuotes(arg.slice(2));
			if (!template) return null;
			tmpdirBase = TEMP_DIR;
			continue;
		}
		if (arg === "--tmpdir") {
			// Bare --tmpdir defaults to TEMP_DIR, but with two following positionals
			// the first is an explicit DIR even if relative, so validate it later.
			const next = stripMatchingQuotes(args[i + 1] ?? "");
			const nextNext = stripMatchingQuotes(args[i + 2] ?? "");
			if (next && !next.startsWith("-") && nextNext && !nextNext.startsWith("-")) {
				tmpdirBase = next;
				i++;
				continue;
			}
			if (next && !next.startsWith("-") && (next.startsWith("/") || next.startsWith("~") || next.startsWith("$") || next.includes("/") || next === "." || next === "..")) {
				tmpdirBase = next;
				i++;
				continue;
			}
			tmpdirBase = TEMP_DIR;
			continue;
		}
		if (arg.startsWith("--tmpdir=")) {
			tmpdirBase = stripMatchingQuotes(arg.slice("--tmpdir=".length)) || TEMP_DIR;
			continue;
		}
		if (arg === "--suffix") {
			i++;
			continue;
		}
		if (arg.startsWith("--suffix=")) continue;
		if (arg.startsWith("-")) continue;
		template = arg;
	}

	if (tmpdirBase !== null) {
		if (!isTempPath(tmpdirBase, cwd, shellVars)) return null;
		if (!template) return path.join(TEMP_DIR, `.pi-mktemp-${name.toLowerCase()}`);
		if (path.isAbsolute(template)) return null;
		const joinedTemplate = path.join(tmpdirBase, template);
		return isTempPath(joinedTemplate, cwd, shellVars)
			? path.join(TEMP_DIR, `.pi-mktemp-${name.toLowerCase()}`)
			: null;
	}

	if (template && !isTempPath(template, cwd, shellVars)) return null;
	return path.join(TEMP_DIR, `.pi-mktemp-${name.toLowerCase()}`);
}

/**
 * Expand a glob pattern to include hidden-file (dotfile) variants.
 *
 * WORKAROUND: `node:fs.globSync` ignores the `dot: true` option on
 * Node.js v24+ — it silently skips dotfiles. This function explicitly
 * generates `.*` variants for each wildcard segment so hidden files
 * are matched.
 */
function expandHiddenGlobPatterns(pattern: string): string[] {
	const segments = pattern.split("/");
	const options = segments.map((segment) => {
		if (segment === "**") return [segment, "**/.*", "**/.*/**"];
		// Literal or already-dotfile segments need no expansion.
		// Brace patterns ({a,b}) get a redundant .{a,b} variant — harmless.
		if (!/[*?{}\[\]]/.test(segment) || segment.startsWith(".")) return [segment];
		return [segment, `.${segment}`];
	});
	const patterns = new Set<string>();
	const visit = (index: number, built: string[]) => {
		if (index === options.length) return void patterns.add(built.join("/"));
		for (const option of options[index]) visit(index + 1, [...built, option]);
	};
	visit(0, []);
	return [...patterns];
}

function isTempPath(rawPath: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map(), visited: Set<string> = new Set()): boolean {
	const normalized = stripMatchingQuotes(rawPath);
	if (!normalized || normalized === "/dev/null" || /^&\d+$/.test(normalized)) return true;

	// Expand ~ and ~/path to the home directory (os.homedir()).
	// ~user/path is not resolvable without getpwuid — block conservatively.
	if (normalized.startsWith("~")) {
		if (normalized === "~" || normalized.startsWith("~/")) {
			const expanded = normalized.replace(/^~/, os.homedir());
			return isTempPath(expanded, cwd);
		}
		return false; // ~user/path cannot be resolved safely
	}

	const expandedVar = expandShellVariable(normalized, shellVars, visited);
	if (expandedVar !== null && expandedVar !== normalized) {
		return isTempPath(expandedVar, cwd, shellVars, visited);
	}

	// Unresolved dynamic paths are unsafe: if a shell var expansion still leaves
	// command/process substitution or an unknown $VAR, we cannot prove temp-dir safety.
	if (/`|\$\(|<\(/.test(normalized) || /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(normalized)) {
		return false;
	}

	if (/[*?{}\[\]]/.test(normalized)) {
		// Glob pattern - resolve against cwd and check each target individually.
		// Expand hidden variants explicitly because node:fs globSync skips dotfiles.
		// Empty glob (no matches) is allowed — no files to mutate.
		try {
			const matches = globSync(expandHiddenGlobPatterns(normalized), { cwd });
			if (matches.length === 0) return true;
			return matches.every((m) => isTempPath(m, cwd));
		} catch {
			return false;
		}
	}
	const absolute = path.resolve(cwd, normalized);
	// Resolve symlinks so /tmp/link -> /etc/passwd is correctly classified as non-temp.
	// Walking up to the nearest existing ancestor handles new files inside symlinked dirs.
	const real = resolveRealPath(absolute);
	const relative = path.relative(TEMP_DIR, real);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Read the file redirect target starting at position `start`.
 *
 * Handles quoted targets (single/double quotes) and backslash escapes.
 * Scope: > (write), >> (append), >| (noclobber override). Heredoc redirects
 * (<<EOF) are stdin, not file writes, and are not checked by this function.
 */
function readRedirectTarget(
	cmd: string,
	start: number,
): { target: string; end: number } {
	let i = start;
	while (i < cmd.length && /\s/.test(cmd[i])) i++;
	if (i >= cmd.length) return { target: "", end: i };

	const first = cmd[i];
	if (first === '"' || first === "'") {
		const quote = first;
		let target = quote;
		i++;
		while (i < cmd.length) {
			const ch = cmd[i];
			target += ch;
			if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
				i++;
				target += cmd[i];
				continue;
			}
			if (ch === quote) {
				i++;
				break;
			}
			i++;
		}
		return { target, end: i };
	}

	let target = "";
	while (i < cmd.length) {
		const ch = cmd[i];
		if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "\n") break;
		if (ch === "&" && target !== "") break;
		target += ch;
		i++;
	}
	return { target, end: i };
}

/**
 * Detect write redirects (>) to unsafe targets outside the temp dir.
 *
 * Scope: > (write), >> (append), >| (noclobber override), 2> (stderr), &> (combined).
 * Heredoc redirect targets (<<EOF) are stdin, not file writes, and are not checked.
 * This is a best-effort inspection layer, not a security sandbox.
 */
function getUnsafeWriteRedirectTarget(cmd: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map()): string | null {
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (quote) { if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch !== ">") continue;

		const next = cmd[i + 1];
		// >&N = fd redirect (e.g., 2>&1) — not a file write, skip
		if (next === "&" && /^[\d-]$/.test(cmd[i + 2] ?? "")) continue;
		// >= is the comparison operator (e.g., in [[ or node -e), not a write redirect
		if (next === "=") continue;
		// >& = combined stdout+stderr redirect to a file, treat as 2-char operator
		const opLen = next === ">" || next === "|" || next === "&" ? 2 : 1;
		const { target, end } = readRedirectTarget(cmd, i + opLen);
		if (!isTempPath(target, cwd, shellVars)) return stripMatchingQuotes(target) || "(unknown target)";
		i = Math.max(i, end - 1);
	}

	return null;
}

/**
 * Split a shell command string into segments separated by shell operators.
 *
 * Handles quoted strings (single/double quotes) and backslash escapes.
 * Shell operator handling:
 *   ;  — sequential (segment boundary)
 *   |  — pipe (segment boundary)
 *   &  — background (segment boundary, but >& and <& are redirects not separators)
 *   && — AND (segment boundary)
 *   || — OR (segment boundary)
 *   \n — newline (segment boundary)
 * The >| and >& operators are consumed as part of the preceding segment.
 */
function splitUnquotedShellSegments(cmd: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		const next = cmd[i + 1];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		const prev = current[current.length - 1];
		if (ch === "|" && prev === ">") {
			current += ch;
			continue;
		}
		if (ch === "&" && (prev === ">" || prev === "<" || next === ">")) {
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			segments.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments;
}

/**
 * Extract command substitution targets ($(...) and backticks) from a shell line.
 *
 * Uses simple depth-tracked matching. This is a best-effort guard — nested
 * nesting, backslash escapes, and quote-aware tracking are intentionally
 * skipped for simplicity since this is not a security boundary.
 */
function extractCommandSubstitutions(line: string): string[] {
	const commands: string[] = [];

	// Backtick substitutions: `` `cmd` ``
	const backtickRe = /`([^`]*)`/g;
	let match: RegExpExecArray | null;
	while ((match = backtickRe.exec(line)) !== null) {
		if (match[1].trim()) commands.push(match[1].trim());
	}

	// $() substitutions: handles arbitrary nesting via depth counter
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "$" || line[i + 1] !== "(") continue;
		let depth = 1;
		let cmd = "";
		let j = i + 2;
		for (; j < line.length && depth > 0; j++) {
			if (line[j] === "(" && line[j - 1] === "$") depth++;
			else if (line[j] === ")") depth--;
			if (depth > 0) cmd += line[j];
		}
		if (cmd.trim()) commands.push(cmd.trim());
		i = j;
	}

	// <() process substitutions: extract inner command for recursive classification.
	// Handles one level of nesting inside <().
	const procSubRe = /<\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
	let procMatch: RegExpExecArray | null;
	while ((procMatch = procSubRe.exec(line)) !== null) {
		if (procMatch[1].trim()) commands.push(procMatch[1].trim());
	}

	return commands;
}

// ── Shared readonly bash guard (consumed by parent tool_call hook and child spawnHook) ──

export type ReadonlyBashGuardResult =
	| { action: "allow" }
	| { action: "block"; reason: string }
	| { action: "sandbox"; sandboxedCommand: string };

/**
 * Apply the readonly bash guard to a command.
 *
 * L1: OS-level sandboxing — wraps command if available (sandbox-exec / bwrap).
 * L2: Command-pattern inspection — blocks if OS sandbox unavailable.
 *
 * @param cmd - Raw bash command string
 * @param cwd - Working directory for path resolution
 * @returns Structured result: allow, block (with reason), or sandbox (with wrapped command)
 */
export function applyReadonlyBashGuard(cmd: unknown, cwd: string): ReadonlyBashGuardResult {
	if (typeof cmd !== "string") {
		return {
			action: "block",
			reason: buildReadonlyBashBlockReason(READONLY_INVALID_BASH_COMMAND_REASON, "<invalid input>"),
		};
	}

	// L1: OS sandbox (primary enforcement when available)
	if (canUseOsSandbox()) {
		const verdict = classifyBashCommand(cmd, cwd);
		if (verdict.ok === false) {
			return { action: "block", reason: buildReadonlyBashBlockReason(verdict.reason, cmd) };
		}
		return { action: "sandbox", sandboxedCommand: wrapCommandWithOsSandbox(cmd) };
	}

	// L2: Pattern inspection fallback (no sandbox available)
	const verdict = classifyBashCommand(cmd, cwd);
	if (verdict.ok === false) {
		return { action: "block", reason: buildReadonlyBashBlockReason(verdict.reason, cmd) };
	}
	return { action: "allow" };
}
