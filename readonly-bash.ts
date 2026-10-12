import { canUseOsSandbox, wrapCommandWithOsSandbox } from "./os-sandbox.js";
import {
	buildReadonlyBashBlockReason,
	FAIL_CLOSED_HINT,
	READONLY_INVALID_BASH_COMMAND_REASON,
} from "./notifications.js";
import {
	decodeShellAssignmentValue, tempPathBlockReason, getCommandTokens,
	normalizedCommand, unescapeCommandWord, matchRedirectToken,
} from "./readonly-shell-utils.js";
import { consumeShellCharacter, splitUnquotedShellSegments, extractCommandSubstitutions } from "./readonly-bash-scanner.js";
import type { ShellScan, ShellPart } from "./readonly-bash-scanner.js";
import { stripHeredocBodies, classifyHeredocBody } from "./readonly-bash-heredoc.js";
import type { HeredocBody } from "./readonly-bash-heredoc.js";
import { getSafeMktempSyntheticPath, getSafeMktempFileSyntheticPath } from "./readonly-bash-mktemp.js";
import { getFilesystemMutationReason, DECL_KEYWORDS, stripDeclKeywords } from "./readonly-bash-commands.js";
import {
	applyDirectoryChange, compoundChangesDirectory, compoundSegmentReason,
	CWD_UNCERTAIN_BUILTINS, deferredCodeReason, parentShellBuiltinTokens,
	runWithPassDirectoryCache,
} from "./readonly-bash-dirchange.js";

/** Outcome of classifying one bash command: allowed, or a user-facing reason it is blocked. */
export type Verdict =
	| { ok: true }
	| { ok: false; reason: string };

