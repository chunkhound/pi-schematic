/**
 * Directory change tracking (cd / pushd / popd) and compound command classification.
 *
 * Tracks cwd through directory-changing builtins, handles compound commands
 * (if/while/for/case/function definitions), and classifies deferred code
 * (trap handlers, alias definitions) that may change the directory later.
 */
import path from "node:path";
import os from "node:os";
import { accessSync, constants, statSync } from "node:fs";
import { FAIL_CLOSED_HINT } from "./notifications.js";
import { decodeShellPathOperand, decodeShellWord, getCommandTokens, normalizedCommand, unescapeCommandWord, stripMatchingQuotes, stripRedirectTokens, SHELL_WORD_PATTERN, skipLeadingRedirections, STDIN_DATA_CONSUMERS, isWindowsRiskyPathTarget } from "./readonly-shell-utils.js";
import { splitUnquotedShellSegments } from "./readonly-bash-scanner.js";
import { parseCommandPrefix, getFilesystemMutationReason } from "./readonly-bash-commands.js";
import { classifyBashCommand, getStandaloneShellAssignments, redirectMayAbortCommand } from "./readonly-bash.js";
import type { ShellState, ShellOutcome } from "./readonly-bash.js";

export const DIR_CHANGE_BUILTINS = new Set(["cd", "pushd", "popd"]);

// Sentinel cwd for a directory change the classifier cannot resolve. It resolves
// outside every temp root, so later relative paths are conservatively blocked.
export const UNKNOWN_CWD = path.join(path.parse(process.cwd()).root, ".pi-readonly-unknown-cwd");

/**
 * Per-pass memoized view of the live filesystem for cd reachability.
 *
 * WHY a cache instead of live per-cd probes: repeated accessSync/statSync calls
 * let a symlink retarget drift the classifier mid-pass and add flake; the pass
 * executes nothing, so one memoized answer per path is consistent and cheaper.
 * Scoped per top-level classify (runWithPassDirectoryCache in readonly-bash.ts);
 * nested classifications reuse the active pass cache. Standalone use falls back
 * to a throwaway (correct, just unshared).
 */
export class PassDirectoryCache {
	private results = new Map<string, boolean>();
	/** True when target is an executable directory — memoized per pass. */
	isAccessibleDirectory(target: string): boolean {
		const hit = this.results.get(target);
		if (hit !== undefined) return hit;
		// A failed cd preserves the caller's directory, so failure stays false.
		let ok = false;
		try { accessSync(target, constants.X_OK); ok = statSync(target).isDirectory(); }
		catch { ok = false; }
		this.results.set(target, ok);
		return ok;
	}
}

let activePassCache: PassDirectoryCache | null = null;

/** Run fn with a fresh per-pass cache; nested classifications reuse the active one. Sync-only, so no interleave. */
export function runWithPassDirectoryCache<T>(fn: () => T): T {
	if (activePassCache !== null) return fn();
	activePassCache = new PassDirectoryCache();
	try { return fn(); }
	finally { activePassCache = null; }
}

function passCache(): PassDirectoryCache {
	return activePassCache ?? new PassDirectoryCache();
}

/** `eval`, `source`, and `.` run code the classifier cannot see; it may change the tracked cwd. */
export const CWD_UNCERTAIN_BUILTINS = new Set(["eval", "source", "."]);

export type ResolvedCwd = { cwd: string; traversalOk: boolean };

function directoryAccessible(cwd: string): boolean {
	return passCache().isAccessibleDirectory(cwd);
}

/**
 * Real `cd` stats every intermediate component, so `missing/..` fails (ENOENT)
 * even though it collapses lexically to the parent. Mirror `cd -L`: walk the raw
 * operand from the root, follow `.`/`..`, and require each named component to be
 * an existing directory (symlinks followed). A lexical resolve alone would hide
 * the failure and let `;`-chained writes run in the caller's outside cwd.
 */
function directoryTraversalAccessible(rawTarget: string, cwd: string, directories: ReadonlySet<string>): boolean {
	const target = path.isAbsolute(rawTarget) ? rawTarget : cwd + path.sep + rawTarget;
	let current = path.parse(target).root;
	for (const part of target.slice(current.length).split(path.sep)) {
		if (!part || part === ".") continue;
		if (part === "..") { current = path.dirname(current); continue; }
		current = path.join(current, part);
		if (!directories.has(current) && !directoryAccessible(current)) return false;
	}
	return true;
}

