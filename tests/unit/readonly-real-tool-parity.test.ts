/**
 * Differential tests: real tools are the ground truth for the rewritten flag grammars.
 *
 * Safety contract (over-block is allowed, under-block is not):
 * - a real run that writes outside the temp roots must be blocked;
 * - a classifier allow must not change anything outside the temp roots.
 *
 * Every verdict goes through classifyBashCommand. Host-mutating package-manager modes
 * are never executed: only read/query modes and dpkg-deb's temp-safe build/extract run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { quoteShellArgument as q } from "../../os-sandbox.js";
import { capabilityRequired, fixture, hasCommand, outsideWritable, posixHost, realToolsRequired } from "./readonly-git-helpers.js";
import { setTempHome } from "./helpers.js";

function hostReason(): string | null {
	if (!posixHost) return "POSIX bash and temp-path semantics required";
	if (!outsideWritable) return "cannot write outside temp";
	return null;
}

function missingTools(...tools: string[]): string | null {
	const missing = tools.find((tool) => !hasCommand(tool));
	return missing ? `${missing} unavailable` : null;
}

/** Two independent capabilities, two gates. Outside-temp access is required on every POSIX
 *  enforcement lane; real-tool presence only on the provisioned Linux lane. Each gate names
 *  its own switch, so a macOS runner without GNU sed skips instead of failing. */
function toolTest(name: string, host: string | null, tool: string | null, run: (t: test.TestContext) => void, variant: string | null = null): void {
	const required = host ? capabilityRequired(true) : realToolsRequired;
	const reason = host ?? tool;
	// WHY variant overrides the required gate: a platform-specific grammar (e.g. BSD find -f)
	// can never run on the Linux REQUIRE_REAL_TOOLS lane, so its absence is a hard skip.
	test(name, { skip: variant ?? (reason && !required ? reason : false) }, (t) => {
		if (reason) assert.fail(`${reason}; ${host ? "REQUIRE_OUTSIDE_TEMP_WRITES" : "REQUIRE_REAL_TOOLS"}=1 forbids skipping`);
		run(t);
	});
}

function fixtures(t: test.TestContext): { inside: string; outside: string } {
	return { inside: fixture(t), outside: fixture(t, os.homedir()) };
}

function bash(command: string, cwd: string, home: string): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("/bin/bash", ["-c", command], {
		cwd, encoding: "utf8", timeout: 30000, env: { ...process.env, HOME: home },
	});
	const stderr = result.stderr ?? (result.error ? String(result.error) : "");
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr };
}

/** Build the classifier's shell string and the direct argv from one source, so a quoting
 *  difference cannot make the real run test a different command. */
function tarCommand(args: string[]): string {
	return ["tar", ...args].map(q).join(" ");
}

function tarRun(args: string[], cwd: string, home: string): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("tar", args, { cwd, encoding: "utf8", timeout: 30000, env: { ...process.env, HOME: home } });
	return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error) : "") };
}

function tarFixture(inside: string): { src: string; archive: string } {
	const src = path.join(inside, "src");
	mkdirSync(src);
	writeFileSync(path.join(src, "a"), "a");
	const archive = path.join(inside, "a.tar");
	const result = tarRun(["-cf", archive, "-C", src, "a"], inside, inside);
	assert.equal(result.status, 0, result.stderr);
	return { src, archive };
}

/** Paths plus file contents: an allow must leave every outside entry byte-identical. */
function snapshot(root: string): string[] {
	const rows: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { rows.push(`${path.relative(root, full)}/`); walk(full); }
			else if (entry.isFile()) rows.push(`${path.relative(root, full)}:${readFileSync(full).toString("base64")}`);
		}
	};
	walk(root);
	return rows.sort();
}

function classifyAt(command: string, cwd: string, allowed: boolean): void {
	const verdict = classifyBashCommand(command, cwd);
	assert.equal(verdict.ok, allowed, verdict.ok ? command : `${command}\nblocked: ${verdict.reason}`);
}

function hasGnu(command: string): boolean {
	try {
		return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).includes(`GNU ${command}`);
	} catch {
		return false;
	}
}

function hasGnuSed(): boolean {
	return hasGnu("sed");
}

