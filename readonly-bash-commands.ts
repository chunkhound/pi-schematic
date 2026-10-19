/**
 * Per-command mutation classifiers and shared token utilities.
 *
 * Each `classify*` function handles one command shape (sudo, env, interpreter,
 * wget, curl, xargs, generic mutation, package manager). The dispatcher chains
 * them; the first matching reason wins. Target extractors (getRmTargets, etc.)
 * pull filesystem paths from command arguments for temp-dir checking.
 */
import { decodeShellAssignmentValue, decodeShellWord, tempPathBlockReason, rawAttachedFlagValue, stripMatchingQuotes, stripRedirectTokens, expandShellVariable, splitFlagValue, normalizedCommand, unescapeCommandWord, getCommandTokens, SHELL_WORD_PATTERN, SHELL_SCRIPT_CONSUMERS, skipLeadingRedirections } from "./readonly-shell-utils.js";
import { matchingParenIndex, extractProcessSubstitutions } from "./readonly-bash-scanner.js";
import { classifyGit } from "./readonly-bash-git.js";
import { resolveDirectoryTarget } from "./readonly-bash-dirchange.js";
import { classifyBashCommand, classifySubstitutionOutput, classifySubstitutionScript } from "./readonly-bash.js";
import { buildReadonlyPackageManagerBlockReason, FAIL_CLOSED_HINT } from "./notifications.js";

// Interpreters whose inline-execution flag is recursively classified.
// node -c = syntax check only (non-executing); -e/--eval and -p/--print execute code.
// perl -E is -e with optional features enabled.
// One table holds every modeled alias so a modeled spelling cannot bypass the check.
export const INTERPRETER_EXEC_FLAGS: Record<string, readonly string[]> = {
	node: ["-e", "--eval", "-p", "--print"],
	bash: ["-c"], sh: ["-c"], zsh: ["-c"], dash: ["-c"], ksh: ["-c"],
	python3: ["-c"], python: ["-c"],
	perl: ["-e", "-E"],
	ruby: ["-e"],
};

export const INTERPRETERS = new Set(Object.keys(INTERPRETER_EXEC_FLAGS));

// Interpreters that accept an attached inline script (`python3 -cprint(1)`, `perl -e'…'`).
// Shells do not: `bash -ce 'cmd'` treats `e` as a flag and runs the next word.
// Node rejects attached scripts; treating one as code only over-blocks, never misses code.
const ATTACHED_SCRIPT_INTERPRETERS = new Set(["node", "python", "python3", "perl", "ruby"]);

// Package managers are blocked unconditionally — they mutate system state
// outside any single directory (npm install writes to node_modules, pip
// installs to site-packages, etc.). Temp-dir path checking is not meaningful.
export const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "pip", "pip3", "pipx", "apt", "apt-get", "brew", "cargo", "gem", "yum", "dnf", "pacman", "choco"]);

// Shells whose command strings this classifier cannot parse are blocked
// unconditionally. Matched on the basename so Windows paths such as
// C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe are caught.
const UNPARSABLE_SHELLS = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe"]);

// ── Command-specific mutation classifiers (one per command, ≤15 lines each) ──

