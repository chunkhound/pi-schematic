/**
 * Heredoc preprocessing + stdin ownership classification.
 *
 * Classification chain for `<<` / `<<-` / `<<<` (line preprocessor first):
 *   stripHeredocBodies — replaces stdin redirects with collision-free `$(...)`
 *                        checks bound to body records, preserving header order.
 *   processHeredocLine → findHeredocDelimiters → readStdinRedirect
 *                     → stdinRedirectOwner → stripStdinOwnerRedirects
 *                     → stdinCodeKind / stdinStageKind → unwrapStdinTokens
 *                          — decide ownership: "shell" (classify body as code),
 *                            "other" (block), or "data" (body is inert).
 *   shellStdinConsumer → stageCwdPrefix → scriptCwdPrefix
 *                          — the shell stage that runs the body (wrapper commands
 *                            such as `sudo`/`time` stripped, its assignments kept)
 *                            plus any `-c` cwd move it applies first; null when it
 *                            can't be resolved. Depth guards (10) bound recursion.
 *   classifyHeredocBody — expands unquoted stdin under `expansionCandidates`, then
 *                         checks child code in the consuming shell's environment
 *                         without propagating cwd/variables back.
 *
 * Ownership rule of thumb: stdin flows down a pipeline (`cat <<E | bash` = code),
 * but not across `||`/`&&` fallbacks (`cat <<E || bash` = inert). A group heredoc
 * (`{ cat; bash; } <<E`) fails closed: how much stdin each member consumes before
 * execution is unknowable.
 */
import { splitFlagValue, normalizedCommand, unescapeCommandWord, STDIN_DATA_CONSUMERS, SHELL_SCRIPT_CONSUMERS } from "./readonly-shell-utils.js";
import { FAIL_CLOSED_HINT } from "./notifications.js";
import { consumeShellCharacter, splitUnquotedShellSegments, extractCommandSubstitutions, findArithmeticEnd } from "./readonly-bash-scanner.js";
import type { ShellScan } from "./readonly-bash-scanner.js";
import { INTERPRETERS, findSudoCommandIndex, envSplitCommand, demangleNestedArgument, parseCommandPrefix } from "./readonly-bash-commands.js";
import { COMPOUND_FRAGMENT, DIR_CHANGE_BUILTINS } from "./readonly-bash-dirchange.js";
import type { Verdict, ShellState } from "./readonly-bash.js";
import { classifyBashWithHeredocs, nestedBlockReason } from "./readonly-bash.js";

/**
 * Remove heredoc bodies before segmentation.
 *
 * A heredoc body is stdin data, not shell source, so classifying its lines as
 * commands creates false positives — a data line like `foo > bar` looks like a
 * write redirect. Shell stdin is recursively classified; non-shell source is
 * blocked because Bash classification cannot establish its write locations.
 * A body is inert only when its stdin owner is a known data consumer
 * (STDIN_DATA_CONSUMERS); any other or unknown owner is blocked, so an
 * unrecognized interpreter cannot execute a body unclassified.
 *
 * Quoted regions: the `<<` operator is only detected outside quotes, so a heredoc
 * nested inside `"$(cat <<EOF)"` is not bound here. The substitution body is
 * classified separately. When an outer shell consumes the substitution result as
 * its script (`bash -c "$(…)"`, `eval "$(…)"`, `bash <(…)`),
 * `classifySubstitutionScript` (readonly-bash.ts) forces the body to code; in a
 * data position (`echo "$(cat <<EOF)"`) the body stays inert.
 */
export type HeredocBody = { spec: HeredocSpec; text: string };
type HeredocState = { header: string; kept: string[]; pending: HeredocSpec[]; body: string[]; continuation: string | null; heredocs: Map<string, HeredocBody>; markerPrefix: string };

/** Expansion environments plus the consuming shell's variables for child code. They differ: a
 * direct `D=x cmd <<EOF` assignment may or may not expand the body (see `expansionCandidates`),
 * while an `env D=x cmd` operand does not — `env` has not run when the outer shell reads it. */
export type HeredocEnvironments = { parent: ReadonlyMap<string, string>; prefix: ReadonlyMap<string, string>; child: ReadonlyMap<string, string> };