/** GNU rsync accepts -@ with a separate value; macOS openrsync does not. */
function hasRsyncModifyWindowShort(): boolean {
	return spawnSync("rsync", ["-@", "5", "--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
}

toolTest("real find: bare + stays payload and only {} + terminates", hostReason(), missingTools("find"), (t) => {
	const { inside, outside } = fixtures(t);
	const tree = path.join(inside, "tree");
	mkdirSync(tree);
	writeFileSync(path.join(tree, "file"), "data");

	// POSIX ends -exec at `+` only after an argument of exactly `{}`. A bare `+` is payload,
	// so the outside touch below really runs when the terminator is the later `;`.
	const pwned = path.join(outside, "pwned");
	const barePlus = `find ${q(tree)} -exec touch + ${q(pwned)} \\;`;
	classifyAt(barePlus, inside, false);
	assert.equal(bash(barePlus, inside, inside).status, 0);
	assert.ok(existsSync(pwned), "real find must execute the bare + payload");

	const batch = `find ${q(tree)} -exec echo {} +`;
	classifyAt(batch, inside, true);
	assert.equal(bash(batch, inside, inside).status, 0);

	// A descendant symlink can make `{}` name an outside path even without -L. find emits
	// the link pathname, and touch follows it, so the classifier must fail closed.
	const victim = path.join(outside, "victim");
	writeFileSync(victim, "victim");
	const old = new Date(1_000_000_000_000);
	utimesSync(victim, old, old);
	symlinkSync(victim, path.join(tree, "link"));
	const throughLink = `find ${q(tree)} -exec touch {} \\;`;
	classifyAt(throughLink, inside, false);
	assert.equal(bash(throughLink, inside, inside).status, 0);
	assert.ok(statSync(victim).mtimeMs > old.getTime(), "real find must follow the descendant symlink");

	// The payload is shell code: its outside write must be classified even though the search
	// root is inside temp. Old parsers only checked the roots and allowed this.
	const shellPwned = path.join(outside, "shell-pwned");
	const payload = `find ${q(tree)} -exec sh -c ${JSON.stringify(`touch ${shellPwned}`)} \\;`;
	classifyAt(payload, inside, false);
	assert.equal(bash(payload, inside, inside).status, 0);
	assert.ok(existsSync(shellPwned), "real find must run the nested shell payload");

	const unterminated = path.join(outside, "unterminated");
	const missingTerminator = `find ${q(tree)} -exec touch ${q(unterminated)}`;
	classifyAt(missingTerminator, inside, false);
	bash(missingTerminator, inside, inside);
	assert.equal(existsSync(unterminated), false, "an unterminated find -exec must not run");

	// -execdir runs in the found file's directory. A relative payload target escapes from
	// there, not from the caller cwd, so a deep in-temp cwd must not mask the write.
	const execdirVictim = path.join(outside, "execdir-pwned");
	const deepCwd = path.join(tree, "a", "b", "c");
	mkdirSync(deepCwd, { recursive: true });
	const execdirRel = path.relative(realpathSync(tree), execdirVictim);
	const execdir = `find ${q(tree)} -type f -execdir touch ${q(execdirRel)} \\;`;
	classifyAt(execdir, deepCwd, false);
	assert.equal(bash(execdir, deepCwd, inside).status, 0);
	assert.ok(existsSync(execdirVictim), "real find -execdir runs in the found file's directory");
});

toolTest("real find: symlink search root runs in its platform-specific directory", hostReason(), missingTools("find"), (t) => {
	const { inside, outside } = fixtures(t);
	const target = path.join(inside, "target"), parent = path.join(inside, "parent");
	mkdirSync(target); mkdirSync(parent);
	const link = path.join(parent, "link");
	symlinkSync(target, link, "dir");
	const outsideMarker = path.join(outside, "marker"), parentMarker = path.join(parent, "marker");
	t.after(() => { if (existsSync(outsideMarker)) rmSync(outsideMarker); if (existsSync(parentMarker)) rmSync(parentMarker); });

	// GNU runs this entry in the link's parent; macOS/BSD runs it in the caller cwd. Both
	// relative targets are unprovable, so the classifier must block even though one host
	// would write inside temp.
	const relative = `find ${q(link)} -execdir touch marker \\;`;
	classifyAt(relative, outside, false);
	assert.equal(bash(relative, outside, inside).status, 0);
	assert.ok(existsSync(outsideMarker) || existsSync(parentMarker), "real find must run a relative -execdir write in the symlink runtime dir");

	// An absolute target inside temp is safe in every candidate runtime directory.
	const absolute = `find ${q(link)} -execdir touch ${q(path.join(inside, "ok"))} \\;`;
	classifyAt(absolute, outside, true);
});

toolTest("real find: repeated BSD -f roots are all search roots", hostReason(), missingTools("find"), (t) => {
	const { inside, outside } = fixtures(t);
	const inRoot = path.join(inside, "in"), outRoot = path.join(outside, "out");
	writeFileSync(inRoot, "in"); writeFileSync(outRoot, "out");

	// BSD keeps its getopt phase open across -f, so the later -f adds a root the first cannot
	// bound. The real run proves that root is searched and deleted.
	const unsafe = `find -f ${q(inRoot)} -f ${q(outRoot)} -- -maxdepth 0 -delete`;
	classifyAt(unsafe, inside, false);
	const unsafeRun = bash(unsafe, inside, inside);
	assert.equal(unsafeRun.status, 0, unsafeRun.stderr);
	assert.equal(existsSync(outRoot), false, "real BSD find must delete the later -f root");

	// Every root inside temp: repeated -f stays allowed and both roots are deleted.
	const safeIn = path.join(inside, "safe-in"), safeOut = path.join(inside, "safe-out");
	writeFileSync(safeIn, "in"); writeFileSync(safeOut, "out");
	const safe = `find -f ${q(safeIn)} -f ${q(safeOut)} -- -maxdepth 0 -delete`;
	classifyAt(safe, inside, true);
	assert.equal(bash(safe, inside, inside).status, 0);
	assert.equal(existsSync(safeIn) || existsSync(safeOut), false, "real BSD find must delete every -f root");
}, hasGnu("find") ? "BSD find required: -f is a BSD-only option" : null);

toolTest("real find: command-line roots run -execdir in a checked runtime directory", hostReason(), missingTools("find"), (t) => {
	const { inside, outside } = fixtures(t);
	const dirRoot = path.join(inside, "dir"), fileRoot = path.join(inside, "file");
	mkdirSync(dirRoot); writeFileSync(fileRoot, "data");
	const caller = realpathSync(outside), searchTree = realpathSync(inside);
	for (const root of [dirRoot, fileRoot]) {
		// Observe the real runtime directory instead of assuming it: BSD runs a command-line
		// entry (directory or file) in the caller cwd, GNU runs it in the entry's directory.
		const observed = bash(`find ${q(root)} -maxdepth 0 -execdir /bin/pwd \\;`, outside, inside);
		assert.equal(observed.status, 0, observed.stderr);
		const runtimeDir = observed.stdout.trim();
		assert.ok(
			runtimeDir === caller || runtimeDir.startsWith(`${searchTree}${path.sep}`),
			`real find -execdir must run in the caller cwd or the search tree, not ${runtimeDir}`,
		);

		// The relative write is outside temp in the caller cwd, so it must be blocked, and the
		// real run proves the runtime directory the classifier had to check.
		const marker = `marker-${path.basename(root)}`;
		const command = `find ${q(root)} -maxdepth 0 -execdir touch ${q(marker)} \\;`;
		classifyAt(command, outside, false);
		assert.equal(bash(command, outside, inside).status, 0);
		assert.ok(existsSync(path.join(runtimeDir, marker)), "the checked runtime directory must receive the relative write");
	}
});

toolTest("real tar: creation, stdout streaming and conflicting modes", hostReason(), missingTools("tar"), (t) => {
	const { inside, outside } = fixtures(t);
	const { src } = tarFixture(inside);

	const outsideArchive = path.join(outside, "a.tar");
	const createOutside = ["-cf", outsideArchive, "-C", src, "a"];
	classifyAt(tarCommand(createOutside), inside, false);
	assert.equal(tarRun(createOutside, inside, inside).status, 0);
	assert.ok(existsSync(outsideArchive), "real tar must create the outside archive");

	// `-f -` and `--file=-` stream the archive to stdout, so neither creates a file.
	const beforeStreams = snapshot(outside);
	for (const args of [["-cf", "-", "-C", src, "a"], ["-c", "--file=-", "-C", src, "a"]]) {
		classifyAt(tarCommand(args), outside, true);
		const run = tarRun(args, outside, inside);
		assert.equal(run.status, 0, run.stderr);
		assert.ok(run.stdout.length > 0, "creation must stream archive bytes");
	}
	assert.deepEqual(snapshot(outside), beforeStreams);

	// Both action modes cannot be trusted: create writes the archive, extract writes members.
	const conflictArchive = path.join(outside, "conflict.tar");
	const conflict = ["-cxf", conflictArchive, "-C", src, "a"];
	classifyAt(tarCommand(conflict), inside, false);
	assert.notEqual(tarRun(conflict, inside, inside).status, 0, "host tar refuses conflicting modes");
	assert.equal(existsSync(conflictArchive), false);
});

toolTest("real tar: extraction targets and stdout member streaming", hostReason(), missingTools("tar"), (t) => {
	const { inside, outside } = fixtures(t);
	const { archive } = tarFixture(inside);
	const outsideCwd = path.join(outside, "cwd");
	mkdirSync(outsideCwd);

	const beforeStreams = snapshot(outside);
	for (const args of [["-xOf", archive], ["--to-stdout", "-xf", archive]]) {
		classifyAt(tarCommand(args), outsideCwd, true);
		const run = tarRun(args, outsideCwd, inside);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, "a");
	}
	assert.deepEqual(snapshot(outside), beforeStreams);

	// Extraction without stdout writes members, so the cwd or -C directory is the target.
	const plain = ["-xf", archive];
	classifyAt(tarCommand(plain), outsideCwd, false);
	assert.equal(tarRun(plain, outsideCwd, inside).status, 0);
	assert.equal(readFileSync(path.join(outsideCwd, "a"), "utf8"), "a");

	const extractDir = path.join(outside, "extract");
	mkdirSync(extractDir);
	const directed = ["-xf", archive, "-C", extractDir];
	classifyAt(tarCommand(directed), inside, false);
	assert.equal(tarRun(directed, inside, inside).status, 0);
	assert.ok(existsSync(path.join(extractDir, "a")));
});

// GNU tar owns exec and side-write options; bsdtar rejects them, so this lane is GNU-only.
const gnuTarReason = missingTools("tar") ?? (hasGnu("tar") ? null : "GNU tar unavailable (BSD tar lacks exec and side-write options)");

toolTest("real GNU tar: exec and side-write options", hostReason(), gnuTarReason, (t) => {
	const { inside, outside } = fixtures(t);
	const { src, archive } = tarFixture(inside);

	const commandMarker = path.join(outside, "to-command");
	const toCommand = path.join(inside, "to-command.sh");
	writeFileSync(toCommand, `#!/bin/sh\ncat >/dev/null\ntouch ${q(commandMarker)}\n`, { mode: 0o755 });
	const toCommandArgs = ["-xf", archive, `--to-command=${toCommand}`];
	classifyAt(tarCommand(toCommandArgs), inside, false);
	assert.equal(tarRun(toCommandArgs, inside, inside).status, 0);
	assert.ok(existsSync(commandMarker), "real GNU tar must run --to-command");

	const compressMarker = path.join(outside, "compress-program");
	const compressor = path.join(inside, "compressor.sh");
	writeFileSync(compressor, `#!/bin/sh\ntouch ${q(compressMarker)}\nexec cat\n`, { mode: 0o755 });
	for (const flag of ["-I", "--use-compress-program"]) {
		const args = [flag, compressor, "-cf", path.join(inside, `${flag}.tar`), "-C", src, "a"];
		classifyAt(tarCommand(args), inside, false);
		const run = tarRun(args, inside, inside);
		assert.equal(run.status, 0, run.stderr);
	}
	assert.ok(existsSync(compressMarker), "real GNU tar must run the compress program");

	const index = path.join(outside, "index.txt");
	const indexArgs = ["-xvf", archive, `--index-file=${index}`];
	classifyAt(tarCommand(indexArgs), inside, false);
	assert.equal(tarRun(indexArgs, inside, inside).status, 0);
	assert.ok(existsSync(index), "real GNU tar must write --index-file");
});

toolTest("real GNU tar: one-top-level and attached -s fail closed", hostReason(), gnuTarReason, (t) => {
	const { inside, outside } = fixtures(t);
	const { src, archive } = tarFixture(inside);

	// GNU resolves a relative top level against the cwd, so an outside cwd is the escape.
	const topCwd = path.join(outside, "top");
	mkdirSync(topCwd);
	const directed = ["-xf", archive, "--one-top-level=top"];
	classifyAt(tarCommand(directed), topCwd, false);
	assert.equal(tarRun(directed, topCwd, inside).status, 0);
	assert.ok(existsSync(path.join(topCwd, "top", "a")), "real GNU tar extracts under --one-top-level");

	// Bare --one-top-level derives its directory from the archive name in the cwd. A distinct
	// member name keeps the derived directory separate from the extracted file.
	writeFileSync(path.join(src, "b"), "b");
	const namedArchive = path.join(inside, "top.tar");
	assert.equal(tarRun(["-cf", namedArchive, "-C", src, "b"], inside, inside).status, 0);
	const bareCwd = path.join(outside, "bare");
	mkdirSync(bareCwd);
	const bare = ["-xf", namedArchive, "--one-top-level"];
	classifyAt(tarCommand(bare), bareCwd, false);
	assert.equal(tarRun(bare, bareCwd, inside).status, 0);
	assert.ok(existsSync(path.join(bareCwd, "top", "b")), "real GNU tar derives a top-level directory");

	// GNU reads attached -s as a flag and extracts; the classifier over-blocks to stay safe.
	const sOut = path.join(inside, "s-out");
	mkdirSync(sOut);
	const attached = ["-xsf", archive, "-C", sOut];
	classifyAt(tarCommand(attached), inside, false);
	assert.equal(tarRun(attached, inside, inside).status, 0);
	assert.ok(existsSync(path.join(sOut, "a")), "GNU treats attached -s as a flag; the block is the safe over-block");
});

// GNU sed owns `--` semantics; BSD sed would make the differential assert the wrong thing.
const sedToolReason = missingTools("sed") ?? (hasGnuSed() ? null : "GNU sed unavailable (BSD sed lacks -- semantics)");

toolTest("real sed: -- ends option parsing", hostReason(), sedToolReason, (t) => {
	const { inside, outside } = fixtures(t);
	const file = path.join(outside, "file");
	writeFileSync(file, "x");

	// Baseline: in-place edit really writes the outside file.
	const baseline = `sed -i 's/x/y/' ${q(file)}`;
	classifyAt(baseline, inside, false);
	assert.equal(bash(baseline, inside, inside).status, 0);
	assert.equal(readFileSync(file, "utf8"), "y");

	// A bundled -i plus `--` still edits: the file after `--` is the operand.
	writeFileSync(file, "x");
	const bundled = `sed -Ei 's/x/y/' -- ${q(file)}`;
	classifyAt(bundled, inside, false);
	assert.equal(bash(bundled, inside, inside).status, 0);
	assert.equal(readFileSync(file, "utf8"), "y");

	// After `--`, `-i` is a script/file word, not an in-place flag: sed only reads.
	writeFileSync(file, "x");
	const readOnly = `sed -- -e 's/x/y/' -i ${q(file)}`;
	classifyAt(readOnly, inside, true);
	const before = snapshot(outside);
	bash(readOnly, inside, inside);
	assert.deepEqual(snapshot(outside), before);
	assert.equal(readFileSync(file, "utf8"), "x");
});

toolTest("real rsync: write options and -- boundaries", hostReason(), missingTools("rsync"), (t) => {
	const { inside, outside } = fixtures(t);
	const src = path.join(inside, "src"), dest = path.join(inside, "dest");
	mkdirSync(src);
	mkdirSync(dest);
	writeFileSync(path.join(src, "a"), "new-content");
	writeFileSync(path.join(dest, "a"), "old");

	// --backup-dir is a write target of its own; the destination alone is not enough.
	const backupOutside = path.join(outside, "bak");
	const backup = `rsync -a --backup --backup-dir=${q(backupOutside)} ${q(`${src}/`)} ${q(`${dest}/`)}`;
	classifyAt(backup, inside, false);
	assert.equal(bash(backup, inside, inside).status, 0);
	assert.equal(readFileSync(path.join(backupOutside, "a"), "utf8"), "old");

	writeFileSync(path.join(dest, "a"), "old2");
	const insideBackup = path.join(inside, "bak");
	const safeBackup = `rsync -a --backup --backup-dir=${q(insideBackup)} ${q(`${src}/`)} ${q(`${dest}/`)}`;
	classifyAt(safeBackup, inside, true);
	const before = snapshot(outside);
	assert.equal(bash(safeBackup, inside, inside).status, 0);
	assert.deepEqual(snapshot(outside), before);
	assert.equal(readFileSync(path.join(insideBackup, "a"), "utf8"), "old2");

	const outsideDest = path.join(outside, "dest");
	const outsideWrite = `rsync -a ${q(`${src}/`)} ${q(`${outsideDest}/`)}`;
	classifyAt(outsideWrite, inside, false);
	assert.equal(bash(outsideWrite, inside, inside).status, 0);
	assert.ok(existsSync(path.join(outsideDest, "a")));

	// A later write option and its separate value must not stand in for the destination.
	// The real run writes the outside destination while the backup dir stays inside temp.
	const hiddenDest = path.join(outside, "hidden");
	const hiddenBackup = path.join(inside, "hidden-bak");
	mkdirSync(hiddenDest);
	writeFileSync(path.join(hiddenDest, "a"), "old-hidden");
	const hidden = `rsync -a -I --backup ${q(`${src}/`)} ${q(`${hiddenDest}/`)} --backup-dir ${q(hiddenBackup)}`;
	classifyAt(hidden, inside, false);
	assert.equal(bash(hidden, inside, inside).status, 0);
	assert.equal(readFileSync(path.join(hiddenDest, "a"), "utf8"), "new-content", "real rsync writes the outside destination");
	assert.equal(readFileSync(path.join(hiddenBackup, "a"), "utf8"), "old-hidden");

	// rsync resolves a relative --backup-dir against the destination, not the caller cwd.
	// The caller cwd is deeper inside temp, so a cwd-based check would approve the escape.
	const relDest = path.join(inside, "rel-dest");
	const relBackup = path.join(outside, "rel-bak");
	mkdirSync(relDest);
	writeFileSync(path.join(relDest, "a"), "old-rel");
	const deepCwd = path.join(relDest, "caller", "b", "c");
	mkdirSync(deepCwd, { recursive: true });
	const relativeBackup = path.relative(realpathSync(relDest), relBackup);
	const relative = `rsync -a -I --backup --backup-dir=${q(relativeBackup)} ${q(`${src}/`)} ${q(`${relDest}/`)}`;
	classifyAt(relative, deepCwd, false);
	assert.equal(bash(relative, deepCwd, inside).status, 0);
	assert.equal(readFileSync(path.join(relBackup, "a"), "utf8"), "old-rel", "real rsync resolves --backup-dir against the destination");

	// After `--`, `--temp-dir=...` is a source operand; it selects no write target.
	const boundary = `rsync -- --temp-dir=${q(path.join(outside, "ignored"))} ${q(`${src}/`)} ${q(`${dest}/`)}`;
	classifyAt(boundary, inside, true);
	const beforeBoundary = snapshot(outside);
	bash(boundary, inside, inside);
	assert.deepEqual(snapshot(outside), beforeBoundary);
});

toolTest("real rsync: separate -@ value after the destination cannot hide it", hostReason(), missingTools("rsync") ?? (hasRsyncModifyWindowShort() ? null : "rsync without the -@/--modify-window short option"), (t) => {
	const { inside, outside } = fixtures(t);
	const src = path.join(inside, "src");
	mkdirSync(src);
	writeFileSync(path.join(src, "a"), "payload");

	// The separate value is the short --modify-window argument, not the destination.
	const outsideDest = path.join(outside, "dest");
	const hidden = `rsync -a ${q(`${src}/`)} ${q(`${outsideDest}/`)} -@ 5`;
	classifyAt(hidden, inside, false);
	assert.equal(bash(hidden, inside, inside).status, 0);
	assert.equal(readFileSync(path.join(outsideDest, "a"), "utf8"), "payload", "real rsync writes the outside destination");

	// The same spelling with an inside destination is allowed and stays inside temp.
	const insideDest = path.join(inside, "dest");
	const safe = `rsync -a ${q(`${src}/`)} ${q(`${insideDest}/`)} -@ 5`;
	classifyAt(safe, inside, true);
	const before = snapshot(outside);
	assert.equal(bash(safe, inside, inside).status, 0);
	assert.deepEqual(snapshot(outside), before);
});

toolTest("real rsync: batch replay writes its single destination", hostReason(), missingTools("rsync"), (t) => {
	const { inside, outside } = fixtures(t);
	const src = path.join(inside, "src");
	const seed = path.join(inside, "seed");
	mkdirSync(src);
	mkdirSync(seed);
	writeFileSync(path.join(src, "a"), "batch-payload");
	const batch = path.join(inside, "payload.batch");
	const write = `rsync -a --write-batch=${q(batch)} ${q(`${src}/`)} ${q(`${seed}/`)}`;
	assert.equal(bash(write, inside, inside).status, 0);
	assert.ok(existsSync(path.join(seed, "a")), "batch fixture must be generated");

	// A replay has no source operand: the one positional is the destination.
	const replayOutside = path.join(outside, "replay");
	const replay = `rsync -a --read-batch ${q(batch)} ${q(`${replayOutside}/`)}`;
	classifyAt(replay, inside, false);
	assert.equal(bash(replay, inside, inside).status, 0);
	assert.equal(readFileSync(path.join(replayOutside, "a"), "utf8"), "batch-payload");

	// The same replay into temp is allowed and leaves outside untouched.
	const replayInside = path.join(inside, "replay");
	const safe = `rsync -a --read-batch=${q(batch)} ${q(`${replayInside}/`)}`;
	classifyAt(safe, inside, true);
	const before = snapshot(outside);
	assert.equal(bash(safe, inside, inside).status, 0);
	assert.deepEqual(snapshot(outside), before);
	assert.equal(readFileSync(path.join(replayInside, "a"), "utf8"), "batch-payload");
});

toolTest("real bash: a non-leading tilde in a redirect word stays literal", hostReason(), missingTools("head"), (t) => {
	const root = fixture(t);
	const home = path.join(root, "home");
	mkdirSync(home);
	mkdirSync(path.join(root, "~"));
	const restore = setTempHome(home);
	try {
		// HOME inside temp makes the old fragment expansion land under root; the literal
		// mid-word `~` reaches outside temp through the later parent traversal.
		const depth = root.split(path.sep).length - 1;
		const word = `"${root}/"~/${"../".repeat(depth + 1)}etc/hosts`;
		const read = spawnSync("/bin/bash", ["-c", `head -c 32 <${word}`], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home } });
		assert.equal(read.status, 0, read.stderr ?? "");
		assert.ok((read.stdout ?? "").length > 0, "Bash must read the outside hosts file");
		const blocked = classifyBashCommand(`echo x >${word}`, root);
		assert.equal(blocked.ok, false);
		assert.match(blocked.reason, /\/etc\/hosts$/);

		// A literal `~` component under temp stays writable for both Bash and the classifier.
		const safeWord = `"${root}/"~/safe.txt`;
		assert.equal(classifyBashCommand(`echo x >${safeWord}`, root).ok, true);
		assert.equal(bash(`echo x >${safeWord}`, root, home).status, 0);
		assert.equal(readFileSync(path.join(root, "~", "safe.txt"), "utf8"), "x\n");
	} finally {
		restore();
	}
});

