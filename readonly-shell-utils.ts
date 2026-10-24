import os from "node:os";
import path from "node:path";
import { globSync } from "node:fs";
import { resolvePathFrom } from "./resolve-path.js";
import { TEMP_WRITE_ROOTS_CANONICAL } from "./temp-dir.js";
import { FAIL_CLOSED_HINT } from "./notifications.js";

/** Owners that read stdin as inert data. Shared by the heredoc classifier (which
 * decides whether a body runs) and the tracked-command denylist (which must reject a
 * function/alias that shadows one, turning an inert body into executable code). */
export const STDIN_DATA_CONSUMERS = new Set([
	":", "true", "false", "cat", "tee", "grep", "sed", "sort", "head", "tail",
	"tr", "wc", "cut", "uniq", "jq", "base64", "gzip", "gunzip", "less", "more",
	"diff", "column", "fmt", "fold", "nl", "rev", "tac", "strings", "shasum",
	"sha256sum", "md5sum",
]);

/** Shells that consume their stdin (or script argument) as program source. Shared by the
 * heredoc ownership check (a body fed to one of these is code, not inert data) and by
 * process-substitution classification. `source`/`.` run their stdin in the current shell. */
export const SHELL_SCRIPT_CONSUMERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "source", "."]);

/** Bash word tokenizer shared by command-prefix parsing: keeps quoted words whole. */
export const SHELL_WORD_PATTERN = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s"'\\])+/g;

/**
 * Approximate Bash word expansion for command lookup: Bash removes backslash
 * escapes and quote characters before resolving the executable name, so `\rm`,
 * `r\m`, and `r""m` all invoke `rm`. Inside double quotes Bash keeps `\` before
 * ordinary characters — unescaping anyway only over-blocks, which fails closed.
 * POSIX-shell assumption: a `\` in a command word is an escape, not a path separator.
 */