/** The cwd a directory-changing builtin leaves behind, plus whether its operand's intermediates exist. */
function resolveBuiltinCwd(command: string, target: string | null, state: ShellState, segment: string, stack: string[]): ResolvedCwd {
	const commandVars = new Map(state.vars);
	for (const [name, value] of getStandaloneShellAssignments(segment, state.cwd, state.vars).assignments) commandVars.set(name, value);
	if (command === "popd") return { cwd: stack.pop() ?? UNKNOWN_CWD, traversalOk: true };
	if (target === null) return { cwd: command === "cd" ? os.homedir() : UNKNOWN_CWD, traversalOk: true };
	const raw = expandDirectoryTarget(target, state.vars, commandVars);
	if (raw === null) return { cwd: UNKNOWN_CWD, traversalOk: true };
	return { cwd: path.resolve(state.cwd, raw), traversalOk: directoryTraversalAccessible(raw, state.cwd, state.directories) };
}

/** Leading `$VAR`/`${VAR}` command word, matched as a whole word after removing optional double quotes. */
const DYNAMIC_COMMAND_WORD = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
/** A resolved command word must be one inert token; anything else stays unresolved. */
const SAFE_COMMAND_WORD = /^[A-Za-z_][A-Za-z0-9_.+/-]*$/;

/**
 * Replace the dynamic `$VAR`/`${VAR}` command word at `index` (after assignments and
 * `command`/`builtin` wrappers) with its tracked value so a resolved `cd` still moves the
 * cwd. Wrappers must not hide the dynamic word: `C=cd; command "$C" /etc` moves the parent
 * shell. `resolved:false` means the value is unknown or not a single safe word, so the
 * caller must fail closed.
 */
function expandCommandWordAt(segment: string, index: number | null, vars: ReadonlyMap<string, string>): { segment: string; resolved: boolean } {
	const words = [...segment.matchAll(SHELL_WORD_PATTERN)];
	const word = index !== null ? words[index] : undefined;
	// Single quotes make the variable literal: Bash never expands them, so the word stays
	// `$C` and fails closed downstream instead of silently becoming the tracked value.
	const match = word && !word[0].startsWith("'") ? DYNAMIC_COMMAND_WORD.exec(stripMatchingQuotes(word[0])) : null;
	if (!word || !match) return { segment, resolved: true };
	const value = vars.get(match[1] ?? match[2]!);
	if (value === undefined || !SAFE_COMMAND_WORD.test(value)) return { segment, resolved: false };
	const start = word.index ?? 0;
	return { segment: segment.slice(0, start) + value + segment.slice(start + word[0].length), resolved: true };
}

/** A dynamic command word may move the shell; fork UNKNOWN_CWD so later paths fail closed. */
function unknownCwdOutcome(state: ShellState): ShellOutcome {
	const unknown = { ...state, cwd: UNKNOWN_CWD };
	return { success: [state, unknown], failure: [state, unknown] };
}

/** The cwd a directory-changing builtin leaves behind: UNKNOWN_CWD when dynamic; `popd` restores from the stack. */
export function applyDirectoryChange(segment: string, state: ShellState): ShellOutcome {
	const lead = leadingCommandIndex(segment.match(SHELL_WORD_PATTERN) ?? []);
	const expanded = expandCommandWordAt(segment, lead, state.vars);
	if (!expanded.resolved) return unknownCwdOutcome(state);
	const tokens = parentShellBuiltinTokens(expanded.segment);
	if (tokens === null) return nonDirectoryChangeOutcome(expanded.segment, state);
	const command = normalizedCommand(tokens[0]), stack = [...state.stack];
	const resolved = resolveBuiltinCwd(command, getDirectoryTarget(tokens), state, segment, stack);
	if (command === "pushd") stack.push(state.cwd);
	const cwd = directoryArgumentsUncertain(command, tokens) ? UNKNOWN_CWD : resolved.cwd;
	const synthetic = state.directories.has(cwd);
	const reachable = resolved.traversalOk && (synthetic || directoryAccessible(cwd));
	// Runtime creation/cd can fail; only && may discard the caller-cwd branch.
	const failure = cwd === UNKNOWN_CWD || synthetic || !reachable || redirectMayAbortCommand(segment) ? [state] : [];
	return { success: [{ ...state, cwd, stack }], failure };
}

