import path from "node:path";
import { decodeShellPathOperand, isTempLiteralPath, rawAttachedFlagValue, unescapeCommandWord, getCommandTokens } from "./readonly-shell-utils.js";
import { TEMP_DIR } from "./temp-dir.js";

/** Parsed mktemp flags: the template pattern and/or an explicit base directory.
 * `ambientBase` marks a base that stood in for the runtime TMPDIR (bare `--tmpdir`, `-t`):
 * the synthetic provenance holds only when that ambient base resolves inside temp. */
export type MktempArgs = { template: string | null; tmpdirBase: string | null; directory: boolean; ambientBase?: boolean };

export function parseMktempArgs(args: string[]): MktempArgs | null {
	const parsed: MktempArgs = { template: null, tmpdirBase: null, directory: false };
	for (let i = 0; i < args.length; i++) {
		const arg = unescapeCommandWord(args[i]!);
		if (!arg) continue;
		if (arg === "-d" || arg === "--directory") { parsed.directory = true; continue; }
		if (arg === "--") return mktempAfterDoubleDash(args, i, parsed);
		const flag = consumeMktempFlag(arg, args, i);
		if (flag === null) return null; // `-t` is unsupported on non-darwin
		if (flag.tmpdirBase !== undefined) parsed.tmpdirBase = flag.tmpdirBase;
		if (flag.ambient) parsed.ambientBase = true;
		if (flag.template !== undefined) parsed.template = flag.template;
		if (flag.skip) i++;
	}
	return parsed;
}

/** `--` makes the next word the template; a second operand is unsupported, so fail closed. */
function mktempAfterDoubleDash(args: string[], i: number, parsed: MktempArgs): MktempArgs | null {
	if (args.length > i + 2) return null;
	parsed.template = args[i + 1] ?? "";
	return parsed;
}

/** One mktemp flag consumed: returns undefined fields for "not this flag", or null for unsupported. */
function consumeMktempFlag(arg: string, args: string[], i: number):
	{ tmpdirBase?: string | null; template?: string | null; skip?: boolean; ambient?: boolean } | null {
	if (arg === "-p") return { tmpdirBase: args[i + 1] || null, skip: true };
	if (arg.startsWith("-p") && arg.length > 2) return { tmpdirBase: rawAttachedFlagValue(args[i], "-p") };
	if (arg === "-t" || (arg.startsWith("-t") && arg.length > 2)) {
		if (process.platform !== "darwin") return null;
		const value = arg === "-t" ? args[i + 1] ?? "" : rawAttachedFlagValue(args[i], "-t");
		if (!value && arg === "-t") return null;
		// `-t` builds its name under the runtime TMPDIR, not a fixed root: ambient like bare --tmpdir.
		return { template: value || null, tmpdirBase: TEMP_DIR, skip: arg === "-t", ambient: true };
	}
	if (arg === "--tmpdir") { const bare = resolveBareTmpdir(args, i); return { tmpdirBase: bare.base, ambient: bare.ambient }; }
	// An empty `--tmpdir=` behaves like bare `--tmpdir`: mktemp falls back to TMPDIR, so the
	// synthetic path holds only when the ambient base resolves inside temp.
	if (arg.startsWith("--tmpdir=")) {
		const value = rawAttachedFlagValue(args[i], "--tmpdir=");
		return value ? { tmpdirBase: value } : { tmpdirBase: TEMP_DIR, ambient: true };
	}
	if (arg === "--suffix" || arg.startsWith("--suffix=")) return { skip: arg === "--suffix" };
	if (arg === "-q" || arg === "--quiet") return {};
	if (arg.startsWith("-")) return null; // No dry runs or unknown flag semantics.
	return { template: args[i] };
}

/** Bare `--tmpdir` creates under the runtime TMPDIR, not a fixed root, so it is flagged
 * ambient; an explicit DIR operand stays proven. Two following positionals make the
 * first an explicit DIR even if relative. */
function resolveBareTmpdir(args: string[], i: number): { base: string; ambient: boolean } {
	const next = args[i + 1] ?? "";
	const nextNext = args[i + 2] ?? "";
	if (next && !next.startsWith("-") && nextNext && !nextNext.startsWith("-")) return { base: next, ambient: false };
	if (next && !next.startsWith("-") && looksLikeDirectory(unescapeCommandWord(next))) return { base: next, ambient: false };
	return { base: TEMP_DIR, ambient: true };
}

