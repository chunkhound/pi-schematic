/**
 * Per-command mutation classifiers and shared token utilities.
 *
 * Each `classify*` function handles one command shape (sudo, env, interpreter,
 * wget, curl, xargs, generic mutation, package manager). The dispatcher chains
 * them; the first matching reason wins. Target extractors (getRmTargets, etc.)
 * pull filesystem paths from command arguments for temp-dir checking.
 */
import path from "node:path";
import { decodeShellAssignmentValue, decodeShellWord, tempPathBlockReason, relativeTempPathBlockReason, rawAttachedFlagValue, rawOperandAfterDecodedFlag, stripMatchingQuotes, stripRedirectTokens, expandShellVariable, splitFlagValue, normalizedCommand, unescapeCommandWord, getCommandTokens, SHELL_WORD_PATTERN, SHELL_SCRIPT_CONSUMERS, skipLeadingRedirections } from "./readonly-shell-utils.js";
import { isRealDirectory, isSymlinkPath, joinPathFrom, resolveRealPath } from "./resolve-path.js";
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

// uv/bun/conda block on every invocation: their ordinary modes write outside
// the temp roots even with an in-temp operand. uv run/venv materialize `.venv`
// and touch ~/.cache/uv, uvx/bunx install before running, and conda resolves
// packages through its own store. No verb list can prove such a call a read.
const ALWAYS_BLOCKED_PACKAGE_MANAGERS = new Set(["uv", "uvx", "bun", "bunx", "conda"]);

// Managers with an explicit write-mode grammar live in PACKAGE_MODE_TABLES below.
// The rest block on a shared mutation verb: they write outside any single directory
// (npm install writes node_modules, pip installs to site-packages), so temp-dir path
// checking is not meaningful.

/** One package-manager mode. Short and long spellings share the row, so a mode cannot
 * enter one grammar without the other. `writes: false` rows only stop the short-bundle
 * scan (rpm/pacman select one mode from the bundle). */
type PackageModeRow = {
	short: string | null;
	long: readonly string[];
	writes: boolean;
	/** Query sub-operations that keep a writing mode read-only (`pacman -Ss`, `-Fl`). */
	shortReadSubops?: RegExp;
	longReadSubops?: readonly string[];
};

type PackageGrammar = {
	/** `first`: the first mode letter selects the mode and later letters are its options
	 * (rpm, pacman). `any`: every write letter is an action (dpkg bundles one action). */
	shortModeScan: "first" | "any";
	modes: readonly PackageModeRow[];
};

export const PACKAGE_MODE_TABLES: Readonly<Record<string, PackageGrammar>> = {
	dpkg: {
		shortModeScan: "any",
		modes: [
			{ short: "i", long: ["--install"], writes: true },
			{ short: "r", long: ["--remove"], writes: true },
			{ short: "P", long: ["--purge"], writes: true },
			// -a/--pending is a modifier used with --configure/--unpack; both block.
			{ short: "a", long: ["--pending"], writes: true },
			{ short: "A", long: ["--record-avail"], writes: true },
			{ short: "b", long: ["--build"], writes: true },
			{ short: "x", long: ["--extract"], writes: true },
			{ short: "X", long: ["--vextract"], writes: true },
			{ short: "e", long: ["--control"], writes: true },
			{ short: null, long: ["--unpack", "--configure"], writes: true },
			{ short: null, long: ["--triggers-only"], writes: true },
			{ short: null, long: ["--set-selections", "--clear-selections"], writes: true },
			{ short: null, long: ["--update-avail", "--merge-avail", "--clear-avail", "--forget-old-unavail"], writes: true },
			{ short: null, long: ["--add-architecture", "--remove-architecture", "--foreign-architecture"], writes: true },
		],
	},
	"dpkg-deb": {
		shortModeScan: "any",
		modes: [
			{ short: "b", long: ["--build"], writes: true },
			{ short: "x", long: ["--extract"], writes: true },
			{ short: "X", long: ["--vextract"], writes: true },
			{ short: "e", long: ["--control"], writes: true },
			{ short: "R", long: ["--raw-extract"], writes: true },
		],
	},
	rpm: {
		shortModeScan: "first",
		modes: [
			{ short: "i", long: ["--install"], writes: true },
			{ short: "U", long: ["--upgrade"], writes: true },
			{ short: "F", long: ["--freshen"], writes: true },
			{ short: "e", long: ["--erase"], writes: true },
			// -b<stage> and -t<stage> build into the rpmbuild tree; the stage is their tail.
			{ short: "b", long: [], writes: true },
			{ short: "t", long: [], writes: true },
			{ short: null, long: ["--import", "--rebuilddb", "--initdb", "--setperms", "--setugids", "--rebuild", "--recompile"], writes: true },
			{ short: "q", long: ["--query"], writes: false },
			{ short: "V", long: ["--verify"], writes: false },
			{ short: "K", long: ["--checksig"], writes: false },
		],
	},
	pacman: {
		shortModeScan: "first",
		modes: [
			{ short: "S", long: ["--sync"], writes: true, shortReadSubops: /^[silgp]+$/, longReadSubops: ["--search", "--info", "--list", "--print", "--groups"] },
			{ short: "R", long: ["--remove"], writes: true },
			{ short: "U", long: ["--upgrade"], writes: true },
			{ short: "D", long: ["--database"], writes: true },
			{ short: "F", long: ["--files"], writes: true, shortReadSubops: /^[lsx]+$/, longReadSubops: ["--list", "--search", "--regex"] },
			{ short: null, long: ["--refresh", "--sysupgrade", "--clean", "--asdeps", "--asexplicit"], writes: true },
			{ short: "Q", long: ["--query"], writes: false },
			{ short: "T", long: ["--deptest"], writes: false },
		],
	},
};

export const PACKAGE_MANAGERS = new Set([
	...ALWAYS_BLOCKED_PACKAGE_MANAGERS,
	...Object.keys(PACKAGE_MODE_TABLES),
	"npm", "yarn", "pnpm", "pip", "pip3", "pipx", "apt", "apt-get", "brew", "cargo", "gem", "yum", "dnf", "choco",
]);

// Mutation words cover managers without a mode grammar; table managers use their own
// grammar, so a read sub-operation (`pacman --sync --search`) is not mistaken for a verb.
const PACKAGE_MUTATION_WORDS = new Set([
	"install", "uninstall", "update", "upgrade", "ci", "link", "publish", "add", "remove", "reinstall",
	"tap", "untap", "download", "build-dep", "i", "un", "ad", "rm", "up", "in", "rb",
	"create", "sync", "purge", "erase", "unpack", "configure", "freshen",
	"--install", "--remove", "--upgrade", "--purge", "--unpack", "--configure", "--erase",
	"--freshen", "--sync", "--database",
]);

/** Long option name without `=value`; null for `--`, short flags, and operands. */
function longOptionName(word: string): string | null {
	const name = unescapeCommandWord(word).split("=", 1)[0]!.toLowerCase();
	return name.startsWith("--") && name.length > 2 ? name : null;
}

/** getopt_long accepts any unambiguous prefix, so a prefix of a write spelling can
 * select that write. Ambiguous prefixes fail inside getopt; blocking them is safe. */
function matchesLongOption(name: string, option: string): boolean {
	return option.startsWith(name);
}

/** Mode row and the bundle letters after it; null outside a short flag. */
function shortModeOf(grammar: PackageGrammar, word: string): { row: PackageModeRow; subops: string } | null {
	const raw = unescapeCommandWord(word);
	if (!raw.startsWith("-") || raw.startsWith("--")) return null;
	const letters = raw.slice(1);
	for (let i = 0; i < letters.length; i++) {
		const row = grammar.modes.find((candidate) => candidate.short === letters[i]);
		if (!row) continue;
		if (grammar.shortModeScan === "first") return { row, subops: letters.slice(i + 1).replace(/[^a-z]/g, "") };
		if (row.writes) return { row, subops: "" };
	}
	return null;
}

/** Letters of a short-flag token; long options and operands carry none. */
function shortFlagLetters(word: string): string {
	const raw = unescapeCommandWord(word);
	return raw.startsWith("-") && !raw.startsWith("--") ? raw.slice(1) : "";
}

/** Only query sub-operations keep a writing mode read-only, whether bundled in the
 * mode token or split across short tokens (`-Ss` ≡ `-S -s`). */
function shortSubopsReadOnly(row: PackageModeRow, subops: string): boolean {
	return row.shortReadSubops !== undefined && row.shortReadSubops.test(subops);
}

function shortBundleMutates(grammar: PackageGrammar, args: string[]): boolean {
	return args.some((arg, index) => {
		const mode = shortModeOf(grammar, arg);
		if (mode === null || !mode.row.writes) return false;
		const others = args.filter((_, other) => other !== index).map(shortFlagLetters).join("");
		return !shortSubopsReadOnly(mode.row, mode.subops + others);
	});
}