/** Shells disagree on whether a redirect command's leading assignments are visible to its
 * unquoted heredoc expansion: bash <= 4.0 applies them, >= 4.1 expands with the parent
 * environment first (manual: redirections before assignment values). Classify under both and
 * block if either fails, so the verdict never depends on the host shell's version. The parent
 * candidate models >= 4.1 exactly: a prefix-only name is unset there, and unset plain names
 * expand to "" — ambient values still come from `process.env`. Other names absent from both
 * maps keep failing closed, guarding against assignments the classifier failed to track. `PWD`
 * is seeded into shell state from the tracked cwd and refreshed on every directory change, so it
 * already exists in `parent` and a PWD prefix cannot blank it here. */
function expansionCandidates({ parent, prefix }: HeredocEnvironments): readonly ReadonlyMap<string, string>[] {
	if (sameVariables(parent, prefix)) return [parent];
	const parentModel = new Map(parent);
	for (const name of prefix.keys()) if (!parent.has(name) && process.env[name] === undefined) parentModel.set(name, "");
	return [parentModel, prefix];
}

const CANDIDATE_LABELS = ["parent expansion", "assignment-prefix expansion"] as const;

/** Attribute a candidate's failure to its expansion model, so a script that works on the user's
 * own shell still points at the version divergence. Unlabeled when one model suffices. */
function candidateReason(expansions: readonly ReadonlyMap<string, string>[], index: number, reason: string): string {
	return expansions.length > 1 ? nestedBlockReason(CANDIDATE_LABELS[index], reason) : reason;
}

function sameVariables(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [name, value] of a) if (b.get(name) !== value) return false;
	return true;
}

export function classifyHeredocBody({ spec, text }: HeredocBody, state: ShellState, depth: number, env?: HeredocEnvironments): Verdict {
	const childVars = env?.child ?? state.vars;
	const expansions = env ? expansionCandidates(env) : [state.vars];
	if (!spec.keep) return spec.quoted ? { ok: true } : classifyHeredocData(text, state, depth, expansions);
	if (spec.quoted) return classifyHeredocCode(text, spec, state, depth, childVars);
	// Bash expands unquoted stdin in the outer shell before the child runs, then the body executes
	// in the consuming shell's environment. Labels name the model whose expansion failed, including
	// value-independent failures such as an unsupported `$` form. Classification failures are
	// labeled only if the expanded text differs between candidates; identical expansions imply the
	// child environment failed, so labeling would mislead.
	const expandedTexts: string[] = [];
	for (const [index, vars] of expansions.entries()) {
		const expanded = expandHeredocText(text, vars);
		if (expanded === null) return { ok: false, reason: candidateReason(expansions, index, `unresolvable shell heredoc expansion${FAIL_CLOSED_HINT}`) };
		expandedTexts.push(expanded);
	}
	const firstExpanded = expandedTexts[0];
	const sameExpansion = expandedTexts.every(exp => exp === firstExpanded);
	for (const [index, expanded] of expandedTexts.entries()) {
		const verdict = classifyHeredocCode(expanded, spec, state, depth, childVars);
		if (!verdict.ok) return sameExpansion ? verdict : { ok: false, reason: candidateReason(expansions, index, verdict.reason) };
	}
	return { ok: true };
}

function classifyHeredocData(text: string, state: ShellState, depth: number, expansions: readonly ReadonlyMap<string, string>[]): Verdict {
	// An unquoted data body still runs its command substitutions in the outer shell. Failures are
	// expansion-dependent: the same command text is classified under each candidate's variables.
	const commands = extractCommandSubstitutions(text);
	for (const [index, vars] of expansions.entries()) {
		for (const command of commands) {
			const verdict = classifyBashWithHeredocs(command, state.cwd, depth, vars, state.heredocs);
			if (!verdict.ok) return { ok: false, reason: candidateReason(expansions, index, verdict.reason) };
		}
	}
	return { ok: true };
}

function classifyHeredocCode(text: string, spec: HeredocSpec, state: ShellState, depth: number, vars: ReadonlyMap<string, string>): Verdict {
	const code = spec.stdinPrefix ? `${spec.stdinPrefix}; ${text}` : text;
	return classifyBashWithHeredocs(code, state.cwd, depth, vars, state.heredocs);
}