toolTest("real chmod: -- keeps the mode operand and the target", hostReason(), missingTools("chmod"), (t) => {
	const { inside, outside } = fixtures(t);
	const target = path.join(outside, "file");
	writeFileSync(target, "x");
	chmodSync(target, 0o644);

	const outsideWrite = `chmod -- -w ${q(target)}`;
	classifyAt(outsideWrite, inside, false);
	assert.equal(bash(outsideWrite, inside, inside).status, 0);
	assert.equal(statSync(target).mode & 0o222, 0, "real chmod must drop the outside write bits");

	const safe = path.join(inside, "file");
	writeFileSync(safe, "x");
	chmodSync(safe, 0o644);
	const insideWrite = `chmod -- -w ${q(safe)}`;
	classifyAt(insideWrite, inside, true);
	assert.equal(bash(insideWrite, inside, inside).status, 0);
	assert.equal(statSync(safe).mode & 0o222, 0);
});

const unzipToolReason = missingTools("zip", "unzip");

toolTest("real unzip: passwords, bundles and -- boundaries", hostReason(), unzipToolReason, (t) => {
	const { inside, outside } = fixtures(t);
	const archiveDir = path.join(inside, "archive");
	mkdirSync(archiveDir);
	writeFileSync(path.join(archiveDir, "payload"), "payload");
	const archive = path.join(archiveDir, "a.zip");
	execFileSync("zip", ["-q", archive, "payload"], { cwd: archiveDir });

	// `-Ppassword`: password letters are data; Info-ZIP extracts into the cwd.
	const outsideCwd = path.join(outside, "cwd");
	mkdirSync(outsideCwd);
	const password = `unzip -Ppassword ${q(archive)}`;
	classifyAt(password, outsideCwd, false);
	bash(password, outsideCwd, inside);
	assert.ok(existsSync(path.join(outsideCwd, "payload")), "real unzip must extract into the outside cwd");

	// Info-ZIP `-` disables the next option letter, so each negated read spelling extracts.
	for (const flag of ["-o-t", "-o-l", "-o-v", "-o-p", "-o-c"]) {
		const negatedCwd = path.join(outside, `negated-${flag.slice(3)}`);
		mkdirSync(negatedCwd);
		const negated = `unzip ${flag} ${q(archive)}`;
		classifyAt(negated, negatedCwd, false);
		assert.equal(bash(negated, negatedCwd, inside).status, 0, flag);
		assert.ok(existsSync(path.join(negatedCwd, "payload")), `real unzip ${flag} must extract`);
	}

	// Single quotes keep `$D` literal, so Info-ZIP creates `$D` beneath the cwd.
	const literalCwd = path.join(outside, "literal");
	mkdirSync(literalCwd);
	const safeD = path.join(inside, "safe");
	const literal = `D=${q(safeD)} unzip -d'$D' ${q(archive)}`;
	classifyAt(literal, literalCwd, false);
	bash(literal, literalCwd, inside);
	assert.ok(existsSync(path.join(literalCwd, "$D", "payload")));

	// Double quotes expand the variable in a later command, so the write stays inside temp.
	const expandedCwd = path.join(outside, "expanded");
	mkdirSync(expandedCwd);
	const expanded = `D=${q(safeD)}; unzip -d"$D" ${q(archive)}`;
	classifyAt(expanded, expandedCwd, true);
	const beforeExpanded = snapshot(expandedCwd);
	bash(expanded, expandedCwd, inside);
	assert.deepEqual(snapshot(expandedCwd), beforeExpanded);
	assert.ok(existsSync(path.join(safeD, "payload")));

	// `-d` inside a short bundle is still the extraction directory.
	const bundledOut = path.join(outside, "bundled");
	const bundled = `unzip -oqd${q(bundledOut)} ${q(archive)}`;
	classifyAt(bundled, inside, false);
	bash(bundled, inside, inside);
	assert.ok(existsSync(path.join(bundledOut, "payload")));

	// `-P` consumes its password before `-d`; read-looking password letters must not hide it.
	const passwordOut = path.join(outside, "password-d");
	const passwordD = `unzip -oPpassword -d${q(passwordOut)} ${q(archive)}`;
	classifyAt(passwordD, inside, false);
	bash(passwordD, inside, inside);
	assert.ok(existsSync(path.join(passwordOut, "payload")));

	const insideOut = path.join(inside, "out");
	const insideExtract = `unzip -o -d${q(insideOut)} ${q(archive)}`;
	classifyAt(insideExtract, inside, true);
	assert.equal(bash(insideExtract, inside, inside).status, 0);
	assert.ok(existsSync(path.join(insideOut, "payload")));

	// `-l` only lists; `--` also stops `-d` from acting as an extraction option.
	const listing = `unzip -l -- ${q(archive)}`;
	classifyAt(listing, inside, true);
	const beforeListing = snapshot(outside);
	assert.equal(bash(listing, inside, inside).status, 0);
	assert.deepEqual(snapshot(outside), beforeListing);

	const ignoredOut = path.join(outside, "ignored-d");
	const boundary = `unzip -- -d ${q(ignoredOut)} ${q(archive)}`;
	classifyAt(boundary, inside, true);
	const beforeBoundary = snapshot(outside);
	bash(boundary, inside, inside);
	assert.equal(existsSync(ignoredOut), false);
	assert.deepEqual(snapshot(outside), beforeBoundary);
});