/**
 * Readonly bash guard.
 *
 * Contract: block filesystem writes/deletions outside the writable temp roots
 * (`TEMP_WRITE_ROOTS` in temp-dir.ts).
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
 *     A `-c`/`-e` script that contains shell metacharacters (e.g. an `=>` arrow
 *     function's `>`, or `$(...)` of its own) is scanned for shell operators too,
 *     so such code may over-block (fail closed) — safe, but surprising.
 *   - **xargs with stdin-fed package managers** — `printf install | xargs npm`
 *     bypasses because `xargs npm` alone has no verb args. The pipe feeds
 *     `install` at runtime via stdin; only the OS sandbox blocks the writes.
 *   - **Wrapper indirection** — `nohup`/`nice`/`timeout`/`stdbuf`/`chroot` (and
 *     similar) around a mutation are not unwrapped by the dispatcher; only L1
 *     blocks the enclosed write. (They are unwrapped for heredoc stdin owners.)
 *   - **Read-only subcommands that still write metadata** — a `git status` index
 *     refresh can still write inside a repository found by ambient cwd discovery or
 *     `-C <outside>` outside temp. A command that PINS the `.git` metadata (`--git-dir`,
 *     `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`) is path-checked like a write.
 *   - **`GIT_OBJECT_DIRECTORY` on immutable Git commands** — mutable commands
 *     path-check it, but immutable commands anchor only `GIT_DIR`, `GIT_COMMON_DIR`,
 *     and `GIT_INDEX_FILE`, so a redirected object store goes unchecked. Immutable
 *     reads rarely write objects, so the exposure is small.
 *   - **Wrapper flags before the wrapped command** — `time -p`, `exec -c/-a`,
 *     `sudo -nu/--user`, and `xargs -a/--max-args` are not
 *     fully parsed, so the value can be mistaken for the command word. Attached
 *     interpreter flags (`python3 -c"…"`) have the same shape.
 *   - **Heredocs attached to a `( ... )`/`{ ... }` group** — the owner is read from the
 *     header line only, so a benign group heredoc whose closing bracket is on a later
 *     line (`(cat <<EOF … )`) is treated as code and false-blocks. A group whose shell
 *     member sits behind other commands (`{ cat; bash; }`) also fails closed: how much
 *     stdin each member consumes is unknowable before execution.
 *   - **Body written to a temp file then executed** — `cat <<EOF > /tmp/x; bash < /tmp/x`
 *     is not tracked across commands. Same class as running an unread script file.
 *   - **Literal `$(...)`/backticks inside single quotes** — Bash does not expand them,
 *     but the substitution scanner reads the quoted text as code and classifies it, so
 *     `echo '$(rm -rf /)'` false-blocks. A benign literal (`echo '$(date)'`) passes
 *     because the inner command is itself allowed. Pre-existing; fails closed only.
 *   - **`||` after a brace group or `eval`/`source`** — the body runs in the parent
 *     shell, so a failed body may already have moved the cwd. The classifier now
 *     classifies the `||` branch in the body's final cwd (brace groups) or the
 *     unknown cwd (`eval`/`source`), so `{ cd /etc; false; } || touch x` blocks.
 *     A body whose last command is a directory change keeps the caller-cwd fallback.
 *     When the body's final cwd is only partly known the `||` branch is checked
 *     against every candidate, which over-blocks (fails closed) but never under-blocks.
 *   - **`shopt -s lastpipe`** — pipelines normally do not leak the cwd, but with
 *     lastpipe the last stage runs in the parent shell: `shopt -s lastpipe;
 *     echo x | cd /etc; touch y` fails open. Only the OS sandbox blocks the write.
 *   - **Opaque command-substitution output fed to `eval`/`source`** — the classifier
 *     models the substitution's inner command but not what it prints, so
 *     `eval "$(echo touch /etc/x)"` is allowed: `echo` is non-mutating and the
 *     `touch /etc/x` text reaches `eval` only at runtime. Deliberate and fail-open.
 *     Modeled substitutions (`$(cd /etc; pwd)`) still move the tracked cwd.
 *   - **Command-substitution command words** — a substitution in command position
 *     (`$(which sh) -c true`) is not expanded because its output becomes argv and
 *     cannot be proven, so it fails closed. Harmless substitutions over-block.
 *   - **Shared host `/tmp` under L1** — Linux bwrap bind-mounts the world-writable host
 *     `/tmp` instead of a private tmpfs, matching macOS Seatbelt, which always allowed it.
 *     A hostile local process can plant a symlink in `/tmp` between classification and
 *     execution (TOCTOU); the classifier resolves paths only before the command runs.
 *   - **Process substitution `>(...)`** — the substitution scanner extracts backticks,
 *     `$(...)`, and `<(...)`, but not `>(...)`. With a temp cwd, the redirect scan reads the
 *     `>` target as `(command`, resolves it inside temp, and the inner command runs
 *     unclassified: `cd /tmp && echo x >(touch /etc/x)`. From an outside cwd the bogus target
 *     blocks. Pre-existing.
 *   - **Brace expansion** — `{a,b}` alternatives are not expanded, so an unmatched brace
 *     pattern falls back to a literal containment check: `touch {/outside/x,/tmp/a}` writes
 *     outside temp. Pre-existing.
 *   - **`mv`/`cp` check only the destination** — `getCpTargets` returns the last operand, so
 *     `mv /outside/x /tmp/` deletes outside temp unclassified (a source `cp` is a read).
 *     Pre-existing.
 *   - **`sudo --chdir`/`-D`** — `--chdir` sits in the value-flag set, so its value is skipped
 *     rather than modeled like `env -C`'s chdir; short `-D` is unmodeled. Both classify the
 *     wrapped command at the caller cwd. Pre-existing.
 *   - **Repo-local Git configuration is trusted input** — a `.git/config` inside temp that
 *     names executables (`remote.<n>.uploadpack`, `core.pager`, `core.sshCommand`) runs them;
 *     only command-provided `-c`/environment values are vetted. Executing a program is outside
 *     the write contract, so this is a deliberate trust boundary, not an outside write.
 *   - **Top-level `>=`** — the redirect scanner treats `>` before `=` as a comparison. That is
 *     true only inside `[[ ]]`/`(( ))`/`[ ]`; at command level `echo a >= notes.txt` writes a
 *     file named `=` in the current directory.
 *   - **`mktemp` targets** — `getMutationTargets` has no `mktemp` case, so
 *     `mktemp -d /outside/x.XXXXXX` is allowed. Only `mktemp -d` substitution output used as a
 *     directory anchor is validated. L1 blocks the write.
 *   - **`sed` `w`/`W` and `sort -o` output targets** — these stdin data consumers can name an
 *     output path in a script or flag. Only `sed -i` targets are extracted, so
 *     `sed "w /outside/x" <<EOF` and `sort -o /outside/x <<EOF` write unclassified.
 */