function expandHeredocText(text: string, vars: ReadonlyMap<string, string>): string | null {
	let expanded = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\" && /[$`\\\n]/.test(text[i + 1] ?? "")) {
			const next = text[++i];
			if (next !== "\n") expanded += next;
			continue;
		}
		if (ch === "`") return null; // Substitution output can generate arbitrary child code.
		if (ch !== "$") { expanded += ch; continue; }
		const reference = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/)?.[0];
		if (!reference) return null; // Unsupported parameter/arithmetic/substitution output fails closed.
		const value = heredocVariableValue(reference, vars);
		if (value === undefined) return null;
		expanded += value;
		i += reference.length - 1;
	}
	return expanded;
}

function heredocVariableValue(reference: string, vars: ReadonlyMap<string, string>): string | undefined {
	const name = reference.replace(/^\$\{?|\}$/g, "");
	return vars.get(name) ?? process.env[name];
}

function startHeredocHeader(line: string, state: HeredocState): boolean {
	state.header += line;
	if (shellHeaderContinues(state.header)) {
		// A backslash continuation is removed; `|`/`&&` retain their operator.
		if (state.header.endsWith("\\")) state.header = state.header.slice(0, -1);
		return true;
	}
	const specs = findHeredocDelimiters(state.header);
	if (specs === null) return false;
	for (const [index, spec] of specs.entries()) spec.marker = `${state.markerPrefix}${state.heredocs.size + index}`;
	state.kept.push(replaceHeredocOperators(state.header, specs));
	state.pending.push(...specs);
	state.header = "";
	return true;
}

/** An unescaped trailing backslash makes Bash delete the following newline. An odd run ends
 * with an unescaped backslash; an even run ends with an escaped one, so the newline stands. */
function endsWithUnescapedBackslash(line: string): boolean {
	let trailing = 0;
	for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) trailing++;
	return trailing % 2 === 1;
}

function processHeredocLine(line: string, state: HeredocState): boolean {
	const current = state.pending[0];
	if (!current) return startHeredocHeader(line, state);
	const candidate = (state.continuation ?? "") + (current.stripTabs ? line.replace(/^\t+/, "") : line);
	state.continuation = null;
	// Bash removes unescaped backslash-newline pairs from body and delimiter lines before it
	// compares the delimiter, so a split delimiter joins. Quoted delimiters keep the backslash.
	if (!current.quoted && endsWithUnescapedBackslash(candidate)) {
		state.continuation = candidate.slice(0, -1);
		return true;
	}
	if (candidate !== current.delimiter) { state.body.push(candidate); return true; }
	state.heredocs.set(current.marker!, { spec: current, text: state.body.join("\n") });
	state.body.length = 0;
	state.pending.shift();
	return true;
}

export function stripHeredocBodies(cmd: string, inherited: ReadonlyMap<string, HeredocBody>): { command: string; heredocs: Map<string, HeredocBody> } | null {
	let markerPrefix = "__readonly_heredoc_";
	while (cmd.includes(markerPrefix) || [...inherited.keys()].some((key) => key.startsWith(markerPrefix))) markerPrefix += "_";
	const state: HeredocState = { header: "", kept: [], pending: [], body: [], continuation: null, heredocs: new Map(inherited), markerPrefix };
	for (const line of cmd.split("\n")) {
		if (!processHeredocLine(line, state)) return null;
	}
	return state.pending.length || state.header ? null : { command: state.kept.join("\n"), heredocs: state.heredocs };
}

/** Place checks at the redirect, before commands later on the same header line. */
function replaceHeredocOperators(header: string, specs: (HeredocSpec & { start: number; end: number })[]): string {
	let result = header;
	for (const spec of [...specs].reverse()) {
		let start = spec.start;
		while (start > 0 && /\d/.test(result[start - 1] ?? "")) start--;
		result = result.slice(0, start) + ` $(${spec.marker}) ` + result.slice(spec.end);
	}
	return result;
}

function shellHeaderContinues(line: string): boolean {
	const scan: ShellScan = { current: "", quote: "", escaped: false, nesting: 0 };
	for (let i = 0; i < line.length; i++) {
		if (consumeShellCharacter(scan, line[i], line.slice(0, i))) continue;
		if (line[i] === "#" && (i === 0 || /\s/.test(line[i - 1]))) return false;
	}
	if (scan.escaped) return true;
	if (scan.quote) return false;
	// A trailing pipe or `&&` continues onto the next line; a lone `&` is background.
	const trimmed = line.replace(/\s+$/, "");
	return trimmed.endsWith("|") || trimmed.endsWith("&&") || trimmed.endsWith("|&");
}

