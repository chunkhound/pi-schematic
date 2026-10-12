/**
 * Per-command mutation classifiers and shared token utilities.
 *
 * Each `classify*` function handles one command shape (sudo, env, interpreter,
 * wget, curl, xargs, generic mutation, package manager). The dispatcher chains
 * them; the first matching reason wins. Target extractors (getRmTargets, etc.)
 * pull filesystem paths from command arguments for temp-dir checking.
 */
import { decodeShellAssignmentValue, tempPathBlockReason, rawAttachedFlagValue, stripMatchingQuotes, stripRedirectTokens, expandShellVariable, splitFlagValue, normalizedCommand, unescapeCommandWord, getCommandTokens, SHELL_WORD_PATTERN, SHELL_SCRIPT_CONSUMERS, skipLeadingRedirections } from "./readonly-shell-utils.js";
import { matchingParenIndex, extractProcessSubstitutions } from "./readonly-bash-scanner.js";
import { classifyGit } from "./readonly-bash-git.js";
import { resolveDirectoryTarget } from "./readonly-bash-dirchange.js";
import { classifyBashCommand, classifySubstitutionOutput, classifySubstitutionScript } from "./readonly-bash.js";
import { buildReadonlyPackageManagerBlockReason, FAIL_CLOSED_HINT } from "./notifications.js";

// Interpreters whose inline-execution flag is recursively classified.
// node -c = syntax check only (non-executing); node -e executes code.
export const INTERPRETER_EXEC_FLAGS: Record<string, string[]> = {
	node: ["-e"],
	bash: ["-c"], sh: ["-c"], zsh: ["-c"], dash: ["-c"], ksh: ["-c"],
	python3: ["-c"], python: ["-c"],
	perl: ["-e"],
	ruby: ["-e"],
};

export const INTERPRETERS = new Set(Object.keys(INTERPRETER_EXEC_FLAGS));

// Package managers are blocked unconditionally — they mutate system state
// outside any single directory (npm install writes to node_modules, pip
// installs to site-packages, etc.). Temp-dir path checking is not meaningful.
export const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "pip", "pip3", "pipx", "apt", "apt-get", "brew", "cargo", "gem", "yum", "dnf", "pacman", "choco"]);

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

/**
 * Approximate the word the nested shell receives: decode `$'...'` ANSI-C quoting and
 * turn `\$` into `$`, so `\$(` and `$'$( )'` are seen as substitutions. Unescaping can
 * only over-block, which fails closed.
 */
export function demangleNestedArgument(raw: string): string {
	if (raw.startsWith("$'") && raw.endsWith("'")) return raw.slice(2, -1).replace(/\\(.)/g, "$1");
	return stripMatchingQuotes(raw).replace(/\\\$/g, "$");
}

/** Interpreters with inline-execution flags — classify inline code recursively. */
export function classifyInterpreter(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (!INTERPRETERS.has(command)) return null;
	const args = tokens.slice(1);
	for (const flag of INTERPRETER_EXEC_FLAGS[command]) {
		const idx = args.indexOf(flag);
		if (idx === -1 || idx + 1 >= args.length) continue;
		const script = demangleNestedArgument(args[idx + 1]!);
		// The inline script is code; a command substitution inside it is code once expanded.
		const outputReason = classifySubstitutionOutput(script, cwd, depth, shellVars);
		if (outputReason) return `${command} ${flag} blocked: ${outputReason}`;
		// A whole-substitution `-c` argument runs the substitution's OUTPUT; its heredoc
		// bodies were forced to code above. Classifying the raw `$(…)` text as shell would
		// misread the substitution command as the child program.
		if (isWholeCommandSubstitution(script)) continue;
		const nested = classifyBashCommand(script, cwd, depth + 1, shellVars);
		if (!nested.ok) return `${command} ${flag} blocked: ${nested.reason}`;
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

/** xargs: classify the command xargs would run + block targetless mutation commands. */
export function classifyXargs(command: string, tokens: string[], cwd: string, depth: number, shellVars: ReadonlyMap<string, string>): string | null {
	if (command !== "xargs") return null;
	const xArgs = tokens.slice(1);
	const XARGS_FLAGS_WITH_VALUE = new Set(["-I", "-L", "-n", "-P", "-d", "-E", "-s"]);
	let cmdStart = 0;
	while (cmdStart < xArgs.length) {
		const word = unescapeCommandWord(xArgs[cmdStart]);
		if (XARGS_FLAGS_WITH_VALUE.has(word)) { cmdStart += 2; continue; }
		if (word.startsWith("-")) { cmdStart++; continue; }
		break;
	}
	if (cmdStart >= xArgs.length) return null;
	const xTokens = xArgs.slice(cmdStart);
	const nested = classifyBashCommand(xTokens.join(" "), cwd, depth + 1, shellVars);
	if (!nested.ok) return nested.reason;
	const xCmd = xTokens[0] ? normalizedCommand(xTokens[0]) : "";
	if (xCmd && getMutationTargets(xCmd, xTokens) !== null) return `xargs ${xCmd} blocked: mutation command via xargs`;
	return null;
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

/** One option scan result: action modes, the `-f` archive operand, and `-C` directories. */
type TarScan = { write: boolean; extract: boolean; list: boolean; archive: string | null; dirs: string[]; unparseable: boolean };

/** Consume one short-bundle word (`-czf`, dash-less `tar cf`) into the scan; bare `f`/`C` take
 * the next token, so the returned count tells the caller how many tokens were consumed. */
function scanTarBundle(word: string, next: string | undefined, scan: TarScan, dashless: boolean): number {
	let consumed = 0;
	const letters = word.replace(/^-/, "");
	for (let j = 0; j < letters.length; j++) {
		const ch = letters[j]!, attached = letters.slice(j + 1);
		if (TAR_WRITE_LETTERS.has(ch)) scan.write = true;
		else if (ch === "x") scan.extract = true;
		else if (ch === "t") scan.list = true;
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
	}
	return consumed;
}

/** Scan leading options (operands are skipped, tar permutes flags) for modes, archive, dirs. */
function scanTarOptions(tokens: string[]): TarScan {
	const scan: TarScan = { write: false, extract: false, list: false, archive: null, dirs: [], unparseable: false };
	for (let i = 1; i < tokens.length; i++) {
		const word = unescapeCommandWord(tokens[i]!);
		if (word === "--") break;
		if (word.startsWith("--")) {
			const mode = TAR_LONG_MODES[word];
			if (mode) scan[mode] = true;
			else if (word === "--file") { const v = tokens[i + 1]; if (v) { scan.archive = v; i++; } }
			else if (word.startsWith("--file=")) scan.archive = word.slice("--file=".length);
			else if (word === "--directory") { const v = tokens[i + 1]; if (v) { scan.dirs.push(v); i++; } }
			else if (word.startsWith("--directory=")) scan.dirs.push(word.slice("--directory=".length));
			continue;
		}
		if (/^-[a-zA-Z]+$/.test(word) || (i === 1 && /^[a-zA-Z]+$/.test(word))) { i += scanTarBundle(word, tokens[i + 1], scan, !word.startsWith("-")); continue; }
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
	if (scan.list && !scan.write && !scan.extract) return null; // `tar -t` reads the archive only
	if (scan.write) return [scan.archive ?? "."];               // creation writes the archive operand
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
