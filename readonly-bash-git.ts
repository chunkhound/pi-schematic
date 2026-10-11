import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { resolveRealPath } from "./resolve-path.js";
import {
	stripMatchingQuotes,
	decodeShellWord,
	decodeShellOperand,
	splitFlagValue,
	isTempLiteralPath,
} from "./readonly-shell-utils.js";
import { FAIL_CLOSED_HINT } from "./notifications.js";
import { expandGitShortBundlesArgs } from "./readonly-bash-git-options.js";
import type { GitBundleOptions, GitExpansion } from "./readonly-bash-git-options.js";

// Only quoted dynamic message values can retain this sentinel: their one-word arity is
// proven, and commit's message option consumes them as data, never as options or paths.
const UNPROVEN_GIT_OPERAND = "\u0000";

const GIT_IMMUTABLE = new Set([
	"diff", "log", "show", "status", "blame", "grep",
	"ls-files", "ls-tree", "format-patch",
	"rev-parse", "rev-list", "cat-file", "for-each-ref",
	"merge-base", "fsck", "range-diff", "shortlog", "name-rev",
	"describe", "var", "version",
	// Pure reads that print to stdout. Destination options they do accept (`--output` on
	// the log-family) are path-checked by gitFlagDestinations; exec options are denied.
	"check-ignore", "check-attr", "check-ref-format", "show-ref",
	"ls-remote", "cherry", "whatchanged", "annotate",
]);

const GIT_MUTABLE = new Set([
	"add", "am", "apply", "checkout", "cherry-pick", "clean",
	"clone", "commit", "fetch", "init", "merge", "merge-tree", "mv", "pull", "push",
	"rebase", "reset", "restore", "revert", "rm", "switch", "gc",
]);

const GIT_BRANCH_LIST_FLAGS = new Set([
	"-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-l", "--list",
	"--show-current", "--color", "--no-color", "-i", "--ignore-case",
	"--merged", "--no-merged", "--contains", "--no-contains",
]);

function isSafeBranchQuery(tokens: string[]): boolean {
	const listsPatterns = tokens.includes("--list") || tokens.includes("-l");
	return tokens.every((token) =>
		GIT_BRANCH_LIST_FLAGS.has(token) ||
		token.startsWith("--sort=") || token.startsWith("--format=") ||
		token.startsWith("--merged=") || token.startsWith("--no-merged=") ||
		token.startsWith("--contains=") || token.startsWith("--no-contains=") ||
		token.startsWith("--points-at=") ||
		(listsPatterns && !token.startsWith("-"))
	);
}

// Subcommand action words parsed from the positional tail: empty/usage prints are read-only,
// named read actions stay immutable, anything else (a write action) is mutable.
const GIT_ACTION_READ = (sub: string, reads: readonly string[]): boolean =>
	sub === "" || reads.some((action) => sub === action || sub.startsWith(action + " "));

const GIT_MIXED: Record<string, (sub: string) => boolean> = {
	reflog: (sub) => sub === "" || sub === "show" || sub.startsWith("show "),
	tag: (sub) => sub === "" || sub === "-l" || sub.startsWith("-l ") || /^--?[a-zA-Z-]*list(?:[=\s]|$)/.test(sub),
	remote: (sub) =>
		sub === "" || sub === "-v" || sub.startsWith("show") || sub.startsWith("get-url"),
	notes: (sub) => sub === "list" || sub === "show" || sub.startsWith("show "),
	stash: (sub) => sub === "list" || sub === "show" || sub.startsWith("show "),
	worktree: (sub) => sub === "list" || sub.startsWith("list "),
	bundle: (sub) => GIT_ACTION_READ(sub, ["list-heads", "verify"]),
	maintenance: (sub) => GIT_ACTION_READ(sub, ["list"]),
	"sparse-checkout": (sub) => GIT_ACTION_READ(sub, ["list"]),
};

/** git: allow read-only subcommands; path-check the write roots of mutable ones. */
export function classifyGit(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "git") return null;
	// One classification pass can ask the same config question repeatedly (worktree, URL
	// rewrites, destination repositories); cache probes for the pass, never across commands.
	// A nested classification (via command substitution) clears the cache mid-pass; that is
	// accepted — re-probing is always safe, only slower. Do not "fix" this with ref-counting.
	gitConfigurationCache.clear();
	if (tokens.length === 1) return null; // bare `git` prints usage — read-only
	const gate = blockedGitEnvironment(shellVars);
	if (gate) return gate;
	try { return classifyGitInvocation(tokens, cwd, shellVars); }
	catch (error) {
		return `unsupported git write location blocked: ${error instanceof Error ? error.message : String(error)}${FAIL_CLOSED_HINT}`;
	}
}

/** Parsing and repository discovery share one visible, fail-closed error boundary. */
function classifyGitInvocation(tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	const decoded = tokens.map((token) => decodeGitToken(token, shellVars));
	if (decoded.some((token) => token === null)) return `unsupported git option name blocked${FAIL_CLOSED_HINT}`;
	const parsed = parseGitInvocation(decoded.filter((token): token is string => token !== null), cwd);
	if (!parsed) return `unsupported git global option or configuration blocked${FAIL_CLOSED_HINT}`;
	if (parsed.kind === "global-only") return null;
	const invocation = parsed.invocation;
	const kind = gitSubcommandKind(invocation.subcommand, invocation.args);
	// Unmodeled subcommands fail closed everywhere, not merely outside temp: their implicit
	// write destinations (e.g. credential-store -> $HOME/.git-credentials) cannot be proven,
	// so a path-check of operands and repository roots would falsely claim confinement.
	if (kind === "unknown") return `unrecognized git command blocked: ${invocation.subcommand}${FAIL_CLOSED_HINT}`;
	const blocked = prepareGitOptions(invocation, kind);
	if (blocked) return blocked;
	// Help prints and exits, so it writes nothing: skip the write-root analysis that the
	// destination flags of mutable subcommands (clone/init default to cwd) would otherwise block.
	return gitHelpInvocation(invocation) ? null : classifyGitRoots(invocation, kind, shellVars);
}

/** Expand bundles before checking arity so their message and destination flags stay visible.
 * Unsupported-option blocks name the offending flag so the caller sees what failed closed. */
function prepareGitOptions(invocation: GitInvocation, kind: "immutable" | "mutable"): string | null {
	const expand = kind === "mutable" ? expandGitShortBundles : expandImmutableShortBundles;
	const expansion = expand(invocation.subcommand, invocation.args);
	if (!expansion.ok) return gitOptionBlock(invocation.subcommand, expansion.blocked);
	invocation.args = expansion.args;
	if (!provenGitOperands(invocation)) return `unproven git operand or option arity blocked${FAIL_CLOSED_HINT}`;
	const blocked = supportedGitOptions(invocation, kind);
	return blocked === null ? null : gitOptionBlock(invocation.subcommand, blocked);
}

function gitOptionBlock(subcommand: string, flag: string): string {
	return `unsupported git option blocked: ${subcommand} ${flag}${FAIL_CLOSED_HINT}`;
}

function classifyGitRoots(invocation: GitInvocation, kind: "immutable" | "mutable", shellVars: ReadonlyMap<string, string>): string | null {
	const roots = getGitWriteRoots(invocation, kind, shellVars);
	if (!roots) return `unsupported git write location blocked: ${invocation.subcommand}${FAIL_CLOSED_HINT}`;
	for (const root of roots) {
		if (!isTempLiteralPath(root.path, invocation.base)) {
			const subject = kind === "mutable" ? "mutable git command" : root.metadata ? "git metadata location" : `git ${invocation.subcommand} output`;
			return `${subject} blocked outside temp dir: ${stripMatchingQuotes(root.path)}`;
		}
	}
	return null;
}

/** Parsed `git [global-flags] <subcommand> <args...>` with its resolved path anchors. */
type GitPathFlags = { base: string; gitDir: string | null; workTree: string | null };
type GitInvocation = GitPathFlags & { subcommand: string; args: string[] };

/** A write root plus whether it is a pinned git metadata location (`--git-dir`/`GIT_DIR`) rather
 * than a subcommand's own destination; the flag selects the outside-temp block wording. */
type GitWriteRoot = { path: string; metadata: boolean };