export type HeredocSpec = { delimiter: string; stripTabs: boolean; quoted: boolean; keep: boolean; stdinPrefix?: string; consumerStage?: string; marker?: string };

/** Heredoc delimiters introduced on a single line, outside quotes. */
function findHeredocDelimiters(line: string): (HeredocSpec & { start: number; end: number })[] | null {
	const found: (HeredocSpec & { start: number; end: number })[] = [];
	const scan: ShellScan = { current: "", quote: "", escaped: false, nesting: 0 };
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (consumeShellCharacter(scan, ch, line.slice(0, i))) continue;
		if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
		const skipped = skipNonHeredocOperator(line, i);
		if (skipped > i) { i = skipped; continue; }
		if (ch !== "<" || line[i + 1] !== "<") continue;
		const parsed = readStdinRedirect(line, i);
		if (parsed === "blocked") return null;
		if (line[i + 2] === "<") { i += 2; continue; }
		if (parsed) { found.push(parsed); i = parsed.end - 1; }
	}
	return found;
}

function readStdinRedirect(line: string, start: number): (HeredocSpec & { start: number; end: number }) | "blocked" | null {
	const owner = stdinRedirectOwner(line, start);
	if (owner === null) return "blocked";
	const code = stdinCodeKind(owner);
	const hereString = line[start + 2] === "<";
	// Here strings expand a word before execution; do not treat that word as literal shell code.
	if (code === "other" || (hereString && code === "shell")) return "blocked";
	if (hereString) return null;
	const parsed = readHeredocDelimiter(line, start);
	if (!parsed) return null;
	if (code !== "shell") return { ...parsed, keep: false };
	// The body runs at the consuming shell's cwd (which a `-c` script may move first) and in that
	// shell's environment; both come from one owner walk so they cannot drift.
	const consumer = shellStdinConsumer(owner);
	return consumer === null ? "blocked" : { ...parsed, keep: true, stdinPrefix: consumer.cwdPrefix.join("; ") || undefined, consumerStage: consumer.stage };
}

/** Redirects may precede the executable; ownership spans the entire simple command. */
export function stdinRedirectOwner(line: string, start: number): string | null {
	const before = splitUnquotedShellSegments(line.slice(0, start)).at(-1)?.text ?? "";
	// The whole tail matters: a pipeline after the heredoc (`cat <<E | bash`) is a
	// downstream stdin consumer that must be analyzed.
	return stripStdinOwnerRedirects(before + line.slice(start));
}

function stripStdinOwnerRedirects(header: string): string | null {
	const scan: ShellScan = { current: "", quote: "", escaped: false, nesting: 0 };
	let owner = "";
	for (let i = 0; i < header.length; i++) {
		const ch = header[i];
		if (consumeShellCharacter(scan, ch, header.slice(0, i)) || !"<>".includes(ch)) { owner += ch; continue; }
		const end = stdinOwnerRedirectEnd(header, i);
		if (end === null) return null;
		owner = stripTrailingFdPrefix(owner) + " ";
		i = end - 1;
	}
	return scan.quote || scan.escaped || scan.nesting ? null : owner;
}

/** Drop an fd/var prefix that belongs to the redirect, not the preceding command word. */
function stripTrailingFdPrefix(owner: string): string {
	return owner.replace(/(?:^|(?<=\s))(?:\d+|&|\{[A-Za-z_][A-Za-z0-9_]*\})?$/, "");
}

function stdinOwnerRedirectEnd(header: string, start: number): number | null {
	const operator = header.slice(start).match(/^(?:<<<|<<-?|>>|<>|[<>][&|]?)/)?.[0];
	if (!operator) return null;
	let i = start + operator.length;
	while (/\s/.test(header[i] ?? "") && i < header.length) i++;
	return readShellDelimiterWord(header, i)?.end ?? null;
}

function skipNonHeredocOperator(line: string, i: number): number {
	// Arithmetic expansions/commands contain `<<` operators that are not redirections.
	if (line.slice(i, i + 3) === "$((") return Math.max(i, findArithmeticEnd(line, i + 3) - 1);
	if (line.slice(i, i + 2) === "((") return Math.max(i, findArithmeticEnd(line, i + 2) - 1);
	return i;
}