function looksLikeDirectory(token: string): boolean {
	return token.startsWith("/") || token.startsWith("~") || token.startsWith("$")
		|| token.includes("/") || token === "." || token === "..";
}

export function resolveMktempSyntheticPath(template: string | null, tmpdirBase: string | null, cwd: string, shellVars: ReadonlyMap<string, string>, name: string, ambientBase = false): string | null {
	const synthetic = path.join(TEMP_DIR, `.pi-mktemp-${name.toLowerCase()}`);
	const base = tmpdirBase === null ? null : decodeShellPathOperand(tmpdirBase, shellVars);
	const operand = template ? decodeShellPathOperand(template, shellVars) : null;
	if ((tmpdirBase !== null && (!base || base.glob)) || (template && (!operand || operand.glob))) return null;
	if (base) {
		if (!isTempLiteralPath(base.value, cwd)) return null;
		// An ambient base (TEMP_DIR stand-in for runtime TMPDIR) keeps provenance only when
		// the real ambient base resolves inside temp.
		if (ambientBase && !ambientBaseInTemp(shellVars, cwd)) return null;
		if (!operand) return synthetic;
		if (path.isAbsolute(operand.value)) return null;
		return isTempLiteralPath(path.join(base.value, operand.value), cwd) ? synthetic : null;
	}
	// With no template and no explicit base, mktemp creates inside the ambient temp dir
	// (TMPDIR/TMP/TEMP); an override that resolves outside temp voids the provenance.
	if (!operand && !ambientBaseInTemp(shellVars, cwd)) return null;
	if (operand && !isTempLiteralPath(operand.value, cwd)) return null;
	return synthetic;
}

/** Bare mktemp uses the first set TMPDIR/TMP/TEMP; that base must resolve inside temp. */
function ambientBaseInTemp(shellVars: ReadonlyMap<string, string>, cwd: string): boolean {
	for (const name of ["TMPDIR", "TMP", "TEMP"]) {
		const value = shellVars.get(name) ?? process.env[name];
		if (value) return isTempLiteralPath(value, cwd);
	}
	return true;
}

function unwrapCommandSubstitution(rawValue: string): string | null {
	// Single quotes make substitutions literal; only a whole double-quoted value
	// can preserve execution. Concatenated quote fragments must not gain provenance.
	const normalized = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
	if (normalized.startsWith("$(") && normalized.endsWith(")")) return normalized.slice(2, -1);
	if (normalized.startsWith("`") && normalized.endsWith("`")) return normalized.slice(1, -1);
	return null;
}

function mktempSyntheticFor(rawValue: string, cwd: string, shellVars: ReadonlyMap<string, string>, name: string, wantDirectory: boolean): string | null {
	const innerCmd = unwrapCommandSubstitution(rawValue);
	// Redirections/composition change the substitution's output or exit status.
	if (!innerCmd || /[;|&<>`\n]/.test(innerCmd) || innerCmd.includes("$(")) return null;
	const innerTokens = getCommandTokens(innerCmd);
	if (innerTokens[0] !== "mktemp") return null;
	const parsed = parseMktempArgs(innerTokens.slice(1));
	if (!parsed || parsed.directory !== wantDirectory) return null;
	return resolveMktempSyntheticPath(parsed.template, parsed.tmpdirBase, cwd, shellVars, name, parsed.ambientBase === true);
}

/** Directory provenance: only `mktemp -d` proves its output is a directory.
 * Chain with &&, not ;: `D=$(mktemp -d) && cd "$D"` proves the move, while
 * `D=$(mktemp -d); cd "$D"` keeps the caller cwd (a failed mktemp assigns empty). */
export function getSafeMktempSyntheticPath(rawValue: string, cwd: string, shellVars: ReadonlyMap<string, string>, name: string): string | null {
	return mktempSyntheticFor(rawValue, cwd, shellVars, name, true);
}

/** File provenance: plain `mktemp` proves a writable file path, never a directory. */
export function getSafeMktempFileSyntheticPath(rawValue: string, cwd: string, shellVars: ReadonlyMap<string, string>, name: string): string | null {
	return mktempSyntheticFor(rawValue, cwd, shellVars, name, false);
}
