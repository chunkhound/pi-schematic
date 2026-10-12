import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { parseMktempArgs, resolveMktempSyntheticPath } from "../../readonly-bash-mktemp.js";
import { TEMP_DIR } from "../../temp-dir.js";
import { shellPath } from "./helpers.js";

// Verdict contracts for mktemp provenance: each case pins the user-facing
// allow/block of a full `mktemp && use` chain from an outside cwd. Internal
// arg-parsing shapes are covered once here via verdicts, not via deepEqual on
// parse output; `--` and `--tmpdir DIR template` cases live in
// readonly-coverage-gaps.test.ts and are not repeated here.
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const outside = shellPath(path.join(os.homedir(), "readonly-mktemp-outside"));

function verdict(command: string, allowed: boolean): void {
	assert.equal(classifyBashCommand(command, outside).ok, allowed, command);
}

// At most one smoke per helper: these pin the wiring (fail-closed on unknown
// flags, outside bases rejected), never the full flag matrix.
test("parseMktempArgs smoke: unknown flags fail closed", () => {
	assert.equal(parseMktempArgs(["-z"]), null);
});

test("resolveMktempSyntheticPath smoke: outside-temp template rejected", () => {
	assert.equal(resolveMktempSyntheticPath("x.XXXXXX", null, outside, new Map(), "mktemp"), null);
});

test("mktemp -d/--directory grants directory provenance", () => {
	verdict('D=$(mktemp -d) && cd "$D" && touch f', true);
	verdict('D=$(mktemp --directory) && cd "$D" && touch f', true);
});

test("mktemp -p with an outside base blocks, inside-temp base allows", () => {
	verdict(`D=$(mktemp -d -p ${quote(outside)} x.XXXXXX) && cd "$D" && touch f`, false);
	verdict(`D=$(mktemp -d -p${quote(shellPath(TEMP_DIR))} x.XXXXXX) && cd "$D" && touch f`, true);
});

test("mktemp --tmpdir=attached base follows the named base", () => {
	verdict(`D=$(mktemp -d --tmpdir=${quote(outside)} x.XXXXXX) && cd "$D" && touch f`, false);
	verdict(`D=$(mktemp -d --tmpdir=${quote(shellPath(TEMP_DIR))} x.XXXXXX) && cd "$D" && touch f`, true);
});

test("mktemp -t fails closed on non-darwin", () => {
	if (process.platform !== "darwin") {
		verdict('D=$(mktemp -d -t foo.XXXXXX) && cd "$D" && touch f', false);
	}
});

test("mktemp --suffix keeps file provenance", () => {
	verdict('F=$(mktemp --suffix=.tmp) && echo > "$F"', true);
});

test("mktemp positional template inside temp allows, outside blocks", () => {
	verdict(`F=$(mktemp ${quote(shellPath(path.join(TEMP_DIR, "x.XXXXXX")))}) && echo > "$F"`, true);
	verdict(`F=$(mktemp ${quote(shellPath(path.join(outside, "x.XXXXXX")))}) && echo > "$F"`, false);
});

test("mktemp unknown flags fail closed", () => {
	verdict('D=$(mktemp -d -z) && cd "$D" && touch f', false);
	verdict('D=$(mktemp -d --unknown) && cd "$D" && touch f', false);
});

// NOTE: directory-vs-file provenance mismatch (plain mktemp fed to cd, or
// mktemp -d fed to a file write) still resolves inside temp end to end, so no
// verdict pins a block there; the single-owner helper distinction is internal.
test("getSafeMktempSyntheticPath allows mktemp -d && cd chain", () => {
	verdict('D=$(mktemp -d) && cd "$D" && touch f', true);
});

test("getSafeMktempSyntheticPath blocks semicolon cd chain", () => {
	verdict('D=$(mktemp -d); cd "$D"; touch f', false);
});

test("getSafeMktempFileSyntheticPath allows file provenance write", () => {
	verdict('F=$(mktemp) && echo > "$F"', true);
});

test("mktemp -d with outside base blocks", () => {
	verdict(`mktemp -d ${quote(shellPath(path.join(outside, "x.XXXXXX")))} && cd "$D" && touch f`, false);
});

test("--tmpdir without a value follows the runtime TMPDIR like bare mktemp", () => {
	// GNU mktemp treats bare --tmpdir as "ambient TMPDIR", not as the fixed TEMP_DIR stand-in,
	// so an outside TMPDIR voids the synthetic provenance exactly like bare mktemp.
	const savedTmpDir = process.env.TMPDIR;
	try {
		delete process.env.TMPDIR;
		verdict(`D=$(mktemp -d --tmpdir) && cd "$D" && touch f`, true);
		verdict(`export TMPDIR=${quote(outside)}; D=$(mktemp -d --tmpdir) && cd "$D" && touch f`, false);
		// An explicit DIR operand plus a template stays proven regardless of the ambient base.
		// (`--tmpdir DIR` with no template is an invalid mktemp invocation, so it over-blocks.)
		verdict(`export TMPDIR=${quote(outside)}; D=$(mktemp -d --tmpdir ${quote(shellPath(TEMP_DIR))} x.XXXXXX) && cd "$D" && touch f`, true);
	} finally {
		if (savedTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmpDir;
	}
});

test("bare mktemp honors the ambient TMPDIR and fails closed when it is not temp", () => {
	// With no template or --tmpdir, mktemp creates inside the ambient temp dir. Clear every
	// inherited temp var: the classifier consults TMPDIR/TMP/TEMP in order, so a host-provided
	// `TMP`/`TEMP` (default on Windows) would otherwise shadow the command's own assignment.
	const names = ["TMPDIR", "TMP", "TEMP"] as const;
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	try {
		for (const name of names) delete process.env[name];
		verdict(`export TMPDIR=${quote(outside)}; D=$(mktemp -d) && cd "$D" && touch f`, false);
		verdict(`export TMPDIR=${quote(shellPath(TEMP_DIR))}; D=$(mktemp -d) && cd "$D" && touch f`, true);
		// TMP/TEMP are consulted only when TMPDIR names no base.
		verdict(`export TMP=${quote(outside)}; D=$(mktemp -d) && cd "$D" && touch f`, false);
		verdict(`export TEMP=${quote(outside)}; D=$(mktemp -d) && cd "$D" && touch f`, false);
	} finally {
		for (const name of names) {
			const value = saved[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("empty --tmpdir= follows the runtime TMPDIR like bare mktemp", () => {
	// GNU mktemp treats `--tmpdir=` (empty value) as bare `--tmpdir`: it falls back to the
	// runtime TMPDIR, so an outside TMPDIR voids the synthetic provenance.
	const savedTmpDir = process.env.TMPDIR;
	try {
		delete process.env.TMPDIR;
		verdict(`D=$(mktemp -d --tmpdir=) && cd "$D" && touch f`, true);
		verdict(`export TMPDIR=${quote(outside)}; D=$(mktemp -d --tmpdir=) && cd "$D" && touch f`, false);
	} finally {
		if (savedTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmpDir;
	}
});
