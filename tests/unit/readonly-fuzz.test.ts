/**
 * Property-based fuzz tests for the readonly bash classifier.
 *
 * Contract under test: a command whose write target decodes to an absolute path
 * outside the temp roots — raw, quoted, or backslash-escaped — must never be allowed,
 * whatever distractors surround it. Inside-temp targets may over-block (fail closed is
 * safe), so those combinations are checked for totality and repeatability, plus one
 * unobscured golden path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as fc from "fast-check";
import { classifyBashCommand } from "../../readonly-bash.js";
import { TEMP_WRITE_ROOTS_CANONICAL } from "../../temp-dir.js";
import { isWithinPath } from "../../readonly-shell-utils.js";

const WORKSPACE = "/workspace";
const PROBE = "fuzz-probe";
const RUNS = 400; // Kept at 400: enough to cover the shape/prefix matrix each run; higher counts cost CI minutes without new coverage.
// Fixed seed: a counterexample reproduces exactly with the same command line.
const SEED = 20261006;

/** Absolute directories that must stay outside every temp root (guarded per run). */
const OUTSIDE_DIRS = ["/etc", "/usr/bin", "/var/tmp", "/sbin", "/usr/local", "/opt"];

// TODO: derive SHAPES/GIT_SHAPES from a central command/flag registry once one
// exists. Today the classifier registry is split across getMutationTargets /
// PACKAGE_MANAGERS / INTERPRETER_EXEC_FLAGS in readonly-bash-commands.ts and the
// git analyzer in readonly-bash-git.ts — no single table to import — so these
// shapes stay manual and must be kept in sync with those files by hand.
/** Write commands whose target is an argv operand, a redirect, or a flag value. */
const SHAPES = [
	"touch {{t}}",
	"rm -rf {{t}}",
	"mkdir -p {{t}}",
	"cp README.md {{t}}",
	"mv README.md {{t}}",
	"ln -s README.md {{t}}",
	"tee {{t}}",
	"echo hi > {{t}}",
	// `\'` inside single quotes: the backslash is literal, so the redirect stays a redirect.
	"echo 'a\\' > {{t}}",
	"cat README.md >> {{t}}",
	"echo hi 2> {{t}}",
	"git init {{t}}",
	"git -C {{t}} commit -m x",
	"git clone README.md {{t}}",
	"cp README.md . {{t}}",
	"dd if=README.md of={{t}}",
	"tee -a {{t}}",
];

/**
 * Target encodings Bash decodes to the same path: literal, single-quoted,
 * double-quoted, and backslash-escaped separators (`\/etc\/probe`).
 */
const QUOTINGS = [
	(t: string) => t,
	(t: string) => `'${t}'`,
	(t: string) => `"${t}"`,
	(t: string) => t.replaceAll("/", "\\/"),
];

/** Leading segments that must not hide the target: assignments, chains, pipelines, cd. */
// `cd $UNKNOWN` names a tracked-but-unresolvable cwd: the write must still fail closed.
const PREFIXES = ["", "FOO=bar ", "cd /tmp && ", "cd /tmp; ", "cd /tmp || ", "true; ", "echo hi | ", "cd / && ", "cd $UNKNOWN && "];

/** cd destinations for composed shapes: temp roots, an outside dir, and a variable. */
const CD_DIRS = [...TEMP_WRITE_ROOTS_CANONICAL, OUTSIDE_DIRS[0]!, "$UNKNOWN"];

/** Composed shapes, on top of the operand shapes above: `{{d}}` is the cd destination. */
// WHY the mktemp and heredoc bodies write {{t}} instead of a literal relative file: every
// generated command with an outside {{t}} must be blocked, which a literal relative write
// cannot honor (the &&-chained mktemp provenance allows it by design). The `;`-chained
// mktemp variant blocks every target, so wedging provenance logic into the pool stays safe.
const COMPOSED_SHAPES = [
	"cd {{d}} && touch {{t}}",
	"cd {{d}}; tee {{t}}",
	"D=$(mktemp -d) && cd \"$D\" && touch {{t}}",
	"D=$(mktemp -d); cd \"$D\"; touch {{t}}",
	"bash <<'EOF'\ntouch {{t}}\nEOF",
	"cat <<EOF\n$(touch {{t}})\nEOF",
];

/** Git shapes whose write root is {{t}}: repository path, -C base, or git-dir anchor.
 * The property: a git write root outside the temp roots is never allowed. */