// Package managers have no sandbox: executing install/remove modes would mutate the host.
// Write modes are covered by the independent oracle in readonly-bash-classifier.test.ts.
const installedManagers = ["dpkg", "rpm", "pacman"].filter((manager) => hasCommand(manager));
const managerToolReason = installedManagers.length === 0 ? "dpkg, rpm and pacman unavailable" : null;

toolTest("real package-manager queries stay read-only", hostReason(), managerToolReason, (t) => {
	const { inside, outside } = fixtures(t);
	const queries: Record<string, string> = { dpkg: "dpkg -l", rpm: "rpm -q bash", pacman: "pacman -Q" };
	for (const manager of installedManagers) {
		const command = queries[manager]!;
		classifyAt(command, inside, true);
		const before = snapshot(outside);
		bash(command, inside, inside);
		assert.deepEqual(snapshot(outside), before, command);
	}
});

toolTest("real dpkg-deb: build and extract are write modes", hostReason(), missingTools("dpkg-deb"), (t) => {
	const { inside, outside } = fixtures(t);
	const pkg = path.join(inside, "pkg");
	mkdirSync(path.join(pkg, "DEBIAN"), { recursive: true });
	writeFileSync(path.join(pkg, "DEBIAN", "control"), "Package: probe\nVersion: 1\nArchitecture: all\nMaintainer: probe\nDescription: probe\n");
	writeFileSync(path.join(pkg, "payload"), "payload");
	const deb = path.join(inside, "probe.deb");

	// The classifier blocks the mode even for a temp target; the real build proves it writes.
	const build = `dpkg-deb --build ${q(pkg)} ${q(deb)}`;
	classifyAt(build, inside, false);
	assert.equal(bash(build, inside, inside).status, 0);
	assert.ok(existsSync(deb));

	const extractOut = path.join(outside, "extract");
	const extract = `dpkg-deb --extract ${q(deb)} ${q(extractOut)}`;
	classifyAt(extract, inside, false);
	assert.equal(bash(extract, inside, inside).status, 0);
	assert.ok(existsSync(path.join(extractOut, "payload")));

	const info = `dpkg-deb --info ${q(deb)}`;
	classifyAt(info, inside, true);
	const before = snapshot(outside);
	bash(info, inside, inside);
	assert.deepEqual(snapshot(outside), before);
});