/** Read the delimiter word after a `<<` / `<<-` operator, unquoting it. */
function readHeredocDelimiter(cmd: string, start: number): (Omit<HeredocSpec, "keep"> & { start: number; end: number }) | null {
	const stripTabs = cmd[start + 2] === "-";
	let i = start + (stripTabs ? 3 : 2);
	while (cmd[i] === " " || cmd[i] === "\t") i++;
	const word = readShellDelimiterWord(cmd, i);
	return word ? { ...word, stripTabs, start } : null;
}

function readShellDelimiterWord(cmd: string, start: number): { delimiter: string; quoted: boolean; end: number } | null {
	let delimiter = "", quoted = false, quote = "", i = start;
	for (; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (!quote && /[\s;|&<>()]/.test(ch)) break;
		// Single quotes make every character literal, including backslashes.
		if (quote === "'") { if (ch === "'") quote = ""; else delimiter += ch; continue; }
		if (ch === "\\") {
			quoted = true;
			// Inside double quotes Bash keeps `\` before ordinary characters (only `$`, `` ` ``,
			// `"`, `\`, and newline are escaped); outside any quote it escapes the next char.
			if (quote === '"' && !'$`"\\\n'.includes(cmd[i + 1] ?? "")) { delimiter += "\\"; continue; }
			delimiter += cmd[++i] ?? "";
			continue;
		}
		if (quote) { if (ch === quote) quote = ""; else delimiter += ch; continue; }
		// `$'...'` is ANSI-C quoting: decode it and keep reading the same word, so `$'E'O`
		// (the ANSI-C fragment plus a literal) yields the joined delimiter `EO` as Bash does.
		if (ch === "$" && cmd[i + 1] === "'") {
			const ansi = readAnsiCDelimiterWord(cmd, i);
			if (ansi === null) return null;
			delimiter += ansi.delimiter;
			quoted = true;
			i = ansi.end - 1;
			continue;
		}
		if (ch === "'" || ch === '"') { quoted = true; quote = ch; continue; }
		delimiter += ch;
	}
	return quote || i === start ? null : { delimiter, quoted, end: i };
}

// Bash ANSI-C escapes (https://www.gnu.org/software/bash/manual/bash.html#ANSI_002dC-Quoting).
const ANSI_C_ESCAPES: Record<string, string> = {
	a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
	"\\": "\\", "'": "'", '"': '"', "?": "?",
};

/** Read a `$'…'` word, decoding ANSI-C escapes. Null when it is unterminated. */
function readAnsiCDelimiterWord(cmd: string, start: number): { delimiter: string; end: number } | null {
	let delimiter = "", i = start + 2;
	for (; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (ch === "'") return { delimiter, end: i + 1 };
		if (ch !== "\\") { delimiter += ch; continue; }
		const decoded = decodeAnsiCEscape(cmd, i);
		delimiter += decoded.value;
		i = decoded.next;
	}
	return null;
}

/** Decode the escape at `slash` in a `$'…'` word; unknown escapes keep the backslash like Bash. */
function decodeAnsiCEscape(cmd: string, slash: number): { value: string; next: number } {
	const code = cmd[slash + 1] ?? "";
	if (code in ANSI_C_ESCAPES) return { value: ANSI_C_ESCAPES[code]!, next: slash + 1 };
	const radix = code === "x" ? 16 : /[0-7]/.test(code) ? 8 : 0;
	const digits = radix === 16 ? cmd.slice(slash + 2).match(/^[0-9a-fA-F]{1,2}/) : radix === 8 ? cmd.slice(slash + 1).match(/^[0-7]{1,3}/) : null;
	if (!digits) return { value: "\\" + code, next: slash + 1 };
	const consumed = digits[0].length + (radix === 16 ? 1 : 0);
	return { value: String.fromCodePoint(parseInt(digits[0], radix)), next: slash + consumed };
}

// Command prefixes that forward stdin to the wrapped command: the body's owner is the
// wrapped command, unwrapped further down. Any other unrecognized owner fails closed
// (`other`), because an unknown interpreter would execute the body unclassified.
const STDIN_WRAPPERS = new Set(["exec", "nohup", "timeout", "nice", "stdbuf", "time"]);
/** A bare `exec` fd target: `exec 3<<EOF` or `exec {fd}<<EOF`. */
const EXEC_PERSISTENT_FD = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