/**
 * Classify a bash command string for readonly mode.
 *
 * Heredoc bodies are preprocessed first (stdin data is inert; shell stdin is
 * recursively classified). The remainder is split into shell-operator-separated
 * segments (&&, ||, ;, |, &, \n) and walked with a tracked state: cwd, directory
 * stack, and shell variables. Parent-shell cd/pushd/popd move it, compound
 * commands (if/while/for/case/function definitions) and eval/source yield a
 * fail-closed unknown-cwd branch, while pipelines and background jobs do not
 * leak state. Each segment is checked for command substitutions ($(...),
 * backticks), write redirects (>), and filesystem mutations — including
 * path-aware Git write-root analysis. Blocks if any write target resolves
 * outside the shared temp-write roots (TEMP_WRITE_ROOTS in temp-dir.ts,
 * enforced identically by the OS sandbox).
 *
 * When OS-level sandboxing (canUseOsSandbox()) is available, this serves as a fallback —
 * the kernel-enforced sandbox enforces the same write-restriction policy.
 *
 * @param cmd - Raw bash command string (may contain multiple segments via &&, ;, |, etc.)
 * @param cwd - Working directory for relative path resolution (defaults to process.cwd())
 * @returns {ok: true} if allowed, or {ok: false, reason} with explanation
 */

export function classifyBashCommand(
	cmd: string, cwd: string = process.cwd(), depth: number = 0,
	shellVars: ReadonlyMap<string, string> = new Map(),
): Verdict {
	return classifyBashWithHeredocs(cmd, cwd, depth, shellVars, new Map());
}

/**
 * Classify a command whose heredoc bodies were pre-extracted by stripHeredocBodies.
 * Bodies travel as records instead of inline text so stdin data is never parsed as
 * shell source; nested classifications re-enter here to inherit them.
 *
 * @param cmd - Command text with heredoc operators replaced by body markers
 * @param inheritedHeredocs - Body records bound to those markers
 * @param cwd - Working directory for relative path resolution
 * @param depth - Recursion depth (bounded by classifyBashCommand)
 * @param shellVars - Variables assigned by earlier segments
 * @returns {ok: true} if allowed, or {ok: false, reason} with an explanation
 */
export function classifyBashWithHeredocs(
	cmd: string, cwd: string, depth: number,
	shellVars: ReadonlyMap<string, string>, inheritedHeredocs: ReadonlyMap<string, HeredocBody>,
): Verdict {
	// One memoized fs view per top-level pass so cd reachability cannot drift mid-command.
	return runWithPassDirectoryCache(() => {
		const prepared = stripHeredocBodies(cmd, inheritedHeredocs);
		if (prepared === null) return { ok: false, reason: `unsupported stdin code, group heredoc, or unterminated heredoc (e.g. avoid { cat; bash; } <<EOF)${FAIL_CLOSED_HINT}` };
		const initial: ShellState = { cwd, stack: [], vars: new Map(shellVars), directories: new Set(), heredocs: prepared.heredocs };
		const result = classifyShellSequence(prepared.command, [initial], depth);
		return result.ok ? { ok: true } : result;
	});
}

function classifyShellSequence(cmd: string, initial: ShellState[], depth: number): ShellGroupResult {
	if (depth > 10) return { ok: false, reason: `recursion depth exceeded in command classification${FAIL_CLOSED_HINT}` };
	let states = initial;
	const parts = splitUnquotedShellSegments(cmd);
	if (parts.some((part) => part.unsupported)) return { ok: false, reason: `unsupported shell grouping syntax${FAIL_CLOSED_HINT}` };
	for (const group of shellExecutionGroups(parts)) {
		const result = classifyShellGroup(group.parts, states, depth);
		if (!result.ok) return result;
		// Background jobs run in a child shell: their state changes never propagate.
		if (!group.background) states = result.states;
	}
	return { ok: true, states };
}

// Vars travel with the state so each && / || branch sees exactly the assignments
// that ran on its path — no shared mutable map, no conditional-invalidation hacks.
export type ShellState = {
	cwd: string; stack: string[]; vars: Map<string, string>;
	directories: ReadonlySet<string>; heredocs: ReadonlyMap<string, HeredocBody>;
};
export type ShellOutcome = { success: ShellState[]; failure: ShellState[] };
type ShellGroupResult = { ok: true; states: ShellState[] } | { ok: false; reason: string };

function uniqueShellStates(states: ShellState[]): ShellState[] {
	// Map does not survive JSON.stringify — serialize vars explicitly so states
	// that differ only by their var maps stay distinct.
	const key = (state: ShellState) => JSON.stringify([state.cwd, state.stack, [...state.vars], [...state.directories]]);
	return [...new Map(states.map((state) => [key(state), state])).values()];
}