/** Long option names present in argv; operands and `--` are not options. */
function longOptionNames(args: string[]): string[] {
	return args.map(longOptionName).filter((name): name is string => name !== null);
}

/** Long sub-operations resolve like getopt_long, so `--sea` is a read when `--search`
 * is the only option it can name; ambiguous or unknown names fail closed. */
function longSubopsAreRead(subops: readonly string[], names: string[]): boolean {
	return names.every((name) => {
		const match = matchLongOption(name, subops);
		return match !== null && match !== "ambiguous";
	});
}

/** A long mode is read-only only when every other long option is one of its query
 * sub-operations; an unrecognized option fails closed as a write. */
function longModeMutates(row: PackageModeRow, names: string[]): boolean {
	if (row.longReadSubops === undefined) return true;
	const others = names.filter((name) => !row.long.some((option) => matchesLongOption(name, option)));
	// No sub-operation means the mode's default action (install/refresh), a write.
	return others.length === 0 || !longSubopsAreRead(row.longReadSubops, others);
}

function packageGrammarMutates(grammar: PackageGrammar, args: string[]): boolean {
	if (shortBundleMutates(grammar, args)) return true;
	const names = longOptionNames(args);
	return grammar.modes.some((row) =>
		row.writes
		&& row.long.some((option) => names.some((name) => matchesLongOption(name, option)))
		&& longModeMutates(row, names),
	);
}

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

/** Positional parameters supply words at runtime, either from argv after `-c` or from `set --`.
 * The classifier cannot resolve either source, so the script's command word is unknowable. */