export function unescapeCommandWord(token: string): string {
	let word = "", quote = "";
	for (let i = 0; i < token.length; i++) {
		const ch = token[i]!;
		if (quote === "'") { if (ch === "'") quote = ""; else word += ch; continue; }
		if (ch === "\\") { word += token[++i] ?? ""; continue; }
		if (quote === '"') { if (ch === '"') quote = ""; else word += ch; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		word += ch;
	}
	return word;
}

/** Decode one static Bash word. Dynamic words fail closed; double quotes retain ordinary backslashes. */
export function decodeShellWord(token: string): string | null {
	let word = "", quote = "";
	for (let i = 0; i < token.length; i++) {
		const ch = token[i]!;
		if (quote === "'") { if (ch === "'") quote = ""; else word += ch; continue; }
		if (ch === "\\") {
			const next = token[++i];
			if (next === undefined || next === "\n") return null;
			word += quote === '"' && !'\\"$`'.includes(next) ? "\\" + next : next;
			continue;
		}
		if (ch === quote) { quote = ""; continue; }
		if (!quote && (ch === "'" || ch === '"')) { quote = ch; continue; }
		if (ch === "$" || ch === "`" || (!quote && (/[\s*?{}\[\]<>]/.test(ch) || (i === 0 && ch === "~")))) return null;
		word += ch;
	}
	return quote ? null : word;
}

/** Chars that make a dynamic value unprovable as a path: shell syntax and globs. One
 * source of truth for the value checks here and in the git environment/temp-root readers. */
export function hasUnprovableValueChars(value: string): boolean {
	return /[$`*?{}\[\]"']/.test(value);
}

/** Literal shell-source fragments (a `$VAR` suffix, or a braced `:-` default) must carry no
 * escapes. Bash decodes `\/` -> `/`, but the classifier appends the fragment to the expansion
 * value verbatim, so a `\` here would desync the classified path from the executed one and
 * could let a `..` traversal escape temp. Expansion *values* stay raw data. */
function hasSourceEscape(fragment: string): boolean {
	return fragment.includes("\\");
}

/** Expand a leading variable or home prefix, then decode escapes exactly once. */
export function decodeShellOperand(token: string, vars: ReadonlyMap<string, string> = new Map()): string | null {
	const raw = stripMatchingQuotes(token);
	if (!token.startsWith("'") && raw.startsWith("$")) {
		const expanded = expandShellVariable(raw, vars);
		// The expanded value is data: its backslashes are literal (a Windows separator from a
		// quoted assignment or the host env). The literal suffix is shell source; expandShellVariable
		// fails closed when it carries an escape, because Bash would decode it.
		return expanded === null || hasUnprovableValueChars(expanded) || (!token.startsWith('"') && /\s/.test(expanded)) ? null : expanded;
	}
	if (token === "~" || token.startsWith("~/")) return decodeShellWord(os.homedir() + token.slice(1));
	return decodeShellWord(token);
}

export function normalizedCommand(token: string): string {
	return path.basename(unescapeCommandWord(token)).toLowerCase();
}

export function getCommandTokens(segment: string): string[] {
	return segment.match(SHELL_WORD_PATTERN) ?? [];
}

/** Longest first: a shorter operator must never win a prefix match. Invalid Bash forms
 * (`>>|`, `>>&`) stay out of the table so no parser lists them as operators. Both parsers
 * consume every entry; keep one list so they cannot drift. */
export const REDIRECT_OPERATORS: readonly string[] = Object.freeze([
	"<<-", "<<<", "&>>", ">>", "<<", "<>", "<&", ">|", ">&", "&>", "<", ">",
]);

const escapeRedirectOperator = (operator: string): string => operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Alternation preserving the table's longest-first order. */
function redirectOperatorAlternation(): string {
	return REDIRECT_OPERATORS.map(escapeRedirectOperator).join("|");
}

/** Leading redirection token: optional fd prefix + operator + optional attached target.
 *
 * NOTE: the bare `<` alternative matches `<(` as a redirect operator, so a token
 * like `<(cmd)` is treated as `<` with attached target `(cmd)`. This is a known
 * approximation: realistic commands are unaffected, but it can over-block when a
 * process-substitution token precedes a directory-change builtin.
 *
 * Exported so the module-graph guard asserts on this value, not on regex source text. */
export const LEADING_REDIRECTION_PATTERN = new RegExp(`^(?:\\d+)?(${redirectOperatorAlternation()})(.*)$`);

/**
 * Skip redirection tokens that precede the command word (`> out rm x`, `2> out rm x`,
 * `>out rm x`). Dispatch only needs the command word; the redirect target is checked by
 * the redirect scanner. `<<`/`<<<` heredocs are removed before classification.
 *
 * Shared by command-prefix parsing (`readonly-bash-commands.ts`) and the directory-change
 * tracker (`readonly-bash-dirchange.ts`); keeping one copy here avoids drift and the cycle
 * that duplicating it in either module would need to dodge.
 */
export function skipLeadingRedirections(tokens: string[], start: number): number {
	let i = start;
	while (i < tokens.length) {
		const match = LEADING_REDIRECTION_PATTERN.exec(unescapeCommandWord(tokens[i]!));
		if (!match) break;
		i += match[2] ? 1 : 2;
	}
	return i;
}

/**
 * Redirect operator at the start of a token, with optional fd prefix (`2>`, `&>>`)
 * and any attached target. Shared by the brace-group trailing scanner
 * (`readonly-bash.ts`) and the cd-operand stripper (`readonly-bash-dirchange.ts`).
 *
 * WHY one table: both scanners must agree on what counts as an operator, otherwise a
 * redirect target drifts into being read as a command operand in one of them.
 * Heredoc stdin parsing (`readonly-bash-heredoc.ts`) uses a different, narrower pattern.
 */
// Exported so the module-graph guard asserts on this value, not on regex source text.
export const REDIRECT_TOKEN_PATTERN = new RegExp(`^(?:\\d+)?(?:${redirectOperatorAlternation()})`);

/** Match a leading redirect operator in `word`; null when the word is not an operator. */
export function matchRedirectToken(word: string): RegExpExecArray | null {
	return REDIRECT_TOKEN_PATTERN.exec(word);
}

/**
 * Remove redirect operators and their targets from a token list. Attached forms
 * (`>out`, `2>/dev/null`) are one token; a bare operator consumes the next token.
 * Redirect targets are validated on the raw segment by the redirect scanner —
 * feeding them to command parsers would misread them as git options or mutation
 * targets (`git status 2>/dev/null`, `touch /tmp/x >/dev/null`).
 */
export function stripRedirectTokens(tokens: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const match = matchRedirectToken(token);
		if (!match) { kept.push(token); continue; }
		if (match[0] === token) i++; // bare operator: its target is the next token
	}
	return kept;
}

/**
 * Word and path primitives shared by the readonly classifier (readonly-bash.ts)
 * and the git write-root analyzer (readonly-bash-git.ts). Keeping them here avoids
 * the import cycle the dispatcher <-> git module would otherwise create.
 */

/** Split `--flag=value` into its parts; `-x` and bare `--flag` return no inline value. */
export function splitFlagValue(token: string): [string, string | undefined] {
	if (!token.startsWith("--")) return [token, undefined];
	const eq = token.indexOf("=");
	return eq === -1 ? [token, undefined] : [token.slice(0, eq), token.slice(eq + 1)];
}

/** Assignment maps lose quote context; unquoted escapes remain unproven, not raw path data. */
export function decodeShellAssignmentValue(token: string): string {
	if (!token.startsWith("'") && !token.startsWith('"') && token.includes("\\")) return "$(unproven-assignment)";
	return decodeShellWord(token) ?? stripMatchingQuotes(token);
}

/** Keep attached operand quote context; unsupported flag spellings fail closed. */
export function rawAttachedFlagValue(token: string, flag: string): string {
	return token.startsWith(flag) ? token.slice(flag.length) : "$(unproven-attached-operand)";
}

export function stripMatchingQuotes(token: string): string {
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
export function expandShellVariable(rawPath: string, shellVars: ReadonlyMap<string, string>, visited: Set<string> = new Set()): string | null {
	const braced = rawPath.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:=)([^}]*))?\}(.*)$/);
	if (braced) return expandBracedVariable(braced, shellVars, visited);
	const plain = rawPath.match(/^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
	if (plain) return expandPlainVariable(plain, shellVars, visited);
	return null;
}

/** Braced `${VAR}`, with an optional `:-`/`:=` default and trailing suffix. A cyclic
 * self-reference fails closed (null), never falling through to the default. */
function expandBracedVariable(match: RegExpMatchArray, vars: ReadonlyMap<string, string>, visited: Set<string>): string | null {
	const [, varName, operator, fallback = "", suffix] = match;
	if (visited.has(varName!)) return null;
	visited.add(varName!);
	const value = vars.get(varName!) ?? process.env[varName!];
	if (value !== undefined && value !== "") return hasSourceEscape(suffix) ? null : value + suffix;
	if (operator !== ":-" && operator !== ":=") return null;
	return hasSourceEscape(fallback) || hasSourceEscape(suffix) ? null : fallback + suffix;
}

/** Plain `$VAR` with a trailing suffix; a cyclic self-reference fails closed. */
function expandPlainVariable(match: RegExpMatchArray, vars: ReadonlyMap<string, string>, visited: Set<string>): string | null {
	const varName = match[1]!;
	if (visited.has(varName)) return null;
	visited.add(varName);
	const value = vars.get(varName) ?? process.env[varName];
	if (value === undefined || value === "") return null;
	return hasSourceEscape(match[2]!) ? null : value + match[2];
}

/**
 * Largest per-pattern expansion `isTempGlobPath` will enumerate before failing closed.
 *
 * Each wildcard/brace segment doubles the pattern count (a dotfile variant),
 * so a segment-dense pattern like `a{b}/a{b}/…` grows 2ⁿ and can exhaust the
 * in-process classifier heap (#41). The classifier runs on every bash tool call,
 * so an unbounded expansion is a host-aborting DoS. 256 (≤8 independent segments)
 * covers real write-target globs; deeper patterns fall through to the literal
 * containment path, preserving both the fail-closed-outside and allow-inside-temp
 * verdicts without ever materializing 2ⁿ patterns.
 */
const MAX_GLOB_PATTERN_EXPANSION = 256;

/**
 * Expand a glob pattern to include hidden-file (dotfile) variants.
 *
 * WORKAROUND: `node:fs.globSync` ignores the `dot: true` option on Node.js v24+
 * — it silently skips dotfiles. This generates `.*` variants for each wildcard
 * segment so hidden files are matched.
 *
 * Brace patterns (`{a,b}`) are NOT expanded: they are treated as opaque segments, and
 * the unmatched-glob fallback then resolves them as literal characters. See the
 * brace-expansion entry in readonly-bash.ts Known L2 limitations.
 *
 * Returns `null` when the full expansion would exceed MAX_GLOB_PATTERN_EXPANSION,
 * so the caller fails closed (the no-match path already falls through to a literal
 * containment check) instead of heap-exhausting the classifier.
 */
function expandHiddenGlobPatterns(pattern: string): string[] | null {
	const segments = pattern.split("/");
	const counts = segments.map(globSegmentVariantCount);
	// Bound the product BEFORE materializing: a 2ⁿ blowup (#41) crashes the host.
	if (globExpansionSize(counts) === null) return null;
	const patterns = new Set<string>();
	collectGlobPatterns(segments, counts, 0, [], patterns);
	return [...patterns];
}

/** Hidden-file variant count for one glob segment: 3 for `**`, 2 for a wildcard, else 1. */
function globSegmentVariantCount(segment: string): number {
	if (segment === "**") return 3;
	// Literal or already-dotfile segments never expand.
	if (!/[*?{}\[\]]/.test(segment) || segment.startsWith(".")) return 1;
	return 2;
}

/** Product of variant counts, or null when it exceeds MAX_GLOB_PATTERN_EXPANSION. */
function globExpansionSize(counts: number[]): number | null {
	let size = 1;
	for (const count of counts) {
		size *= count;
		if (size > MAX_GLOB_PATTERN_EXPANSION) return null;
	}
	return size;
}

function collectGlobPatterns(segments: string[], counts: number[], index: number, built: string[], patterns: Set<string>): void {
	if (index === segments.length) { patterns.add(built.join("/")); return; }
	const segment = segments[index]!;
	const options = counts[index] === 3 ? [segment, "**/.*", "**/.*/**"] : counts[index] === 1 ? [segment] : [segment, `.${segment}`];
	for (const option of options) collectGlobPatterns(segments, counts, index + 1, [...built, option], patterns);
}

/** Inert paths that are never real writes: empty, /dev/null, fd redirects, terminal fds. */
function isInertPath(normalized: string): boolean {
	return !normalized || normalized === "/dev/null" || /^&\d+$/.test(normalized)
		|| /^\/dev\/(?:stdout|stderr|tty|fd\/\d+)$/.test(normalized);
}

/** Resolve path syntax once; expanded values and glob matches remain filesystem data. */
export function decodeShellPathOperand(token: string, vars: ReadonlyMap<string, string> = new Map()): { value: string; glob: boolean } | null {
	const raw = stripMatchingQuotes(token);
	const quoted = token.startsWith('"') && token.endsWith('"');
	if (!token.startsWith("'") && raw.startsWith("$")) {
		// Unsupported suffix syntax must not be concatenated as literal data.
		if (!/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::[-=][^$`\\"'{}]*)?\})[^$`\\"']*$/.test(raw)) return null;
		const value = expandShellVariable(raw, vars);
		// Dynamic values cannot prove safety. The raw-token regex above already excludes glob/quote
		// and source-escape syntax; the value's own backslashes are literal data (a Windows
		// separator). Source-fragment escapes fail closed inside expandShellVariable.
		if (value === null || /[$`]/.test(value) || (!quoted && /[\s"'{}]/.test(value))) return null;
		return { value, glob: !quoted && /[*?{}\[\]]/.test(value) };
	}
	const value = decodeShellOperand(token, vars);
	if (value !== null) return { value, glob: false };
	// Only plain glob syntax is modeled; mixed quotes/escapes fail closed.
	if (/[*?{}\[\]]/.test(token) && !/[\s$`\\"'~<>]/.test(token)) return { value: token, glob: true };
	return null;
}

/** Glob patterns: resolve against cwd and check each match; unmatched falls through to literal. */
function isTempGlobPath(normalized: string, cwd: string): boolean | null | "unproven" {
	if (!/[*?{}\[\]]/.test(normalized)) return null;
	const expanded = expandHiddenGlobPatterns(normalized);
	// Too dense to enumerate safely (#41): treat as the unmatched case and let the
	// caller fall through to a literal containment check — fail-closed for any
	// outside path, allowed for an inside-temp literal path, matching the
	// no-match behaviour without ever materializing 2ⁿ patterns.
	if (expanded === null) return null;
	try {
		const matches = globSync(expanded, { cwd });
		// Without nullglob (Bash default), an unmatched pattern passes through literally.
		// With nullglob, it disappears. The classifier assumes default behavior — safe:
		// a literal containment check over-blocks rather than under-blocks.
		// Glob matches are literal filesystem paths — no $VAR expansion needed.
		if (matches.length > 0) return matches.every((m) => isTempLiteralPath(m, cwd));
	} catch { return "unproven"; }
	return null;
}

/** Device-namespace prefixes (`\\?\`, `\\.\`, `\??\`, `//?/`, `//./`) name the NT object
 * manager, not a filesystem path. No host resolver can prove where they lead, so they stay
 * fail-closed everywhere. Tested on the DECODED value: unquoted `\/` decodes to `/` (a real
 * temp path), so raw text proves nothing. A decoded `\/` leader (double-quoted
 * `\"\/etc\/probe\"`) stays a relative path. */
const WINDOWS_DEVICE_NAMESPACE_PATTERN = /^(?:\\\\[?.]|\\[?.]|\/\/[?.]\/)/;

/** Drive-anchored (`C:\`, `C:/`, `C:rel`) and backslash-UNC (`\\server\share`) forms. A POSIX
 * resolver reads `C:\Temp\x` as a relative filename, so it cannot prove containment. The win32
 * resolver models these natively, so isWindowsRiskyPathTarget defers to it on win32.
 * Forward-slash `//server/share` matches neither pattern; both resolvers land it outside temp. */
const WINDOWS_RESOLVER_ONLY_PATTERN = /^(?:\\\\|[A-Za-z]:)/;

/** True when a decoded path must be treated as unprovable. Device namespaces always are; drive
 * and UNC forms are only unprovable on a POSIX host, whose resolver cannot model them.
 * Cross-drive-relative needs `cwd`, so it lives in isCrossDriveRelative, not here. */
export function isWindowsRiskyPathTarget(decodedValue: string, platform: NodeJS.Platform = process.platform): boolean {
	if (WINDOWS_DEVICE_NAMESPACE_PATTERN.test(decodedValue)) return true;
	return platform !== "win32" && WINDOWS_RESOLVER_ONLY_PATTERN.test(decodedValue);
}

/** Drive-relative (`C:rel`, not `C:\`/`C:/`) naming another drive than `cwd`. Win32 resolves it
 * against that drive's ambient cwd, which the classifier cannot see, so the target is unproven.
 * Pure (no platform read) so Linux CI exercises the win32 branch directly. */
export function isCrossDriveRelative(value: string, cwd: string): boolean {
	const target = value.match(/^([A-Za-z]):(?![\\/])/)?.[1]?.toLowerCase();
	const base = cwd.match(/^([A-Za-z]):/)?.[1]?.toLowerCase();
	return target !== undefined && base !== undefined && target !== base;
}

/** Basename of the UNKNOWN_CWD sentinel (readonly-bash-dirchange.ts). Structural check
 * avoids an import cycle; a later relative path there is unproven, never outside. */
const UNKNOWN_CWD_BASENAME = ".pi-readonly-unknown-cwd";

/** Whether a write target is provably inside the temp roots, provably outside, or unprovable. */
export type TempPathVerdict = "inside" | "outside" | "unproven";

export function classifyTempPath(rawPath: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map()): TempPathVerdict {
	const operand = decodeShellPathOperand(rawPath, shellVars);
	// Dynamic values (unknown vars, substitutions) prove nothing — callers must fail closed.
	if (operand === null) return "unproven";
	if (isWindowsRiskyPathTarget(operand.value)) return "unproven";
	// Cross-drive-relative resolves against another drive's ambient cwd: unprovable on win32.
	if (process.platform === "win32" && isCrossDriveRelative(operand.value, cwd)) return "unproven";
	if (isInertPath(operand.value)) return "inside";
	const globResult = operand.glob ? isTempGlobPath(operand.value, cwd) : null;
	if (globResult === "unproven") return "unproven";
	return (globResult ?? isTempLiteralPath(operand.value, cwd)) ? "inside" : "outside";
}

/**
 * Block reason for one write target, or null when it is provably inside the temp roots.
 * An unprovable target reports "cannot prove", never a false "outside temp dir" claim —
 * the wrong diagnosis sends users after a fix that cannot help them.
 */
export function tempPathBlockReason(subject: string, rawPath: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map()): string | null {
	const verdict = classifyTempPath(rawPath, cwd, shellVars);
	if (verdict === "inside") return null;
	const shown = stripMatchingQuotes(rawPath) || "(unknown target)";
	if (verdict === "outside") {
		// A relative target at the unknown cwd is unproven, not outside: the tracker
		// lost the directory (e.g. cd -P), so say so with a fix (cd -L).
		return path.basename(cwd) === UNKNOWN_CWD_BASENAME
			? `${subject} blocked: cannot prove target stays inside temp: ${shown} (cwd unknown after cd; use cd -L with a literal path)${FAIL_CLOSED_HINT}`
			: `${subject} blocked outside temp dir: ${shown}`;
	}
	return `${subject} blocked: cannot prove target stays inside temp: ${shown}${FAIL_CLOSED_HINT}`;
}

/** Check data already decoded by Bash/Git; literal quotes and backslashes are not shell syntax. */
export function isTempLiteralPath(value: string, cwd: string): boolean {
	// Join raw, then realpath: collapsing `..` first would misjudge `link/../pwn` when
	// `link` points outside temp (the kernel resolves the link before its parent).
	const real = resolvePathFrom(cwd, value);
	return TEMP_WRITE_ROOTS_CANONICAL.some((root) => isWithinPath(root, real));
}

/** Is `target` equal to or nested under `root`? */
export function isWithinPath(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