/**
 * True when `exec` leaves the heredoc on the shell's stdin/fd instead of running a
 * command: no command word follows, or the next word is a persisted fd.
 */
function execLeavesBodyPersistent(tokens: string[]): boolean {
	const next = stdinWrapperCommandIndex(tokens);
	return next >= tokens.length || EXEC_PERSISTENT_FD.test(unescapeCommandWord(tokens[next]!));
}

/** Only shell program source can be interpreted by the Bash classifier. */
export function stdinCodeKind(headerLine: string, depth = 0, sharedStdin = false): "shell" | "other" | "data" {
	// stdin flows down the pipeline only: `cat <<E | bash` executes the body as
	// code, while `cat <<E || bash` never feeds it (fallback, not consumer).
	// Group members are different: when a whole group arrives as one stage
	// (`{ bash; } <<E`), `sharedStdin` keeps the flow across its separators. A group
	// split across `;` before this point cannot be unwrapped and fails closed upstream.
	// A shell stage only sees the exact body when every earlier stage copies stdin to
	// stdout unchanged (bare `cat`); a transforming stage (`sed … | bash`) changes the
	// bytes the shell runs, so the body cannot be classified as the downstream code.
	const kinds: ("shell" | "other" | "data")[] = [];
	let flows = true, passThrough = true;
	for (const part of splitUnquotedShellSegments(headerLine)) {
		const stage = part.text.trim();
		if (stage && flows) {
			const kind = stdinStageKind(stage, depth);
			if (kind === "shell" && !passThrough) return "other";
			kinds.push(kind);
			if (!stdinPassThroughStage(stage)) passThrough = false;
		}
		flows = sharedStdin || part.operator === "|" || part.operator === "|&";
	}
	if (kinds.includes("shell")) return "shell";
	return kinds.includes("other") ? "other" : "data";
}

/** A pipeline stage that copies stdin to stdout byte-for-byte: bare `cat` reading stdin. */
function stdinPassThroughStage(stage: string): boolean {
	const tokens = stdinCommandTokens(envSplitCommand(stage) ?? stage);
	if (normalizedCommand(tokens[0] ?? "") !== "cat") return false;
	return tokens.length === 1 || (tokens.length === 2 && unescapeCommandWord(tokens[1]!) === "-");
}

function unwrapStdinTokens(tokens: string[]): string[] {
	const command = normalizedCommand(tokens[0]);
	if (command === "sudo") return tokens.slice(findSudoCommandIndex(tokens));
	if (STDIN_WRAPPERS.has(command)) return tokens.slice(stdinWrapperCommandIndex(tokens));
	return [];
}

/**
 * Inner body of a fully-wrapped `{ ...; }` / `( ... )` stdin owner, else null.
 * A heredoc attaches to a group's stdin, so `{ bash; } <<EOF` feeds the body to
 * `bash` exactly like `bash <<EOF`. Without this, the owner word is `{`/`(` and the
 * body would be misread as inert data — command execution escaping classification.
 */
function unwrapStdinGroup(stage: string, depth: number): string | null {
	if (depth > 10) return null;
	const trimmed = stage.trim();
	const wrapped = (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("(") && trimmed.endsWith(")"));
	return wrapped ? trimmed.slice(1, -1).trim() : null;
}

/** Prefix-stripping token extraction for stdin ownership classification. */
function stdinCommandTokens(segment: string): string[] {
	return parseCommandPrefix(segment, new Map()).tokens;
}