function shellExecutionGroups(parts: ShellPart[]): { parts: ShellPart[]; background: boolean }[] {
	const groups: { parts: ShellPart[]; background: boolean }[] = [];
	let pending: ShellPart[] = [];
	for (const part of parts) {
		pending.push(part);
		if ([";", "\n", "&", ""].includes(part.operator)) {
			groups.push({ parts: pending, background: part.operator === "&" });
			pending = [];
		}
	}
	return groups;
}

function classifyShellGroup(parts: ShellPart[], initial: ShellState[], depth: number): ShellGroupResult {
	let outcome: ShellOutcome = { success: initial, failure: initial };
	let operator = "";
	// States entering the most recent pipeline, kept for the `||` fallback in activeShellStates.
	let pipelineInput = initial;
	for (let i = 0; i < parts.length; i++) {
		const active = activeShellStates(operator, outcome, pipelineInput, initial);
		pipelineInput = active;
		const pipeline = takeShellPipeline(parts, i);
		const result = classifyShellPipeline(pipeline, uniqueShellStates(active), depth);
		if (!result.ok) return result;
		outcome = carryShellOutcome(operator, outcome, result.outcome);
		i += pipeline.length - 1;
		operator = pipeline[pipeline.length - 1].operator;
	}
	return { ok: true, states: uniqueShellStates([...outcome.success, ...outcome.failure]) };
}

/** States entering the next pipeline. Invariant: at least one success state and at least one
 * failure branch always survive, because an empty set would iterate zero states, classify
 * nothing, and pass vacuously as {ok:true} — a silent fail-open. A `||` branch also keeps its
 * previous states when the LHS provably cannot fail: the runtime can still fail it. */
function activeShellStates(operator: string, outcome: ShellOutcome, previous: ShellState[], initial: ShellState[]): ShellState[] {
	const active = operator === "&&" ? outcome.success
		: operator === "||" ? (outcome.failure.length > 0 ? outcome.failure : previous)
		: initial;
	return active.length === 0 ? initial : active;
}

function carryShellOutcome(operator: string, previous: ShellOutcome, next: ShellOutcome): ShellOutcome {
	if (operator === "&&") next.failure.push(...previous.failure);
	if (operator === "||") next.success.push(...previous.success);
	return next;
}

function takeShellPipeline(parts: ShellPart[], start: number): ShellPart[] {
	let end = start;
	while (parts[end]?.operator === "|" || parts[end]?.operator === "|&") end++;
	return parts.slice(start, end + 1);
}

function classifyShellPipeline(parts: ShellPart[], states: ShellState[], depth: number):
	{ ok: true; outcome: ShellOutcome } | { ok: false; reason: string } {
	const outcome: ShellOutcome = { success: [], failure: [] };
	for (const state of states) {
		let next: ShellOutcome = { success: [state], failure: [state] };
		for (const part of parts) {
			// Pipeline stages run concurrently: cwd/stack/vars/directory-provenance never leak across stages or downstream.
			const result = classifyShellPart(part.text.trim(), state, depth);
			if (!result.ok) return result;
			if (parts.length === 1) next = result.outcome;
		}
		outcome.success.push(...next.success);
		outcome.failure.push(...next.failure);
	}
	return { ok: true, outcome };
}

// Brace groups execute in the parent shell; subshells and pipelines must not leak cwd/stack.
function classifyShellPart(segment: string, state: ShellState, depth: number):
	{ ok: true; outcome: ShellOutcome } | { ok: false; reason: string } {
	const heredocReason = heredocSegmentReason(segment, state, depth);
	if (heredocReason) return { ok: false, reason: heredocReason };
	segment = stripHeredocMarkers(segment, state.heredocs);
	if (segment.startsWith("{")) return classifyBraceGroup(segment, state, depth);
	const reason = shellSegmentReason(segment, state, depth);
	if (reason) return { ok: false, reason };
	return { ok: true, outcome: applySegmentAssignments(segment, applyDirectoryChange(segment, state)) };
}

/**
 * Standalone assignments (including export/declare forms) update the shell's
 * vars for subsequent segments. Prefix assignments belong to their command
 * only and never leak into the shell state (parseCommandPrefix handles those).
 */
function applySegmentAssignments(segment: string, outcome: ShellOutcome): ShellOutcome {
	return {
		success: outcome.success.map((state) => assignedShellState(segment, state, true)),
		failure: outcome.failure.map((state) => assignedShellState(segment, state, false)),
	};
}