const GIT_SHAPES = [
	"git init {{t}}",
	"git clone README.md {{t}}",
	"git -C {{t}} add .",
	"git --git-dir={{t}} commit -m x",
	"git -C {{t}} push {{t}}",
	"git -C {{t}} checkout -b x",
];

const posixJoin = (dir: string, leaf: string) => path.posix.join(dir, leaf);
const insideTargets = () => TEMP_WRITE_ROOTS_CANONICAL.map((root) => posixJoin(root, PROBE));
const outsideTargets = () => OUTSIDE_DIRS.map((dir) => posixJoin(dir, PROBE));

/** Build the command arbitrary over a fixed target pool. */
function arbCommand(targets: string[]): fc.Arbitrary<string> {
	return fc
		.tuple(
			fc.constantFrom(...SHAPES, ...COMPOSED_SHAPES),
			fc.constantFrom(...targets),
			fc.integer({ min: 0, max: QUOTINGS.length - 1 }),
			fc.constantFrom(...PREFIXES),
			fc.constantFrom(...CD_DIRS),
		)
		.map(([shape, target, quoting, prefix, dir]) =>
			`${prefix}${shape.replace("{{d}}", dir).replace("{{t}}", QUOTINGS[quoting]!(target))}`,
		);
}

// POSIX-only: the temp roots and these path literals only mean something off Windows.
const posix = { skip: process.platform === "win32" ? "POSIX path literals" : false };

function assertProbeTargetsAreOutside(): void {
	for (const dir of OUTSIDE_DIRS) {
		for (const root of TEMP_WRITE_ROOTS_CANONICAL) {
			assert.ok(!isWithinPath(root, dir), `fuzz generator is stale: ${dir} is under ${root}`);
		}
	}
}

test("fuzz: a literal outside-temp write target is never allowed", posix, () => {
	assertProbeTargetsAreOutside();
	fc.assert(
		fc.property(arbCommand(outsideTargets()), (command) => {
			const verdict = classifyBashCommand(command, WORKSPACE);
			if (verdict.ok) assert.fail(`under-block: ${command} -> ${JSON.stringify(verdict)}`);
		}),
		{ numRuns: RUNS, seed: SEED },
	);
	// WHY a second fixed seed: the first reproduces failures exactly; this one explores
	// different combinations deterministically. A random seed would make CI flaky.
	fc.assert(
		fc.property(arbCommand(outsideTargets()), (command) => {
			const verdict = classifyBashCommand(command, WORKSPACE);
			if (verdict.ok) assert.fail(`under-block: ${command} -> ${JSON.stringify(verdict)}`);
		}),
		{ numRuns: RUNS, seed: SEED + 1 },
	);
});

/** Git write roots are path-checked like any other target, whatever the anchor spelling. */
test("fuzz: a git write root outside the temp roots is never allowed", posix, () => {
	assertProbeTargetsAreOutside();
	fc.assert(
		fc.property(
			fc.tuple(
				fc.constantFrom(...GIT_SHAPES),
				fc.constantFrom(...outsideTargets()),
				fc.integer({ min: 0, max: QUOTINGS.length - 1 }),
				fc.constantFrom(...PREFIXES),
			).map(([shape, target, quoting, prefix]) =>
				`${prefix}${shape.replace("{{t}}", QUOTINGS[quoting]!(target))}`,
			),
			(command) => {
				const verdict = classifyBashCommand(command, WORKSPACE);
				if (verdict.ok) assert.fail(`under-blocked git: ${command} -> ${JSON.stringify(verdict)}`);
			},
		),
		{ numRuns: RUNS, seed: SEED },
	);
});

test("fuzz: classification is total, explained and repeatable", posix, () => {
	assertProbeTargetsAreOutside();
	fc.assert(
		fc.property(arbCommand([...insideTargets(), ...outsideTargets()]), (command) => {
			const first = classifyBashCommand(command, WORKSPACE);
			if (!first.ok) assert.ok(first.reason.length > 0, `unexplained block: ${command}`);
			assert.deepEqual(classifyBashCommand(command, WORKSPACE), first, `verdict drifts: ${command}`);
		}),
		{ numRuns: RUNS, seed: SEED },
	);
});

/** Golden path: nothing obscures the target, so inside-temp writes must pass. */
test("fuzz: unobscured inside-temp write targets stay allowed", posix, () => {
	for (const target of insideTargets()) {
		for (const shape of SHAPES) {
			const command = shape.replace("{{t}}", target);
			const verdict = classifyBashCommand(command, WORKSPACE);
			assert.equal(verdict.ok, true, `false block: ${command} -> ${verdict.ok ? "" : verdict.reason}`);
		}
	}
});