/** Assignment quote context is unavailable; dynamic/escaped values cannot prove a path. */
function gitEnvironmentOperand(name: string, vars: ReadonlyMap<string, string>): string | null | undefined {
	const supplied = vars.get(name);
	if (supplied === undefined) return process.env[name];
	return /[$`\\*?{}\[\]"']/.test(supplied) || supplied.startsWith("~") ? null : supplied;
}

const GIT_POINTER_ENV = new Set(["GIT_DIR", "GIT_COMMON_DIR"]);

/** Resolve one metadata env value with the same semantics as its flag counterpart.
 * GIT_DIR/GIT_COMMON_DIR name repository metadata, so follow gitdir: pointer files exactly like
 * the --git-dir flag and the mutable GIT_DIR do — one env value keeps one morphology.
 * GIT_INDEX_FILE is a plain file path, never a repository pointer. */
function resolveGitEnvironmentValue(name: string, value: string, base: string): string | null {
	return GIT_POINTER_ENV.has(name) ? resolveGitDir(value, base) : resolveGitPath(value, base);
}

/** Shell operands are decoded at entry. Metadata/config values are data, never shell source. */
function resolveGitPath(value: string, base: string): string | null {
	// The dynamic-operand sentinel (and any NUL) cannot name a path: fail closed here so it
	// never reaches the filesystem, while the surrounding flag still parses as data.
	if (value.includes(UNPROVEN_GIT_OPERAND)) return null;
	return value ? path.resolve(base, value) : null;
}

/** Decode option names as Bash does, retaining flags when dynamic values become sentinels.
 * Otherwise escaped names or unproven attached values could hide writes/execution from vetting. */
function decodeGitToken(token: string, vars: ReadonlyMap<string, string>): string | null {
	if (token.startsWith("--")) {
		const eq = token.indexOf("=");
		const name = decodeShellWord(eq > 0 ? token.slice(0, eq) : token);
		if (name === null) return null;
		if (eq > 0) {
			const value = decodeGitOperand(token.slice(eq + 1), vars);
			return value === null ? null : `${name}=${value}`;
		}
		return name;
	}
	const short = token.match(/^-([A-Za-z])(.*)$/);
	if (short?.[2]) {
		const value = decodeGitOperand(short[2], vars);
		return value === null ? null : `-${short[1]}${value}`;
	}
	return decodeGitOperand(token, vars);
}

/** Double quotes prove one argument even when its value is unknown; unquoted expansion does not. */
function decodeGitOperand(token: string, vars: ReadonlyMap<string, string>): string | null {
	const value = decodeShellOperand(token, vars);
	if (value !== null) return value;
	return /^"(?:\\.|[^"\\])*"$/.test(token) ? UNPROVEN_GIT_OPERAND : null;
}

/** Unknown values are permitted only where a proven message option consumes one inert word. */
function provenGitOperands(invocation: GitInvocation): boolean {
	const values = GIT_VALUE_FLAGS[invocation.subcommand] ?? NO_GIT_VALUE_FLAGS;
	for (let i = 0; i < invocation.args.length; i++) {
		const token = invocation.args[i]!;
		if (token === "--") return invocation.args.slice(i + 1).every((arg) => !arg.includes(UNPROVEN_GIT_OPERAND));
		const [flag, inline] = splitGitDestinationFlag(token);
		const message = invocation.subcommand === "commit" && ["-m", "--message"].includes(flag);
		if (token.includes(UNPROVEN_GIT_OPERAND) && !(message && inline !== undefined)) return false;
		if (values.has(flag) && inline === undefined) {
			const value = invocation.args[++i];
			if (value?.includes(UNPROVEN_GIT_OPERAND) && !message) return false;
		}
	}
	return true;
}

function applyGitPathFlag(flag: string, value: string, paths: GitPathFlags): boolean {
	if (flag === "-C") {
		const resolved = resolveGitPath(value, paths.base);
		if (resolved === null) return false;
		paths.base = resolved;
	} else if (flag === "--git-dir") paths.gitDir = value;
	else paths.workTree = value;
	return true;
}

const GIT_GLOBAL_PATH_FLAGS = new Set(["-C", "--git-dir", "--work-tree"]);
const GIT_GLOBAL_READ_FLAGS = new Set(["--bare", "--no-pager", "--paginate", "-p", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);
// Global help/version options print and exit before any subcommand runs; they are read-only.
const GIT_GLOBAL_HELP_FLAGS = new Set(["--version", "--help", "-h"]);
// Per-subcommand help flags. A help invocation prints usage and ignores its operands, so the
// write-root analysis is skipped for it.
const GIT_HELP_FLAGS = new Set(["-h", "--help"]);

// Only inert presentation values are vetted; arbitrary Git config can execute code or redirect writes.
function safeGitConfig(value: string | undefined): boolean {
	return value !== undefined && /^color\.ui=(?:always|auto|never|true|false|0|1)$/i.test(stripMatchingQuotes(value));
}

// Config injected via env can redirect write roots even for read subcommands, so it is
// distrusted from the inherited process environment as well.
function unsupportedGitConfigEnvironment(vars: ReadonlyMap<string, string>): boolean {
	return ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].some((name) => vars.has(name) || process.env[name] !== undefined);
}

// Direct config injection stays blocked; HOME/XDG config-location overrides are probed.
function commandSuppliedGitConfigEnvironment(vars: ReadonlyMap<string, string>): boolean {
	// GIT_CONFIG is a config-file override like GLOBAL/SYSTEM; its content could carry
	// executable aliases, so a command-supplied value fails closed for every subcommand.
	return ["GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"].some((name) => vars.has(name));
}

// Git executes these values from read-only subcommands too (pager fires on log/diff, askpass/ssh
// on fetch, clone/fetch delegate to GIT_PROXY_COMMAND for transport). Only command-provided
// assignments are distrusted: the user's own exported values are trusted process environment,
// not agent-smuggled input. A malicious repo's own .git/config (core.pager, core.hooksPath)
// is out of scope — same trust class as reviewing checked-in workflow files before trusting them.
const GIT_EXECUTABLE_HOOK_ENV = new Set([
	"GIT_PAGER", "PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL",
	"GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS",
	"GIT_TEMPLATE_DIR", "GIT_PROXY_COMMAND",
]);

function gitExecutableHookEnvironment(vars: ReadonlyMap<string, string>): boolean {
	return [...GIT_EXECUTABLE_HOOK_ENV].some((name) => vars.has(name));
}

// Path-valued tracing/redirect vars command-provided name a file git opens or appends during
// any subcommand (including reads: fsck/status emit trace output and redirect stdout/stderr to
// the path). The user's exported env stays trusted; only assignments in the command string block.
const GIT_TRACE_REDIRECT_ENV = new Set([
	"GIT_TRACE", "GIT_TRACE_PACK_ACCESS", "GIT_TRACE_PACKET", "GIT_TRACE_PERFORMANCE",
	"GIT_TRACE_SETUP", "GIT_TRACE_SHALLOW", "GIT_TRACE_CURL", "GIT_TRACE_CURL_NOISE",
	"GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF",
	"GIT_REDIRECT_STDOUT", "GIT_REDIRECT_STDERR",
]);

function commandSuppliedGitTraceEnvironment(vars: ReadonlyMap<string, string>): boolean {
	return [...GIT_TRACE_REDIRECT_ENV].some((name) => vars.has(name));
}

// Ordered env-gate: return a block reason for any command-provided override that can redirect
// config roots or execute code, or null when the environment is safe to classify further.
function blockedGitEnvironment(vars: ReadonlyMap<string, string>): string | null {
	if (unsupportedGitConfigEnvironment(vars)) return `unsupported git configuration environment blocked${FAIL_CLOSED_HINT}`;
	if (commandSuppliedGitConfigEnvironment(vars)) return `command-provided git configuration environment blocked${FAIL_CLOSED_HINT}`;
	if (gitExecutableHookEnvironment(vars)) return `git executable hook environment blocked${FAIL_CLOSED_HINT}`;
	if (commandSuppliedGitTraceEnvironment(vars)) return `command-provided git trace environment blocked${FAIL_CLOSED_HINT}`;
	return null;
}

/** Parse result: a full invocation, or a globals-only form that prints usage/version and exits. */
type GitParse = { kind: "invocation"; invocation: GitInvocation } | { kind: "global-only" };

/** Unknown globals and non-vetted configuration overrides fail closed. */
function parseGitInvocation(tokens: string[], cwd: string): GitParse | null {
	const paths: GitPathFlags = { base: cwd, gitDir: null, workTree: null };
	for (let i = 1; i < tokens.length; i++) {
		const step = consumeGitGlobalToken(tokens, i, paths);
		if (step.parse !== undefined) return step.parse;
		if (step.next !== undefined) i = step.next;
	}
	// Consumed only global flags: git prints usage/version and writes nothing.
	return { kind: "global-only" };
}

/** Consume one pre-subcommand token. A returned `parse` ends the scan; `next` skips value
 * tokens the flag consumed. Mutates `paths` with any path anchors it applies. */
function consumeGitGlobalToken(tokens: string[], i: number, paths: GitPathFlags): { parse?: GitParse | null; next?: number } {
	const token = tokens[i]!;
	const pathFlag = splitPathFlag(token);
	if (pathFlag) {
		const value = pathFlag[1] ?? tokens[++i];
		if (value === undefined || !applyGitPathFlag(pathFlag[0], value, paths)) return { parse: null };
		return { next: i };
	}
	if (token === "-c" || token.startsWith("-c")) {
		if (!safeGitConfig(token === "-c" ? tokens[++i] : token.slice(2))) return { parse: null };
		return { next: i };
	}
	const [flag] = splitFlagValue(token);
	// A global help/version flag prints and exits; nothing after it runs.
	if (GIT_GLOBAL_HELP_FLAGS.has(flag) && !token.includes("=")) return { parse: { kind: "global-only" } };
	if (GIT_GLOBAL_READ_FLAGS.has(flag) && !token.includes("=")) return { next: i };
	if (token.startsWith("-")) return { parse: null };
	const invocation = finalizeGitInvocation(paths, token, tokens.slice(i + 1));
	return { parse: invocation === null ? null : { kind: "invocation", invocation } };
}

/** Split a path anchor flag (`-C`, `--git-dir`, `--work-tree`) from its value, including
 * attached short forms like `-C/tmp/x` that `splitFlagValue` would leave unsplit. */
function splitPathFlag(token: string): [string, string | undefined] | null {
	if (GIT_GLOBAL_PATH_FLAGS.has(token)) return [token, undefined];
	if (token.startsWith("--")) {
		const [flag, inline] = splitFlagValue(token);
		if (GIT_GLOBAL_PATH_FLAGS.has(flag)) return [flag, inline];
	}
	const short = token.match(/^-C(.+)/);
	if (short) return ["-C", short[1]];
	return null;
}

/** A `--git-dir` value may name a gitfile (a `.git` pointer file), not the directory itself;
 * follow the `gitdir:` pointer like Git does so the real repository location is root-checked. */
function resolveGitDir(value: string, base: string): string | null {
	const resolved = resolveGitPath(value, base);
	if (resolved === null) return null;
	try {
		if (statSync(resolved).isDirectory()) return resolved;
		const pointer = readGitMetadata(resolved);
		if (pointer && pointer.startsWith("gitdir: ")) {
			const target = pointer.slice(8).trim();
			return resolveGitPath(target, path.dirname(resolved)) ?? path.resolve(path.dirname(resolved), target);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return resolved;
}

/** Git interprets relative explicit anchors after all -C flags have changed cwd. */
function finalizeGitInvocation(paths: GitPathFlags, subcommand: string, args: string[]): GitInvocation | null {
	const gitDir = paths.gitDir === null ? null : resolveGitDir(paths.gitDir, paths.base);
	const workTree = paths.workTree === null ? null : resolveGitPath(paths.workTree, paths.base);
	if ((paths.gitDir !== null && gitDir === null) || (paths.workTree !== null && workTree === null)) return null;
	return { base: paths.base, gitDir, workTree, subcommand, args };
}

/** Classify a git subcommand as read-only, write-capable, or unmodeled. Unmodeled names
 * fail closed ("unknown"): git executes real subcommands this table does not model
 * (credential-store, send-email, …), and their write destinations cannot be proven. */
function gitSubcommandKind(subcommand: string, args: string[]): "immutable" | "mutable" | "unknown" {
	if (GIT_IMMUTABLE.has(subcommand)) return "immutable";
	if (GIT_MUTABLE.has(subcommand)) return "mutable";
	const special = gitSpecialSubcommandKind(subcommand, args);
	if (special) return special;
	const mixed = GIT_MIXED[subcommand];
	if (!mixed) return "unknown";
	return mixed(args.join(" ")) ? "immutable" : "mutable";
}

/** Kind for subcommands whose read/write outcome depends on a positional action word. */
function gitSpecialSubcommandKind(subcommand: string, args: string[]): "immutable" | "mutable" | null {
	if (subcommand === "branch") return isSafeBranchQuery(args) ? "immutable" : "mutable";
	// `bisect`/`submodule` action words sit after options, so they need positional parsing.
	if (subcommand === "bisect") {
		const action = gitActionWord("bisect", args);
		// `view`/`visualize` exec gitk from PATH and persist per-repo options into `.git/gitk` —
		// the same exec/write vector `run` and every mutable subcommand are denied by default.
		return action === undefined || action === "log" ? "immutable" : "mutable";
	}
	if (subcommand === "submodule") {
		const action = gitActionWord("submodule", args);
		return action === undefined || action === "status" ? "immutable" : "mutable";
	}
	// `config` decides on raw tokens, not the joined argument string: stripping the destination
	// flags there made every read-modifier prefix (`--show-origin`, `--show-scope`) look like an
	// inert read even when the remaining operands were a `<key> <value>` write.
	if (subcommand === "config") return gitConfigIsRead(args) ? "immutable" : "mutable";
	return null;
}

// Output shaping only; never writes. `--get*` actions are lookups, `-l`/`--list` dumps the file.
const GIT_CONFIG_READ_FLAGS = new Set([
	"-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool",
	"--show-origin", "--show-scope", "--show-names", "--name-only", "-z", "--null", "--includes",
	"--bool", "--int", "--bool-or-int", "--bool-or-str", "--path", "--expiry-date",
	"--fixed-value",
]);
// Lookup actions (plus `--list`) that select what `git config` reports; two different actions
// cannot form a read.
const GIT_CONFIG_READ_ACTIONS = new Set(["-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool"]);
// Flags that consume the next token: their value must not be counted as a config operand.
const GIT_CONFIG_VALUE_FLAGS = new Set(["-t", "--type", "--file", "-f", "--blob", "--default"]);
// Scope selectors with no operand; the file they name is path-checked when the form writes.
const GIT_CONFIG_SCOPE_FLAGS = new Set(["--global", "--system", "--local", "--worktree"]);

/** A config flag that consumes the next token (`-t`, `--type`, `-f`, `--file`, …). */
function isGitConfigValueFlag(flag: string): boolean {
	return GIT_CONFIG_VALUE_FLAGS.has(flag);
}

/** Output-shaping/scoping flags that never write on their own. */
function isGitConfigReadOrScopeFlag(flag: string): boolean {
	return GIT_CONFIG_SCOPE_FLAGS.has(flag) || GIT_CONFIG_READ_FLAGS.has(flag);
}

/**
 * True when `git config` can only read. Anything unrecognised — a write action (`--add`,
 * `--unset`, `--edit`, old-git `--stdin`), a filter that carries a value (`--value=`), or more
 * operands than the selected lookup takes — fails closed as mutable. A value regex is a
 * second operand only with an explicit lookup action; without it, two operands write.
 */
function gitConfigIsRead(args: string[]): boolean {
	let operands = 0, action: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const [flag, inline] = splitGitDestinationFlag(args[i]!);
		if (isGitConfigValueFlag(flag)) { if (inline === undefined && ++i >= args.length) return false; continue; }
		if (GIT_CONFIG_READ_ACTIONS.has(flag)) {
			if (gitConfigActionConflict(action, flag)) return false;
			action = flag;
			continue;
		}
		if (isGitConfigReadOrScopeFlag(flag)) { if (inline !== undefined) return false; continue; }
		if (flag.startsWith("-")) return false;
		operands++;
	}
	return operands <= gitConfigMaxOperands(action);
}

function gitConfigActionConflict(action: string | undefined, newAction: string): boolean {
	return action !== undefined && action !== newAction;
}

function gitConfigMaxOperands(action: string | undefined): number {
	return GIT_CONFIG_TWO_OPERAND_ACTIONS.has(action ?? "") ? 2 : 1;
}

// Lookups that accept a value regex/default as their second operand (name + value).
const GIT_CONFIG_TWO_OPERAND_ACTIONS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool"]);

/**
 * git flags that consume the next token, keyed by subcommand.
 *
 * Arity is subcommand-specific: `-f` is `--force` for push/worktree but `--file` for
 * config, and `-u` is `--set-upstream` for push but `--upload-pack` for clone/fetch.
 * A flat set cannot express that, so it misparses operands — `git push -u origin main`
 * would consume `origin` and resolve the remote as `main` (a network push read as local).
 *
 * Unlisted options are rejected by supportedGitOptions before positional parsing.
 */
const GIT_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
	init: new Set(["-b", "--initial-branch", "--object-format", "--ref-format", "--separate-git-dir", "--template"]),
	clone: new Set([
		"-b", "-B", "--branch", "-o", "--origin", "-u", "--upload-pack", "--depth",
		"--shallow-since", "--shallow-exclude", "--reference", "--reference-if-able",
		"--filter", "--template", "--separate-git-dir", "--config", "--object-format",
		"--ref-format", "--revision", "--server-option", "--bundle-uri", "-j", "--jobs",
	]),
	config: GIT_CONFIG_VALUE_FLAGS,
	apply: new Set(["--directory", "--build-fake-ancestor", "-p", "-C"]),
	diff: new Set(["--output", "--diff-filter"]),
	log: new Set(["--output", "--format", "--pretty", "--max-count", "-n", "-S", "-G", "-L", "-O", "--grep", "--author", "--committer", "--since", "--until", "--after", "--before"]),
	show: new Set(["--output", "--format", "--pretty"]),
	"format-patch": new Set(["-o", "--output-directory", "--output", "--start-number", "--subject-prefix"]),
	grep: new Set(["-e", "--regexp", "-f", "--file", "-A", "--after-context", "-B", "--before-context", "-C", "--context"]),
	commit: new Set(["-m", "--message", "-F", "--file", "-c", "-C", "--reedit-message", "--reuse-message", "--author", "--date"]),
	checkout: new Set(["-b", "-B", "--track", "--orphan", "--conflict"]),
	switch: new Set(["-c", "-C", "--track", "--orphan"]),
	merge: new Set(["-m", "--message", "-F", "--file", "-s", "--strategy", "-X", "--strategy-option", "--into-name"]),
	tag: new Set(["-m", "--message", "-F", "--file", "-u", "--local-user", "-n"]),
	stash: new Set(["-m", "--message"]),
	fetch: new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--refmap", "--negotiation-tip", "-j", "--jobs"]),
	"merge-tree": new Set(["--merge-base"]),
	bundle: new Set(["--version", "--compression"]),
	notes: new Set(["-m", "--message", "-F", "--file"]),
	reflog: new Set(["--expire", "--expire-unreachable"]),
	restore: new Set(["--source", "-s", "--conflict", "--pathspec-from-file"]),
	am: new Set(["-C", "-p", "--directory", "--exclude", "--include", "--whitespace", "--patch-format"]),
	maintenance: new Set(["--config-file"]),
	push: new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]),
	worktree: new Set(["-b", "-B", "--reason"]),
	submodule: new Set(["-b", "--branch", "--name", "--reference", "--depth", "-j", "--jobs"]),
};

const NO_GIT_VALUE_FLAGS: ReadonlySet<string> = new Set();

// Exact allowlists are the option grammar: unknown flags and Git's long-option abbreviations
// cannot be proven inert. Add options only with their arity and write/execute effects modeled.
const GIT_DIFF_PRESENTATION_FLAGS = "--stat --numstat --name-only --name-status --no-ext-diff --no-textconv -c -p --patch --no-patch";
const GIT_BOOLEAN_FLAGS: Record<string, string> = {
	init: "--bare --shared",
	clone: "--local -l --no-hardlinks --shared -s --no-checkout -n --bare --mirror --single-branch --no-single-branch --recurse-submodules --no-tags --reject-shallow",
	config: "--add --replace-all --unset --unset-all --rename-section --remove-section --edit -e",
	add: "--all -A --update -u --force -f --intent-to-add -N --dry-run -n --ignore-errors --ignore-missing --renormalize",
	apply: "--check --stat --numstat --summary --cached --index --3way --reverse -R --reject --whitespace=nowarn",
	checkout: "--merge -m --detach --force -f --ours --theirs -t --recurse-submodules",
	switch: "-d --detach -f --force --discard-changes --guess --no-guess -t",
	commit: "--all -a --amend --no-edit --allow-empty --allow-empty-message --no-verify -n --signoff -s --dry-run",
	reset: "--hard --soft --mixed --merge --keep",
	restore: "--staged --worktree --ours --theirs --merge --overlay --no-overlay --ignore-unmerged --ignore-skip-worktree-bits --quiet -q --recurse-submodules --no-recurse-submodules",
	clean: "--force -f -ff --dry-run -n -d -x -X",
	rm: "--force -f --cached --recursive -r --dry-run -n --ignore-unmatch",
	mv: "--force -f --dry-run -n",
	push: "--force -f --force-with-lease --set-upstream -u --all --tags --mirror --delete -d --dry-run -n --atomic --porcelain --no-verify",
	fetch: "--all --append -a --prune -p --prune-tags --tags -t --no-tags -n --force -f --update-head-ok -u --dry-run --no-write-fetch-head",
	pull: "--ff-only --rebase --no-rebase --no-commit --no-edit",
	merge: "--ff-only --no-ff --no-commit --no-edit --abort --continue --squash -e --edit --ff --autostash",
	"merge-tree": "--write-tree --messages --name-only -z --allow-unrelated-histories",
	rebase: "--abort --continue --skip --quit --interactive -i --autosquash --autostash",
	"cherry-pick": "--abort --continue --skip --quit --no-commit -n --no-edit -x",
	revert: "--abort --continue --skip --quit --no-commit -n --no-edit",
	worktree: "--force -f --detach --lock --porcelain --expire",
	submodule: "--cached --recursive --init --remote --force -f",
	bisect: "--first-parent --no-checkout",
	gc: "--auto --aggressive --prune --force",
	maintenance: "--auto --detach --no-detach",
	stash: `${GIT_DIFF_PRESENTATION_FLAGS} -u --include-untracked -a --all -k --keep-index --no-keep-index --staged --no-staged`,
	branch: [...GIT_BRANCH_LIST_FLAGS, "--delete", "-d", "-D", "--move", "-m", "-M", "--copy", "-c", "-C"].join(" "),
	tag: "--list -l --delete -d --force -f -a --annotate -s --sign",
	remote: "--verbose -v",
	notes: "--force -f --allow-empty --no-allow-empty",
	reflog: "--all --rewrite --updateref --stale-fix --dry-run -n --verbose",
	bundle: "--all --branches --tags --stdin --quiet -q",
	"sparse-checkout": "--cone --no-cone --stdin --sparse-index --no-sparse-index --skip-checks --quiet -q",
	am: "--abort --continue --skip --resolved --retry --3way -3 --interactive -i --keep --keep-non-patch --signoff -s --committer-date-is-author-date --ignore-date --ignore-space-change --ignore-whitespace --utf8 --no-utf8 --empty=keep --empty=drop --empty=stop",
};

/** Boolean flag tokens for a subcommand, normalized to their base name
 * (`--whitespace=nowarn` -> `--whitespace`) so `--flag=value` boolean forms match. */
function gitBooleanFlagTokens(subcommand: string): string[] {
	return (GIT_BOOLEAN_FLAGS[subcommand] ?? "").split(" ").filter(Boolean).map((flag) => flag.split("=")[0]!);
}

/** Short flags the mutable allowlist models, split by arity. Config output/scoping flags are
 * boolean at runtime, so they must expand as booleans too (`config -z --file …`). */
function gitShortFlagSets(subcommand: string): { values: Set<string>; booleans: Set<string> } {
	const values = new Set<string>();
	for (const flag of GIT_VALUE_FLAGS[subcommand] ?? NO_GIT_VALUE_FLAGS) if (/^-[A-Za-z]$/.test(flag)) values.add(flag);
	const booleans = new Set<string>();
	const booleanSources = subcommand === "config" ? [...gitBooleanFlagTokens(subcommand), "-q", "-v", ...GIT_HELP_FLAGS, ...GIT_CONFIG_READ_FLAGS, ...GIT_CONFIG_SCOPE_FLAGS] : [...gitBooleanFlagTokens(subcommand), "-q", "-v", ...GIT_HELP_FLAGS];
	for (const flag of booleanSources) if (/^-[A-Za-z]$/.test(flag)) booleans.add(flag);
	return { values, booleans };
}

/* GitBundleOptions + GitExpansion + expandGitShortBundlesArgs live in git-options. */

/**
 * Expand bundled mutable short flags (`-am` -> `-a -m`) using the modeled arity. A value flag
 * ends the bundle and keeps the trailing chars as its value (`-mmsg` -> `-m msg`); an unmodeled
 * short flag fails closed, so `clone -c`/`rebase -x` cannot hide in a bundle.
 */
function expandGitShortBundles(subcommand: string, args: string[]): GitExpansion {
	const { values, booleans } = gitShortFlagSets(subcommand);
	return expandGitShortBundlesArgs(args, values, (token) => expandGitShortBundle(token, values, { kind: "mutable", booleans }));
}

/**
 * Expand bundled short flags for an immutable subcommand, splitting the bundle so an embedded
 * value flag (`-ko<dir>` -> `-k -o <dir>`) or injection flag (`-nO<cmd>` -> `-n -O <cmd>`) is
 * visible to the existing destination/denylist checks. Unlike the mutable path, an unknown char
 * is inert data (push it) rather than a block: only a *modeled* value or injection flag can
 * redirect output or execute code on a read-only subcommand.
 */
function expandImmutableShortBundles(subcommand: string, args: string[]): GitExpansion {
	const { values } = gitShortFlagSets(subcommand);
	return expandGitShortBundlesArgs(args, values, (token) => expandGitShortBundle(token, values, { kind: "immutable", injection: GIT_IMMUTABLE_INJECTION_FLAGS[subcommand] }));
}

/** Walk one short bundle against per-subcommand value/injection knowledge.
 * Mutable: null when a char is neither a modeled value nor boolean flag. Immutable: unknown
 * chars are inert, a value flag ends the bundle with its trailing chars as the value operand,
 * and an `injection` regex match fails closed. */
function expandGitShortBundle(token: string, values: ReadonlySet<string>, options: GitBundleOptions): string[] | null {
	const out: string[] = [];
	const chars = token.slice(1);
	for (let i = 0; i < chars.length; i++) {
		const flag = `-${chars[i]}`;
		if (values.has(flag)) return chars.slice(i + 1) ? [...out, flag, chars.slice(i + 1)] : [...out, flag];
		if (options.kind === "immutable" && options.injection?.test(flag)) return null;
		if (options.kind === "mutable" && !options.booleans.has(flag)) return null;
		out.push(flag);
	}
	return out;
}

/**
 * Immutable reads use a write/execute denylist: every other option is inert data (D1a). An
 * unknown option cannot redirect a write here, so only proven-dangerous options and long-option
 * abbreviations of denied/destination options fail closed.
 */
function supportedImmutableGitOptions(invocation: GitInvocation): string | null {
	for (const token of invocation.args) {
		if (token === "--") break;
		if (!token.startsWith("-") || token === "-") continue;
		const [flag] = splitGitDestinationFlag(token);
		if (GIT_UNSUPPORTED_WRITE_FLAGS.has(flag) || GIT_IMMUTABLE_DENIED_FLAGS.has(flag)) return token;
		if (GIT_IMMUTABLE_INJECTION_FLAGS[invocation.subcommand]?.test(token)) return token;
		if (flag.startsWith("--") && matchesDeniedGitAbbreviation(flag)) return token;
	}
	return null;
}

/** Mutable writes keep the strict allowlist that models each option's arity and write effect. */
function supportedMutableGitOptions(invocation: GitInvocation): string | null {
	const values = GIT_VALUE_FLAGS[invocation.subcommand] ?? NO_GIT_VALUE_FLAGS;
	const booleans = new Set(gitBooleanFlagTokens(invocation.subcommand));
	if (invocation.subcommand === "config") for (const flag of [...GIT_CONFIG_READ_FLAGS, ...GIT_CONFIG_SCOPE_FLAGS]) booleans.add(flag);
	for (let i = 0; i < invocation.args.length; i++) {
		const token = invocation.args[i]!;
		if (token === "--") break;
		if (!token.startsWith("-") || token === "-") continue;
		const [flag, inline] = splitGitDestinationFlag(token);
		if (GIT_UNSUPPORTED_WRITE_FLAGS.has(flag) || GIT_SUBCOMMAND_INJECTION_FLAGS[invocation.subcommand]?.test(token)) return token;
		if (values.has(flag)) { if (inline === undefined && invocation.args[++i] === undefined) return token; continue; }
		if (["-q", "--quiet", "-v", "--verbose"].includes(flag) || booleans.has(flag) || GIT_HELP_FLAGS.has(flag)) continue;
		return token;
	}
	return null;
}

function supportedGitOptions(invocation: GitInvocation, kind: "immutable" | "mutable"): string | null {
	return kind === "immutable" ? supportedImmutableGitOptions(invocation) : supportedMutableGitOptions(invocation);
}

/** Positional operands, skipping flags and the values this subcommand consumes. */
function gitPositionalArgs(subcommand: string, args: string[]): string[] {
	const valueFlags = GIT_VALUE_FLAGS[subcommand] ?? NO_GIT_VALUE_FLAGS;
	const positionals: string[] = [];
	let operandsOnly = false;
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (!operandsOnly && token === "--") { operandsOnly = true; continue; }
		if (!operandsOnly && valueFlags.has(token)) { i++; continue; }
		if (!operandsOnly && token.startsWith("-") && token !== "-") continue;
		positionals.push(token);
	}
	return positionals;
}

/** Action word of a subcommand (first positional after options), if any. */
function gitActionWord(subcommand: string, args: string[]): string | undefined {
	return gitPositionalArgs(subcommand, args)[0];
}

/** Only a leading help flag unambiguously selects usage; later flags may be option values. */
function gitHelpInvocation(invocation: GitInvocation): boolean {
	const first = invocation.args[0];
	return first !== "--" && first !== undefined && GIT_HELP_FLAGS.has(first);
}

type GitRepository = { worktree: string; metadata: string[] };

/** Missing files are normal during discovery; unreadable metadata is not silently ignored. */
function readGitMetadata(file: string): string | null {
	try { return readFileSync(file, "utf8").trim(); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function gitMetadataRoots(directory: string): string[] {
	directory = resolveRealPath(directory);
	const common = readGitMetadata(path.join(directory, "commondir"));
	return common === null ? [directory] : [directory, path.resolve(directory, common)];
}

/** A linked worktree's .git file and commondir can point outside its visible directory. */
function discoverGitRepository(base: string): GitRepository {
	for (let current = resolveRealPath(base); ; current = path.dirname(current)) {
		const repo = dotGitRepository(current, path.join(current, ".git"));
		if (repo) return repo;
		if (readGitMetadata(path.join(current, "HEAD")) !== null && readGitMetadata(path.join(current, "config")) !== null)
			return { worktree: current, metadata: gitMetadataRoots(current) };
		if (path.dirname(current) === current) return { worktree: resolveRealPath(base), metadata: [] };
	}
}

/** Repository rooted at a `.git` entry: a directory, a `gitdir:` pointer file, or absent (null). */
function dotGitRepository(current: string, dotGit: string): GitRepository | null {
	let hasGitEntry = false;
	try { lstatSync(dotGit); hasGitEntry = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	if (!hasGitEntry) return null;
	try {
		if (statSync(dotGit).isDirectory()) return { worktree: current, metadata: gitMetadataRoots(dotGit) };
		const pointer = readGitMetadata(dotGit);
		if (!pointer?.startsWith("gitdir: ")) throw new Error("not a git repository");
		return { worktree: current, metadata: gitMetadataRoots(path.resolve(current, pointer.slice(8))) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new Error("not a git repository");
	}
}

const GIT_DESTINATION_FLAGS = new Set(["--separate-git-dir", "--directory", "--file", "-f", "--output", "-o", "--output-directory", "--build-fake-ancestor", "--config-file"]);
// These exact options inject executable code, configuration, or unchecked write paths.
const GIT_UNSUPPORTED_WRITE_FLAGS = new Set(["--unsafe-paths", "--exec", "--upload-pack", "--receive-pack", "--config", "--config-env", "--template"]);
// Short aliases that inject config or an executable for one subcommand. Matched as a prefix
// so bundled values (`-cuser.name=x`, `-xcommand`) cannot slip through:
// `clone` has `-c` (--config) and `-u` (--upload-pack); `rebase` has `-x` (--exec).
// `fetch -u` is --update-head-ok and `push -u` is --set-upstream, so those stay allowed.
const GIT_SUBCOMMAND_INJECTION_FLAGS: Record<string, RegExp> = {
	clone: /^-(?:c|u|x)/,
	rebase: /^-(?:x)/,
};

// Immutable reads reject these outright: fsck's --lost-found writes `.git/lost-found`, and the
// others run or capture a program. Destination options stay allowed here and are path-checked.
const GIT_IMMUTABLE_DENIED_FLAGS = new Set(["--lost-found", "--ext-diff", "--textconv", "--open-files-in-pager"]);
// Short aliases that execute in an immutable read. `-O` is grep's --open-files-in-pager; for
// log/blame `-O<orderfile>` only orders reads, so it must stay a per-subcommand deny.
const GIT_IMMUTABLE_INJECTION_FLAGS: Record<string, RegExp> = { grep: /^-O/ };

/** Git accepts any unambiguous long-option abbreviation, so a strict prefix of a denied or
 * destination long option must fail closed (`--out` -> `--output`, `--lost` -> `--lost-found`). */
function matchesDeniedGitAbbreviation(flag: string): boolean {
	// An exact destination option (`--output`) is a prefix of a longer destination
	// (`--output-directory`) but is itself path-checked, not an abbreviation.
	if (GIT_DESTINATION_FLAGS.has(flag)) return false;
	for (const denied of [GIT_IMMUTABLE_DENIED_FLAGS, GIT_UNSUPPORTED_WRITE_FLAGS, GIT_DESTINATION_FLAGS]) {
		for (const candidate of denied) if (candidate.length > flag.length && candidate.startsWith(flag)) return true;
	}
	return false;
}

function gitFlagDestinations(invocation: GitInvocation, kind: "immutable" | "mutable"): string[] | null {
	const roots: string[] = [];
	for (let i = 0; i < invocation.args.length; i++) {
		const token = invocation.args[i]!;
		if (token === "--") break;
		const [flag, inline] = splitGitDestinationFlag(token);
		if (!GIT_DESTINATION_FLAGS.has(flag) || !gitFlagIsDestination(invocation.subcommand, flag)) continue;
		if (kind === "immutable" && invocation.subcommand === "config") continue;
		const value = inline ?? invocation.args[++i];
		const resolved = value === undefined ? null : resolveGitPath(value, invocation.base);
		if (resolved === null) return null;
		roots.push(resolved);
	}
	return roots;
}

function splitGitDestinationFlag(token: string): [string, string | undefined] {
	// git attaches short flag values (`-f<file>`, `-t<type>`); split them so the value is not
	// mistaken for a config/subcommand operand. Only -f/-o/-t take attached values today; -t is
	// config's type selector, not a destination. Audit new subcommands before extending this set.
	if (/^-[fot](.+)/.test(token)) return [token.slice(0, 2), token.slice(2)];
	return splitFlagValue(token);
}

function gitFlagIsDestination(subcommand: string, flag: string): boolean {
	if (flag === "--config-file") return subcommand === "maintenance";
	if (flag === "-f" || flag === "--file") return subcommand === "config";
	if (flag === "-o") return subcommand === "format-patch";
	return true;
}

function gitCreationRoots(invocation: GitInvocation, vars: ReadonlyMap<string, string>): string[] {
	const target = gitCreationTarget(invocation);
	const resolved = resolveGitPath(target ?? invocation.base, invocation.base);
	if (target === null || resolved === null) throw new Error("unresolved Git creation destination");
	const metadata = [...discoverGitRepository(resolved).metadata, ...(invocation.gitDir ? gitMetadataRoots(invocation.gitDir) : [])];
	const configured = metadata.flatMap((directory) => gitConfiguredWorktree(invocation.base, directory, vars));
	return [resolved, ...metadata, ...configured, ...[invocation.gitDir, invocation.workTree].filter((p): p is string => p !== null)];
}

/**
 * Destination of `git init [<directory>]` / `git clone <repo> [<directory>]`: `undefined`
 * for the default (cwd), or null when the parse cannot be trusted. More positionals than
 * the subcommand accepts means an unmodeled valued flag shifted the operands, so the real
 * destination may differ — never guess, fail closed.
 */
function gitCreationTarget(invocation: GitInvocation): string | null | undefined {
	const operands = gitPositionalArgs(invocation.subcommand, invocation.args);
	if (invocation.subcommand === "init") return operands.length <= 1 ? operands[0] : null;
	return operands.length <= 2 ? operands[1] : null;
}

function gitEnvironmentRoots(invocation: GitInvocation, vars: ReadonlyMap<string, string>): string[] | null {
	const roots: string[] = [];
	const envNames = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE", "GIT_CONFIG"];
	if (invocation.subcommand === "config" && invocation.args.some((arg) => arg === "--global")) envNames.push("GIT_CONFIG_GLOBAL");
	if (invocation.subcommand === "config" && invocation.args.some((arg) => arg === "--system")) envNames.push("GIT_CONFIG_SYSTEM");
	for (const name of envNames) {
		const value = gitEnvironmentOperand(name, vars);
		if (value === undefined) continue;
		const resolved = value === null ? null : resolveGitEnvironmentValue(name, value, invocation.base);
		if (resolved === null) return null;
		roots.push(resolved);
		if (name === "GIT_DIR" || name === "GIT_COMMON_DIR") roots.push(...gitMetadataRoots(resolved), ...gitConfiguredWorktree(invocation.base, resolved, vars));
	}
	const temporary = gitTemporaryWriteRoots(vars, invocation.base);
	return temporary === null ? null : [...roots, ...temporary];
}

// Config probes shell out to `git` — the classifier's only synchronous subprocess, on the event
// loop, re-spawned per pass because the cache clears at classifyGit entry. A pass spawns a few
// probes at ~7 ms each, so the 100 ms budget below caps a degraded machine's stall while keeping
// generous headroom. An over-budget probe is "unprovable" and fails closed.
const GIT_CONFIG_PROBE_TIMEOUT_MS = 100;
const gitConfigurationCache = new Map<string, string[]>();

/** Let Git interpret its own config, including linked-worktree and include semantics.
 * Probes use the selected metadata and permitted config-location environment. Relative
 * output paths use command cwd; core.worktree uses its metadata directory. */
function readGitConfiguration(directory: string, args: string[], base: string, vars: ReadonlyMap<string, string>): string[] {
	const key = `${directory}\u0000${base}\u0000${args.join("\u0000")}`;
	const cached = gitConfigurationCache.get(key);
	if (cached) return cached;
	const probe = probeGitConfiguration(directory, args, base, vars);
	gitConfigurationCache.set(key, probe);
	return probe;
}

function probeGitConfiguration(directory: string, args: string[], base: string, vars: ReadonlyMap<string, string>): string[] {
	try {
		// Only config-location overrides enter the probe; command PATH/hooks must never execute.
		const value = execFileSync("git", ["--git-dir", directory, "config", ...args], { encoding: "utf8", timeout: GIT_CONFIG_PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], env: gitProbeEnvironment(base, vars), cwd: existingDirectory(base) }).trim();
		return value ? value.split("\n") : [];
	} catch (error) {
		if ((error as { status?: number }).status === 1) return [];
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("git binary unavailable");
		throw error;
	}
}

/** HOME/XDG select config files, not executables. Resolve shell values before probing. */
function gitProbeEnvironment(base: string, vars: ReadonlyMap<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of ["HOME", "XDG_CONFIG_HOME"]) {
		if (!vars.has(name)) continue;
		const value = gitEnvironmentOperand(name, vars);
		const resolved = value == null ? null : resolveGitPath(value, base);
		if (resolved === null) throw new Error(`unresolved ${name}`);
		env[name] = resolved;
	}
	return env;
}

/** The probe cwd: `base` only when it is a real directory, otherwise undefined (host cwd). */
function existingDirectory(base: string): string | undefined {
	try { return statSync(base).isDirectory() ? base : undefined; } catch { return undefined; }
}

/** Git anchors relative core.worktree to the metadata directory, not cwd. */
function gitConfiguredWorktree(base: string, directory: string, vars: ReadonlyMap<string, string>): string[] {
	return readGitConfiguration(directory, ["--path", "--get", "core.worktree"], base, vars).map((value) => {
		const resolved = resolveGitPath(value, directory);
		if (resolved === null) throw new Error("unresolved core.worktree");
		return resolved;
	});
}

/** `format.outputDirectory` redirects `format-patch` output; a relative value resolves against the cwd. */
function gitConfiguredOutputDirectory(invocation: GitInvocation, vars: ReadonlyMap<string, string>): string[] | null {
	const metadata = gitSelectedMetadata(invocation, discoverGitRepository(invocation.base), vars);
	const values = metadata.flatMap((directory) => readGitConfiguration(directory, ["--path", "--get", "format.outputDirectory"], invocation.base, vars));
	const resolved = values.map((value) => resolveGitPath(value, invocation.base));
	return resolved.some((value) => value === null) ? null : resolved as string[];
}

/** Local pushes write the destination repository too; unprovable transport locations fail closed. */
function gitPushWriteRoots(invocation: GitInvocation, metadata: string[], workTree: string, vars: ReadonlyMap<string, string>): string[] {
	const remote = gitPushRemoteOperand(invocation);
	// The remote token is an operand (`"origin"`, `$REMOTE`, `'origin'`). The dynamic-operand
	// sentinel is a NUL that cannot be a git argument, so fail closed before the config probe.
	if (remote !== undefined && (remote.includes(UNPROVEN_GIT_OPERAND) || remote === "")) throw new Error("unresolved Git remote name");
	const rawLocations = remote === undefined
		? gitDefaultPushLocations(invocation, metadata, vars)
		: gitNamedPushLocations(metadata, remote, invocation.base, vars);
	// A bare remote NAME resolves through repo config; with unreadable metadata a configured
	// network remote is indistinguishable from a local path, so the name cannot be a target.
	if (remote !== undefined && !metadata.length) throw new Error("unsupported Git push transport");
	// Git rewrites URLs at transport time, so the configured value alone is not the write target.
	const rewrites = metadata.length ? readGitUrlRewrites(metadata[0]!, invocation.base, vars) : [];
	const locations = rawLocations.map((location) => filePushLocalPath(applyGitUrlRewrite(location, rewrites, true)));
	if (!locations.length || locations.some((location) => location === null)) throw new Error("unsupported Git push transport");
	// Relative remote URLs resolve against the repository top level, not the cwd
	// (`git push ../remote.git` from a subdir writes the top-level's sibling).
	return locations.flatMap((location) => gitLocalDestinationRoots(location!, workTree, vars));
}

/** Positional remote, or the `--repo[=]` value; undefined when the command names neither. */
function gitPushRemoteOperand(invocation: GitInvocation): string | undefined {
	const index = invocation.args.findIndex((arg) => splitFlagValue(arg)[0] === "--repo");
	if (index >= 0) return splitFlagValue(invocation.args[index]!)[1] ?? invocation.args[index + 1];
	return gitPositionalArgs("push", invocation.args)[0];
}

/** Configured URL(s) for a named remote; an unconfigured name is itself the location Git uses. */
function gitNamedPushLocations(metadata: string[], remote: string, base: string, vars: ReadonlyMap<string, string>): string[] {
	const configured = gitRemoteLocations(metadata, remote, base, vars);
	return configured.length ? configured : [remote];
}

/** With no positional remote Git picks branch.<b>.pushRemote, then remote.pushDefault, then
 * branch.<b>.remote. A selector that names no configured remote holds a location, so check it. */
function gitDefaultPushLocations(invocation: GitInvocation, metadata: string[], vars: ReadonlyMap<string, string>): string[] {
	if (!metadata.length) return [];
	const entries = gitRemoteConfigEntries(metadata, invocation.base, vars);
	const locations = entries.map((line) => line.slice(line.indexOf(" ") + 1));
	const selector = gitPushSelector(metadata, invocation.base, vars);
	if (selector === undefined || configuredGitRemoteNames(entries).has(selector)) return locations;
	return [...locations, selector];
}

/** Effective push selector in Git's precedence order; values are normally remote NAMES. */
function gitPushSelector(metadata: string[], base: string, vars: ReadonlyMap<string, string>): string | undefined {
	const branch = currentGitBranch(metadata);
	const read = (key: string) => readGitConfiguration(metadata[0]!, ["--get", key], base, vars)[0];
	if (branch !== null) {
		const pushRemote = read(`branch.${branch}.pushRemote`);
		if (pushRemote !== undefined) return pushRemote;
	}
	return read("remote.pushDefault") ?? (branch === null ? undefined : read(`branch.${branch}.remote`));
}

/** Current branch from HEAD across the selected metadata dirs; a detached HEAD has none. */
function currentGitBranch(metadata: string[]): string | null {
	for (const directory of metadata) {
		const match = readGitMetadata(path.join(directory, "HEAD"))?.match(/^ref: refs\/heads\/(.+)$/);
		if (match) return match[1]!;
	}
	return null;
}

/** `remote.<name>.(url|pushurl)` config lines: every configured remote, in config order. */
function gitRemoteConfigEntries(metadata: string[], base: string, vars: ReadonlyMap<string, string>): string[] {
	return readGitConfiguration(metadata[0]!, ["--get-regexp", "^remote\\..*\\.(url|pushurl)$"], base, vars);
}

/** Configured url/pushurl values for one remote NAME; empty when that remote is absent. */
function gitRemoteLocations(metadata: string[], remote: string, base: string, vars: ReadonlyMap<string, string>): string[] {
	if (!metadata.length) return [];
	const pattern = `^remote\\.${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(url|pushurl)$`;
	return readGitConfiguration(metadata[0]!, ["--get-regexp", pattern], base, vars).map((line) => line.slice(line.indexOf(" ") + 1));
}

/** Remote names declared by the config entries; the subsection preserves case. */
function configuredGitRemoteNames(entries: string[]): Set<string> {
	return new Set(entries.map((line) => {
		const key = line.slice(0, line.indexOf(" "));
		return key.slice("remote.".length, key.lastIndexOf("."));
	}));
}

/** A push location that names a local path, or null for a network transport. `file://` URLs are
 * local destinations (Git parses host then path), so `file:///tmp/x.git` is path-checked like a
 * filesystem path rather than blocked as transport. */
function filePushLocalPath(location: string): string | null {
	if (location.startsWith("file://")) return fileUrlLocalPath(location.slice("file://".length));
	if (process.platform === "win32" && /^[a-zA-Z]:[\\/]/.test(location)) return location;
	return location.includes(":") ? null : location;
}

/** Host must be empty or localhost; percent-decode the path and drop a leading slash before a
 * Windows drive (`/C:/x` -> `C:/x`). A malformed escape cannot be proven local, so it fails. */
function fileUrlLocalPath(rest: string): string | null {
	const slash = rest.indexOf("/");
	const host = slash < 0 ? rest : rest.slice(0, slash);
	if (host !== "" && host !== "localhost") return null;
	try {
		const decoded = decodeURIComponent(slash < 0 ? "" : rest.slice(slash));
		return /^\/[a-zA-Z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
	} catch { return null; }
}

/** One `url.<base>.insteadOf` / `.pushInsteadOf` rule as Git applies it at transport time. */
type GitUrlRewrite = { base: string; prefix: string; pushOnly: boolean };

/** A rewrite can aim a locally-looking remote at a network or non-temp destination. */
function readGitUrlRewrites(directory: string, base: string, vars: ReadonlyMap<string, string>): GitUrlRewrite[] {
	const rewrites: GitUrlRewrite[] = [];
	for (const line of readGitConfiguration(directory, ["--get-regexp", "^url\\."], base, vars)) {
		const separator = line.indexOf(" ");
		if (!line.startsWith("url.") || separator < 0) throw new Error("unsupported Git URL rewrite");
		const key = line.slice(0, separator);
		// Git lowercases variable names when it stores them; compare case-insensitively.
		const lower = key.toLowerCase();
		const pushOnly = lower.endsWith(".pushinsteadof");
		if (!pushOnly && !lower.endsWith(".insteadof")) continue;
		const suffix = pushOnly ? ".pushinsteadof" : ".insteadof";
		rewrites.push({ base: key.slice("url.".length, -suffix.length), prefix: line.slice(separator + 1), pushOnly });
	}
	return rewrites;
}

/** Longest matching prefix wins; pushes consult `pushInsteadOf` before `insteadOf`. */
function applyGitUrlRewrite(location: string, rewrites: GitUrlRewrite[], forPush: boolean): string {
	const groups = forPush ? [rewrites.filter((rule) => rule.pushOnly), rewrites.filter((rule) => !rule.pushOnly)] : [rewrites.filter((rule) => !rule.pushOnly)];
	for (const rules of groups) {
		const match = rules.filter((rule) => rule.prefix && location.startsWith(rule.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
		if (match) return match.base + location.slice(match.prefix.length);
	}
	return location;
}

function gitLocalDestinationRoots(location: string, base: string, vars: ReadonlyMap<string, string>): string[] {
	const resolved = resolveGitPath(location, base);
	if (resolved === null) throw new Error("unresolved Git destination");
	const metadata = discoverGitRepository(resolved).metadata;
	return [resolved, ...metadata, ...metadata.flatMap((directory) => gitConfiguredWorktree(base, directory, vars))];
}

/** Explicit metadata selects the config source, not just an additional checked path. */
function gitSelectedMetadata(invocation: GitInvocation, repo: GitRepository, vars: ReadonlyMap<string, string>): string[] {
	const value = gitEnvironmentOperand("GIT_DIR", vars);
	const directory = invocation.gitDir ?? (value === undefined ? undefined : value === null ? null : resolveGitDir(value, invocation.base));
	if (directory === null) throw new Error("unresolved GIT_DIR");
	return directory === undefined ? repo.metadata : gitMetadataRoots(directory);
}

function gitRepositoryWriteRoots(invocation: GitInvocation, vars: ReadonlyMap<string, string>): string[] {
	const repo = discoverGitRepository(invocation.base);
	const metadata = gitSelectedMetadata(invocation, repo, vars);
	const configured = metadata.flatMap((directory) => gitConfiguredWorktree(invocation.base, directory, vars));
	const roots = [invocation.workTree ?? repo.worktree, ...metadata, ...configured];
	if (invocation.subcommand === "push") roots.push(...gitPushWriteRoots(invocation, metadata, invocation.workTree ?? repo.worktree, vars));
	if (invocation.subcommand === "worktree") roots.push(...gitPositionalArgs("worktree", invocation.args.slice(1)));
	if (invocation.subcommand === "submodule" && gitActionWord("submodule", invocation.args) === "add") roots.push(...gitPositionalArgs("submodule", invocation.args).slice(2));
	roots.push(...gitSubmoduleWriteRoots(invocation, invocation.workTree ?? repo.worktree));
	return roots;
}

/** `submodule update` and `checkout --recurse-submodules` materialize declared submodule
 * worktrees, so each `.gitmodules` path joins the write roots, resolved against the worktree. */
function gitSubmoduleWriteRoots(invocation: GitInvocation, workTree: string): string[] {
	const action = invocation.subcommand === "submodule" ? gitActionWord("submodule", invocation.args) : undefined;
	const recursive = invocation.subcommand === "checkout" && invocation.args.includes("--recurse-submodules");
	return action === "update" || recursive ? gitSubmodulePaths(workTree) : [];
}

/** `submodule.<name>.path` values from `.gitmodules`. A missing file means no submodules; an
 * unreadable or malformed file cannot be trusted, so this throws and the command fails closed. */
function gitSubmodulePaths(workTree: string): string[] {
	const content = readGitMetadata(path.join(workTree, ".gitmodules"));
	if (content === null) return [];
	const paths: string[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";") || /^\[.*\]$/.test(line)) continue;
		const { key, value } = parseGitmodulesLine(line);
		if (key !== "path") continue;
		// Git's config quoting/escaping would change the path, so an escaped value cannot be
		// resolved reliably; fail closed rather than check the wrong location.
		if (/["'\\]/.test(value)) throw new Error("unsupported .gitmodules path escaping");
		paths.push(path.resolve(workTree, value));
	}
	return paths;
}

function parseGitmodulesLine(line: string): { key: string; value: string } {
	const match = line.match(/^([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.+)$/);
	if (!match) throw new Error("malformed .gitmodules");
	return { key: match[1]!, value: match[2]! };
}

/** Explicit `.git` metadata anchors a command pins git to: `--git-dir` and the matching
 * `GIT_DIR`/`GIT_COMMON_DIR` env vars. For immutable reads these are still path-checked: incidental
 * metadata writes (index refresh on `status`) land in the anchored `.git`, so a command
 * pointing that `.git` outside temp is blocked. GIT_INDEX_FILE also names an incidental write
 * destination. GIT_ALTERNATE_OBJECT_DIRECTORIES is deliberately NOT checked: it is a read-only
 * object store, and path-checking it would block read-only git for any ambient value outside
 * temp (see "allows read-only git from any directory"). Worktree/cwd anchors (`-C`,
 * `--work-tree`, `GIT_WORK_TREE`) are deliberately NOT checked for immutable commands: they only
 * redirect where git reads worktree files, and read-only git is permitted from any directory. A
 * plain cwd that merely sits in an outside repo is the accepted ambient limitation. */
function gitImmutableAnchorRoots(invocation: GitInvocation, vars: ReadonlyMap<string, string>): string[] | null {
	const roots: string[] = [];
	if (invocation.gitDir !== null) roots.push(invocation.gitDir);
	for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
		const value = gitEnvironmentOperand(name, vars);
		if (value === undefined) continue;
		const resolved = value === null ? null : resolveGitEnvironmentValue(name, value, invocation.base);
		if (resolved === null) return null;
		roots.push(resolved);
	}
	const temporary = gitTemporaryWriteRoots(vars, invocation.base);
	return temporary === null ? null : [...roots, ...temporary];
}

/**
 * Command-provided `TMPDIR`/`TEMP`/`TMP` name where git writes transient scratch files
 * (merge/commit/rebase temp files, `diff` output staging). The value is a real write
 * location, so it joins the write roots and blocks when it resolves outside temp. Only
 * command-line assignments are read here (`vars`); the user's exported environment stays
 * trusted, matching the `HOME`/`XDG` rule. Returns null when a value cannot be resolved.
 */
function gitTemporaryWriteRoots(vars: ReadonlyMap<string, string>, base: string): string[] | null {
	const roots: string[] = [];
	for (const name of ["TMPDIR", "TEMP", "TMP"]) {
		const supplied = vars.get(name);
		if (supplied === undefined) continue;
		const resolved = /[$`\\*?{}\[\]"']/.test(supplied) || supplied.startsWith("~") ? null : resolveGitPath(supplied, base);
		if (resolved === null) return null;
		roots.push(resolved);
	}
	return roots;
}

/**
 * Every write root a mutable Git command may touch, or null when one cannot be proven.
 * Throws on discovery/transport failure; classifyGit surfaces the cause.
 */
function getGitWriteRoots(invocation: GitInvocation, kind: "immutable" | "mutable", vars: ReadonlyMap<string, string>): GitWriteRoot[] | null {
	const destinations = gitFlagDestinations(invocation, kind);
	if (!destinations || gitWriteRootsUnprovable(invocation)) return null;
	return kind === "immutable"
		? immutableGitWriteRoots(invocation, destinations, vars)
		: mutableGitWriteRoots(invocation, destinations, vars);
}

/** `submodule foreach`/`bisect run` execute arbitrary commands, so no write root is provable. */
function gitWriteRootsUnprovable(invocation: GitInvocation): boolean {
	return (invocation.subcommand === "submodule" && gitActionWord("submodule", invocation.args) === "foreach")
		|| (invocation.subcommand === "bisect" && gitActionWord("bisect", invocation.args) === "run");
}

function immutableGitWriteRoots(invocation: GitInvocation, destinations: string[], vars: ReadonlyMap<string, string>): GitWriteRoot[] | null {
	// Immutable reads still emit incidental metadata into the anchored `.git` (index refresh on
	// `status`, lost-found on `fsck --lost-found`). Ambient discovery from cwd is an accepted
	// limitation (see readonly-bash.ts "Known L2 limitations"), but a command that PINS the
	// `.git` metadata with --git-dir / GIT_DIR / GIT_COMMON_DIR is path-checked like a write —
	// the author chose that repository on purpose. Worktree/cwd anchors are read contexts
	// (see gitImmutableAnchorRoots).
	const anchors = gitImmutableAnchorRoots(invocation, vars);
	if (anchors === null) return null;
	const taggedAnchors = anchors.map((path): GitWriteRoot => ({ path, metadata: true }));
	if (invocation.subcommand !== "format-patch" || destinations.length || invocation.args.includes("--stdout"))
		return [...taggedAnchors, ...destinations.map((path): GitWriteRoot => ({ path, metadata: false }))];
	const configured = gitConfiguredOutputDirectory(invocation, vars);
	return configured === null ? null : [...taggedAnchors, { path: invocation.base, metadata: false }, ...configured.map((path): GitWriteRoot => ({ path, metadata: false }))];
}

function mutableGitWriteRoots(invocation: GitInvocation, destinations: string[], vars: ReadonlyMap<string, string>): GitWriteRoot[] | null {
	const environment = gitEnvironmentRoots(invocation, vars);
	if (!environment) return null;
	const roots = gitDefaultWriteRoots(invocation, destinations, vars);
	const resolved = [...roots, ...destinations, ...environment].map((root) => resolveGitPath(root, invocation.base));
	return resolved.some((root) => root === null) ? null : resolved.map((path): GitWriteRoot => ({ path: path as string, metadata: false }));
}

/** Git can choose either user config file; check both unless the environment pins one. */
function gitGlobalConfigurationRoots(vars: ReadonlyMap<string, string>, base: string): string[] {
	const global = gitEnvironmentOperand("GIT_CONFIG_GLOBAL", vars);
	if (global === null) throw new Error("unresolved GIT_CONFIG_GLOBAL");
	if (global !== undefined) return [global];
	const env = gitProbeEnvironment(base, vars);
	const home = env.HOME ?? os.homedir();
	const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
	return [path.join(home, ".gitconfig"), path.join(xdg, "git", "config")];
}

function gitAdditionalWriteRoots(invocation: GitInvocation, vars: ReadonlyMap<string, string>): string[] {
	const operands = gitPositionalArgs(invocation.subcommand, invocation.args);
	if (invocation.subcommand === "bundle" && operands[0] === "create") {
		if (!operands[1]) throw new Error("missing Git bundle destination");
		return operands[1] === "-" ? [] : [operands[1]];
	}
	if (invocation.subcommand === "maintenance" && ["register", "unregister"].includes(operands[0] ?? "")) {
		if (invocation.args.some((arg) => splitFlagValue(arg)[0] === "--config-file")) return [];
		return gitGlobalConfigurationRoots(vars, invocation.base);
	}
	// `maintenance start`/`stop` install a scheduler in the user's global config/session, a
	// location beyond the writable temp roots; fail closed rather than guess the platform target.
	if (invocation.subcommand === "maintenance" && ["start", "stop"].includes(operands[0] ?? ""))
		throw new Error("unsupported Git maintenance scheduler location");
	return [];
}

function gitDefaultWriteRoots(invocation: GitInvocation, destinations: string[], vars: ReadonlyMap<string, string>): string[] {
	if (invocation.subcommand === "init" || invocation.subcommand === "clone") return gitCreationRoots(invocation, vars);
	if (invocation.subcommand === "config") {
		if (invocation.args.includes("--global")) return gitGlobalConfigurationRoots(vars, invocation.base);
		if (invocation.args.includes("--system")) {
			const system = gitEnvironmentOperand("GIT_CONFIG_SYSTEM", vars);
			if (system === null) throw new Error("unresolved GIT_CONFIG_SYSTEM");
			return [system ?? "/etc/gitconfig"];
		}
		if (invocation.args.some((arg) => ["--file", "-f"].includes(splitGitDestinationFlag(arg)[0]))) return destinations;
	}
	// Deferred-effect config writes inside temp: a value like `core.worktree /etc` writes only
	// the repo's local config (allowed when the repo is inside temp); the redirected location
	// is checked by `gitConfiguredWorktree` when a later command runs.
	return [...gitRepositoryWriteRoots(invocation, vars), ...gitAdditionalWriteRoots(invocation, vars)];
}