const POSITIONAL_PARAMETER_PATTERN = /^\$(?:[@*]|[0-9]|\{[@*]|[0-9])/;

/** Scan shell source for an expanding positional parameter. Single-quoted spans are literal
 * data (`awk '{print $1}'`), so only unquoted and double-quoted references count. */
function expandsPositionalParameter(script: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < script.length; i++) {
		const ch = script[i]!;
		if (ch === "\\") { i++; continue; }
		if (ch === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue; }
		if (ch === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; continue; }
		if (ch === "$" && quote !== "'" && POSITIONAL_PARAMETER_PATTERN.test(script.slice(i, i + 4))) return true;
	}
	return false;
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
			if (SHELL_SCRIPT_CONSUMERS.has(command) && expandsPositionalParameter(demangleNestedArgument(script))) {
				return `${command} ${flag} blocked: positional parameters supply the runtime command; pass the command text literally${FAIL_CLOSED_HINT}`;
			}
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
type XargsShortOption = { readonly size: number; readonly replaceToken: string | null; readonly clearsReplacement?: boolean; readonly maxArgsValue?: string; readonly unsafeJ?: boolean };
type XargsShortScan = XargsShortOption | { readonly reason: string };
type XargsMode = { readonly replaceToken: string | null; readonly unsafeJ: boolean };

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

function replacementMode(raw: string | undefined): XargsMode | { reason: string } {
	const token = decodedReplacement(raw);
	return token === null ? replacementReason(raw) : { replaceToken: token, unsafeJ: false };
}

/** Value-taking short letters. `J` is resettable but unsafe; `n` records max-args. */
function xargsShortValueScan(raw: string, args: string[], index: number, letters: string, i: number): XargsShortScan {
	const letter = letters[i]!, attached = letters.slice(i + 1), size = attached ? 1 : 2;
	if (letter === "L") return { size, replaceToken: null, clearsReplacement: true };
	if (letter === "J") return { size, replaceToken: null, clearsReplacement: true, unsafeJ: true };
	if (letter === "n") {
		const value = attached ? rawAttachedFlagValue(raw, `-${letters.slice(0, i + 1)}`) : args[index + 1] ?? "";
		return { size, replaceToken: null, maxArgsValue: decodeShellWord(value) ?? value };
	}
	if (letter !== "I") return { size, replaceToken: null };
	const value = attached ? rawAttachedFlagValue(raw, `-${letters.slice(0, i + 1)}`) : args[index + 1];
	const mode = replacementMode(value);
	return "reason" in mode ? mode : { size, replaceToken: mode.replaceToken };
}

/** Optional values bind only when attached; bare `-i` still selects the default `{}`. */
function xargsShortOptionalScan(raw: string, letters: string, i: number): XargsShortScan {
	const letter = letters[i]!;
	if (letter === "l") return { size: 1, replaceToken: null, clearsReplacement: true };
	if (letter !== "i") return { size: 1, replaceToken: null };
	const mode = replacementMode(rawAttachedFlagValue(raw, `-${letters.slice(0, i + 1)}`));
	return "reason" in mode ? mode : { size: 1, replaceToken: mode.replaceToken };
}

/** `I`/`J` take a replacement token; `i` defaults to `{}` when bare. Other values are
 * consumed so they cannot become the wrapped command word. `J` is not a safe replacement
 * mode: BSD xargs appends stdin when its token is absent. */
function xargsShortOptionScan(raw: string, args: string[], index: number, word: string): XargsShortScan | null {
	const letters = word.slice(1);
	let clearsReplacement = false;
	for (let i = 0; i < letters.length; i++) {
		const letter = letters[i]!, arity = XARGS_SHORT_ARITY[letter];
		if (arity === undefined) return null;
		if (arity === "value") return xargsShortValueScan(raw, args, index, letters, i);
		if (arity === "optional" && i < letters.length - 1) return xargsShortOptionalScan(raw, letters, i);
		if (letter === "l") clearsReplacement = true;
		if (letter === "i") return { size: 1, replaceToken: "{}" };
	}
	return { size: 1, replaceToken: null, clearsReplacement };
}

/** Wrapped-command start, the active replacement token, and whether BSD `-J` mode is active. */
type XargsOptionScan = XargsMode & { readonly start: number };

function xargsLongModeScan(name: string, inline: string | undefined, args: string[], index: number, mode: XargsMode): XargsMode | { reason: string } {
	if (name === "--replace") return inline === undefined ? { replaceToken: "{}", unsafeJ: false } : replacementMode(inline);
	if (name === "--max-lines") return { replaceToken: null, unsafeJ: false };
	if (name === "--max-args") {
		const value = inline ?? args[index + 1] ?? "";
		return (decodeShellWord(value) ?? value) !== "1" ? { replaceToken: null, unsafeJ: false } : mode;
	}
	return mode;
}

function xargsLongOptionScan(word: string, args: string[], index: number, mode: XargsMode): { size: number; mode: XargsMode } | { reason: string } {
	const [name, inline] = splitFlagValue(word), arity = XARGS_LONG_ARITY[name];
	if (arity === undefined) return { reason: `xargs option blocked: cannot model "${name}"${FAIL_CLOSED_HINT}` };
	const next = xargsLongModeScan(name, inline, args, index, mode);
	if ("reason" in next) return next;
	return { size: arity === "value" && inline === undefined ? 2 : 1, mode: next };
}

function applyXargsShortScan(scan: XargsShortOption, mode: XargsMode): XargsMode {
	if (scan.clearsReplacement || (scan.maxArgsValue !== undefined && scan.maxArgsValue !== "1")) mode = { replaceToken: null, unsafeJ: false };
	if (scan.replaceToken !== null) mode = { replaceToken: scan.replaceToken, unsafeJ: false };
	if (scan.unsafeJ) mode = { replaceToken: null, unsafeJ: true };
	return mode;
}

type XargsStep = { readonly mode: XargsMode; readonly size: number } | { readonly reason: string };

function xargsOptionScan(word: string, args: string[], index: number, mode: XargsMode): XargsStep {
	if (word.startsWith("--")) {
		const scan = xargsLongOptionScan(word, args, index, mode);
		return "reason" in scan ? scan : { mode: scan.mode, size: scan.size };
	}
	const scan = xargsShortOptionScan(args[index]!, args, index, word);
	if (scan === null) return { reason: `xargs option blocked: cannot model "${word}"${FAIL_CLOSED_HINT}` };
	if ("reason" in scan) return scan;
	return { mode: applyXargsShortScan(scan, mode), size: scan.size };
}

function xargsCommandStart(args: string[]): XargsOptionScan | { reason: string } {
	let i = 0, mode: XargsMode = { replaceToken: null, unsafeJ: false };
	while (i < args.length) {
		const word = unescapeCommandWord(args[i]!);
		if (word === "--") return { start: i + 1, ...mode };
		if (!word.startsWith("-") || word === "-") return { start: i, ...mode };
		const step = xargsOptionScan(word, args, i, mode);
		if ("reason" in step) return step;
		mode = step.mode; i += step.size;
	}
	return { start: i, ...mode };
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

export const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_OUTPUT_ACTIONS = new Set(["-fprintf", "-fprint", "-fprint0", "-fls"]);

function findFollowsSymlinks(args: string[]): boolean {
	return args.some((arg) => {
		const word = unescapeCommandWord(arg);
		return word === "-L" || word === "-follow";
	});
}

/** Index of an `-exec`-family terminator, or `args.length` when unterminated. POSIX
 * ends the primary at `;` or at a `+` that follows an argument of exactly `{}`; a bare
 * `+` elsewhere is payload, and cutting there would leave the rest unclassified. */
function findExecPayloadEnd(args: string[], start: number): number {
	let end = start;
	for (; end < args.length; end++) {
		const word = unescapeCommandWord(args[end]!);
		if (word === ";") break;
		if (word === "+" && end > start && unescapeCommandWord(args[end - 1]!) === "{}") break;
	}
	return end;
}

/** Walk find actions once. An `-exec` payload is opaque command text, so skip to its
 * terminator; output actions consume their file (and `-fprintf` its format) so a path
 * spelled like an action cannot be misread. */
function scanFindActions(args: string[]): { mutatesPaths: boolean; deletesPaths: boolean; outputs: string[] } {
	let mutatesPaths = false, deletesPaths = false;
	const outputs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = unescapeCommandWord(args[i]!);
		if (FIND_EXEC_ACTIONS.has(arg)) {
			mutatesPaths = true;
			i = findExecPayloadEnd(args, i + 1);
			continue;
		}
		if (arg === "-delete") { mutatesPaths = true; deletesPaths = true; continue; }
		if (!FIND_OUTPUT_ACTIONS.has(arg)) continue;
		const output = args[i + 1];
		outputs.push(output ?? ".");
		if (output !== undefined) i += arg === "-fprintf" ? 2 : 1;
	}
	return { mutatesPaths, deletesPaths, outputs };
}

/** One find -exec action plus the facts the payload checks need. */
type FindExecGuard = {
	action: string;
	followsSymlinks: boolean;
	roots: string[];
	cwd: string;
	depth: number;
	shellVars: ReadonlyMap<string, string>;
};

/** An absolute path no entry can name: a write there proves the payload mutated `{}`. */
const FIND_EXEC_DESCENDANT_BASENAME = "\u0000find-exec-descendant";

/** Classify the payload after binding every literal `{}` to `substitute`. `runtimeCwd` is
 * where the action runs: -execdir does not inherit the caller cwd. */
function findExecScriptReason(payload: string[], substitute: string, guard: FindExecGuard, runtimeCwd = guard.cwd): string | null {
	const script = payload.map((word) => word.split("{}").join(substitute)).join(" ");
	const nested = classifyBashCommand(script, runtimeCwd, guard.depth + 1, guard.shellVars);
	return nested.ok ? null : nested.reason;
}

/** `{}` reached find, and whether the raw shell word preserves it for substitution. */
function findExecPlaceholder(payload: string[]): "none" | "modeled" | "unmodeled" {
	let seen = false;
	for (const word of payload) {
		if (!unescapeCommandWord(word).includes("{}")) continue;
		if (!word.includes("{}")) return "unmodeled";
		seen = true;
	}
	return seen ? "modeled" : "none";
}

/** Probe path on cwd's drive root: outside every temp root, and NUL keeps it nonexistent. */
function findExecProbePath(cwd: string): string {
	return path.join(path.parse(path.resolve(cwd)).root, FIND_EXEC_DESCENDANT_BASENAME);
}

/** Directories -execdir can run in for one search root. A real directory root is the
 * shallowest directory that can hold a match (deeper matches escape less), so it bounds a
 * relative `..` target. A non-symlink entry runs in its parent. BSD/macOS also runs every
 * command-line entry (directory or file) in the caller cwd, so that cwd is always a
 * candidate. For a symlink root, implementations disagree: GNU runs in the link's parent,
 * BSD/macOS in the caller cwd, and a followed root (-H) in the target. The raw join keeps a
 * later `..` after the kernel's symlink resolution. */
function findExecRuntimeDirs(root: string, cwd: string): string[] {
	const joined = joinPathFrom(cwd, unescapeCommandWord(root));
	const caller = resolveRealPath(cwd);
	if (isRealDirectory(joined)) return [...new Set([resolveRealPath(joined), caller])];
	const parent = resolveRealPath(path.dirname(joined));
	if (!isSymlinkPath(joined)) return [...new Set([parent, caller])];
	return [...new Set([parent, caller, resolveRealPath(joined)])];
}

/** Check the payload once per search root and possible runtime directory. */
function findExecBoundReason(payload: string[], dirBinding: boolean, guard: FindExecGuard): string | null {
	for (const root of guard.roots.length > 0 ? guard.roots : ["."]) {
		const bound = dirBinding ? path.dirname(root) : root;
		const runtimeDirs = dirBinding ? findExecRuntimeDirs(root, guard.cwd) : [guard.cwd];
		for (const runtimeCwd of runtimeDirs) {
			const reason = findExecScriptReason(payload, bound, guard, runtimeCwd);
			if (reason) return reason;
		}
	}
	return null;
}

/** find substitutes a runtime descendant for `{}`, not the root. A descendant symlink can
 * leave temp, so a mutating payload using `{}` is never proven contained. */
function findExecPlaceholderReason(payload: string[], guard: FindExecGuard): string | null {
	if (!findExecScriptReason(payload, findExecProbePath(guard.cwd), guard)) return null;
	return `{} can name a descendant symlink outside temp; use a literal path${FAIL_CLOSED_HINT}`;
}

/** Structural failures that need no runtime path: an absent terminator or payload, and
 * -execdir under -L whose walk can reach outside temp before the payload runs. */
function findExecBasicReason(payload: string[], unterminated: boolean, dirBinding: boolean, guard: FindExecGuard): string | null {
	const { action } = guard;
	if (unterminated) return `find ${action} blocked: unterminated command${FAIL_CLOSED_HINT}`;
	if (payload.length === 0) return `find ${action} blocked: empty command${FAIL_CLOSED_HINT}`;
	if (dirBinding && guard.followsSymlinks) return `find ${action} blocked: symlink-following mode can leave temp before the payload runs; drop -L/-follow${FAIL_CLOSED_HINT}`;
	return null;
}

function findExecPlaceholderGuardReason(placeholders: "none" | "modeled" | "unmodeled", guard: FindExecGuard): string | null {
	const { action } = guard;
	if (guard.followsSymlinks && placeholders !== "none") return `find ${action} blocked: -L/-follow can substitute an outside pathname for {}; drop -L/-follow or avoid {}${FAIL_CLOSED_HINT}`;
	if (placeholders === "unmodeled") return `find ${action} blocked: cannot model the {} substitution; spell it literally or avoid {}${FAIL_CLOSED_HINT}`;
	return null;
}

function findExecActionReason(payload: string[], unterminated: boolean, guard: FindExecGuard): string | null {
	const { action } = guard;
	const dirBinding = action === "-execdir" || action === "-okdir";
	const basic = findExecBasicReason(payload, unterminated, dirBinding, guard);
	if (basic) return basic;
	const placeholders = findExecPlaceholder(payload);
	const placeholderGuard = findExecPlaceholderGuardReason(placeholders, guard);
	if (placeholderGuard) return placeholderGuard;
	const bound = findExecBoundReason(payload, dirBinding, guard);
	if (bound) return `find ${action} blocked: ${bound}`;
	if (placeholders === "none") return null;
	const probe = findExecPlaceholderReason(payload, guard);
	return probe ? `find ${action} blocked: ${probe}` : null;
}

/** find's `-exec` family runs a command the root check never sees. Classify the payload
 * (`-exec sh -c 'touch /etc/x' \;`) as shell code; an unterminated action fails closed.
 * `-execdir` runs in the matched file's directory. */
function findExecReason(tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>, roots: string[]): string | null {
	const args = tokens.slice(1);
	const followsSymlinks = findFollowsSymlinks(args);
	for (let i = 0; i < args.length; i++) {
		const action = unescapeCommandWord(args[i]!);
		if (!FIND_EXEC_ACTIONS.has(action)) continue;
		const end = findExecPayloadEnd(args, i + 1);
		const payload = args.slice(i + 1, end);
		const reason = findExecActionReason(payload, end === args.length, { action, followsSymlinks, roots, cwd, depth, shellVars });
		if (reason) return reason;
		i = end;
	}
	return null;
}

/** `-delete` removes every visited pathname, so -L can reach outside temp through a
 * symlink even when the search root is inside. */
function findDeleteSymlinkReason(tokens: string[]): string | null {
	const args = tokens.slice(1);
	if (!findFollowsSymlinks(args) || !scanFindActions(args).deletesPaths) return null;
	return `find blocked: -L/-follow can walk symlinks outside temp before -delete; drop -L/-follow${FAIL_CLOSED_HINT}`;
}

/** Generic mutation: extract targets via getMutationTargets, block non-temp paths. */
export function classifyGenericMutation(command: string, tokens: string[], cwd: string, shellVars: ReadonlyMap<string, string>, depth = 0): string | null {
	// Roots first: an outside search root is the real reason, and its path is more useful
	// than the `{}` placeholder the payload sees. Only then inspect an in-temp -exec payload.
	const paths = getMutationTargets(command, tokens);
	for (const { path: target, base } of paths ?? []) {
		if (target === UNMODELED_FIND_OPTION) return `find blocked: cannot model its leading option; remove it or pass an explicit search root${FAIL_CLOSED_HINT}`;
		if (target === UNPROVABLE_TARGET) return `${command} blocked: cannot model its write target${FAIL_CLOSED_HINT}`;
		const reason = base === undefined
			? tempPathBlockReason(command, target, cwd, shellVars)
			: relativeTempPathBlockReason(command, target, base, cwd, shellVars);
		if (reason) return reason;
	}
	if (command === "find") return findDeleteSymlinkReason(tokens) ?? findExecReason(tokens, cwd, depth, shellVars, findRoots(tokens.slice(1)).roots);
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
		?? classifyGenericMutation(command, tokens, cwd, shellVars, depth);
}

/** Package manager mutation: block regardless of target path. */
export function classifyPackageManager(command: string, tokens: string[]): string | null {
	if (!PACKAGE_MANAGERS.has(command)) return null;
	if (!ALWAYS_BLOCKED_PACKAGE_MANAGERS.has(command) && !isPackageMutation(command, tokens.slice(1))) return null;
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

/** Flags that consume a separate value. `--reference` replaces MODE, so its presence
 * makes every operand a target. */
const CHMOD_VALUE_OPTIONS = new Set(["--reference"]);
const CHMOD_VALUE_PREFIXES = ["--reference="] as const;
/** Short flags that are options, not a symbolic MODE. A dash token made only of mode
 * letters (`-w`, `-rwx`) is the MODE operand; chmod accepts that spelling. */
const CHMOD_OPTION_LETTERS = new Set(["R", "H", "L", "P", "f", "v", "c", "h"]);
const CHMOD_LONG_OPTIONS = new Set(["--recursive", "--silent", "--quiet", "--verbose", "--changes", "--no-preserve-root", "--preserve-root", "--help", "--version"]);

function isChmodOptionWord(word: string): boolean {
	if (word.startsWith("--")) return CHMOD_LONG_OPTIONS.has(word.split("=")[0]!);
	if (!word.startsWith("-") || word === "-") return false;
	return [...word.slice(1)].every((flag) => CHMOD_OPTION_LETTERS.has(flag));
}

/** `--reference` replaces MODE and GNU permutes options, so it can follow the operand it
 * would otherwise expose as MODE. Detect it before the operand walk. */
function chmodHasReference(args: string[]): boolean {
	for (const arg of args) {
		const word = unescapeCommandWord(arg);
		if (word === "--") return false;
		if (CHMOD_VALUE_OPTIONS.has(word)) return true;
		if (CHMOD_VALUE_PREFIXES.some((prefix) => word.startsWith(prefix))) return true;
	}
	return false;
}

function getChmodTargets(tokens: string[]): string[] {
	const args = tokens.slice(1);
	const targets: string[] = [];
	const hasReference = chmodHasReference(args);
	let modeSeen = false, optionsEnded = false;
	for (let i = 0; i < args.length; i++) {
		const raw = args[i]!;
		const word = unescapeCommandWord(raw);
		if (!optionsEnded) {
			if (word === "--") { optionsEnded = true; continue; }
			if (CHMOD_VALUE_OPTIONS.has(word)) { i++; continue; }
			if (CHMOD_VALUE_PREFIXES.some((prefix) => word.startsWith(prefix))) continue;
			if (isChmodOptionWord(word)) continue;
		}
		// `--reference` has no MODE operand; otherwise only the first operand is MODE.
		if (!hasReference && !modeSeen) { modeSeen = true; continue; }
		targets.push(raw);
	}
	return targets;
}

type CpFamilyOptionSpec = { readonly boolean: ReadonlySet<string>; readonly value: ReadonlySet<string> };

/** Short option letters for the copy family. `value` letters consume the rest of the
 * cluster (or the next token); `t` is the target-directory flag. A letter in neither set
 * makes the destination unprovable, so the parser fails closed. */
const CP_FAMILY_SHORT_OPTIONS: Record<string, CpFamilyOptionSpec> = {
	cp: { boolean: new Set(["a", "b", "d", "f", "H", "i", "L", "l", "n", "P", "p", "R", "r", "s", "T", "u", "v", "x", "Z"]), value: new Set(["S", "t"]) },
	mv: { boolean: new Set(["b", "f", "i", "n", "T", "u", "v", "Z"]), value: new Set(["S", "t"]) },
	install: { boolean: new Set(["b", "c", "C", "d", "D", "p", "s", "T", "v", "Z"]), value: new Set(["g", "m", "o", "S", "t"]) },
	ln: { boolean: new Set(["b", "d", "F", "f", "i", "L", "n", "P", "r", "s", "T", "v", "Z"]), value: new Set(["S", "t"]) },
};

/** macOS changes the arity of some letters; GNU `-S` takes a suffix, macOS `-S` is a
 * flag, and `-D`/`-T` disagree in the other direction. */
type CpFamilyOptionDelta = {
	readonly addBoolean?: readonly string[];
	readonly addValue?: readonly string[];
	readonly removeBoolean?: readonly string[];
	readonly removeValue?: readonly string[];
};

const DARWIN_CP_FAMILY_SHORT_OPTIONS: Record<string, CpFamilyOptionDelta> = {
	cp: { addBoolean: ["c", "N", "X", "S"], removeValue: ["S"] },
	mv: { addBoolean: ["h"] },
	install: { addBoolean: ["S", "U"], addValue: ["B", "D", "f", "h", "l", "M", "T"], removeBoolean: ["D", "T"], removeValue: ["S"] },
	ln: { addBoolean: ["h", "w"] },
};

function cpFamilyOptionSpec(command: string): CpFamilyOptionSpec | null {
	const base = CP_FAMILY_SHORT_OPTIONS[command];
	if (!base) return null;
	const delta = process.platform === "darwin" ? DARWIN_CP_FAMILY_SHORT_OPTIONS[command] : undefined;
	if (!delta) return base;
	const boolean = new Set(base.boolean);
	const value = new Set(base.value);
	for (const letter of delta.removeBoolean ?? []) boolean.delete(letter);
	for (const letter of delta.removeValue ?? []) value.delete(letter);
	for (const letter of delta.addBoolean ?? []) boolean.add(letter);
	for (const letter of delta.addValue ?? []) value.add(letter);
	return { boolean, value };
}

/** GNU long-option arity per cp-family command. Optional values bind only when attached.
 * Unknown or ambiguous spellings fail closed: GNU accepts unique prefixes, so ignoring an
 * unmodeled spelling can hide a destination or consume its value. macOS rejects long options;
 * treating them as GNU options only over-blocks there. The macOS short-option delta assumes
 * the host's native BSD tools; GNU coreutils earlier in PATH can change `-S`/`-D`/`-T` arity. */
type CpLongOptionArity = "value" | "flag" | "optional";
type CpLongOptionSpec = Readonly<Record<string, CpLongOptionArity>>;

const CP_FAMILY_LONG_OPTIONS: Record<string, CpLongOptionSpec> = {
	cp: {
		"--archive": "flag", "--attributes-only": "flag", "--backup": "optional", "--context": "optional",
		"--copy-contents": "flag", "--debug": "flag", "--dereference": "flag", "--force": "flag",
		"--help": "flag", "--interactive": "flag", "--keep-directory-symlink": "flag", "--link": "flag", "--no-clobber": "flag",
		"--no-dereference": "flag", "--no-preserve": "value", "--no-target-directory": "flag",
		"--one-file-system": "flag", "--parents": "flag", "--preserve": "optional", "--recursive": "flag",
		"--reflink": "optional", "--remove-destination": "flag", "--sparse": "value",
		"--strip-trailing-slashes": "flag", "--suffix": "value", "--symbolic-link": "flag",
		"--target-directory": "value", "--update": "optional", "--verbose": "flag", "--version": "flag",
	},
	mv: {
		"--backup": "optional", "--context": "optional", "--debug": "flag", "--exchange": "flag",
		"--force": "flag", "--help": "flag", "--interactive": "flag", "--no-clobber": "flag",
		"--no-copy": "flag", "--no-target-directory": "flag", "--strip-trailing-slashes": "flag",
		"--suffix": "value", "--target-directory": "value", "--update": "optional", "--verbose": "flag",
		"--version": "flag",
	},
	install: {
		"--backup": "optional", "--compare": "flag", "--context": "optional", "--debug": "flag",
		"--directory": "flag", "--group": "value", "--help": "flag", "--mode": "value",
		"--no-target-directory": "flag", "--owner": "value", "--preserve-context": "flag", "--preserve-timestamps": "flag",
		"--strip": "flag", "--strip-program": "value", "--suffix": "value",
		"--target-directory": "value", "--verbose": "flag", "--version": "flag",
	},
	ln: {
		"--backup": "optional", "--directory": "flag", "--force": "flag", "--help": "flag",
		"--interactive": "flag", "--logical": "flag", "--no-dereference": "flag",
		"--no-target-directory": "flag", "--physical": "flag", "--relative": "flag",
		"--symbolic": "flag", "--suffix": "value", "--target-directory": "value",
		"--verbose": "flag", "--version": "flag",
	},
};

/** GNU/popt long-option resolution, shared by every prefix-aware guard: an exact name wins,
 * a unique prefix resolves, and `ambiguous` names a spelling the tool rejects. */
type LongOptionMatch = { readonly name: string } | "ambiguous" | null;

function matchLongOption(name: string, options: readonly string[]): LongOptionMatch {
	if (options.includes(name)) return { name };
	const matches = options.filter((option) => option.startsWith(name));
	if (matches.length > 1) return "ambiguous";
	return matches.length === 1 ? { name: matches[0]! } : null;
}

type CpLongOptionResolution = { readonly name: string; readonly arity: CpLongOptionArity };

/** Resolve an exact GNU long option or a unique prefix, as getopt_long does. */
function resolveCpLongOption(command: string, name: string): CpLongOptionResolution | null {
	const spec = CP_FAMILY_LONG_OPTIONS[command];
	if (!spec) return null;
	const match = matchLongOption(name, Object.keys(spec));
	if (match === null || match === "ambiguous") return null;
	return { name: match.name, arity: spec[match.name]! };
}

/** Unique fail-closed sentinel. It is not a path, so a real `/` operand keeps its
 * truthful "outside temp" reason; classifyGenericMutation turns it into a clear block. */
const UNPROVABLE_TARGET = "\u0000unprovable-target";

/** One write target, plus the raw operand that supplies its resolution base when the tool
 * resolves a relative path against another operand (rsync destination-relative writes). */
type MutationTarget = { readonly path: string; readonly base?: string };

/** Effect of one cp-family option word: a destination, a consumed next token, or a
 * side-write target (macOS `install -M metalog`). */
type CpOptionScan = { readonly target: string | null; readonly skipNext: boolean; readonly extraTargets: readonly string[]; readonly unprovable: boolean; readonly flags?: readonly string[] };

/** One long option: a modeled spelling names the destination or consumes its value. */
function scanCpLongOption(command: string, raw: string, word: string, tokens: string[], index: number): CpOptionScan {
	const [name, inline] = splitFlagValue(word);
	const resolved = resolveCpLongOption(command, name);
	if (!resolved) return { target: null, skipNext: false, extraTargets: [], unprovable: true };
	if (resolved.name === "--target-directory") {
		if (inline !== undefined) return { target: rawAttachedFlagValue(raw, `${name}=`), skipNext: false, extraTargets: [], unprovable: false };
		const next = tokens[index + 1];
		return { target: next ? stripMatchingQuotes(next) : UNPROVABLE_TARGET, skipNext: Boolean(next), extraTargets: [], unprovable: false };
	}
	if (resolved.arity === "value") {
		const next = tokens[index + 1];
		if (inline === undefined && !next) return { target: null, skipNext: false, extraTargets: [], unprovable: true };
		return { target: null, skipNext: inline === undefined, extraTargets: [], unprovable: false };
	}
	return { target: null, skipNext: false, extraTargets: [], unprovable: false, flags: resolved.name === "--directory" ? ["directory"] : [] };
}

function cpOptionScan(fields: Partial<CpOptionScan> = {}): CpOptionScan {
	return { target: null, skipNext: false, extraTargets: [], unprovable: false, ...fields };
}

/** `t` names the destination; a missing value is unprovable rather than empty. */
function cpShortTargetScan(raw: string, letters: string, j: number, tokens: string[], index: number, flags: string[]): CpOptionScan {
	const attached = letters.slice(j + 1), next = tokens[index + 1];
	const target = attached ? rawAttachedFlagValue(raw, `-${letters.slice(0, j + 1)}`) : next ? stripMatchingQuotes(next) : UNPROVABLE_TARGET;
	return cpOptionScan({ target, skipNext: !attached && Boolean(next), flags });
}

/** A value letter consumes the cluster tail or the next token; `install -M` adds a write. */
function cpShortValueScan(command: string, raw: string, letters: string, j: number, tokens: string[], index: number, flags: string[]): CpOptionScan {
	const letter = letters[j]!, attached = letters.slice(j + 1), next = tokens[index + 1];
	const value = attached ? rawAttachedFlagValue(raw, `-${letters.slice(0, j + 1)}`) : next ? stripMatchingQuotes(next) : null;
	const extraTargets = command === "install" && letter === "M" && value !== null ? [value] : [];
	return cpOptionScan({ skipNext: !attached && Boolean(next), extraTargets, flags });
}

/** One short cluster: `t` names the destination; a value letter consumes the cluster tail
 * or the next token. An unknown letter makes the destination unprovable. */
function scanCpShortOption(command: string, raw: string, word: string, tokens: string[], index: number, spec: CpFamilyOptionSpec): CpOptionScan {
	const letters = word.slice(1), flags: string[] = [];
	for (let j = 0; j < letters.length; j++) {
		const letter = letters[j]!;
		if (letter === "t") return cpShortTargetScan(raw, letters, j, tokens, index, flags);
		if (spec.value.has(letter)) return cpShortValueScan(command, raw, letters, j, tokens, index, flags);
		if (!spec.boolean.has(letter)) return cpOptionScan({ unprovable: true, flags });
		flags.push(letter);
	}
	return cpOptionScan({ flags });
}

/** One pass over a cp-family segment: destination, operands, flags, side writes, unprovable. */
type CpFamilyScan = { target: string | null; operands: string[]; extraTargets: string[]; unprovable: boolean; flags: Set<string> };

function mergeCpOptionScan(result: CpFamilyScan, scan: CpOptionScan): void {
	for (const flag of scan.flags ?? []) result.flags.add(flag);
	if (scan.target !== null) result.target = scan.target; // last `-t` wins, like getopt
	result.extraTargets.push(...scan.extraTargets);
}

function scanCpFamily(command: string, tokens: string[]): CpFamilyScan {
	const result: CpFamilyScan = { target: null, operands: [], extraTargets: [], unprovable: false, flags: new Set() };
	const spec = cpFamilyOptionSpec(command);
	if (!spec) return result;
	for (let i = 1; i < tokens.length; i++) {
		const raw = tokens[i]!, word = unescapeCommandWord(raw);
		if (word === "--") { result.operands.push(...tokens.slice(i + 1)); break; }
		if (!word.startsWith("-") || word === "-") { result.operands.push(raw); continue; }
		const scan = word.startsWith("--")
			? scanCpLongOption(command, raw, word, tokens, i)
			: scanCpShortOption(command, raw, word, tokens, i, spec);
		if (scan.unprovable) { result.unprovable = true; return result; }
		mergeCpOptionScan(result, scan);
		if (scan.skipNext) i++;
	}
	return result;
}

function getCpTargets(command: string, tokens: string[]): string[] {
	const scan = scanCpFamily(command, tokens);
	if (scan.unprovable) return [UNPROVABLE_TARGET];
	if (command === "install" && (scan.flags.has("d") || scan.flags.has("directory"))) {
		const targets = [...scan.operands, ...scan.extraTargets];
		if (scan.target !== null) targets.unshift(scan.target);
		return targets;
	}
	// `ln source` has no target operand: it creates the link in the tracked cwd.
	if (command === "ln" && scan.target === null && scan.operands.length === 1) return [".", ...scan.extraTargets];
	const target = scan.target ?? scan.operands.at(-1) ?? null;
	return target !== null ? [target, ...scan.extraTargets] : scan.extraTargets;
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

/** GNU sed long options (manual, 4.9). Used only to prove a prefix is unambiguous; a
 * spelling that matches none or several is one sed rejects, so ambiguity fails closed. */
const SED_LONG_OPTIONS = [
	"--binary", "--debug", "--expression", "--file", "--follow-symlinks", "--in-place",
	"--line-length", "--null-data", "--posix", "--quiet", "--regexp-extended", "--sandbox",
	"--separate", "--silent", "--unbuffered", "--help", "--version",
];

type SedScanState = { inPlace: boolean; filtered: string[]; hasExpression: boolean; suffixAttached: boolean };

/** Long option: return 1 when its separate value must be skipped. A unique-prefix match
 * consumes the same value as the exact spelling; an ambiguous prefix fails closed. */
function scanSedLongOption(raw: string, word: string, state: SedScanState): number {
	const [name, inline] = splitFlagValue(word);
	const match = matchLongOption(name, SED_LONG_OPTIONS);
	if (match === "ambiguous" || (match !== null && match.name === "--in-place")) {
		state.inPlace = true;
		if (inline !== undefined) state.suffixAttached = true;
		return 0;
	}
	if (match !== null && (match.name === "--expression" || match.name === "--file")) {
		state.hasExpression = true;
		return inline === undefined ? 1 : 0;
	}
	state.filtered.push(raw);
	return 0;
}

/** Short bundle: `i` starts the backup suffix, `e`/`f` consume the bundle tail or the
 * next token. Return 1 when a separate value must be skipped. */
function scanSedShortOption(raw: string, word: string, state: SedScanState): number {
	let consumedValue = false, skip = 0;
	for (let j = 1; j < word.length; j++) {
		const ch = word[j]!;
		if (ch === "i") {
			state.inPlace = true;
			state.suffixAttached = j < word.length - 1; // rest is the backup suffix
			break;
		}
		if (ch === "e" || ch === "f") {
			state.hasExpression = true;
			if (j === word.length - 1) skip = 1; // separate value
			consumedValue = true;
			break;
		}
	}
	if (!consumedValue) state.filtered.push(raw);
	return skip;
}

/** Walk sed options once: detect `-i` inside a short bundle (`-Ei`, `-ni`) and the long
 * `--in-place`, while removing expression/file values from the operand list. A bundle
 * letter that takes a value ends the bundle (`-i.bak`, `-e'expr'`). */
function scanSedOptions(sedTokens: string[]): SedScanState {
	const state: SedScanState = { inPlace: false, filtered: [], hasExpression: false, suffixAttached: false };
	for (let i = 0; i < sedTokens.length; i++) {
		const raw = sedTokens[i]!, word = unescapeCommandWord(raw);
		if (word === "--") { state.filtered.push(...sedTokens.slice(i)); break; }
		if (word.startsWith("--")) { i += scanSedLongOption(raw, word, state); continue; }
		if (word.startsWith("-") && word.length > 1) { i += scanSedShortOption(raw, word, state); continue; }
		state.filtered.push(raw);
	}
	return state;
}

/** Empty or dot-prefixed operand is the BSD backup suffix; GNU reads the same word as
 * the script. */
function isSedBackupSuffix(word: string): boolean {
	return /^$|^\.[a-zA-Z0-9._-]{0,9}$/.test(stripMatchingQuotes(word));
}

/** sed -i target extraction with -e/--expression and backup-extension handling. */
function getSedTargets(tokens: string[]): string[] | null {
	const { inPlace, filtered, hasExpression, suffixAttached } = scanSedOptions(tokens.slice(1));
	if (!inPlace) return null;
	const args = nonOptionArgs(filtered);
	const suffix = !suffixAttached && args.length > 1 && isSedBackupSuffix(args[0]!) ? args[0]! : null;
	// An empty operand cannot name a GNU input file, so it is only a BSD suffix.
	const emptySuffix = suffix !== null && stripMatchingQuotes(suffix) === "";
	let targets: string[];
	if (hasExpression) {
		// GNU reads every operand as an input file; BSD reads a leading separate suffix as
		// the backup extension. Validate the union, keeping the ambiguous suffix last so a
		// concrete file names the block reason. Empty stays dropped (no GNU file possible).
		targets = suffix !== null && !emptySuffix ? [...args.slice(1), suffix] : emptySuffix ? args.slice(1) : args;
	} else {
		// BSD takes the next operand as the backup suffix; GNU reads it as the script. Skip
		// one suffix only when a file operand remains, so the file never empties the list.
		const operands = suffix !== null ? args.slice(1) : args;
		targets = operands.length <= 1 ? operands : operands.slice(1);
	}
	return targets.length > 0 ? targets : ["."]; // safety net — mutation with no provable operand
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

/** Long archive/directory destinations, including extraction under a selected directory. */
function scanTarLongPathOption(word: string, tokens: string[], index: number, scan: TarScan): number | null {
	if (word === "--file") { const v = tokens[index + 1]; if (v) { scan.archive = v; return 1; } return 0; }
	if (word.startsWith("--file=")) { scan.archive = word.slice("--file=".length); return 0; }
	if (word === "--directory") { const v = tokens[index + 1]; if (v) { scan.dirs.push(v); return 1; } return 0; }
	if (word.startsWith("--directory=")) { scan.dirs.push(word.slice("--directory=".length)); return 0; }
	if (word.startsWith("--one-top-level=")) { scan.dirs.push(word.slice("--one-top-level=".length)); return 0; }
	if (word === "--one-top-level") { scan.unparseable = true; return 0; }
	return null;
}

/** Exec/side-write options fail closed even when stdout is selected. */
function scanTarLongExecOption(word: string, tokens: string[], index: number, scan: TarScan): number | null {
	if (!TAR_EXEC_OPTIONS.has(word) && !(word.includes("=") && TAR_EXEC_OPTIONS.has(word.slice(0, word.indexOf("="))))) return null;
	scan.exec = true;
	return TAR_EXEC_OPTIONS.has(word) && tokens[index + 1] !== undefined ? 1 : 0;
}

/** Other value options skip one token so their value cannot read as a flag. */
function scanTarLongValueOption(word: string, tokens: string[], index: number): number | null {
	if (!TAR_LONG_VALUE_OPTIONS.has(word)) return null;
	return tokens[index + 1] === undefined ? 0 : 1;
}

function scanTarLongOption(word: string, tokens: string[], index: number, scan: TarScan, precededByUnmodeled: boolean): { consumed: number; pendingValue: boolean } {
	const mode = TAR_LONG_MODES[word];
	if (mode) { scan[mode] = true; return { consumed: 0, pendingValue: false }; }
	if (word === "--to-stdout") {
		if (precededByUnmodeled) scan.unparseable = true;
		else scan.stdout = true;
		return { consumed: 0, pendingValue: false };
	}
	const path = scanTarLongPathOption(word, tokens, index, scan);
	if (path !== null) return { consumed: path, pendingValue: false };
	const exec = scanTarLongExecOption(word, tokens, index, scan);
	if (exec !== null) return { consumed: exec, pendingValue: false };
	const value = scanTarLongValueOption(word, tokens, index);
	if (value !== null) return { consumed: value, pendingValue: false };
	return { consumed: 0, pendingValue: !TAR_LONG_FLAGS.has(word) && !word.includes("=") };
}

function scanTarShortOption(word: string, tokens: string[], index: number, scan: TarScan, precededByUnmodeled: boolean): { consumed: number; stop: boolean } {
	const stdoutBefore = scan.stdout;
	const consumed = scanTarBundle(word, tokens[index + 1], scan, !word.startsWith("-"));
	// The bundle is the previous long option's value when it sets stdout: trusting it
	// would allow a real extraction (`tar -xf a.tar --quote-chars -O`).
	const stop = precededByUnmodeled && scan.stdout && !stdoutBefore;
	if (stop) scan.unparseable = true;
	return { consumed, stop };
}

function scanTarAttachedShortOption(word: string, scan: TarScan): boolean {
	if (word.startsWith("-C") && word.length > 2) { scan.dirs.push(rawAttachedFlagValue(word, "-C")); return true; }
	if (word.startsWith("-f") && word.length > 2) { scan.archive = word.slice(2); return true; }
	return false;
}

/** A bundle with a non-letter tail consumed its value ambiguously; fail closed. */
function isTarMalformedWord(word: string, index: number): boolean {
	return /^-[a-zA-Z]+[^a-zA-Z]/.test(word) || (index === 1 && /^[a-zA-Z]+[^a-zA-Z]/.test(word));
}

function isTarShortWord(word: string, index: number): boolean {
	return /^-[a-zA-Z]+$/.test(word) || (index === 1 && /^[a-zA-Z]+$/.test(word));
}

/** Handle one non-long word: a short bundle, an attached `-C`/`-f`, or a malformed tail. */
function scanTarShortWord(word: string, tokens: string[], index: number, scan: TarScan, precededByUnmodeled: boolean): { consumed: number; stop: boolean } | null {
	if (isTarShortWord(word, index)) return scanTarShortOption(word, tokens, index, scan, precededByUnmodeled);
	if (scanTarAttachedShortOption(word, scan)) return { consumed: 0, stop: false };
	if (isTarMalformedWord(word, index)) scan.unparseable = true;
	return null;
}

/** Scan leading options (operands are skipped, tar permutes flags) for modes, archive, dirs. */
function scanTarOptions(tokens: string[]): TarScan {
	const scan: TarScan = { write: false, extract: false, list: false, stdout: false, exec: false, archive: null, dirs: [], unparseable: false };
	// An unmodeled long option may consume the next token as its value. If that token
	// spells `-O`/`--to-stdout`, trusting it would let a real extraction read as stdout.
	let pendingValue = false;
	for (let i = 1; i < tokens.length; i++) {
		const word = unescapeCommandWord(tokens[i]!), precededByUnmodeled = pendingValue;
		pendingValue = false;
		if (word === "--") break;
		if (word.startsWith("--")) {
			const long = scanTarLongOption(word, tokens, i, scan, precededByUnmodeled);
			i += long.consumed; pendingValue = long.pendingValue;
			if (scan.unparseable) break;
			continue;
		}
		const short = scanTarShortWord(word, tokens, i, scan, precededByUnmodeled);
		if (short !== null) {
			i += short.consumed;
			if (short.stop) break;
			continue;
		}
	}
	return scan;
}

function getTarTargets(tokens: string[]): string[] | null {
	const scan = scanTarOptions(tokens);
	if (scan.unparseable) return [UNPROVABLE_TARGET];
	// Exec/side-write options run code or write files regardless of stdout routing.
	if (scan.exec) return [UNPROVABLE_TARGET];
	if (scan.list && !scan.write && !scan.extract) return null; // `tar -t` reads the archive only
	// Conflicting action modes cannot be proven safe: creation targets the archive while
	// extraction writes member files, so check neither guess and fail closed.
	if (scan.write && scan.extract) return [UNPROVABLE_TARGET];
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

/** One rsync long option: whether popt consumes a value, and when that value names a write
 * target, the directory rsync resolves a relative value against. The value set is rsync
 * `options.c` `long_options[]` (client and daemon) plus the exact flags that prefix a value
 * option, because a missed value can hide the real destination. Unknown names are flags and
 * any ambiguous prefix fails closed. */
type RsyncLongOptionSpec = { readonly value?: true; readonly write?: "cwd" | "destination"; readonly replay?: true };

const RSYNC_LONG_OPTIONS: Readonly<Record<string, RsyncLongOptionSpec>> = {
	// Exact flags that are strict prefixes of value options: popt prefers the exact name.
	"--backup": {}, "--partial": {}, "--compress": {}, "--checksum": {},
	// Write targets. The receiver chdirs into the destination, so --backup-dir/--temp-dir and
	// the relative --partial-dir land under it; log/batch files stay in the caller's cwd.
	"--backup-dir": { value: true, write: "destination" },
	"--temp-dir": { value: true, write: "destination" },
	"--partial-dir": { value: true, write: "destination" },
	"--log-file": { value: true, write: "cwd" },
	"--write-batch": { value: true, write: "cwd" },
	"--only-write-batch": { value: true, write: "cwd" },
	// Value options that select no write target the classifier tracks.
	"--info": { value: true }, "--debug": { value: true }, "--stderr": { value: true },
	"--confine-root": { value: true }, "--chmod": { value: true }, "--modify-window": { value: true },
	"--max-size": { value: true }, "--min-size": { value: true }, "--max-alloc": { value: true },
	"--max-delete": { value: true }, "--filter": { value: true }, "--exclude": { value: true },
	"--include": { value: true }, "--exclude-from": { value: true }, "--include-from": { value: true },
	"--checksum-choice": { value: true }, "--cc": { value: true }, "--checksum-seed": { value: true },
	"--block-size": { value: true }, "--compare-dest": { value: true }, "--copy-dest": { value: true },
	"--link-dest": { value: true }, "--compress-choice": { value: true }, "--zc": { value: true },
	"--compress-level": { value: true }, "--zl": { value: true }, "--compress-threads": { value: true },
	"--zt": { value: true }, "--skip-compress": { value: true }, "--log-file-format": { value: true },
	"--out-format": { value: true }, "--log-format": { value: true }, "--bwlimit": { value: true },
	"--suffix": { value: true }, "--read-batch": { value: true, replay: true }, "--files-from": { value: true },
	"--usermap": { value: true }, "--groupmap": { value: true }, "--chown": { value: true },
	"--stop-after": { value: true }, "--time-limit": { value: true }, "--stop-at": { value: true },
	"--rsh": { value: true }, "--rsync-path": { value: true }, "--iconv": { value: true },
	"--copy-as": { value: true }, "--address": { value: true }, "--sockopts": { value: true },
	"--password-file": { value: true }, "--early-input": { value: true }, "--outbuf": { value: true },
	"--remote-option": { value: true }, "--timeout": { value: true }, "--contimeout": { value: true },
	"--protocol": { value: true }, "--port": { value: true }, "--config": { value: true },
	"--dparam": { value: true },
};

/** rsync short options that consume the bundle tail (or the next word) as a value.
 * `@` is --modify-window: rsync requires an argument for the short form too.
 * `T` also names a write target resolved under the destination. */
const RSYNC_SHORT_VALUE_OPTIONS: Readonly<Record<string, { readonly write?: "destination" }>> = {
	e: {}, f: {}, B: {}, T: { write: "destination" }, M: {}, "@": {},
};

/** Exact-name-first option resolution; an ambiguous prefix is a spelling rsync rejects. */
function resolveRsyncLongOption(name: string): RsyncLongOptionSpec | "ambiguous" | null {
	const exact = RSYNC_LONG_OPTIONS[name];
	if (exact) return exact;
	const matches = Object.keys(RSYNC_LONG_OPTIONS).filter((option) => option.startsWith(name));
	if (matches.length > 1) return "ambiguous";
	return matches.length === 1 ? RSYNC_LONG_OPTIONS[matches[0]!]! : null;
}

/** One rsync write option value. `destination` means the tool resolves a relative value
 * against the destination operand, not the caller cwd. */
type RsyncWriteScan = { readonly target: string; readonly write: NonNullable<RsyncLongOptionSpec["write"]> };

/** One-pass rsync argv state: replay mode changes the positional grammar. */
type RsyncScan = { readonly positionals: string[]; readonly targets: RsyncWriteScan[]; replay: boolean; unprovable: boolean };

/** Consume one long option word; the return value is the index of its last argv word. */
function scanRsyncLongOption(raw: string, word: string, args: string[], index: number, scan: RsyncScan): number | "ambiguous" {
	const [name, inline] = splitFlagValue(word);
	const option = resolveRsyncLongOption(name);
	if (option === null) return index;
	if (option === "ambiguous") return "ambiguous";
	if (option.value !== true) return index;
	if (option.replay) scan.replay = true;
	const target = inline !== undefined ? rawAttachedFlagValue(raw, `${name}=`) : args[index + 1];
	if (target === undefined) return index; // missing value: rsync rejects the command
	if (option.write) scan.targets.push({ target, write: option.write });
	return inline === undefined ? index + 1 : index;
}

/** Consume a short bundle: the first value letter takes the remaining letters or the next
 * word, so letters after it are data and never become positionals. */
function scanRsyncShortOption(raw: string, word: string, args: string[], index: number, scan: RsyncScan): number {
	const letters = word.slice(1);
	for (let j = 0; j < letters.length; j++) {
		const spec = RSYNC_SHORT_VALUE_OPTIONS[letters[j]!];
		if (!spec) continue;
		if (j < letters.length - 1) {
			if (spec.write) scan.targets.push({ target: rawAttachedFlagValue(raw, `-${letters.slice(0, j + 1)}`), write: spec.write });
			return index;
		}
		const next = args[index + 1];
		if (next === undefined) return index;
		if (spec.write) scan.targets.push({ target: next, write: spec.write });
		return index + 1;
	}
	return index;
}

/** One-pass rsync argv scan, so option values are removed before the positional list is
 * read. Two passes let a separate option value masquerade as the destination. */
function scanRsyncArgs(args: string[]): RsyncScan {
	const scan: RsyncScan = { positionals: [], targets: [], replay: false, unprovable: false };
	for (let i = 0; i < args.length; i++) {
		const raw = args[i]!;
		const word = unescapeCommandWord(raw);
		if (word === "--") { scan.positionals.push(...args.slice(i + 1)); break; }
		if (word.startsWith("--")) {
			const consumed = scanRsyncLongOption(raw, word, args, i, scan);
			if (consumed === "ambiguous") scan.unprovable = true;
			else i = consumed;
			continue;
		}
		if (!word.startsWith("-") || word === "-") { scan.positionals.push(raw); continue; }
		i = scanRsyncShortOption(raw, word, args, i, scan);
	}
	return scan;
}

/** rsync writes into the last positional. A batch replay has no source operand, so one
 * positional is already the destination and no positional means the caller's cwd. */
function rsyncDestination(scan: RsyncScan): string | null {
	if (scan.replay) return scan.positionals[scan.positionals.length - 1] ?? ".";
	return scan.positionals.length >= 2 ? scan.positionals[scan.positionals.length - 1]! : null;
}

function getRsyncTargets(tokens: string[]): MutationTarget[] | null {
	const scan = scanRsyncArgs(tokens.slice(1));
	const destination = rsyncDestination(scan);
	// Destination first: it is the real write root, and a relative option only proves
	// containment once that root is proven inside temp.
	const targets: MutationTarget[] = scan.unprovable ? [{ path: UNPROVABLE_TARGET }] : [];
	if (destination !== null) targets.push({ path: destination });
	for (const { target, write } of scan.targets) {
		if (write === "destination" && destination === null) targets.push({ path: UNPROVABLE_TARGET });
		else targets.push(write === "destination" ? { path: target, base: destination! } : { path: target });
	}
	return targets.length > 0 ? targets : null;
}

/** unzip flags that read the archive without extracting. */
const UNZIP_READ_LETTERS = new Set(["l", "t", "Z", "v", "p", "c"]);
const UNZIP_READ_LONG_FLAGS = new Set(["--list", "--test", "--info"]);

/** Info-ZIP option state for one unzip command line. */
type UnzipScan = { readOnly: boolean; negatedRead: boolean; unmodeled: boolean; dirs: string[] };

/** `-` inside an Info-ZIP bundle negates the next letter: `-o-t` is overwrite + not-test. */
function negateUnzipLetter(next: string | undefined, scan: UnzipScan): void {
	if (next === undefined) return; // trailing dash is a no-op
	if (UNZIP_READ_LETTERS.has(next)) { scan.negatedRead = true; return; }
	// A negated value letter has no modeled meaning; fail closed instead of guessing.
	if (next === "d" || next === "P") scan.unmodeled = true;
}

/** Consume one short bundle; `P` data and `d` values are not option letters. */
function scanUnzipBundle(raw: string, word: string, tokens: string[], index: number, scan: UnzipScan): number {
	for (let j = 1; j < word.length; j++) {
		const ch = word[j]!;
		if (ch === "-") { negateUnzipLetter(word[j + 1], scan); j++; continue; }
		if (ch === "P") return index + (j === word.length - 1 ? 2 : 1);
		if (ch === "d") {
			const attached = j === word.length - 1 ? "" : rawOperandAfterDecodedFlag(raw, word.slice(0, j + 1));
			scan.dirs.push(attached || tokens[index + 1] || ".");
			return index + (attached ? 1 : 2);
		}
		if (UNZIP_READ_LETTERS.has(ch)) scan.readOnly = true;
	}
	return index + 1;
}

function getUnzipTargets(tokens: string[]): string[] | null {
	// `-d <dir>` chooses the extraction directory; otherwise unzip writes into the cwd, so the
	// cwd itself is the target. Combined flags (`-oqd/outside`) hide `-d` from a prefix check,
	// so walk the bundle and decide read-only only after the complete argument list: a negated
	// read letter (`-o-t`) leaves extraction active even when another read letter appears.
	const scan: UnzipScan = { readOnly: false, negatedRead: false, unmodeled: false, dirs: [] };
	for (let i = 1; i < tokens.length;) {
		const raw = tokens[i]!;
		const word = unescapeCommandWord(raw);
		if (word === "--") break;
		if (UNZIP_READ_LONG_FLAGS.has(word)) { scan.readOnly = true; i++; continue; }
		if (!word.startsWith("-") || word === "-") { i++; continue; }
		i = scanUnzipBundle(raw, word, tokens, i, scan);
	}
	if (scan.unmodeled) return [UNPROVABLE_TARGET];
	if (scan.readOnly && !scan.negatedRead) return null;
	return scan.dirs.length > 0 ? scan.dirs : ["."];
}

/** Wrap a plain target list so every command shares one target shape. */
function asMutationTargets(paths: string[] | null): MutationTarget[] | null {
	return paths?.map((path) => ({ path })) ?? null;
}

export function getMutationTargets(command: string, tokens: string[]): MutationTarget[] | null {
	// rsync resolves some write options against the destination, so it builds its own shape.
	if (command === "rsync") return getRsyncTargets(tokens);
	return asMutationTargets(plainMutationTargets(command, tokens));
}

function plainMutationTargets(command: string, tokens: string[]): string[] | null {
	switch (command) {
		case "rm": case "rmdir": case "unlink": case "mkdir": return getRmTargets(tokens);
		case "truncate": return getTruncateTargets(tokens);
		case "touch": return getTouchTargets(tokens);
		case "chmod": case "chown": case "chgrp": return getChmodTargets(tokens);
		case "cp": case "mv": case "install": case "ln": return getCpTargets(command, tokens);
		case "tee": return getTeeTargets(tokens);
		case "sed": return getSedTargets(tokens);
		case "perl": case "ruby": return getPerlRubyTargets(tokens);
		case "find": return getFindMutationTargets(tokens.slice(1));
		case "wget": return getWgetTargets(tokens);
		case "curl": return getCurlTargets(tokens);
		case "tar": return getTarTargets(tokens);
		case "unzip": return getUnzipTargets(tokens);
		default: return null;
	}
}

const FIND_PREROOT_FLAGS = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);
const UNMODELED_FIND_OPTION = "\u0000find-unmodeled-option";

/** Roots are the operands before the expression, after every BSD/GNU pre-root option.
 * `-f <path>` adds a root (BSD semantics) and its getopt phase continues, so a repeated `-f`
 * adds another root; `-D`/`-O` take non-root values. An unmodeled leading option may consume
 * the next word, so the cwd default is never trusted for it: the parse reports the option and
 * the caller fails closed. */
function findRoots(args: string[]): { roots: string[]; unmodeled: string | null } {
	const roots: string[] = [];
	let options = true;
	for (let i = 0; i < args.length;) {
		const word = unescapeCommandWord(args[i]!);
		if (options) {
			if (word === "--") { options = false; i++; continue; }
			if (FIND_PREROOT_FLAGS.has(word)) { i++; continue; }
			if (word === "-f" || word === "-D") {
				const value = args[i + 1];
				if (value === undefined) return { roots, unmodeled: word };
				if (word === "-f") roots.push(findRootTarget(value));
				i += 2; continue;
			}
			if (/^-D./.test(word) || /^-O/.test(word)) { i++; continue; }
		}
		if (word === "(" || word === ")" || word === "!" || word === ",") break;
		if (word.startsWith("-")) {
			// Known options were consumed above. A dash token before any root is ambiguous:
			// it may take the following path as its value, hiding the real root.
			if (options || roots.length === 0) return { roots, unmodeled: word };
			break;
		}
		roots.push(findRootTarget(args[i]!));
		options = false;
		i++;
	}
	return { roots, unmodeled: null };
}

/** Never drop a root the classifier cannot model: tilde/glob roots reach the path checker,
 * and brace alternation (not expanded by the glob model) and home expansion fail closed. */
function findRootTarget(root: string): string {
	return /[{}]/.test(root) || root.startsWith("~") ? UNPROVABLE_TARGET : root;
}

function getFindMutationTargets(args: string[]): string[] | null {
	const { roots, unmodeled } = findRoots(args);
	const { mutatesPaths, outputs } = scanFindActions(args);
	if (!mutatesPaths && outputs.length === 0) return null;
	const targets: string[] = [];
	// Roots are write targets only for delete/exec; output-only actions read the search tree.
	if (mutatesPaths) targets.push(...(unmodeled ? [UNMODELED_FIND_OPTION] : roots.length > 0 ? roots : ["."]));
	targets.push(...outputs);
	return targets;
}

export function isPackageMutation(command: string, args: string[]): boolean {
	// Token-level matching (vs. substring-on-joined-string) avoids false positives
	// when a path or argument contains a verb word (install-sh, etc.). Quoted and
	// escaped spellings are the same argv word to the invoked program.
	const grammar = PACKAGE_MODE_TABLES[command];
	if (grammar) return packageGrammarMutates(grammar, args);
	return args.some((arg) => PACKAGE_MUTATION_WORDS.has(unescapeCommandWord(arg).toLowerCase()));
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