export function stdinStageKind(stage: string, depth = 0): "shell" | "other" | "data" {
	const group = unwrapStdinGroup(stage, depth);
	if (group !== null) return stdinCodeKind(group, depth + 1, true);
	let tokens = stdinCommandTokens(envSplitCommand(stage) ?? stage);
	for (let step = 0; tokens.length && step < 10; step++) {
		const command = normalizedCommand(tokens[0]);
		// Dynamic or composite executable words cannot establish stdin ownership.
		if (/[$`\\'"]/.test(command)) return "other";
		// `exec` without a command keeps the body on the shell's persistent stdin/fd, so
		// a later command can execute it — fail closed.
		if (command === "exec" && execLeavesBodyPersistent(tokens)) return "other";
		if (SHELL_SCRIPT_CONSUMERS.has(command)) return "shell";
		if (INTERPRETERS.has(command)) return "other";
		const unwrapped = unwrapStdinTokens(tokens);
		if (unwrapped.length) { tokens = stdinCommandTokens(unwrapped.join(" ")); continue; }
		if (command === "xargs" || COMPOUND_FRAGMENT.test(` ${stage} `)) return "other";
		return stdinDataKind(command, tokens);
	}
	return tokens.length ? stdinDataKind(normalizedCommand(tokens[0]), tokens) : "other";
}

/** Data consumers read stdin as inert bytes — except GNU sed running an `e` script. */
function stdinDataKind(command: string, tokens: string[]): "data" | "other" {
	if (!STDIN_DATA_CONSUMERS.has(command)) return "other";
	if (command === "sed" && sedScriptExecutesStdin(tokens)) return "other";
	return "data";
}

/**
 * Script words from sed args: `-e`/`--expression` values, or the first operand when
 * no script flag is given. Null when a script is unreadable (`-f` file, `-` stdin) —
 * the classifier cannot see it, so ownership must fail closed. In a short-flag
 * cluster the first `e`/`f` consumes the rest of the word as its value.
 */
function sedScripts(tokens: string[]): string[] | null {
	const scripts: string[] = [];
	const args = tokens.slice(1).map((token) => unescapeCommandWord(token));
	let operandIsScript = true;
	for (let i = 0; i < args.length; i++) {
		if (!args[i]!.startsWith("-")) { if (operandIsScript) scripts.push(args[i]!); break; }
		const arg = sedArgScript(args, i);
		if (arg?.script === null) return null;
		if (arg) { scripts.push(arg.script); i = arg.next; operandIsScript = false; }
	}
	return scripts.includes("") ? null : scripts;
}

/** One sed option's script (consuming through `next`), script:null for unreadable, null for a plain flag. */
function sedArgScript(args: string[], i: number): { script: string | null; next: number } | null {
	const word = args[i]!;
	const [name, inline] = splitFlagValue(word);
	if (word === "-f" || name === "--file" || word === "-") return { script: null, next: i };
	if (word === "-e" || word === "--expression") return { script: args[i + 1] ?? "", next: i + 1 };
	if (name === "--expression" && inline !== undefined) return { script: inline, next: i };
	if (word.startsWith("--")) return null;
	const ef = word.search(/[ef]/);
	if (ef === -1) return null;
	if (word[ef] === "f") return { script: null, next: i };
	const attached = word.slice(ef + 1);
	return attached ? { script: attached, next: i } : { script: args[i + 1] ?? "", next: i + 1 };
}

// GNU sed `e` executes the pattern space as a shell command, so a body fed to
// `sed -n e` is code, not data (POSIX sed has no `e` — the divergence is why the
// check is word-boundary based). A command starts after a `;`/newline/`{}` boundary.
const SED_ADDRESS = String.raw`(?:[0-9$~+]+|\/(?:\\.|[^/\\])*\/|\\(?:\\.|[^;\\])*)`;
const SED_EXEC_COMMAND = new RegExp(String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*${SED_ADDRESS})?\s*!?)?\s*e(?:\s|$)`);
// `s<d>regex<d>replacement<d>flags` with an `e` flag executes the substituted pattern
// space. Delimiter-aware: `<d>` is any character, and `\<d>` escapes it inside the parts.
const SED_SUBSTITUTION = /s([\s\S])(?:\\[\s\S]|(?!\1)[\s\S])*\1(?:\\[\s\S]|(?!\1)[\s\S])*\1([a-z]*)/g;

function sedSubstitutionExecutes(fragment: string): boolean {
	for (const match of fragment.matchAll(SED_SUBSTITUTION)) if (match[2]!.includes("e")) return true;
	return false;
}

function sedScriptExecutesStdin(tokens: string[]): boolean {
	const scripts = sedScripts(tokens);
	if (scripts === null) return true; // unreadable script — fail closed
	return scripts.some((script) => script.split(/[;\n{}]/).some((fragment) =>
		SED_EXEC_COMMAND.test(fragment) || sedSubstitutionExecutes(fragment)));
}

function stdinWrapperCommandIndex(tokens: string[]): number {
	const valued = new Set(["-k", "--kill-after", "-s", "--signal", "-n", "--adjustment", "-i", "-o", "-e", "-f", "--format", "--output"]);
	let i = 1;
	while (tokens[i] && unescapeCommandWord(tokens[i]).startsWith("-")) {
		const word = unescapeCommandWord(tokens[i]);
		if (word === "--") { i++; break; }
		i += valued.has(word) ? 2 : 1;
	}
	return normalizedCommand(tokens[0]) === "timeout" ? i + 1 : i;
}

/**
 * Directory changes a shell stdin owner applies (via `-c` scripts) before the body
 * runs: `bash -c 'cd /; bash' <<EOF` executes the body at `/`, not the parent cwd.
 * Null means the chain cannot be resolved — the owner must fail closed.
 */
/** The shell stage that consumes the heredoc body: it executes the body and owns its
 * environment (wrapper commands stripped, so its prefix assignments stay visible), and
 * a `-c` script inside it may move cwd first. Null fails closed. */
function shellStdinConsumer(owner: string, depth = 0): { stage: string; cwdPrefix: string[] } | null {
	if (depth > 10) return null;
	let flows = true;
	for (const part of splitUnquotedShellSegments(owner)) {
		const stage = part.text.trim();
		// The body flows down the pipeline into the first shell stage.
		if (stage && flows && stdinStageKind(stage, depth) === "shell") {
			const consumer = stageCwdPrefix(stage, depth);
			return consumer === null ? null : { stage: consumer.shellStage, cwdPrefix: consumer.cwdPrefix };
		}
		flows = part.operator === "|" || part.operator === "|&";
	}
	return null;
}

/** Prefix for one pipeline stage: unwraps groups/wrappers down to the shell invocation.
 * `shellStage` is the invocation text at the point the walk reached the shell, so prefix
 * assignments survive wrapper stripping (`sudo D=x bash` → `D=x bash`) and the child
 * environment parses from it without unwrapping a second time. */
function stageCwdPrefix(stage: string, depth: number): { cwdPrefix: string[]; shellStage: string } | null {
	const group = unwrapStdinGroup(stage, depth);
	if (group !== null) return scriptCwdPrefix(group, depth + 1);
	let text = envSplitCommand(stage) ?? stage;
	let tokens = stdinCommandTokens(text);
	for (let step = 0; step < 10 && tokens.length; step++) {
		if (SHELL_SCRIPT_CONSUMERS.has(normalizedCommand(tokens[0]))) {
			// The body runs in the script's stdin-consuming member, whose environment is the
			// outer invocation's: anything else the script sets up first fails closed below.
			const script = interpreterStdinScript(tokens.slice(1));
			const inner = script === null ? { cwdPrefix: [] as string[] } : scriptCwdPrefix(script, depth);
			return inner === null ? null : { cwdPrefix: inner.cwdPrefix, shellStage: text };
		}
		const unwrapped = unwrapStdinTokens(tokens);
		if (!unwrapped.length) return null;
		text = unwrapped.join(" ");
		tokens = stdinCommandTokens(text);
	}
	return null;
}

/**
 * Directory changes in a `-c` script or group body up to its stdin-consuming member.
 * Anything else before the consumer could read or redirect stdin in ways the
 * classifier cannot model — fail closed (null).
 */
function scriptCwdPrefix(script: string, depth: number): { cwdPrefix: string[]; shellStage: string } | null {
	if (depth > 10) return null;
	const prefix: string[] = [];
	for (const part of splitUnquotedShellSegments(script)) {
		const text = part.text.trim();
		if (!text) continue;
		if (stdinStageKind(text, depth) === "shell") {
			const inner = stageCwdPrefix(text, depth);
			return inner === null ? null : { cwdPrefix: [...prefix, ...inner.cwdPrefix], shellStage: inner.shellStage };
		}
		if (!DIR_CHANGE_BUILTINS.has(normalizedCommand(stdinCommandTokens(text)[0] ?? ""))) return null;
		prefix.push(text);
	}
	return null;
}

/** The `-c` script word a shell executes, or null when it reads program source from stdin/a file. */
function interpreterStdinScript(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const word = unescapeCommandWord(args[i]!);
		if (word === "--") return null;
		if (/^-[a-zA-Z]*c$/.test(word)) return args[i + 1] ? demangleNestedArgument(args[i + 1]!) : null;
	}
	return null;
}