function assignedShellState(segment: string, state: ShellState, success: boolean): ShellState {
	const { assignments, complete, directories, files } = getStandaloneShellAssignments(segment, state.cwd, state.vars);
	const vars = new Map(state.vars), tokens = getCommandTokens(segment);
	if (normalizedCommand(tokens[0] ?? "") === "unset") {
		// `-v/-f/-n` (combined like `-vf`) and `--` are unset's own options, not
		// variable names; treating them as names once deleted a var called "v".
		let operands = tokens.slice(1);
		if (operands[0] === "--") operands = operands.slice(1);
		for (const token of operands) if (!UNSET_FLAG_PATTERN.test(token)) vars.delete(unescapeCommandWord(token));
	}
	if (!complete || assignments.size === 0) return { ...state, vars };
	// Failed command substitutions assign empty output, never file or directory provenance.
	for (const [name, value] of assignments) vars.set(name, !success && (directories.has(value) || files.has(value)) ? "" : value);
	return { ...state, vars, directories: success ? new Set([...state.directories, ...directories]) : state.directories };
}

/** Var-name check for `unset` operands: exclude its `-v/-f/-n` option tokens. */
const UNSET_FLAG_PATTERN = /^-[vfn]+$/;

/** Split `{ body; } trailing` at the matching close brace. Null when unterminated. */
function splitBraceGroup(segment: string): { body: string; trailing: string } | null {
	if (!/^\{\s/.test(segment)) return null;
	const scan: ShellScan = { current: "", quote: "", escaped: false, nesting: 0 };
	for (let i = 0; i < segment.length; i++) {
		consumeShellCharacter(scan, segment[i], segment.slice(0, i));
		if (scan.nesting !== 0) continue;
		if (segment[i] !== "}") return null;
		const body = segment.slice(1, i);
		return /[;\n]\s*$/.test(body) ? { body, trailing: segment.slice(i + 1) } : null;
	}
	return null;
}

/** True when trailing text holds only write redirects (fd/operator plus target). */
function isRedirectOnlyTrailing(trailing: string): boolean {
	const tokens = getCommandTokens(trailing);
	for (let i = 0; i < tokens.length; i++) {
		const match = matchRedirectToken(tokens[i]!);
		if (!match) return false;
		if (match[0] === tokens[i]) i++;
		if (i >= tokens.length) return false;
	}
	return true;
}

/** Last non-empty simple command in a brace body, or null when the body is empty. */
function lastSimpleCommand(body: string): string | null {
	const parts = splitUnquotedShellSegments(body);
	for (let i = parts.length - 1; i >= 0; i--) {
		const text = parts[i]!.text.trim();
		if (text) return text;
	}
	return null;
}

/**
 * True when a brace body's final simple command may leave the shell in a new
 * directory (cd/pushd/popd, a compound holding one, or eval/source). Only then
 * can the group's `||` failure branch still run in the caller cwd.
 */
function endsWithDirectoryChange(body: string): boolean {
	const last = lastSimpleCommand(body);
	if (last === null) return false;
	if (parentShellBuiltinTokens(last) !== null || compoundChangesDirectory(last)) return true;
	const lead = getCommandTokens(last)[0];
	return lead !== undefined && CWD_UNCERTAIN_BUILTINS.has(normalizedCommand(lead));
}

/** Brace groups run in the parent shell; redirects apply before the body runs. */
function classifyBraceGroup(segment: string, state: ShellState, depth: number):
	{ ok: true; outcome: ShellOutcome } | { ok: false; reason: string } {
	const split = splitBraceGroup(segment);
	if (!split || !isRedirectOnlyTrailing(split.trailing)) return { ok: false, reason: `unsupported brace group syntax${FAIL_CLOSED_HINT}` };
	const unsafe = split.trailing.trim() ? writeRedirectBlockReason(split.trailing, state.cwd, state.vars) : null;
	if (unsafe) return { ok: false, reason: unsafe };
	const result = classifyShellSequence(split.body, [state], depth + 1);
	if (!result.ok) return result;
	if (!split.trailing.trim()) return { ok: true, outcome: { success: result.states, failure: braceFailureBranches(split, result, state) } };
	// A failing trailing redirect skips the body, so the failure branch keeps caller state.
	return { ok: true, outcome: { success: result.states, failure: [...result.states, state] } };
}

/** Failure branches of a group. When its last command is a directory change, the
 * failure branch runs in the caller cwd (a failed change leaves it unchanged), so
 * an empty failure set lets the `||` fallback reuse the caller states. Otherwise
 * the body's directory changes already ran, so `||` runs in the body's final cwd
 * and must be classified there; reusing the caller cwd instead let
 * `{ cd /etc; false; } || touch x` write outside temp. */
function braceFailureBranches(split: { body: string }, result: { ok: true; states: ShellState[] }, state: ShellState): ShellState[] {
	return endsWithDirectoryChange(split.body) ? [] : result.states;
}

function stripHeredocMarkers(segment: string, heredocs: ReadonlyMap<string, HeredocBody>): string {
	for (const marker of extractCommandSubstitutions(segment)) {
		if (heredocs.has(marker)) segment = segment.replaceAll(`$(${marker})`, "");
	}
	return segment.trim();
}

/** Prefix a nested block reason once; nested classifications repeat the same prefix. */
function nestedBlockReason(prefix: string, reason: string): string {
	return reason.includes(prefix) ? reason : `${prefix}: ${reason}`;
}

function heredocSegmentReason(segment: string, state: ShellState, depth: number): string | null {
	for (const subcommand of extractCommandSubstitutions(segment)) {
		const body = state.heredocs.get(subcommand);
		if (!body) continue;
		const verdict = classifyHeredocBody(body, state, depth + 1);
		if (!verdict.ok) return nestedBlockReason("heredoc blocked", verdict.reason);
	}
	return null;
}

function shellSegmentReason(segment: string, state: ShellState, depth: number): string | null {
	for (const subcommand of extractCommandSubstitutions(segment)) {
		const nested = classifyBashWithHeredocs(subcommand, state.cwd, depth + 1, state.vars, state.heredocs);
		if (!nested.ok) return nestedBlockReason("command substitution blocked", nested.reason) + quotedSubstitutionHint(segment, nested.reason);
	}
	const redirect = writeRedirectBlockReason(segment, state.cwd, state.vars);
	if (redirect) return redirect;
	return compoundSegmentReason(segment, state, depth)
		?? deferredCodeReason(segment, state, depth)
		?? getFilesystemMutationReason(segment, state.cwd, depth, state.vars);
}

/** Single quotes make `$(...)`/backticks literal, but the scanner still reads them as code. */
function quotedSubstitutionHint(segment: string, reason: string): string {
	if (reason.includes("fail-closed") || !/'[^']*(?:\$\(|`)/.test(segment)) return "";
	return ` (literal '$(...)' is still scanned; rephrase without it)${FAIL_CLOSED_HINT}`;
}

/**
 * Classify the heredoc bodies a substitution carries as shell code.
 *
 * A data-consumer heredoc (`cat <<EOF`) is inert to its own command, but when an
 * outer shell consumes the substitution result as its script (`bash -c "$(…)"`,
 * `eval "$(…)"`, `bash <(…)`) that same body becomes the child's program text.
 * Bind the bodies, force `keep`, and classify each as code; fail closed when the
 * heredoc is unterminated. Returns a block reason, or null when every body is safe.
 */
export function classifySubstitutionScript(
	subcommand: string, cwd: string, depth: number, vars: ReadonlyMap<string, string>,
): string | null {
	const prepared = stripHeredocBodies(subcommand, new Map());
	if (prepared === null) return `unsupported substitution heredoc${FAIL_CLOSED_HINT}`;
	const state: ShellState = { cwd, stack: [], vars: new Map(vars), directories: new Set(), heredocs: prepared.heredocs };
	for (const body of prepared.heredocs.values()) {
		const verdict = classifyHeredocBody({ spec: { ...body.spec, keep: true }, text: body.text }, state, depth + 1);
		if (!verdict.ok) return verdict.reason;
	}
	return null;
}

/** First block reason from the heredoc bodies in any `$(…)`/backtick substitution of `script`. */
export function classifySubstitutionOutput(script: string, cwd: string, depth: number, vars: ReadonlyMap<string, string>): string | null {
	for (const subcommand of extractCommandSubstitutions(script)) {
		const reason = classifySubstitutionScript(subcommand, cwd, depth, vars);
		if (reason) return reason;
	}
	return null;
}

// ── Assignment tracking ───────────────────────────────

function countParentheses(s: string): number {
	let diff = 0;
	for (const ch of s) { if (ch === "(") diff++; else if (ch === ")") diff--; }
	return diff;
}

/** Walk `cmd` once, Bash-quote-aware: single quotes make backslash literal,
 * double quotes honor escapes. Returns indices of unquoted characters and
 * the quote (if any) left open at the end. */
function scanUnquoted(cmd: string): { unquoted: number[]; openQuote: '"' | "'" | null } {
	const unquoted: number[] = [];
	let quote: '"' | "'" | null = null, escaped = false;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		unquoted.push(i);
	}
	return { unquoted, openQuote: quote };
}

/** True when `word` ends inside an unclosed quote (backslash escapes honored). */
function hasUnbalancedQuote(word: string): boolean {
	return scanUnquoted(word).openQuote !== null;
}

/** True while a `$(` / backtick substitution at the value start is still unterminated. */
function substitutionOpen(rawValue: string): boolean {
	const sub = rawValue.startsWith('"') ? rawValue.slice(1) : rawValue;
	if (sub.startsWith("$(")) return countParentheses(sub) > 0;
	return sub.startsWith("`") && sub.indexOf("`", 1) === -1;
}

/** Values split on whitespace rejoin while a quote or substitution stays unterminated. */
function rejoinValueTokens(tokens: string[], start: number, initial: string): { rawValue: string; nextIndex: number } {
	let rawValue = initial, i = start;
	while (i + 1 < tokens.length && (hasUnbalancedQuote(rawValue) || substitutionOpen(rawValue))) {
		rawValue += ` ${tokens[++i]}`;
	}
	return { rawValue, nextIndex: i };
}

function substitutionSuccessBound(segment: string): boolean {
	// Declaration builtins mask substitution failure; multiple substitutions report
	// only the last status. Neither proves that a particular mktemp succeeded.
	return !DECL_KEYWORDS.has(getCommandTokens(segment)[0] ?? "") && extractCommandSubstitutions(segment).length === 1;
}

/** Mutable sinks and inputs shared by the assignment-walk helpers. */
interface ShellAssignmentContext {
	cwd: string;
	shellVars: ReadonlyMap<string, string>;
	successBound: boolean;
	assignments: Map<string, string>;
	directories: Set<string>;
	files: Set<string>;
}

/** Result of scanning one segment for standalone assignments and mktemp provenance. */
type ShellAssignmentScan = { assignments: Map<string, string>; directories: Set<string>; files: Set<string>; complete: boolean };

export function getStandaloneShellAssignments(
	segment: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map(),
): ShellAssignmentScan {
	const assignments = new Map<string, string>(), directories = new Set<string>(), files = new Set<string>();
	const tokens = stripDeclKeywords(getCommandTokens(segment));
	if (tokens.length === 0) return { assignments, directories, files, complete: false };
	const context: ShellAssignmentContext = {
		cwd, shellVars, successBound: substitutionSuccessBound(segment), assignments, directories, files,
	};
	const complete = collectShellAssignments(tokens, context);
	return { assignments, directories, files, complete };
}

/** Walk tokens, recording every `NAME=value` and reporting whether any token was neither. */
function collectShellAssignments(tokens: string[], context: ShellAssignmentContext): boolean {
	let unconsumed = false;
	for (let i = 0; i < tokens.length; i++) {
		const match = tokens[i]?.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) {
			// Redirects were validated on the raw segment; they are syntax, not stray
			// words that make the assignment list incomplete (`export D=x 2>/dev/null`).
			// Handled here, not by pre-stripping: rejoin must still see `>` inside
			// an unbalanced quoted value (`D="a > b"`).
			const redirect = matchRedirectToken(tokens[i]!);
			if (redirect) { if (redirect[0] === tokens[i]) i++; continue; }
			unconsumed = true;
			continue;
		}
		i = recordShellAssignment(tokens, i, match, context);
	}
	return !unconsumed;
}

/** Decode one assignment token (rejoining unbalanced-quote continuations) into the sinks. */
function recordShellAssignment(tokens: string[], index: number, match: RegExpMatchArray, context: ShellAssignmentContext): number {
	const [, name, initial] = match;
	const { rawValue, nextIndex } = rejoinValueTokens(tokens, index, initial);
	const value = decodeShellAssignmentValue(rawValue);
	const currentVars = new Map([...context.shellVars, ...context.assignments]);
	const directory = context.successBound ? getSafeMktempSyntheticPath(rawValue, context.cwd, currentVars, name) : null;
	const file = !directory && context.successBound ? getSafeMktempFileSyntheticPath(rawValue, context.cwd, currentVars, name) : null;
	if (directory) context.directories.add(directory);
	if (file) context.files.add(file);
	context.assignments.set(name, directory ?? file ?? value);
	return nextIndex;
}

// ── Redirect checking ─────────────────────────────────

/** Skip whitespace; return the current index. */
function skipWhitespace(cmd: string, start: number): number {
	let i = start;
	while (i < cmd.length && /\s/.test(cmd[i])) i++;
	return i;
}

function readQuotedRedirectTarget(cmd: string, start: number): { target: string; end: number } {
	const quote = cmd[start];
	let target = quote, i = start + 1;
	while (i < cmd.length) {
		const ch = cmd[i];
		target += ch;
		if (ch === "\\" && quote === '"' && i + 1 < cmd.length) { i++; target += cmd[i]; continue; }
		if (ch === quote) { i++; break; }
		i++;
	}
	return { target, end: i };
}

function readUnquotedRedirectTarget(cmd: string, start: number): { target: string; end: number } {
	let target = "", i = start;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "\n") break;
		if (ch === "&" && target !== "") break;
		target += ch;
		i++;
	}
	return { target, end: i };
}

function readRedirectTarget(cmd: string, start: number): { target: string; end: number } {
	const i = skipWhitespace(cmd, start);
	if (i >= cmd.length) return { target: "", end: i };
	const first = cmd[i];
	return (first === '"' || first === "'") ? readQuotedRedirectTarget(cmd, i) : readUnquotedRedirectTarget(cmd, i);
}

/** Is the `>` at position `i` a non-file redirect (fd redirect or comparison)? */
function isNonFileRedirect(cmd: string, i: number): boolean {
	const next = cmd[i + 1];
	if (next === "&" && /^[\d-]$/.test(cmd[i + 2] ?? "")) return true; // >&N = fd redirect
	// `>=` is a comparison only inside `[[ ]]`/`(( ))`/`[ ]`; at command level Bash writes a
	// file named `=` (Known L2 limitation). The skip stays until context-aware scoping lands.
	if (next === "=") return true;
	return false;
}

/** First write-redirect block reason, or null when all targets stay inside the temp roots. */
function writeRedirectBlockReason(cmd: string, cwd: string, shellVars: ReadonlyMap<string, string> = new Map()): string | null {
	for (const i of scanUnquoted(cmd).unquoted) {
		const ch = cmd[i];
		if (ch !== ">" || isNonFileRedirect(cmd, i)) continue;
		const opLen = ">|&".includes(cmd[i + 1] ?? "") ? 2 : 1;
		const { target, end } = readRedirectTarget(cmd, i + opLen);
		const reason = tempPathBlockReason("write redirect", target, cwd, shellVars);
		if (reason) return reason;
	}
	return null;
}

/**
 * Bash applies redirects before cd. File existence cannot prove redirect success:
 * permissions, noclobber, descriptor state, and races can preserve the original cwd.
 * Keep that failure branch without tracking shell options; && selects success only.
 */
export function redirectMayAbortCommand(segment: string): boolean {
	for (const i of scanUnquoted(segment).unquoted) {
		const ch = segment[i];
		const next = segment[i + 1] ?? "";
		if ((ch === "<" || ch === ">") && next === "&") return true; // Untracked fd may be closed.
		if (ch === "<" ? ["<", "(", ">"].includes(next) : ch !== ">" || isNonFileRedirect(segment, i)) continue;
		return true;
	}
	return false;
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
function classifyResult(cmd: string, cwd: string): ReadonlyBashGuardResult | null {
	const verdict = classifyBashCommand(cmd, cwd);
	return verdict.ok ? null : { action: "block", reason: buildReadonlyBashBlockReason(verdict.reason, cmd) };
}

export function applyReadonlyBashGuard(cmd: unknown, cwd: string): ReadonlyBashGuardResult {
	if (typeof cmd !== "string") {
		return { action: "block", reason: buildReadonlyBashBlockReason(READONLY_INVALID_BASH_COMMAND_REASON, "<invalid input>") };
	}
	const blocked = classifyResult(cmd, cwd);
	if (blocked) return blocked;
	if (!canUseOsSandbox()) return { action: "allow" };
	// Sandbox build failure (e.g. no writable temp root) fails closed, never passthrough-allow.
	try {
		return { action: "sandbox", sandboxedCommand: wrapCommandWithOsSandbox(cmd) };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { action: "block", reason: buildReadonlyBashBlockReason(`sandbox unavailable: ${detail}`, cmd) };
	}
}