/** Strip subshell parens and recurse; a trailing redirect is checked by the caller. */
export function classifySubshellSegment(segment: string, cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (!segment.startsWith("(")) return null;
	const end = matchingParenIndex(segment, 0);
	if (end === -1) return null;
	// `((...))` is arithmetic, not a nested subshell: `<<` is a shift and bare words are
	// not commands. Only mutation-like words matter (substitutions are checked by the caller).
	if (segment.startsWith("((") && end === segment.length - 1) {
		return getFilesystemMutationReason(segment.slice(2, -2), cwd, depth, shellVars);
	}
	const inner = segment.slice(1, end).trim();
	if (!inner) return null;
	const nested = classifyBashCommand(inner, cwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** eval/exec/coproc: recursively classify the remaining argument string. */
export function classifyEvalExec(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "eval" && command !== "exec" && command !== "coproc") return null;
	// eval re-parses its args as a flat word list, so quote grouping is already
	// resolved. exec/coproc execute the parsed command directly — their quotes
	// still group words and must reach the nested classification intact.
	const inner = command === "eval" ? tokens.slice(1).map(demangleNestedArgument).join(" ") : tokens.slice(1).join(" ");
	// eval runs the substitution result as shell code, so a heredoc body inside it is code too.
	if (command === "eval") {
		const outputReason = classifySubstitutionOutput(inner, cwd, depth, shellVars);
		if (outputReason) return `eval substitution blocked: ${outputReason}`;
	}
	// A whole-substitution argument runs the substitution's OUTPUT; its heredoc bodies
	// were forced to code above. Classifying the raw `$(…)` text as shell would misread
	// the substitution command as the program.
	if (isWholeCommandSubstitution(inner)) return null;
	const nested = classifyBashCommand(inner, cwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** sudo: classify the command after sudo flags. */
export function classifySudo(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "sudo") return null;
	const nested = classifyBashCommand(tokens.slice(findSudoCommandIndex(tokens)).join(" "), cwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** env: classify the wrapped command, applying `-C/--chdir`; an unresolved child cwd fails closed. */
export function classifyEnv(command: string, segment: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "env") return null;
	const prefix = skipEnvOptions(tokens, 1);
	// `-S`/`--split-string` carries the whole wrapped command and Bash appends the
	// remaining argv; `-C` keeps the wrapped command in tokens.
	const split = prefix.splitString;
	const wrapped = split !== null
		? [stripMatchingQuotes(split), ...tokens.slice(prefix.next)].join(" ")
		: envSplitCommand(segment) ?? (tokens.length > 1 ? tokens.slice(prefix.next).join(" ") : null);
	if (wrapped === null || wrapped === "") return null;
	const childCwd = prefix.chdir === null ? cwd : resolveDirectoryTarget(prefix.chdir, cwd, shellVars);
	if (childCwd === null) return `env directory change blocked: unresolved working directory${FAIL_CLOSED_HINT}`;
	const nested = classifyBashCommand(wrapped, childCwd, depth + 1, shellVars);
	return nested.ok ? null : nested.reason;
}

/** PowerShell and cmd: block unconditionally — their syntax is not parsed.
 * Takes the raw command word, not `normalizedCommand` output: `unescapeCommandWord`
 * consumes `\` as an escape, so a Windows path would lose its separators before the
 * basename is extracted and the check would silently miss it. */
export function classifyUnparsableShell(rawCommandWord: string): string | null {
	const shell = stripMatchingQuotes(rawCommandWord).toLowerCase().split(/[\\/]/).pop()!;
	if (!UNPARSABLE_SHELLS.has(shell)) return null;
	return `${shell} blocked: readonly cannot inspect commands run through ${shell}`;
}

/**
 * Approximate the word the nested shell receives: decode `$'...'` ANSI-C quoting and
 * turn `\$` into `$`, so `\$(` and `$'$( )'` are seen as substitutions. Unescaping can
 * only over-block, which fails closed.
 */
export function demangleNestedArgument(raw: string): string {
	if (raw.startsWith("$'") && raw.endsWith("'")) return raw.slice(2, -1).replace(/\\(.)/g, "$1");
	return stripMatchingQuotes(raw).replace(/\\\$/g, "$");
}

/** Script attached to a flag in the decoded word. The raw suffix keeps `$'…'` intact;
 * the decoded suffix is what the interpreter receives when quoting splits the prefix
 * (`perl -w'e'…`, `'-e'…`). Never substitute a path sentinel here: classifyInlineScript
 * would read it as a whole command substitution and skip the script. */
function attachedInterpreterScript(raw: string, word: string, prefix: string): string {
	return raw.startsWith(prefix) ? raw.slice(prefix.length) : word.slice(prefix.length);
}

/** Script carried by a short option cluster. Leading option letters and digits are flags;
 * value-taking letters before the exec letter can move the script into their value, so
 * treating the remainder as code may over-block. That is the safe direction. */
function clusteredInterpreterScript(command: string, raw: string, word: string, flag: string, next: string | undefined): string | null {
	const match = /^-([A-Za-z0-9]+)(.*)$/.exec(word);
	if (!match) return null;
	const letters = match[1]!;
	const at = letters.indexOf(flag[1]!);
	if (at === -1) return null;
	if (!ATTACHED_SCRIPT_INTERPRETERS.has(command)) return next ?? null;
	const attached = attachedInterpreterScript(raw, word, `-${letters.slice(0, at + 1)}`);
	return attached || next || null;
}

/** Inline script named by one flag spelling, or null when this word is not that flag. */
function inlineInterpreterScript(command: string, raw: string, word: string, flag: string, next: string | undefined): string | null {
	if (flag.startsWith("--")) {
		if (word === flag) return next ?? null;
		return word.startsWith(`${flag}=`) ? attachedInterpreterScript(raw, word, `${flag}=`) : null;
	}
	if (word === flag) return next ?? null;
	if (word.startsWith(flag) && ATTACHED_SCRIPT_INTERPRETERS.has(command)) {
		return attachedInterpreterScript(raw, word, flag) || next || null;
	}
	return clusteredInterpreterScript(command, raw, word, flag, next);
}

/** Classify one inline script; a whole-substitution argument runs the substitution's
 * OUTPUT, so its heredoc bodies were already forced to code above. */
function classifyInlineScript(command: string, flag: string, rawScript: string, cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	const script = demangleNestedArgument(rawScript);
	// The inline script is code; a command substitution inside it is code once expanded.
	const outputReason = classifySubstitutionOutput(script, cwd, depth, shellVars);
	if (outputReason) return `${command} ${flag} blocked: ${outputReason}`;
	if (isWholeCommandSubstitution(script)) return null;
	const nested = classifyBashCommand(script, cwd, depth + 1, shellVars);
	return nested.ok ? null : `${command} ${flag} blocked: ${nested.reason}`;
}

/** Interpreters with inline-execution flags — classify inline code recursively. */
export function classifyInterpreter(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (!INTERPRETERS.has(command)) return null;
	const args = tokens.slice(1);
	for (let i = 0; i < args.length; i++) {
		const raw = args[i]!;
		const word = unescapeCommandWord(raw);
		for (const flag of INTERPRETER_EXEC_FLAGS[command]!) {
			const script = inlineInterpreterScript(command, raw, word, flag, args[i + 1]);
			if (script === null) continue;
			const reason = classifyInlineScript(command, flag, script, cwd, depth, shellVars);
			if (reason) return reason;
			break;
		}
	}
	return null;
}

/** `bash <(cmd)`: the fd content is the shell's script, so its heredoc body is code. */
export function classifyScriptProcessSubstitution(command: string, segment: string, cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (!SHELL_SCRIPT_CONSUMERS.has(command)) return null;
	for (const subcommand of extractProcessSubstitutions(segment)) {
		const reason = classifySubstitutionScript(subcommand, cwd, depth, shellVars);
		if (reason) return `process substitution blocked: ${reason}`;
	}
	return null;
}

/** dd of= target check. */
export function classifyDdOutput(segment: string, cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	const ddMatch = segment.match(/\bof=([^\s]+)/);
	return ddMatch ? tempPathBlockReason("dd output", ddMatch[1], cwd, shellVars) : null;
}

/** wget -P/--download-dir outside temp — block. No-flag case falls through to classifyGenericMutation. */
export function classifyWget(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "wget") return null;
	const wArgs = tokens.slice(1);
	const hasOutputFlag = wArgs.some((a) => {
		const word = unescapeCommandWord(a);
		return word === "-O" || word.startsWith("-O") || word === "--output-document" || word.startsWith("--output-document=");
	});
	if (hasOutputFlag) return null;
	const outputDir = getWgetOutputDir(tokens);
	return outputDir ? tempPathBlockReason("wget download dir", outputDir, cwd, shellVars) : null;
}

/** curl -O/--remote-name writes to disk — block unless cwd is temp. */
export function classifyCurl(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "curl") return null;
	const { hasRemoteName, outputDir } = getCurlWriteTargets(tokens);
	if (!hasRemoteName) return null;
	const reason = tempPathBlockReason("curl", outputDir ?? ".", cwd, shellVars);
	return reason ? `${reason} (use -o to write to a chosen path)` : null;
}

/**
 * A `$VAR` command word hides the executable from the dispatcher checks.
 * Expand it from tracked vars (or the environment) and reclassify the whole segment;
 * an unresolvable word fails closed because any program — including a mutating one —
 * could be named. Unquoted heredoc bodies (`bash <<EOF` + `$CMD`) funnel through here.
 */
export function dynamicCommandReason(tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	const expanded = expandShellVariable(unescapeCommandWord(tokens[0]!), shellVars);
	// A `$(...)`/backtick word never expands here: its output is opaque argv data.
	if (expanded === null || /[$`]/.test(expanded)) return `dynamic command blocked: cannot expand command word "${tokens[0]}"${FAIL_CLOSED_HINT}`;
	const nested = classifyBashCommand([expanded, ...tokens.slice(1)].join(" "), cwd, depth + 1, shellVars);
	return nested.ok ? null : `dynamic command blocked: ${nested.reason}`;
}

/** Command word whose expansion supplies the executable name instead of naming it. */
function isDynamicCommandWord(command: string): boolean {
	return command.startsWith("`") || /^\$(?:[A-Za-z_{(])/.test(command);
}

/** True when `script` is exactly one command-substitution word (`$(...)` or backticks). */
function isWholeCommandSubstitution(script: string): boolean {
	const trimmed = script.trim();
	if (trimmed.startsWith("$(")) return matchingParenIndex(trimmed, 1) === trimmed.length - 1;
	if (trimmed.startsWith("`")) return trimmed.indexOf("`", 1) === trimmed.length - 1;
	return false;
}

type XargsOptionArity = "value" | "flag" | "optional";

/** Option arity for `xargs`. A required value consumes the next token or the attached
 * rest; an optional value binds only when attached (`-iX`, `--eof=X`). Unknown options
 * fail closed: their value could otherwise become the wrapped command word. */
const XARGS_SHORT_ARITY: Record<string, XargsOptionArity> = {
	a: "value", d: "value", E: "value", I: "value", J: "value", L: "value", n: "value",
	P: "value", R: "value", s: "value", S: "value",
	e: "optional", i: "optional", l: "optional",
	"0": "flag", o: "flag", p: "flag", r: "flag", t: "flag", x: "flag",
};

const XARGS_LONG_ARITY: Record<string, XargsOptionArity> = {
	"--arg-file": "value", "--delimiter": "value", "--max-args": "value", "--max-chars": "value",
	"--max-lines": "optional", "--max-procs": "value", "--process-slot-var": "value",
	"--eof": "optional", "--replace": "optional",
	"--interactive": "flag", "--no-run-if-empty": "flag", "--null": "flag", "--open-tty": "flag",
	"--show-limits": "flag", "--verbose": "flag", "--exit": "flag", "--help": "flag", "--version": "flag",
};

/** Tokens consumed by one short `xargs` option, the replacement token it selects, and
 * mode resets: GNU xargs lets the last of replace/max-lines/max-args win. */
type XargsShortScan = { readonly size: number; readonly replaceToken: string | null; readonly clearsReplacement?: boolean; readonly maxArgsValue?: string; readonly unsafeJ?: boolean } | { readonly reason: string };

/** Decode the token xargs receives. A dynamic value cannot be compared to the wrapped
 * command, so it fails closed; a null return means the shell hides its value. `{}` is the
 * default token and stays literal even though the shell decoder rejects unquoted braces. */
function decodedReplacement(raw: string | undefined): string | null {
	const shell = decodeShellWord(raw ?? "");
	if (shell !== null) return shell;
	const word = unescapeCommandWord(raw ?? "");
	// Unquoted redirect/operator syntax ends the shell word; the fallback would keep it
	// attached and hide the real replacement token (`-I X<&0` passes `X` to xargs).
	return word !== "{}" && /[$`*?[\]{}~<>|&;()]/.test(word) ? null : word;
}

function replacementReason(raw: string | undefined): { reason: string } {
	return { reason: `xargs replacement token blocked: cannot model ${raw ?? "(missing)"}${FAIL_CLOSED_HINT}` };
}

/** `I`/`J` take a replacement token; `i` defaults to `{}` when bare. Other values are
 * consumed so they cannot become the wrapped command word. `J` is not a safe replacement
 * mode: BSD xargs appends stdin when its token is absent. */
function xargsShortOptionScan(raw: string, args: string[], index: number, word: string): XargsShortScan | null {
	const letters = word.slice(1);
	let clearsReplacement = false;
	for (let i = 0; i < letters.length; i++) {
		const letter = letters[i]!;
		const arity = XARGS_SHORT_ARITY[letter];
		if (arity === undefined) return null;
		const attached = letters.slice(i + 1);
		if (arity === "value") {
			const size = attached ? 1 : 2;
			if (letter === "L") return { size, replaceToken: null, clearsReplacement: true };
			if (letter === "n") {
				const rawValue = attached ? rawAttachedFlagValue(raw, `-${letters.slice(0, i + 1)}`) : args[index + 1] ?? "";
				return { size, replaceToken: null, maxArgsValue: decodeShellWord(rawValue) ?? rawValue };
			}
			if (letter === "J") return { size, replaceToken: null, clearsReplacement: true, unsafeJ: true };
			if (letter !== "I") return { size, replaceToken: null };
			const rawValue = attached ? rawAttachedFlagValue(raw, `-${letters.slice(0, i + 1)}`) : args[index + 1];
			const replaceToken = decodedReplacement(rawValue);
			return replaceToken === null ? replacementReason(rawValue) : { size, replaceToken };
		}
		// Optional values bind only when attached; bare `-i` still selects the default `{}`.
		if (arity === "optional" && attached) {
			if (letter === "l") return { size: 1, replaceToken: null, clearsReplacement: true };
			if (letter !== "i") return { size: 1, replaceToken: null };
			const rawValue = rawAttachedFlagValue(raw, `-${letters.slice(0, i + 1)}`);
			const replaceToken = decodedReplacement(rawValue);
			return replaceToken === null ? replacementReason(rawValue) : { size: 1, replaceToken };
		}
		if (letter === "l") clearsReplacement = true;
		if (letter === "i") return { size: 1, replaceToken: "{}" };
	}
	return { size: 1, replaceToken: null, clearsReplacement };
}

/** Wrapped-command start, the active replacement token, and whether BSD `-J` mode is active. */
type XargsOptionScan = { readonly start: number; readonly replaceToken: string | null; readonly unsafeJ: boolean };

function xargsCommandStart(args: string[]): XargsOptionScan | { reason: string } {
	let i = 0;
	let replaceToken: string | null = null;
	let unsafeJ = false;
	while (i < args.length) {
		const word = unescapeCommandWord(args[i]!);
		if (word === "--") return { start: i + 1, replaceToken, unsafeJ };
		if (!word.startsWith("-") || word === "-") return { start: i, replaceToken, unsafeJ };
		if (word.startsWith("--")) {
			const [name, inline] = splitFlagValue(word);
			const arity = XARGS_LONG_ARITY[name];
			if (arity === undefined) return { reason: `xargs option blocked: cannot model "${name}"${FAIL_CLOSED_HINT}` };
			if (name === "--replace") {
				const token = inline === undefined ? "{}" : decodedReplacement(inline);
				if (token === null) return replacementReason(inline);
				replaceToken = token;
				unsafeJ = false;
			}
			if (name === "--max-lines") { replaceToken = null; unsafeJ = false; }
			if (name === "--max-args") {
				const rawValue = inline ?? args[i + 1] ?? "";
				if ((decodeShellWord(rawValue) ?? rawValue) !== "1") { replaceToken = null; unsafeJ = false; }
			}
			i += arity === "value" && inline === undefined ? 2 : 1;
			continue;
		}
		const scan = xargsShortOptionScan(args[i]!, args, i, word);
		if (scan === null) return { reason: `xargs option blocked: cannot model "${word}"${FAIL_CLOSED_HINT}` };
		if ("reason" in scan) return scan;
		if (scan.clearsReplacement || (scan.maxArgsValue !== undefined && scan.maxArgsValue !== "1")) {
			replaceToken = null;
			unsafeJ = false;
		}
		if (scan.replaceToken !== null) {
			replaceToken = scan.replaceToken;
			unsafeJ = false;
		}
		if (scan.unsafeJ) {
			replaceToken = null;
			unsafeJ = true;
		}
		i += scan.size;
	}
	return { start: i, replaceToken, unsafeJ };
}

/** True when the word xargs receives can contain the replacement token. A token the
 * shell decoder cannot prove literal can still expand to it, so it fails closed. */
function carriesReplacementToken(token: string, replaceToken: string): boolean {
	const decoded = decodeShellWord(token);
	return decoded === null || decoded.includes(replaceToken);
}

/** Wrappers the dispatcher does not unwrap; xargs cannot prove their child without a
 * replacement token, so a mutation could hide behind them. */
const XARGS_WRAPPER_COMMANDS = new Set(["nohup", "nice", "timeout", "stdbuf", "chroot"]);

const XARGS_J_REASON = `xargs -J blocked: BSD -J can append stdin paths; use -I with explicit targets${FAIL_CLOSED_HINT}`;

/** Strip assignments that `env` parses before its command word. Quote removal happens
 * before the assignment split, so `env 'FOO=bar' rm` still hides rm without this. */
function stripXargsEnvAssignments(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(unescapeCommandWord(tokens[i]!))) i++;
	return tokens.slice(i);
}

/** Effective command tokens after wrappers the dispatcher models. Null when a child cwd
 * or split string cannot be represented as plain tokens; callers fail closed when stdin
 * can append. */
function xargsEffectiveTokens(tokens: string[]): string[] | null {
	let current = tokens;
	for (let depth = 0; depth < 10; depth++) {
		current = current.slice(collectCommandPrefixAssignments(current, 0, new Map()));
		if (current.length === 0) return null;
		const command = normalizedCommand(current[0]!);
		if (command === "sudo") { current = current.slice(findSudoCommandIndex(current)); continue; }
		if (command === "env") {
			const prefix = skipEnvOptions(current, 1);
			if (prefix.chdir !== null) return null;
			if (prefix.splitString !== null) {
				const split = envSplitCommand(current.join(" "));
				if (split === null) return null;
				current = stripXargsEnvAssignments(getCommandTokens(split));
				continue;
			}
			current = stripXargsEnvAssignments(current.slice(prefix.next));
			continue;
		}
		// xargs execs external programs only: shell builtins such as `command` and
		// `builtin` do not run their argument here, so do not unwrap them.
		return current;
	}
	return null;
}

/** Block a mutation launched by xargs unless -I/-i/--replace proves stdin is not appended.
 * `-J` always blocks mutations: BSD appends stdin when its token is absent. */
function xargsMutationReason(tokens: string[], replaceToken: string | null, unsafeJ: boolean): string | null {
	const effective = xargsEffectiveTokens(tokens);
	if (effective === null) {
		if (unsafeJ) return XARGS_J_REASON;
		return replaceToken === null ? `xargs blocked: stdin appends unchecked paths; use a replacement token${FAIL_CLOSED_HINT}` : null;
	}
	const command = effective[0] ? normalizedCommand(effective[0]) : "";
	if (replaceToken === null && XARGS_WRAPPER_COMMANDS.has(command)) {
		return `xargs ${command} blocked: cannot model its wrapped command${FAIL_CLOSED_HINT}`;
	}
	const targets = command ? getMutationTargets(command, effective) : null;
	if (targets === null) return null;
	if (unsafeJ) return XARGS_J_REASON;
	// Without a replacement token xargs appends stdin after the explicit arguments, so
	// the checked targets cannot bound the write. -I/-i/--replace substitute the token
	// instead; an absent token means the input is ignored and the targets stay checked.
	if (replaceToken === null) return `xargs ${command} blocked: stdin appends unchecked paths; use a replacement token${FAIL_CLOSED_HINT}`;
	if (targets.length === 0) return `xargs ${command} blocked: mutation command via xargs`;
	return null;
}

/** xargs: classify the wrapped command and bound mutation targets. */
export function classifyXargs(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "xargs") return null;
	const xArgs = tokens.slice(1);
	const parsed = xargsCommandStart(xArgs);
	if ("reason" in parsed) return parsed.reason;
	const xTokens = xArgs.slice(parsed.start);
	if (xTokens.length === 0) return null;
	// stdin replaces every occurrence of the token at runtime. A checked literal cannot
	// bound that substitution, so any occurrence in the wrapped command fails closed.
	// Undecodable shell syntax (`\{\}`, `$'\x7b'`, globs, expansions) can still produce
	// the token after the shell decodes it, so it fails closed too.
	if (parsed.replaceToken !== null && xTokens.some((token) => carriesReplacementToken(token, parsed.replaceToken!))) {
		return `xargs replacement token blocked: "${parsed.replaceToken}" is substituted at runtime${FAIL_CLOSED_HINT}`;
	}
	const nested = classifyBashCommand(xTokens.join(" "), cwd, depth + 1, shellVars);
	if (!nested.ok) return nested.reason;
	return xargsMutationReason(xTokens, parsed.replaceToken, parsed.unsafeJ);
}

/** Generic mutation: extract targets via getMutationTargets, block non-temp paths. */
export function classifyGenericMutation(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>): string | null {
	const paths = getMutationTargets(command, tokens);
	if (!paths) return null;
	for (const target of paths) {
		const reason = tempPathBlockReason(command, target, cwd, shellVars);
		if (reason) return reason;
	}
	return null;
}

// ── Main dispatcher ─────────────────────────────────────────────────

export function getFilesystemMutationReason(segment: string, cwd: string, depth: number = 0, shellVars: ReadonlyMap<string, string> = new Map()): string | null {
	const local = parseCommandPrefix(segment, shellVars);
	// Redirect targets were already validated on the raw segment; they are not operands.
	const tokens = stripRedirectTokens(local.tokens);
	shellVars = local.vars;
	const command = tokens[0] ? normalizedCommand(tokens[0]) : "";
	if (!command) return null;
	// A leading variable, command substitution, or backtick word supplies argv[0]:
	// the dispatcher cannot see which executable runs, so it fails closed. The inner
	// `$(...)` code is classified separately, but its output still becomes the command.
	if (isDynamicCommandWord(command)) return dynamicCommandReason(tokens, cwd, depth, shellVars);
	return dispatchMutationReason(command, tokens, segment, cwd, depth, shellVars);
}

/** Chain of per-command mutation checks; the first matching reason wins. */
export function dispatchMutationReason(command: string, tokens: string[], segment: string, cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	return classifySubshellSegment(segment, cwd, depth, shellVars)
		?? classifyEvalExec(command, tokens, cwd, depth, shellVars)
		?? classifySudo(command, tokens, cwd, depth, shellVars)
		?? classifyEnv(command, segment, tokens, cwd, depth, shellVars)
		?? classifyUnparsableShell(tokens[0] ?? "")
		?? classifyGit(command, tokens, cwd, shellVars)
		?? classifyInterpreter(command, tokens, cwd, depth, shellVars)
		?? classifyScriptProcessSubstitution(command, segment, cwd, depth, shellVars)
		?? classifyDdOutput(segment, cwd, shellVars)
		?? classifyPackageManager(command, tokens)
		?? classifyWget(command, tokens, cwd, shellVars)
		?? classifyCurl(command, tokens, cwd, shellVars)
		?? classifyXargs(command, tokens, cwd, depth, shellVars)
		?? classifyGenericMutation(command, tokens, cwd, shellVars);
}

/** Package manager mutation: block unconditionally regardless of target path. */
export function classifyPackageManager(command: string, tokens: string[]): string | null {
	if (!PACKAGE_MANAGERS.has(command)) return null;
	if (!isPackageMutation(tokens.slice(1))) return null;
	const args = tokens.slice(1).join(" ");
	return buildReadonlyPackageManagerBlockReason(command, args);
}

export function skipFlagValues(args: string[], flagsWithValues: Set<string>): string[] {
	const result: string[] = [];
	let i = 0;
	while (i < args.length) {
		// `--` ends option parsing: later flag/value pairs are operands, so skipping
		// them here would hide real write targets (e.g. `touch -- -r /etc/hosts x`).
		if (args[i] === "--") break;
		if (flagsWithValues.has(args[i])) {
			i += 2; // skip flag + value
		} else {
			result.push(args[i]);
			i++;
		}
	}
	// Tokens from `i` on (including `--`) flow into nonOptionArgs, which emits
	// everything after `--` as operands.
	for (; i < args.length; i++) result.push(args[i]!);
	return result;
}

/** One curl output flag consumed: returns the effect on outputs/outputDir, or null for "not this flag". */
function consumeCurlOutputFlag(word: string, cArgs: string[], i: number):
	{ output?: string; outputDir?: string; remoteName?: boolean; skip?: boolean } | null {
	if ((word === "-o" || word === "--output") && cArgs[i + 1]) return { output: cArgs[i + 1], skip: true };
	if (word === "--output-dir" && cArgs[i + 1]) return { outputDir: cArgs[i + 1], skip: true };
	if (word.startsWith("--output=")) return { output: rawAttachedFlagValue(cArgs[i], "--output=") };
	if (word.startsWith("--output-dir=")) return { outputDir: rawAttachedFlagValue(cArgs[i], "--output-dir=") };
	if (word.startsWith("-o") && word.length > 2 && !word.startsWith("--")) return { output: rawAttachedFlagValue(cArgs[i], "-o") };
	if (word === "-O" || word === "--remote-name" || word === "--remote-name-all") return { remoteName: true };
	if (isCurlShortFlagBundleWithRemoteName(word)) return { remoteName: true };
	return null;
}

export function getCurlWriteTargets(tokens: string[]): { hasRemoteName: boolean; outputs: string[]; outputDir: string | null } {
	const cArgs = tokens.slice(1);
	const outputs: string[] = [];
	let hasRemoteName = false, outputDir: string | null = null;
	for (let i = 0; i < cArgs.length; i++) {
		const word = unescapeCommandWord(cArgs[i]);
		if (word === "--") break; // end of options; remaining args are URLs
		const effect = consumeCurlOutputFlag(word, cArgs, i);
		if (!effect) continue;
		if (effect.output) outputs.push(effect.output);
		if (effect.outputDir) outputDir = effect.outputDir;
		if (effect.remoteName) hasRemoteName = true;
		if (effect.skip) i++;
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
export function getWgetOutputDir(tokens: string[]): string | null {
	const wArgs = tokens.slice(1);
	for (let i = 0; i < wArgs.length; i++) {
		const word = unescapeCommandWord(wArgs[i]);
		if (word === "--") break;
		if (word === "-P" && wArgs[i + 1]) {
			return wArgs[i + 1];
		}
		if (word.startsWith("-P") && word.length > 2) {
			return rawAttachedFlagValue(wArgs[i], "-P");
		}
		if (word === "--directory-prefix" && wArgs[i + 1]) {
			return wArgs[i + 1];
		}
		if (word.startsWith("--directory-prefix=")) {
			return rawAttachedFlagValue(wArgs[i], "--directory-prefix=");
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
	const args = tokens.slice(1);
	const hasReference = args.some((arg) => {
		const word = unescapeCommandWord(arg);
		return word === "--reference" || word.startsWith("--reference=");
	});
	// `--reference` replaces the MODE operand, so every non-option word is a target.
	const operands = nonOptionArgs(skipFlagValues(args, new Set(["--reference"])));
	return operands.slice(hasReference ? 0 : 1);
}

function getCpTargets(tokens: string[]): string[] {
	const target = getCpTargetDirectory(tokens);
	if (target !== null) return [target];
	const args = nonOptionArgs(tokens.slice(1));
	return args.length > 0 ? [args[args.length - 1]] : [];
}

/** `-tDIR`/`-t DIR`/`--target-directory[=]DIR` destination, or null when unused. */
function getCpTargetDirectory(tokens: string[]): string | null {
	for (let i = 1; i < tokens.length; i++) {
		const word = unescapeCommandWord(tokens[i]!);
		if (word === "--") break;
		if (word === "-t" || word === "--target-directory") return tokens[i + 1] ? stripMatchingQuotes(tokens[i + 1]!) : null;
		if (word.startsWith("--target-directory=")) return rawAttachedFlagValue(tokens[i]!, "--target-directory=");
		if (word.startsWith("-t") && word.length > 2 && !word.startsWith("--")) return rawAttachedFlagValue(tokens[i]!, "-t");
	}
	return null;
}

function getTeeTargets(tokens: string[]): string[] {
	return nonOptionArgs(tokens.slice(1));
}

function getPerlRubyTargets(tokens: string[]): string[] | null {
	if (!tokens.slice(1).some((arg) => /^-p?i/.test(arg))) return null;
	const args = tokens.slice(1);
	const stripped: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		// -e / -pe / -ne take the next token as the program text
		if (/^-(?:e|pe|ne)$/.test(arg)) { i++; continue; }
		// -e'...' / -pe'...' / -ne'...' attach the program to the flag
		if (/^-(?:e|pe|ne)[^=-]/.test(arg)) continue;
		stripped.push(arg);
	}
	return nonOptionArgs(stripped);
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
	// A separate suffix arg is only confirmed when it is empty (BSD `sed -i ""`) or dot-prefixed
	// (`sed -i .bak`). Anything else — `sed -i 5d /etc/hosts` — is GNU's script, and dropping it
	// as a suffix dropped the file operand entirely (a verified write outside temp). Reading a
	// short word as the script over-targets instead: the safe direction.
	const extArg = args.length > 0 ? stripMatchingQuotes(args[0]) : "";
	const hasBackupExt = args.length > 0 && /^$|^\.[a-zA-Z0-9._-]{0,9}$/.test(extArg);
	if (hasBackupExt) return hasExpression ? (extArg === "" ? args.slice(1) : args) : args.slice(2);
	return hasExpression ? args : args.slice(1);
}

/** wget target extraction from -O/--output-document flags. */
function getWgetTargets(tokens: string[]): string[] {
	const wArgs = tokens.slice(1);
	let outputTarget: string | null = null;
	for (let i = 0; i < wArgs.length; i++) {
		const word = unescapeCommandWord(wArgs[i]);
		if (word === "--") break;
		if ((word === "-O" || word === "--output-document") && wArgs[i + 1]) { outputTarget = wArgs[++i]; continue; }
		if (word.startsWith("-O") && word.length > 2) { outputTarget = rawAttachedFlagValue(wArgs[i], "-O"); continue; }
		if (word.startsWith("--output-document=")) { outputTarget = rawAttachedFlagValue(wArgs[i], "--output-document="); }
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

/** tar action letters: c/r/u/A/d write the archive, x extracts, t lists. */
const TAR_WRITE_LETTERS = new Set(["c", "r", "u", "A", "d"]);
const TAR_LONG_MODES: Record<string, "write" | "extract" | "list"> = {
	"--create": "write", "--append": "write", "--update": "write", "--concatenate": "write", "--delete": "write",
	"--extract": "extract", "--get": "extract", "--list": "list",
};

/** tar option letters that consume a value. `f`/`C` also take values but record a
 * destination, so `scanTarBundle` handles them explicitly. Without this consume an option
 * value leaks into the flag scan (`tar -X -O` read `-O` as the stdout flag).
 *
 * Include a letter only when consuming cannot swallow a real flag on either implementation:
 * `-H` (GNU `--format`, bsdtar `--dereference`) and `-L` (GNU `--tape-length`, bsdtar
 * `--dereference`) take a value on GNU but are flags on bsdtar, so consuming would swallow a
 * real `-f`/`-C` on a bsdtar host and hide a write (`tar -cH -f /etc/a.tar src`). Their only
 * GNU values are a format/number, never `-O`, so leaving them unconsumed cannot read `-O` as a
 * value. `-g`/`-K`/`-N`/`-V` are GNU-only value options that bsdtar rejects, so consuming them
 * is harmless. `-s` conflicts the other way and is handled in `scanTarBundle`. */
const TAR_VALUE_LETTERS = new Set(["b", "g", "K", "N", "T", "V", "X"]);

/** Long options that consume a separate value. Same reason as `TAR_VALUE_LETTERS`: a value
 * such as `-O` must not read as a flag. Only REQUIRED-argument options belong here: an
 * optional-argument option (`--backup`, `--atime-preserve`, `--checkpoint`, `--totals`,
 * `--occurrence`) binds its value with `=`, so consuming the next token
 * would swallow a real option and hide a write target. `--file`/`--directory` record a
 * destination and stay explicit in `scanTarOptions`; the `=value` form needs no consume.
 * Completeness here only avoids over-blocking: a missing option is caught by the
 * unmodeled-option guard in `scanTarOptions`. */
const TAR_LONG_VALUE_OPTIONS = new Set([
	"--exclude", "--exclude-from", "--exclude-ignore", "--exclude-ignore-recursive",
	"--exclude-tag", "--exclude-tag-all", "--exclude-tag-under", "--xattrs-include",
	"--xattrs-exclude", "--files-from", "--transform", "--xform", "--owner", "--group",
	"--owner-map", "--group-map", "--mode", "--mtime", "--newer", "--newer-mtime",
	"--after-date", "--blocking-factor", "--record-size", "--format", "--level",
	"--use-compress-program", "--tape-length", "--label", "--info-script",
	"--new-volume-script", "--listed-incremental", "--starting-file", "--volno-file",
	"--suffix", "--sparse-version", "--quoting-style", "--quote-chars", "--no-quote-chars",
	"--rmt-command", "--rsh-command", "--to-command", "--strip-components", "--pax-option",
	"--checkpoint-action", "--warning", "--index-file", "--sort", "--hole-detection",
	"--set-mtime-command", "--set-mtime-format", "--passphrase", "--uname", "--gname",
	"--newer-than", "--newer-mtime-than",
]);

/** Long options that never consume the next token: booleans plus the optional-argument options
 * (`--backup`, `--checkpoint`, ... bind with `=`, so they leave a following `-O` in flag
 * position). Only needed to avoid over-blocking; a missing entry only makes the unmodeled-option
 * guard fail closed. */
const TAR_LONG_FLAGS = new Set([
	"--occurrence", "--atime-preserve", "--backup", "--checkpoint", "--totals",
	"--verbose", "--absolute-names", "--dereference", "--no-same-owner", "--same-owner",
	"--no-same-permissions", "--same-permissions", "--preserve-permissions", "--numeric-owner",
	"--overwrite", "--keep-old-files", "--skip-old-files", "--keep-newer-files", "--unlink-first",
	"--recursive", "--no-recursion", "--one-file-system", "--ignore-zeros", "--ignore-failed-read",
	"--remove-files", "--wildcards", "--no-wildcards", "--anchored", "--ignore-case",
	"--wildcards-match-slash", "--no-wildcards-match-slash", "--exclude-caches",
	"--exclude-caches-all", "--exclude-caches-under", "--exclude-vcs", "--exclude-vcs-ignores",
	"--exclude-backups", "--show-transformed-names", "--show-omitted-dirs", "--show-defaults",
	"--full-time", "--utc", "--delay-directory-restore", "--no-delay-directory-restore",
	"--no-overwrite-dir", "--force-local", "--no-unquote", "--unquote", "--verbatim-files-from",
	"--no-verbatim-files-from", "--gzip", "--gunzip", "--bzip2", "--xz", "--lzma", "--lzip",
	"--lzop", "--zstd", "--compress", "--uncompress", "--auto-compress", "--sparse",
	"--no-sparse", "--block-number", "--check-device", "--no-check-device", "--seek",
	"--no-seek", "--read-full-records", "--null", "--no-null", "--help", "--version",
	"--usage", "--license",
]);

/** Long options (and short letters) that run a command or write a side file: never allow via the stdout carve-out. Both `--opt value` and `--opt=value` forms count. */
const TAR_EXEC_OPTIONS = new Set([
	"--to-command", "--use-compress-program", "--info-script",
	"--new-volume-script", "--checkpoint-action", "--rmt-command", "--rsh-command",
	"--set-mtime-command", "--index-file",
]);

/** One option scan result: action modes, the `-f` archive operand, `-C` directories, stdout, exec. */
type TarScan = { write: boolean; extract: boolean; list: boolean; stdout: boolean; exec: boolean; archive: string | null; dirs: string[]; unparseable: boolean };

/** Consume one short-bundle word (`-czf`, dash-less `tar cf`) into the scan; bare `f`/`C`
 * and value letters take the next token, so the returned count tells the caller how many
 * tokens were consumed. */
function scanTarBundle(word: string, next: string | undefined, scan: TarScan, dashless: boolean): number {
	let consumed = 0;
	const letters = word.replace(/^-/, "");
	for (let j = 0; j < letters.length; j++) {
		const ch = letters[j]!, attached = letters.slice(j + 1);
		if (TAR_WRITE_LETTERS.has(ch)) scan.write = true;
		else if (ch === "x") scan.extract = true;
		else if (ch === "t") scan.list = true;
		// Uppercase `O` streams members to stdout. Lowercase `o` is GNU `--no-same-owner`
		// (an extract flag), so it must never set stdout.
		else if (ch === "O") scan.stdout = true;
		// `-I`/`-F` run a program or script per member: fail closed even with stdout.
		else if (ch === "I" || ch === "F") { scan.exec = true; break; }
		else if (ch === "f") {
			// Obsolescent dash-less bundles take the archive from the NEXT token
			// (`tar fc x.tar dir`), not from the attached letters — treating the
			// attached letter as the archive hid `tar fc /etc/a.tar`. Letters after
			// `f` stay mode flags so `tar fc` still registers the create mode.
			if (dashless) { scan.archive = next ?? null; consumed = 1; continue; }
			if (attached) { scan.archive = attached; break; }
			scan.archive = next ?? null; consumed = 1;
		}
		else if (ch === "C") { if (attached) { scan.dirs.push(attached); break; } if (next) { scan.dirs.push(next); consumed = 1; } }
		// `-s` is a preserve-order flag in GNU tar but takes a substitution pattern in bsdtar.
		// The tail is more flags on GNU (it can carry `f`/`C`/a mode), so trusting the bsdtar
		// reading under-blocks (`tar -csf /etc/a.tar src`); the separated form stays a plain
		// flag for GNU, so only the attached form fails closed.
		else if (ch === "s") { if (attached) scan.unparseable = true; break; }
		// Any other value letter consumes its value, so the value can never read as a flag.
		// A dash-less bundle takes each value from the NEXT token (`tar bcf 20 a.tar`), so a
		// second value letter cannot be attributed to its token — fail closed, do not guess.
		else if (TAR_VALUE_LETTERS.has(ch)) {
			if (dashless) { scan.unparseable = true; break; }
			if (attached) break;
			consumed = 1;
		}
	}
	return consumed;
}

/** Scan leading options (operands are skipped, tar permutes flags) for modes, archive, dirs. */
function scanTarOptions(tokens: string[]): TarScan {
	const scan: TarScan = { write: false, extract: false, list: false, stdout: false, exec: false, archive: null, dirs: [], unparseable: false };
	// A long option we do not model may still consume the next token as its value. If that token
	// spells `-O`/`--to-stdout`, trusting it would let a real extraction read as stdout
	// (`tar -xf a.tar --quote-chars -O`), so fail closed instead of guessing.
	let pendingValue = false;
	for (let i = 1; i < tokens.length; i++) {
		const word = unescapeCommandWord(tokens[i]!);
		const precededByUnmodeled = pendingValue;
		pendingValue = false;
		if (word === "--") break;
		if (word.startsWith("--")) {
			const mode = TAR_LONG_MODES[word];
			if (mode) scan[mode] = true;
			else if (word === "--to-stdout") { if (precededByUnmodeled) { scan.unparseable = true; break; } scan.stdout = true; }
			else if (word === "--file") { const v = tokens[i + 1]; if (v) { scan.archive = v; i++; } }
			else if (word.startsWith("--file=")) scan.archive = word.slice("--file=".length);
			else if (word === "--directory") { const v = tokens[i + 1]; if (v) { scan.dirs.push(v); i++; } }
			else if (word.startsWith("--directory=")) scan.dirs.push(word.slice("--directory=".length));
			// `--one-top-level=<dir>` redirects extraction under <dir>, so it is an extraction
			// destination like `-C`. The bare form derives the directory from the archive name,
			// which cannot be proven — fail closed.
			else if (word.startsWith("--one-top-level=")) scan.dirs.push(word.slice("--one-top-level=".length));
			else if (word === "--one-top-level") scan.unparseable = true;
			// Exec/side-write options fail closed even with stdout (`-O` streams members but
			// `--to-command` still runs per member). Check before the stdout carve-out.
			else if (TAR_EXEC_OPTIONS.has(word)) { scan.exec = true; if (tokens[i + 1] !== undefined) i++; }
			else if (word.includes("=") && TAR_EXEC_OPTIONS.has(word.slice(0, word.indexOf("=")))) { scan.exec = true; }
			// Other value options only need their value skipped: without this, an operand
			// like `-O` reads as the stdout flag (`tar -xf a.tar --exclude -O`).
			else if (TAR_LONG_VALUE_OPTIONS.has(word)) { if (tokens[i + 1] !== undefined) i++; }
			else if (!TAR_LONG_FLAGS.has(word) && !word.includes("=")) pendingValue = true;
			continue;
		}
		if (/^-[a-zA-Z]+$/.test(word) || (i === 1 && /^[a-zA-Z]+$/.test(word))) {
			const stdoutBefore = scan.stdout;
			i += scanTarBundle(word, tokens[i + 1], scan, !word.startsWith("-"));
			// The bundle is the previous long option's value when it sets stdout: trusting it
			// would allow a real extraction (`tar -xf a.tar --quote-chars -O`).
			if (precededByUnmodeled && scan.stdout && !stdoutBefore) { scan.unparseable = true; break; }
			continue;
		}
		if (word.startsWith("-C") && word.length > 2) { scan.dirs.push(rawAttachedFlagValue(word, "-C")); continue; }
		if (word.startsWith("-f") && word.length > 2) { scan.archive = word.slice(2); continue; }
		// A bundle with a non-letter tail means some option letter consumed the rest of
		// the word as its value (GNU attaches it to the first value-taking letter).
		// Unmodeled letters (b, B, …) can also take that value, so the archive path
		// cannot be attributed — fail closed instead of guessing a safe target.
		if (/^-[a-zA-Z]+[^a-zA-Z]/.test(word) || (i === 1 && /^[a-zA-Z]+[^a-zA-Z]/.test(word))) scan.unparseable = true;
	}
	return scan;
}

// Fail-closed sentinel for unparseable tar option words: the archive operand may be
// hidden inside them, so no real target can be proven inside temp. "/" sits outside
// every temp root, forcing a block from any cwd.
const TAR_UNPARSEABLE_TARGET = "/";

function getTarTargets(tokens: string[]): string[] | null {
	const scan = scanTarOptions(tokens);
	if (scan.unparseable) return [TAR_UNPARSEABLE_TARGET];
	// Exec/side-write options run code or write files regardless of stdout routing.
	if (scan.exec) return [TAR_UNPARSEABLE_TARGET];
	if (scan.list && !scan.write && !scan.extract) return null; // `tar -t` reads the archive only
	// Conflicting action modes cannot be proven safe: creation targets the archive while
	// extraction writes member files, so check neither guess and fail closed.
	if (scan.write && scan.extract) return [TAR_UNPARSEABLE_TARGET];
	if (scan.write) {
		// Creation writes the archive operand. `-f -`/`--file=-` streams the archive to
		// stdout, so `-` is not a filesystem path.
		const archive = scan.archive ?? ".";
		return [stripMatchingQuotes(archive) === "-" ? "/dev/null" : archive];
	}
	// `-O`/`--to-stdout` streams extracted members to stdout: no filesystem target.
	// `-C` only selects where member files land, so it never re-adds a target here.
	if (scan.stdout && !scan.write) return null;
	// Extraction (or an unmodeled action) writes member files into each -C dir, else the cwd —
	// tracking the cwd only classifies writes reached through a tracked cd, so the cwd itself
	// must be the target here.
	return scan.dirs.length > 0 ? scan.dirs : ["."];
}

function getRsyncTargets(tokens: string[]): string[] | null {
	// rsync destination is the last positional arg when there are two or more.
	const args = nonOptionArgs(tokens.slice(1));
	return args.length >= 2 ? [args[args.length - 1]!] : null;
}

/** unzip flags that read the archive without extracting. */
const UNZIP_READ_FLAGS = new Set(["-l", "-t", "-Z", "-v", "-p", "-c", "--list", "--test", "--info"]);

function getUnzipTargets(tokens: string[]): string[] | null {
	// `-d <dir>` chooses the extraction directory; otherwise unzip writes into the cwd, so the
	// cwd itself is the target — tracking only classifies writes reached through a tracked cd.
	for (let i = 1; i < tokens.length; i++) {
		const word = unescapeCommandWord(tokens[i]!);
		if (word === "--") break;
		if (UNZIP_READ_FLAGS.has(word)) return null;
		if (word === "-d") return tokens[i + 1] ? [tokens[i + 1]!] : ["."];
		if (word.startsWith("-d") && word.length > 2) return [rawAttachedFlagValue(tokens[i]!, "-d")];
	}
	return ["."];
}

export function getMutationTargets(command: string, tokens: string[]): string[] | null {
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
		case "tar": return getTarTargets(tokens);
		case "rsync": return getRsyncTargets(tokens);
		case "unzip": return getUnzipTargets(tokens);
		default: return null;
	}
}

function getFindMutationTargets(args: string[]): string[] | null {
	// Skip flags, home expansion (`~user`), glob patterns (e.g., -name '*.txt'), and find's own
	// grouping tokens (bare `(`/`)` or escaped `\(`/`\)`) — none can be a filesystem root.
	// A `~` or `()` inside a name is literal data (Windows `Program Files (x86)`), so the grouping
	// check operates on the decoded token and never touches embedded parentheses.
	const isFindGroupOperator = (arg: string): boolean => {
		const decoded = unescapeCommandWord(arg);
		return decoded === "(" || decoded === ")";
	};
	const roots = args.filter((arg) => arg && !arg.startsWith("-") && !arg.startsWith("~") && !/[*?{}\[\]]/.test(arg) && !isFindGroupOperator(arg));
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

export function isPackageMutation(args: string[]): boolean {
	// Match individual tokens against known package-mutation verbs.
	// Token-level matching (vs. substring-on-joined-string) avoids false
	// positives when a path or argument contains a verb word (install-sh, etc.).
	const VERBS = new Set(["install", "uninstall", "update", "upgrade", "ci", "link", "publish", "add", "remove", "reinstall", "tap", "untap", "download", "build-dep", "i", "un", "ad", "rm", "up", "in", "rb"]);
	return args.some((a) => VERBS.has(a.toLowerCase()));
}

export function findSudoCommandIndex(tokens: string[]): number {
	const FLAGS_WITH_VALUE = new Set(["-u", "-g", "-p", "-C", "-T", "-h"]);
	const LONG_SUDO_VALUE_FLAGS = new Set([
		"--user", "--group", "--host", "--prompt",
		"--chdir", "--close-from", "--command-timeout",
	]);
	let i = 1;
	while (i < tokens.length) {
		const word = unescapeCommandWord(tokens[i]);
		if (word === "--") return i + 1;
		if (!word.startsWith("-")) return i;
		if (FLAGS_WITH_VALUE.has(word)) { i += 2; continue; }
		if (word.startsWith("--") && !word.includes("=") && LONG_SUDO_VALUE_FLAGS.has(word)) { i += 2; continue; }
		i += 1;
	}
	return tokens.length;
}

/** `-S`/`--split-string` value `env` runs as the wrapped command, or null when absent. */
export function envSplitCommand(segment: string): string | null {
	const tokens = getCommandTokens(segment);
	const envIndex = tokens.findIndex((token) => normalizedCommand(token) === "env");
	if (envIndex === -1) return null;
	const prefix = skipEnvOptions(tokens, envIndex + 1);
	return prefix.splitString === null ? null : [stripMatchingQuotes(prefix.splitString), ...tokens.slice(prefix.next)].join(" ");
}

// `env` options that consume the next token. `-C/--chdir` also moves the child's cwd and so
// must be tracked: `env -C <outside> rm rel` is a write outside temp, not an unknown command.
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-S", "--split-string", "-g", "--group", "-a", "--argv0", "-C", "--chdir"]);
const ENV_CHDIR_FLAGS = new Set(["-C", "--chdir"]);
const ENV_SPLIT_FLAGS = new Set(["-S", "--split-string"]);

type EnvOptions = { chdir: string | null; splitString: string | null };

/** Inline values (`-Cdir`, `--chdir=dir`, `-Sscript`); null when the value is a separate token. */
function envInlineOption(word: string, token: string): { name: string; value: string } | null {
	const [name, value] = splitFlagValue(word);
	if (value !== undefined && name !== word) return { name, value: rawAttachedFlagValue(token, name + "=") };
	return /^-[CaS]./.test(word) ? { name: word.slice(0, 2), value: rawAttachedFlagValue(token, word.slice(0, 2)) } : null;
}

export function skipEnvOptions(tokens: string[], start: number): { next: number; chdir: string | null; splitString: string | null } {
	let i = start;
	const state: EnvOptions = { chdir: null, splitString: null };
	while (i < tokens.length) {
		const word = unescapeCommandWord(tokens[i]);
		if (!word.startsWith("-")) break;
		if (word === "--") { i++; break; }
		i += consumeEnvOption(word, tokens, i, state);
		// Everything after the `-S` split string is the wrapped command's argv, not
		// env options: `env -S"touch" -- -r x` passes `-- -r x` to the wrapped command.
		if (state.splitString !== null) break;
	}
	return { next: i, ...state };
}

/** Consume one `env` option token into `state`; returns how many tokens it occupies. */
function consumeEnvOption(word: string, tokens: string[], i: number, state: EnvOptions): number {
	const inline = envInlineOption(word, tokens[i]);
	if (inline) {
		if (ENV_CHDIR_FLAGS.has(inline.name)) state.chdir = inline.value;
		if (ENV_SPLIT_FLAGS.has(inline.name)) state.splitString = inline.value;
		return 1;
	}
	if (ENV_CHDIR_FLAGS.has(word)) state.chdir = tokens[i + 1] ?? null;
	if (ENV_SPLIT_FLAGS.has(word)) state.splitString = tokens[i + 1] ?? null;
	return ENV_VALUE_FLAGS.has(word) ? 2 : 1;
}

/** Outcome of stripping one prefix layer (env/command/builtin/redirections). */
type PrefixSkip =
	// Consumed a prefix word; keep parsing tokens at `next`.
	| { kind: "advance"; next: number }
	// `env -C` (child cwd) / `env -S` (split-string): classifyEnv needs the raw slice; hand it off.
	| { kind: "handOffEnv"; tokens: string[]; vars: Map<string, string> }
	// Bare `env` whose args were all consumed as flags: nothing left to dispatch.
	| { kind: "handOffEnvOnly" }
	// Not a prefix word: stop and dispatch on the current token.
	| { kind: "stop" };

/** Strip one prefix layer (env/command/builtin); returns a discriminated skip result. */
function skipCommandPrefix(tokens: string[], i: number, vars: Map<string, string>): PrefixSkip {
	const command = tokens[i] ? normalizedCommand(tokens[i]) : "";
	if (command === "env") {
		const prefix = skipEnvOptions(tokens, i + 1);
		// `-C` (child cwd) and `-S` (split-string) cannot be represented as plain
		// tokens: keep `env` and its args so classifyEnv can recurse correctly.
		if (prefix.chdir !== null || prefix.splitString !== null) return { kind: "handOffEnv", tokens: tokens.slice(i), vars };
		if (prefix.next >= tokens.length) return { kind: "handOffEnvOnly" };
		return { kind: "advance", next: prefix.next };
	}
	// Bash strips escapes/quotes before parsing, so flag detection compares unescaped words.
	if (command === "command") { let j = i + 1; while (tokens[j] && unescapeCommandWord(tokens[j]).startsWith("-")) j++; return { kind: "advance", next: j }; }
	// `builtin` takes no options and runs its argument in the current shell.
	if (command === "builtin") return { kind: "advance", next: i + 1 };
	return { kind: "stop" };
}

export function parseCommandPrefix(segment: string, inherited: ReadonlyMap<string, string>): { tokens: string[]; vars: Map<string, string> } {
	const tokens = segment.match(SHELL_WORD_PATTERN) ?? [];
	const vars = new Map(inherited);
	let i = 0;
	for (let depth = 0; depth < 10; depth++) {
		i = collectCommandPrefixAssignments(tokens, i, vars);
		i = skipLeadingRedirections(tokens, i);
		const next = skipCommandPrefix(tokens, i, vars);
		if (next.kind === "stop") break;
		if (next.kind === "handOffEnv") return { tokens: next.tokens, vars: next.vars };
		if (next.kind === "handOffEnvOnly") return { tokens: tokens.slice(i, i + 1), vars };
		i = next.next;
	}
	return { tokens: tokens.slice(i), vars };
}

function collectCommandPrefixAssignments(tokens: string[], start: number, vars: Map<string, string>): number {
	let i = start;
	while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
		const word = unescapeCommandWord(tokens[i]);
		const eq = word.indexOf("=");
		const value = rawAttachedFlagValue(tokens[i], word.slice(0, eq + 1));
		vars.set(word.slice(0, eq), decodeShellAssignmentValue(value));
		i++;
	}
	return i;
}

/** Variables a simple command's own leading `NAME=value` prefixes set. These form the prefix
 * candidate for `expansionCandidates` in readonly-bash-heredoc.ts. `env`/`command` operand
 * assignments are excluded: the outer shell expands the heredoc before the command runs. */
export function leadingShellAssignments(segment: string, inherited: ReadonlyMap<string, string>): Map<string, string> {
	const tokens = segment.match(SHELL_WORD_PATTERN) ?? [];
	const vars = new Map(inherited);
	let i = 0;
	for (let depth = 0; depth < 10; depth++) {
		i = collectCommandPrefixAssignments(tokens, i, vars);
		i = skipLeadingRedirections(tokens, i);
		// `time` is a keyword: its command's assignments belong to the prefix candidate.
		// Wrapper commands (`sudo`, `nohup`, …) take assignments as arguments instead.
		if (normalizedCommand(tokens[i] ?? "") !== "time") break;
		i += unescapeCommandWord(tokens[i + 1] ?? "") === "-p" ? 2 : 1;
	}
	return vars;
}

export function nonOptionArgs(args: string[]): string[] {
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

/**
 * Declaration keywords (export/declare/typeset/local/readonly) and their
 * flags are skipped before looking for assignments.
 */
export const DECL_KEYWORDS = new Set(["export", "declare", "typeset", "local", "readonly"]);

export function stripDeclKeywords(tokens: string[]): string[] {
	if (!tokens[0] || !DECL_KEYWORDS.has(tokens[0])) return tokens;
	let i = 1;
	while (tokens[i]?.startsWith("-")) i++;
	return tokens.slice(i);
}