/** Keep the real state, plus an unknown-cwd branch when the segment may move the shell. */
export function nonDirectoryChangeOutcome(segment: string, state: ShellState): ShellOutcome {
	const tokens = getCommandTokens(segment);
	const index = leadingCommandIndex(tokens);
	const lead = index !== null && tokens[index] ? tokens[index] : null;
	// Function bodies with cd already fork UNKNOWN via compoundChangesDirectory; trap
	// handlers and alias values run later, so their definitions fork UNKNOWN the same way.
	const deferredUncertain = getTrapHandlerCode(segment) !== null
		|| getAliasDefinitionValues(segment).some(deferredCodeMayChangeDirectory);
	const uncertain = lead && (CWD_UNCERTAIN_BUILTINS.has(normalizedCommand(lead)) || compoundChangesDirectory(segment) || deferredUncertain)
		? [{ ...state, cwd: UNKNOWN_CWD }] : [];
	// A failing eval/source may also have moved the shell, so its `||` branch must
	// classify at UNKNOWN_CWD too; keeping only the caller state let
	// `eval "cd /etc; false" || touch x` write outside temp.
	return { success: [state, ...uncertain], failure: [state, ...uncertain] };
}

function directoryArgumentsUncertain(command: string, tokens: string[]): boolean {
	const operands = tokens.slice(1).filter((token) => {
		const word = decodeShellWord(token) ?? token;
		return word === "-" || !word.startsWith("-");
	});
	// pushd/popd rotate the directory stack with +N/-N operands; the tracked stack
	// cannot model that, so those targets fail closed (`cd +N` is a real dirname).
	// Only `-L` is safe: it keeps the lexical path the tracker already models, while
	// `-P` (or any other flag) resolves symlinks physically and can escape the temp roots.
	const stackOperands = command !== "cd" && operands.some((op) => /^[+-]\d+$/.test(decodeShellWord(op) ?? op));
	return stackOperands
		|| hasUnsafeDirectoryFlag(tokens)
		|| operands.length > 1 || (command === "popd" && operands.length > 0);
}

/**
 * Only `-L` (logical) matches the lexical tracker; combined flags like `-LP`/`-Pe` are
 * physical, and an unknown long flag (`--physical`) is not something `cd` accepts, so it
 * fails closed too. `--` is the standard end-of-options separator and stays safe.
 */
function hasUnsafeDirectoryFlag(tokens: string[]): boolean {
	return tokens.some((token) => {
		const word = decodeShellWord(token) ?? token;
		if (word === "--") return false;
		return /^-/.test(word) && [...word.slice(1)].some((flag) => flag !== "L");
	});
}

// ── Compound commands (if / while / for / case / function definitions) ──

// The operator splitter already fragments compounds at `;`, so both introducers
// (`if`, `for`, `name()`) and continuation clauses (`then`, `do`, …) arrive as
// separate segments. All of them run in the parent shell.
export const COMPOUND_FRAGMENT = /^\s*(?:(?:if|while|until|for|select|case|then|do|else|elif|fi|esac|done|time)\s|!\s|(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)|function\s)/;
const FUNCTION_DEF_HEADER = /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*|^\s*function\s+[A-Za-z_][A-Za-z0-9_]*\s*/;
const SHELL_RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "esac", "in", "!", "time", "{", "}", "while", "until", "for", "select", "case"]);

/**
 * Simple-command strings inside a compound fragment, with scaffolding keywords
 * and case-arm `pattern)` prefixes stripped. Needed because the fragment's
 * first word is the introducer or clause keyword (`if`, `then`), which hides
 * inner commands from the ordinary first-word mutation parse.
 */
function compoundCommands(segment: string): string[] {
	const isCase = /^\s*case\s/.test(segment);
	const commands: string[] = [];
	for (const part of splitUnquotedShellSegments(segment.replace(FUNCTION_DEF_HEADER, ""))) {
		let text = part.text.trim();
		if (isCase) text = text.replace(/^[^)\n]*\)/, "").trim();
		const words = text.match(SHELL_WORD_PATTERN) ?? [];
		let i = 0;
		while (words[i] && SHELL_RESERVED.has(normalizedCommand(words[i]))) i++;
		if (words[i]) commands.push(words.slice(i).join(" "));
	}
	return commands;
}

// Replacing these names invalidates cwd tracking, prefix unwrapping, or heredoc stdin
// ownership (which trusts a data-consumer name to keep a body inert). Reject definitions,
// not just their bodies.
const TRACKED_COMMAND_NAMES = new Set([...DIR_CHANGE_BUILTINS, "command", "builtin", ...STDIN_DATA_CONSUMERS]);