// Ground truth for tilde quoting: Bash expands only an unquoted `~` prefix.
toolTest("real bash: quoted tilde prefixes stay literal", hostReason(), missingTools("touch"), (t) => {
	const literal = ['touch ~"/pwn"', 'echo x >~"/redirect"'];

	// HOME inside temp, cwd outside: the literal tilde lands outside. The old classifier
	// expanded HOME and approved this write.
	const homeInside = fixture(t);
	const outsideCwd = fixture(t, os.homedir());
	mkdirSync(path.join(outsideCwd, "~"));
	for (const command of literal) {
		classifyAt(command, outsideCwd, false);
		assert.equal(bash(command, outsideCwd, homeInside).status, 0);
	}
	assert.ok(existsSync(path.join(outsideCwd, "~", "pwn")));
	assert.ok(existsSync(path.join(outsideCwd, "~", "redirect")));
	assert.equal(existsSync(path.join(homeInside, "pwn")), false);

	// HOME outside temp, cwd inside: the same literal word stays writable under cwd.
	const insideCwd = fixture(t);
	mkdirSync(path.join(insideCwd, "~"));
	const outsideHome = fixture(t, os.homedir());
	const before = snapshot(outsideHome);
	for (const command of literal) {
		classifyAt(command, insideCwd, true);
		assert.equal(bash(command, insideCwd, outsideHome).status, 0);
	}
	assert.ok(existsSync(path.join(insideCwd, "~", "pwn")));
	assert.ok(existsSync(path.join(insideCwd, "~", "redirect")));
	assert.deepEqual(snapshot(outsideHome), before);

	// Contrast: the same word with an unquoted slash really expands HOME.
	classifyAt('touch ~/"expanded"', insideCwd, false);
	assert.equal(bash('touch ~/"expanded"', insideCwd, outsideHome).status, 0);
	assert.ok(existsSync(path.join(outsideHome, "expanded")));
});