function trackedCommandDefinitionReason(segment: string): string | null {
	const header = /^\s*(?:function\s+([^\s()]+)|([^\s()]+)\s*\(\s*\))/.exec(segment);
	if (header) {
		const name = unescapeCommandWord(header[1] ?? header[2]!);
		if (TRACKED_COMMAND_NAMES.has(name)) return `function definition replaces tracked shell command: ${name}${FAIL_CLOSED_HINT}`;
	}
	const tokens = parseCommandPrefix(segment, new Map()).tokens;
	if (tokens[0] && normalizedCommand(tokens[0]) === "alias") {
		for (const token of tokens.slice(1)) {
			const word = unescapeCommandWord(token), separator = word.indexOf("=");
			const name = separator < 0 ? word : word.slice(0, separator);
			if (/[$`]/.test(name) || (separator >= 0 && TRACKED_COMMAND_NAMES.has(name))) return `alias definition may replace tracked shell command: ${name}${FAIL_CLOSED_HINT}`;
		}
	}
	return null;
}

/** Classify each inner simple command of a compound fragment against the tracked state. */
export function compoundSegmentReason(segment: string, state: ShellState, depth: number): string | null {
	const definitionReason = trackedCommandDefinitionReason(segment);
	if (definitionReason) return definitionReason;
	if (!COMPOUND_FRAGMENT.test(segment)) return null;
	const commands = compoundCommands(segment);
	const reason = compoundMutationReason(commands, state.cwd, depth, state.vars);
	if (reason) return reason;
	// A directory change inside the body may succeed, so inner relative writes are
	// also checked from the fail-closed unknown cwd (same posture as eval/source).
	return compoundChangesDirectory(segment) ? compoundMutationReason(commands, UNKNOWN_CWD, depth, state.vars) : null;
}

function compoundMutationReason(commands: string[], cwd: string, depth: number, vars: ReadonlyMap<string, string>): string | null {
	for (const command of commands) {
		const reason = trackedCommandDefinitionReason(command) ?? getFilesystemMutationReason(command, cwd, depth, vars);
		if (reason) return reason;
	}
	return null;
}

/** Does a compound fragment run a directory-changing builtin in the parent shell? */
export function compoundChangesDirectory(segment: string): boolean {
	if (!COMPOUND_FRAGMENT.test(segment)) return false;
	// Prefix wrappers (`command cd`) are stripped by the ordinary command parse;
	// eval/source inside a body may move the shell, so they count as uncertain too.
	return compoundCommands(segment).some((command) => {
		const lead = parseCommandPrefix(command, new Map()).tokens[0];
		return lead !== undefined && (DIR_CHANGE_BUILTINS.has(normalizedCommand(lead)) || CWD_UNCERTAIN_BUILTINS.has(normalizedCommand(lead)));
	});
}

/**
 * Tokens of a cd/pushd/popd invocation, or null when the segment does not run
 * one in the parent shell. `command`/`builtin` prefixes keep execution in the
 * current shell; `env` forks a child, so `env cd` must not move the tracked cwd.
 */
export function parentShellBuiltinTokens(segment: string): string[] | null {
	const tokens = segment.match(SHELL_WORD_PATTERN) ?? [];
	const i = leadingCommandIndex(tokens);
	return i !== null && tokens[i] && DIR_CHANGE_BUILTINS.has(decodeShellWord(tokens[i]) ?? "") ? stripRedirectTokens(tokens.slice(i)) : null;
}

/** Leading command token index after standalone assignments and `command`/`builtin` wrappers. */
function leadingCommandIndex(tokens: string[]): number | null {
	let start = 0;
	// Quoted or escaped assignment names are command words, not shell assignments.
	while (tokens[start] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!)) start++;
	return parentBuiltinIndex(tokens, start);
}

/** Cwd proof requires actual builtin names and execution-preserving wrapper flags. */
function parentBuiltinIndex(tokens: string[], start: number): number | null {
	let i = start;
	for (let depth = 0; depth < 10; depth++) {
		i = skipLeadingRedirections(tokens, i);
		const word = tokens[i] ? decodeShellWord(tokens[i]) : null;
		if (word === "builtin") { i++; continue; }
		if (word !== "command") return i;
		const next = commandExecutionIndex(tokens, i + 1);
		if (next === null) return null;
		i = next;
	}
	return null;
}

/** Query/invalid command flags cannot prove that the directory builtin executes. */
function commandExecutionIndex(tokens: string[], start: number): number | null {
	let i = start;
	while (tokens[i]) {
		const word = decodeShellWord(tokens[i]) ?? tokens[i];
		if (!word.startsWith("-")) break;
		if (word === "--") return i + 1;
		if (word !== "-p") return null;
		i++;
	}
	return i;
}

/** First non-flag operand of a directory-change builtin (`-` counts as an operand). */
export function getDirectoryTarget(tokens: string[]): string | null {
	for (const token of tokens.slice(1)) {
		const word = decodeShellWord(token) ?? token;
		if (word === "--") continue;
		if (word.startsWith("-") && word !== "-") continue;
		return token;
	}
	return null;
}

/** Directory operands use path decoding, never the command-name approximation. */
function expandDirectoryTarget(target: string, shellVars: ReadonlyMap<string, string>, commandVars: ReadonlyMap<string, string>): string | null {
	const operand = decodeShellPathOperand(target, shellVars);
	if (operand === null || operand.value === "-" || (operand.glob && /[*?{}\[\]]/.test(operand.value))) return null;
	// Win32-only syntax (device prefixes, drive anchors) is unprovable on a POSIX resolve.
	if (isWindowsRiskyPathTarget(operand.value)) return null;
	return gateRelativeCdPath(operand.value, commandVars);
}

/** CDPATH can select a directory outside cwd; explicit relative paths bypass it. */
function gateRelativeCdPath(value: string, commandVars: ReadonlyMap<string, string>): string | null {
	const search = commandVars.get("CDPATH") ?? process.env.CDPATH;
	return search && !path.isAbsolute(value) && !/^(?:\.\.?)(?:\/|$)/.test(value) ? null : value;
}

/** Resolve a directory operand to an absolute path, or null when it is dynamic. */
export function resolveDirectoryTarget(target: string, cwd: string, shellVars: ReadonlyMap<string, string>, commandVars: ReadonlyMap<string, string> = shellVars): string | null {
	const expanded = expandDirectoryTarget(target, shellVars, commandVars);
	return expanded === null ? null : path.resolve(cwd, expanded);
}

// ── Deferred code (trap handlers, alias definitions) ──

/** `trap` handler code set by this segment, or null when listing/clearing. */
export function getTrapHandlerCode(segment: string): string | null {
	const tokens = getCommandTokens(segment);
	if (!tokens[0] || normalizedCommand(tokens[0]) !== "trap") return null;
	const args = tokens.slice(1);
	let i = 0;
	while (i < args.length) {
		const word = unescapeCommandWord(args[i]!);
		if (word === "--") { i++; continue; }
		if (word === "-l") return null;
		// `-p` is a listing mode: the following words are signal specs, never handler code.
		if (word === "-p") return null;
		break;
	}
	// `trap - SIGNAL`, `trap '' SIGNAL`, bare `trap -p` list or clear — no deferred code.
	const handler = args[i] === undefined ? null : stripMatchingQuotes(args[i]!);
	if (handler === null || handler === "" || handler === "-") return null;
	return handler;
}

/** `alias name='value'` definitions in this segment. Values run on later invocation, not here. */
export function getAliasDefinitionValues(segment: string): string[] {
	const tokens = getCommandTokens(segment);
	if (!tokens[0] || normalizedCommand(tokens[0]) !== "alias") return [];
	const values: string[] = [];
	for (const token of tokens.slice(1)) {
		const word = unescapeCommandWord(token);
		if (word === "--" || word === "-p") continue;
		if (!word.includes("=")) continue; // bare `alias name` prints — no code
		values.push(stripMatchingQuotes(word.slice(word.indexOf("=") + 1)));
	}
	return values;
}

/** May deferred code move the shell (cd/pushd/popd/eval/source/trap/alias)? */
export function deferredCodeMayChangeDirectory(code: string): boolean {
	for (const part of splitUnquotedShellSegments(code)) {
		const text = part.text.trim();
		if (!text) continue;
		if (parentShellBuiltinTokens(text) !== null) return true;
		if (compoundChangesDirectory(text)) return true;
		const lead = parseCommandPrefix(text, new Map()).tokens[0];
		if (lead === undefined) continue;
		const cmd = normalizedCommand(lead);
		if (CWD_UNCERTAIN_BUILTINS.has(cmd) || cmd === "trap" || cmd === "alias") return true;
	}
	return false;
}

/**
 * Classify trap-handler / alias-value code that runs later. A definition like
 * `alias f='rm /etc/passwd'` is blocked now (same posture as function bodies in
 * compoundSegmentReason); a directory change inside defers via UNKNOWN_CWD in
 * nonDirectoryChangeOutcome so later relative writes fail closed.
 */
export function deferredCodeReason(segment: string, state: ShellState, depth: number): string | null {
	const handler = getTrapHandlerCode(segment);
	if (handler !== null) {
		const nested = classifyBashCommand(handler, state.cwd, depth + 1, state.vars);
		if (!nested.ok) return `trap handler blocked: ${nested.reason}`;
	}
	for (const value of getAliasDefinitionValues(segment)) {
		const nested = classifyBashCommand(value, state.cwd, depth + 1, state.vars);
		if (!nested.ok) return `alias definition blocked: ${nested.reason}`;
	}
	return null;
}
