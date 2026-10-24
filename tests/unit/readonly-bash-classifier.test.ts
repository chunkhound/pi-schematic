import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { registerReadonlyPI, makeReadonlyUICtx, setTempHome, shellPath } from "./helpers.js";
import type { ToolCall } from "./helpers.js";
import type { TestPI } from "./test-host.js";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { PACKAGE_MANAGERS, PACKAGE_MODE_TABLES } from "../../readonly-bash-commands.js";
import { TEMP_WRITE_ROOTS_CANONICAL } from "../../temp-dir.js";
import { canUseOsSandbox, quoteShellArgument } from "../../os-sandbox.js";
import { installGitIsolation } from "./readonly-git-helpers.js";

// Git verdicts below shell out to `git config` probes. Clear ambient GIT_* overrides so an
// injected config cannot flip a verdict; keep HOME so `git config --global` still targets the
// real outside-temp home (the contract this suite asserts).
installGitIsolation(false);

// ── Helpers ───────────────────────────────────────────────────────

async function enableReadonly(pi: TestPI) {
	await pi.commands.get("readonly").handler("", makeReadonlyUICtx() as any);
}

async function assertBlocked(toolCall: ToolCall, command: string, cwd = "/workspace") {
	const result = await toolCall({ toolName: "bash", input: { command } }, { cwd });
	assert.equal(result.block, true, `expected block: ${command}`);
}

async function assertAllowed(toolCall: ToolCall, command: string, cwd = "/workspace") {
	assert.equal(await toolCall({ toolName: "bash", input: { command } }, { cwd }), undefined, `expected allow: ${command}`);
}

// Windows has no OS sandbox: the L2 classifier is the only write barrier.
// This test states that contract explicitly and keeps the POSIX fallback honest.
test("windows contract: classifier-only enforcement", () => {
	const inside = shellPath(path.join(os.tmpdir(), "pi-win-contract-file"));
	const outside = shellPath(path.join(os.homedir(), "pi-win-contract-file"));
	if (process.platform === "win32") {
		assert.equal(canUseOsSandbox(), false, "win32 must not claim OS sandbox support");
		assert.equal(
			classifyBashCommand(`touch ${quoteShellArgument(inside)}`, shellPath(os.tmpdir())).ok,
			true,
			"inside-temp touch stays allowed",
		);
		assert.equal(
			classifyBashCommand(`touch ${quoteShellArgument(outside)}`, shellPath(os.homedir())).ok,
			false,
			"outside-temp touch must be blocked by the classifier alone",
		);
	} else {
		// POSIX may layer an OS sandbox on top; the classifier contract holds regardless.
		assert.equal(
			classifyBashCommand("touch /etc/pi-win-contract-probe", "/workspace").ok,
			false,
			"classifier blocks outside-temp writes on POSIX too",
		);
	}
});

// ── Behavioral contract tests (via tool_call hook — real code path) ──

test("blocks bash writes outside temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = shellPath(path.join(os.homedir(), "readonly-test-file"));

	// Representative mutation commands targeting a concrete non-temp path.
	// Tests the CONTRACT: writes outside temp dir are blocked.
	await assertBlocked(toolCall, `touch ${outsideTemp}`);
	await assertBlocked(toolCall, `rm -f ${outsideTemp}`);
	await assertBlocked(toolCall, `echo "test" > ${outsideTemp}`);
});

test("blocks malformed bash input without throwing", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	for (const command of [undefined, null, 42, false, true, Symbol("test"), BigInt(42), () => {}]) {
		const result = await toolCall(
			{ toolName: "bash", input: { command } } as any,
			{ cwd: "/workspace" },
		);
		assert.equal(result?.block, true, `expected malformed input to block: ${String(command)}`);
		assert.match(result?.reason ?? "", /bash command input must be a string/);
	}
});

test("allows bash reads and non-mutating commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: reads are allowed (catches over-blocking).
	await assertAllowed(toolCall, "ls -la");
	await assertAllowed(toolCall, "echo hello");
	await assertAllowed(toolCall, "git status");
	await assertAllowed(toolCall, "git log --oneline");
	await assertAllowed(toolCall, "git stash list");
});

test("allows bash writes to temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: temp dir writes are allowed.
	await assertAllowed(toolCall, `echo ok > ${tmp}/readonly-test.txt`);
	await assertAllowed(toolCall, `rm ${tmp}/readonly-test.txt`);
});

test("blocks command substitutions that write outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = shellPath(path.join(os.homedir(), "readonly-test-file"));

	// CONTRACT: evasion via command substitution is caught.
	await assertBlocked(toolCall, `touch $(echo ${outsideTemp})`);
});

test("unknown-cwd block reasons name a fix for the actual cause", () => {
	const tmp = shellPath(os.tmpdir());
	const outside = shellPath(path.join(os.homedir(), "readonly-cwd-hint"));

	const flag = classifyBashCommand(`cd -P ${tmp} && touch f`, "/workspace");
	assert.equal(flag.ok, false);
	assert.match(flag.reason, /cd -L with a literal path/);

	const cdpath = classifyBashCommand(`CDPATH=${outside} cd sub && touch f`, tmp);
	assert.equal(cdpath.ok, false);
	assert.match(cdpath.reason, /unset CDPATH or start the path with \.\//);
	assert.doesNotMatch(cdpath.reason, /cd -L/);

	const glob = classifyBashCommand(`cd ${tmp}/* && touch f`, tmp);
	assert.equal(glob.ok, false);
	assert.match(glob.reason, /use a literal directory path/);
	assert.doesNotMatch(glob.reason, /cd -L/);

	const previous = classifyBashCommand("cd - && touch f", tmp);
	assert.equal(previous.ok, false);
	assert.match(previous.reason, /pass the literal directory path instead of -/);
	assert.doesNotMatch(previous.reason, /cd -L/);

	const mktemp = classifyBashCommand(`TMPDIR=${outside} D=$(mktemp -d) && cd "$D" && touch f`, "/workspace");
	assert.equal(mktemp.ok, false);
	assert.match(mktemp.reason, /mktemp base/);
	assert.match(mktemp.reason, /&&/);
	assert.doesNotMatch(mktemp.reason, /cd -L/);

	const dynamic = classifyBashCommand('cd "$UNKNOWN_CWD" && touch f', "/workspace");
	assert.equal(dynamic.ok, false);
	assert.match(dynamic.reason, /cwd is not provable/);
	assert.doesNotMatch(dynamic.reason, /cd -L/);

	// An absolute target is proven outside independently of the tracked cwd.
	const absolute = classifyBashCommand(`cd "$UNKNOWN_CWD" && touch ${outside}`, "/workspace");
	assert.equal(absolute.ok, false);
	assert.match(absolute.reason, /blocked outside temp dir/);
	assert.doesNotMatch(absolute.reason, /cd -L|cwd is not provable/);
});

test("blocks write redirects outside temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = shellPath(path.join(os.homedir(), "readonly-test-file"));

	// CONTRACT: write redirects to non-temp paths are blocked.
	await assertBlocked(toolCall, `echo hello > ${outsideTemp}`);
});

test("block reasons separate unproven targets from proven-outside writes", () => {
	// CONTRACT: the reason is the user's diagnosis. A dynamic target that cannot be
	// resolved must say "cannot prove", never a false "outside temp dir" claim.
	const unproven = classifyBashCommand('mkdir -p "$(mktemp -d)"', "/workspace");
	assert.equal(unproven.ok, false);
	assert.match(unproven.reason, /cannot prove target stays inside temp/);

	// Unprovable via redirect/pipeline-redirect and glob-shaped compositions too —
	// the wording is the diagnosis, so a substitution-decoded target must never
	// surface the "outside temp dir" claim even when it carries glob syntax.
	for (const command of [
		'echo a > $(printf /tmp/x%s.mjs 1)',
		'echo a | tee "$(printf /tmp/x%s.mjs 1)"',
		'touch /tmp/[$(printf x)]*.mjs',
	]) {
		const verdict = classifyBashCommand(command, shellPath(os.tmpdir()));
		assert.equal(verdict.ok, false, command);
		assert.match(verdict.reason!.replace(/\n/g, " "), /cannot prove target stays inside temp/, command);
		assert.doesNotMatch(verdict.reason!.replace(/\n/g, " "), /blocked outside temp dir/, command);
	}

	const outside = classifyBashCommand("touch /etc/readonly-reason-probe", "/workspace");
	assert.equal(outside.ok, false);
	assert.match(outside.reason, /blocked outside temp dir/);
});

test("blocks package managers unconditionally", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: package managers blocked regardless of target path.
	await assertBlocked(toolCall, "npm install lodash");
	await assertBlocked(toolCall, "pip install requests");
	await assertBlocked(toolCall, "yarn add lodash");
	await assertBlocked(toolCall, "uvx ruff check .");

	// uv/bun/conda write outside the temp roots in their ordinary modes (caches,
	// `.venv`), so every invocation blocks, even version queries.
	const alwaysBlocked = [
		"uv", "uv --version", "uv venv /etc/probe", "uv run build.js", "uv tool run ruff",
		"uvx ruff check .", "bun", "bun run build", "bunx cowsay hi",
		"conda", "conda list", "conda run -n base true",
	];
	for (const command of alwaysBlocked) assert.equal(classifyBashCommand(command, "/workspace").ok, false, command);

	// Short flags are case-sensitive: mutation verbs block, read-only queries stay allowed.
	const blocked = [
		"pacman -S curl", "pacman -Syu", "pacman -Rns pkg", "pacman -Sc", "pacman -U pkg",
		"dpkg -i pkg.deb", "dpkg --install pkg.deb", "dpkg -P pkg",
		// dpkg extract/control-extract/build and pacman -F refreshes write outside the cwd.
		"dpkg -x pkg.deb /etc/x", "dpkg -e pkg.deb /etc/control", "dpkg -b /etc/pkg",
		"dpkg -X pkg.deb /etc/x", "dpkg --extract pkg.deb /etc/x",
		"dpkg --vextract pkg.deb /etc/x", "dpkg --control pkg.deb /etc/control",
		"dpkg --build /etc/pkg", "dpkg --set-selections", "dpkg --update-avail",
		"dpkg --add-architecture arm64", "dpkg --triggers-only bash", "dpkg -D2 --triggers-only bash",
		// dpkg-deb writes through the same modes; long-only rpm options mutate its database.
		"dpkg-deb -x pkg.deb /etc/x", "dpkg-deb --extract pkg.deb /etc/x",
		"dpkg-deb -b /etc/pkg", "dpkg-deb --build /etc/pkg", "dpkg-deb -R pkg.deb /etc/x",
		"rpm --import key.pub", "rpm --rebuilddb", "rpm --initdb",
		"rpm --rebuild /outside/spec.spec", "rpm --recompile /outside/spec.spec",
		"rpm -bp /outside/spec.spec", "rpm -bc /outside/spec.spec", "rpm -bb /outside/spec.spec",
		"rpm -tb /outside/spec.spec",
		"pacman -F", "pacman -Fy", "pacman -Fyy", "pacman --files --refresh",
		"pacman --sync --refresh",
		// A write modifier stays a write next to query sub-operations, separate or bundled.
		"pacman -S -y", "pacman -S -s -y", "pacman -Ss -y", "pacman -F -l -y",
		"pacman --sync --sea --refresh",
		"rpm -i pkg.rpm", "rpm -U pkg.rpm", "rpm -e pkg",
		// getopt_long abbreviations and quoted flags are the same argv spelling.
		"dpkg --extr pkg.deb /etc/x", "rpm --imp key.pub", "pacman --fil --ref",
		`dpkg "--extract" pkg.deb /etc/x`, `rpm "-i" pkg.rpm`,
		"uv add requests", "bun add x", "conda install x",
	];
	for (const command of blocked) assert.equal(classifyBashCommand(command, "/workspace").ok, false, command);
	const allowed = [
		"pacman -Q curl", "dpkg -l", "dpkg -p bash", "dpkg -c pkg.deb", "dpkg -L pkg",
		"dpkg --print-avail bash", "dpkg --get-selections", "dpkg-deb --info pkg.deb",
		"rpm -q bash", "rpm --query bash", "rpm --verify bash", "npm --version",
		// Query bundles stay reads: rpm's first mode letter is q; pacman's S/F sub-ops
		// below are query-only, including their long spellings.
		"rpm -qi bash", "rpm -qif", "rpm -q --info bash",
		"pacman -Ss", "pacman -Si", "pacman -Sp",
		"pacman --sync --search curl", "pacman --sync --info curl",
		"pacman --query curl", "pacman --deptest bash",
		"pacman -Fl pkg", "pacman -Fs file", "pacman -Fx 'regex'",
		"pacman --files --list", "pacman --files --search file",
		// Separate short sub-ops and unique long abbreviations query the same way.
		"pacman -S -s curl", "pacman -S -i pkg", "pacman -S -s -i curl",
		"pacman -F -l pkg", "pacman -F -s file",
		"pacman --sync --sea curl", "pacman --sync --inf pkg", "pacman --files --lis pkg",
	];
	for (const command of allowed) assert.equal(classifyBashCommand(command, "/workspace").ok, true, command);
});

// Independent oracle for package-mode verdicts. It must stay a literal hand-written copy:
// deriving expected verdicts from PACKAGE_MODE_TABLES made a wrong `writes` flag flip both
// sides of the assertion. The completeness test below only cross-checks row identity.
type PackageModeOracleRow = { short: string | null; long: readonly string[]; writes: boolean };
type PackageModeOracle = { shortModeScan: "first" | "any"; rows: readonly PackageModeOracleRow[] };
const PACKAGE_MODE_ORACLE: Readonly<Record<string, PackageModeOracle>> = {
	dpkg: {
		shortModeScan: "any",
		rows: [
			{ short: "i", long: ["--install"], writes: true },
			{ short: "r", long: ["--remove"], writes: true },
			{ short: "P", long: ["--purge"], writes: true },
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
		rows: [
			{ short: "b", long: ["--build"], writes: true },
			{ short: "x", long: ["--extract"], writes: true },
			{ short: "X", long: ["--vextract"], writes: true },
			{ short: "e", long: ["--control"], writes: true },
			{ short: "R", long: ["--raw-extract"], writes: true },
		],
	},
	rpm: {
		shortModeScan: "first",
		rows: [
			{ short: "i", long: ["--install"], writes: true },
			{ short: "U", long: ["--upgrade"], writes: true },
			{ short: "F", long: ["--freshen"], writes: true },
			{ short: "e", long: ["--erase"], writes: true },
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
		rows: [
			{ short: "S", long: ["--sync"], writes: true },
			{ short: "R", long: ["--remove"], writes: true },
			{ short: "U", long: ["--upgrade"], writes: true },
			{ short: "D", long: ["--database"], writes: true },
			{ short: "F", long: ["--files"], writes: true },
			{ short: null, long: ["--refresh", "--sysupgrade", "--clean", "--asdeps", "--asexplicit"], writes: true },
			{ short: "Q", long: ["--query"], writes: false },
			{ short: "T", long: ["--deptest"], writes: false },
		],
	},
};

test("package-manager short and long write modes stay in parity", () => {
	// CONTRACT: a write mode blocks under both spellings; read modes and read-only
	// sub-operations stay allowed. A table row is the only place a mode is declared.
	const pairs = [
		["dpkg -x pkg.deb /etc/x", "dpkg --extract pkg.deb /etc/x"],
		["dpkg -X pkg.deb /etc/x", "dpkg --vextract pkg.deb /etc/x"],
		["dpkg -e pkg.deb /etc/c", "dpkg --control pkg.deb /etc/c"],
		["dpkg -b /etc/pkg", "dpkg --build /etc/pkg"],
		["dpkg-deb -x pkg.deb /etc/x", "dpkg-deb --extract pkg.deb /etc/x"],
		["dpkg-deb -R pkg.deb /etc/x", "dpkg-deb --raw-extract pkg.deb /etc/x"],
		["rpm -i pkg.rpm", "rpm --install pkg.rpm"],
		["rpm -e pkg", "rpm --erase pkg"],
		["pacman -S curl", "pacman --sync curl"],
		["pacman -R pkg", "pacman --remove pkg"],
		["pacman -F", "pacman --files"],
		["pacman -Fy", "pacman --files --refresh"],
		["pacman -S -s -y", "pacman --sync --search --refresh"],
	];
	for (const [shortForm, longForm] of pairs) {
		for (const command of [shortForm!, longForm!]) assert.equal(classifyBashCommand(command, "/workspace").ok, false, command);
	}
	const reads = [
		["pacman -Ss", "pacman --sync --search"],
		["pacman -S -s curl", "pacman --sync --search curl"],
		["pacman -Ss curl", "pacman --sync --sea curl"],
		["pacman -Fl pkg", "pacman --files --list"],
		["pacman -F -l pkg", "pacman --files --list pkg"],
		["pacman -Fl pkg", "pacman --files --lis pkg"],
		["rpm -q bash", "rpm --query bash"],
		["dpkg -l", "dpkg --list"],
	];
	for (const [shortForm, longForm] of reads) {
		for (const command of [shortForm!, longForm!]) assert.equal(classifyBashCommand(command, "/workspace").ok, true, command);
	}
});

test("package modes match independent oracle verdicts", () => {
	// CONTRACT: every declared mode spelling has the verdict recorded in the literal oracle.
	for (const [command, oracle] of Object.entries(PACKAGE_MODE_ORACLE)) {
		for (const row of oracle.rows) {
			for (const long of row.long) {
				const spelling = `${command} ${long} probe`;
				assert.equal(classifyBashCommand(spelling, "/workspace").ok, !row.writes, spelling);
			}
			if (row.short === null) continue;
			const spelling = `${command} -${row.short} probe`;
			assert.equal(classifyBashCommand(spelling, "/workspace").ok, !row.writes, spelling);
		}
	}
	// Rows the older independent lists missed; keep them named so a regression is readable.
	const uncovered = [
		"pacman --clean", "pacman --asdeps", "pacman --sysupgrade",
		"dpkg --clear-selections", "dpkg --merge-avail", "rpm --setperms",
	];
	for (const spelling of uncovered) assert.equal(classifyBashCommand(`${spelling} probe`, "/workspace").ok, false, spelling);
});

test("rpm build stages and dpkg trigger processing are write modes", () => {
	// CONTRACT: -b/-t consume the stage as their tail, and the legacy long aliases build too.
	const blocked = [
		...["bp", "bc", "bi", "bb", "ba", "bs", "bl", "bt"].map((stage) => `rpm -${stage} /outside/spec.spec`),
		...["tp", "tc", "ti", "tb", "ta", "ts"].map((stage) => `rpm -${stage} /outside/spec.spec`),
		"rpm --rebuild /outside/spec.spec", "rpm --recompile /outside/spec.spec",
		"dpkg --triggers-only bash", "dpkg -D2 --triggers-only bash",
	];
	for (const command of blocked) assert.equal(classifyBashCommand(command, "/workspace").ok, false, command);
});

test("oracle covers every production package-mode row", () => {
	// Secondary completeness check: the table may only declare rows the oracle already knows.
	assert.deepEqual(Object.keys(PACKAGE_MODE_ORACLE).sort(), Object.keys(PACKAGE_MODE_TABLES).sort());
	const rowKey = (row: PackageModeOracleRow) => `${row.short ?? "none"}|${[...row.long].sort().join(",")}|${row.writes}`;
	for (const [command, grammar] of Object.entries(PACKAGE_MODE_TABLES)) {
		assert.equal(PACKAGE_MANAGERS.has(command), true, `${command} must be a package manager`);
		const oracle = PACKAGE_MODE_ORACLE[command]!;
		assert.equal(oracle.shortModeScan, grammar.shortModeScan, `${command} short mode scan`);
		assert.deepEqual(grammar.modes.map(rowKey).sort(), oracle.rows.map(rowKey).sort(), command);
	}
});

test("blocks archivers that extract outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: tar/rsync/unzip destinations are path-checked like other mutations.
	await assertBlocked(toolCall, `tar xf archive.tar -C /outside`);
	await assertBlocked(toolCall, `tar --directory=/outside -xf a.tar`);
	await assertBlocked(toolCall, `tar --directory /outside -xf a.tar`);
	await assertBlocked(toolCall, `rsync src/ /outside/`);
	await assertBlocked(toolCall, `unzip archive.zip -d /outside`);
	await assertAllowed(toolCall, `tar -C ${tmp} -xf a.tar`);
	await assertAllowed(toolCall, `tar --directory=${tmp} -xf a.tar`);
	await assertAllowed(toolCall, `tar xf archive.tar -C ${tmp}`);
	await assertAllowed(toolCall, `rsync src/ ${tmp}/dest`);
	await assertAllowed(toolCall, `unzip archive.zip -d ${tmp}`);
	// The archive creation target (-f) and the implicit extraction cwd are write targets too:
	// cwd tracking only classifies writes reached through a tracked cd, so without -C/-d the
	// cwd itself is checked like any other target.
	await assertBlocked(toolCall, `tar -cf /outside/a.tar ${tmp}/a`);
	await assertBlocked(toolCall, `tar -czf /outside/a.tar ${tmp}/a`);
	await assertBlocked(toolCall, `tar cf /outside/a.tar ${tmp}/a`);
	await assertBlocked(toolCall, `tar --create --file=/outside/a.tar ${tmp}/a`);
	await assertBlocked(toolCall, `tar -xf ${tmp}/a.tar`);
	await assertAllowed(toolCall, `tar -czf ${tmp}/a.tar ${tmp}/a`);
	await assertAllowed(toolCall, `tar -tzf /outside/a.tar`);
	await assertBlocked(toolCall, `unzip ${tmp}/a.zip`);
	await assertAllowed(toolCall, `unzip -l /outside/a.zip`);
});

test("allows tar stdout-only modes from outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: -O/--to-stdout and the `-f -` archive operand route output to stdout,
	// so no filesystem target escapes temp even when the cwd (/workspace) is outside it.
	await assertAllowed(toolCall, `tar -xzOf ${tmp}/pkg.tgz README.md`);
	await assertAllowed(toolCall, `tar --to-stdout -xf ${tmp}/a.tar`);
	await assertAllowed(toolCall, `tar -czf - src/`);
	await assertAllowed(toolCall, `tar -c --file=- src/`);
	await assertAllowed(toolCall, `tar --file - -c src/`);
	// Real filesystem writes still block: relative extract targets the cwd, and archive
	// creation outside temp is an outside write. Extracting from stdin (`-xf -`) still
	// writes member files into the cwd, so the dash archive operand never allows it.
	await assertBlocked(toolCall, `tar -xf a.tar`);
	await assertBlocked(toolCall, `tar -xf -`);
	await assertBlocked(toolCall, `tar -cf /outside/a.tar`);
	await assertBlocked(toolCall, `tar -czf /outside/a.tar`);
	await assertBlocked(toolCall, `tar -xf a.tar -C /outside`);
	await assertAllowed(toolCall, `tar -czf ${tmp}/a.tar ${tmp}/a`);
	// Lowercase `o` is a GNU extract flag, never stdout: the extraction still targets the cwd.
	await assertBlocked(toolCall, `tar -xof a.tar`);
	// A quoted `-` archive still streams to stdout, like `-f -`. An attached tail (`-cf-`)
	// stays fail-closed: the bundle rule cannot attribute a non-letter tail to a value letter.
	await assertAllowed(toolCall, `tar -cf '-' src/`);
	await assertBlocked(toolCall, `tar -cf- src/`);
	// The stdout carve-out does not depend on `-C`: extraction with -O writes no member files.
	await assertAllowed(toolCall, `tar -xO -C /outside -f a.tar`);
	// Conflicting action modes fail closed: creation targets the archive while extraction
	// writes member files, so neither guess is safe even when the archive is stdout.
	await assertBlocked(toolCall, `tar -xc -f - src/`);
	await assertBlocked(toolCall, `tar -xczf - src/`);
	// `-O` without `-x` still streams to stdout: no member files land in `-C` or the cwd.
	await assertAllowed(toolCall, `tar -O -f ${tmp}/a.tar`);
	await assertAllowed(toolCall, `tar -cO -f - src/`);
	// CONTRACT: a value-taking option consumes its operand, so a value that spells `-O` or
	// `--to-stdout` never reads as the stdout flag. Real tar extracts (`--exclude -O` excludes
	// the member named `-O`), so the extraction must still be classified by its cwd.
	await assertBlocked(toolCall, `tar -xf a.tar --exclude -O`);
	await assertBlocked(toolCall, `tar -xf a.tar --exclude --to-stdout`);
	await assertBlocked(toolCall, `tar -xf a.tar --exclude=-O`);
	await assertBlocked(toolCall, `tar -xf a.tar -X -O`);
	await assertBlocked(toolCall, `tar -xf a.tar --owner -O`);
	// The same command inside temp stays allowed: the value is consumed, not misread as stdout.
	await assertAllowed(toolCall, `tar -xf a.tar --exclude -O -C ${tmp}`);
	// Optional-argument options bind with `=`, so a following `-C` is a real option: consuming
	// it as the option value would hide the extraction directory.
	await assertBlocked(toolCall, `tar -xf a.tar --backup -C /outside`);
	await assertAllowed(toolCall, `tar -xf a.tar --backup -C ${tmp}`);
	// And the optional-argument form leaves `-O` in flag position, where it really streams.
	await assertAllowed(toolCall, `tar --backup -O -x -f a.tar`);
	// A dash-less bundle takes values from the NEXT token, so more than one value letter cannot
	// be attributed to its operand — fail closed rather than lose the archive destination.
	await assertBlocked(toolCall, `tar bcf 20 /outside/a.tar src/`);
	// Modeled value options consume `-O` as their value, so the extraction keeps its real
	// (outside) cwd target and blocks. `--quote-chars`/`--exclude-tag`/`--xattrs-include`
	// are in TAR_LONG_VALUE_OPTIONS; only the unknown option below exercises the
	// unmodeled-option guard: its unprovable value may be `-O`, so it fails closed.
	await assertBlocked(toolCall, `tar -xf a.tar --quote-chars -O`);
	await assertBlocked(toolCall, `tar -xf a.tar --exclude-tag -O`);
	await assertBlocked(toolCall, `tar -xf a.tar --xattrs-include -O`);
	await assertBlocked(toolCall, `tar -xf a.tar --future-unknown-option -O`);
	// A known no-argument option leaves `-O` in flag position.
	await assertAllowed(toolCall, `tar -xf a.tar --verbose -O`);
	// `-H`/`-L` take a value in GNU tar but are flags in bsdtar (the default tar on macOS and
	// Windows). Consuming their "value" would swallow `-f` and hide an outside archive write.
	await assertBlocked(toolCall, `tar -cH -f /outside/a.tar src`);
	await assertBlocked(toolCall, `tar -cL -f /outside/a.tar src`);
	await assertAllowed(toolCall, `tar -cH -f ${tmp}/a.tar src`);
	// `-s` is a preserve-order flag in GNU tar but takes a substitution pattern in bsdtar. An
	// attached pattern can contain `O` delimiters (`-sOqOqO`); scanning them as the stdout flag
	// would allow a real extraction into the cwd.
	await assertBlocked(toolCall, `tar -xf a.tar -sOqOqO`);
	await assertAllowed(toolCall, `tar -xf a.tar -s /a/b/ -O`);
	// CONTRACT: on GNU tar the attached tail is more flags, so it can carry a write mode and
	// the archive/directory operand. Trusting the bsdtar reading hides the real target
	// (`-csf` = `-c -s -f`), so every attached form fails closed.
	await assertBlocked(toolCall, `tar -csf /outside/a.tar src`);
	await assertBlocked(toolCall, `tar -cszf /outside/a.tar src`);
	await assertBlocked(toolCall, `tar -xsCdirlink -f a.tar`);
	// The separated `-s` stays a plain flag, so the archive operand is still read.
	await assertAllowed(toolCall, `tar -c -s -f ${tmp}/a.tar src`);
	// CONTRACT: exec/side-write options fail closed even with stdout: -O streams members
	// but --to-command still runs per member and -I/-F/--index-file/--use-compress-program
	// run programs or write side files outside the stdout stream.
	await assertBlocked(toolCall, `tar -xOf a.tar --to-command 'touch /outside/x'`);
	await assertBlocked(toolCall, `tar -xOf a.tar --to-command=touch`);
	await assertBlocked(toolCall, `tar -xOf a.tar -I 'touch /outside/x'`);
	await assertBlocked(toolCall, `tar -xOf a.tar --index-file /outside/x`);
	await assertBlocked(toolCall, `tar -xOf a.tar --use-compress-program prog`);
	await assertBlocked(toolCall, `tar -xOf a.tar -F prog`);
	// `--one-top-level=<dir>` redirects extraction under <dir>: the dir is the write target.
	await assertBlocked(toolCall, `tar -xf a.tar --one-top-level=/outside/x`);
	await assertAllowed(toolCall, `tar -xf a.tar --one-top-level=${tmp}`);
	// The bare form derives the directory from the archive name, which cannot be proven.
	await assertBlocked(toolCall, `tar -xf a.tar --one-top-level`);
	// Control: plain stdout extraction without exec still streams and stays allowed.
	await assertAllowed(toolCall, `tar -xOf a.tar`);
});

test("blocks tar bundles whose attached value cannot be attributed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: a bundle with a non-letter tail means an option letter consumed the
	// rest of the word as its value, and unmodeled letters can also take that value —
	// the archive path cannot be attributed, so these fail closed from any cwd.
	await assertBlocked(toolCall, `tar -czf/etc/a.tar ${tmp}/f`, tmp);
	await assertBlocked(toolCall, `tar czf/etc/a.tar ${tmp}/f`, tmp);
	const unattributable = classifyBashCommand(`tar -czf/etc/a.tar ${tmp}/f`, tmp);
	assert.ok(!unattributable.ok && /cannot model/.test(unattributable.reason),
		"an unattributable archive must fail closed, not claim a fake outside path");
	// Obsolescent dash-less bundles take the archive from the NEXT token: `f` must
	// not swallow the following option letter as the archive name.
	await assertBlocked(toolCall, `tar fc /etc/a.tar ${tmp}/f`, tmp);
	// The modern attached-value forms stay confidently parseable.
	await assertAllowed(toolCall, `tar -czf ${tmp}/a.tgz ${tmp}/a`, tmp);
	await assertAllowed(toolCall, `tar cf ${tmp}/a.tar ${tmp}/a`, tmp);
	await assertAllowed(toolCall, `tar --create --file=${tmp}/a.tar ${tmp}/a`, tmp);
	await assertAllowed(toolCall, `tar -tzf /outside/a.tar`, tmp);
});

test("treats every token after -- as an operand", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: `--` ends option parsing, so `-r` after it is a write target, not a
	// value flag whose argument may be skipped.
	await assertBlocked(toolCall, `touch -- -r /etc/hosts ${tmp}/x`, tmp);
	await assertAllowed(toolCall, `touch ${tmp}/ok`, tmp);
});

test("allows unzip -p and -c as read-only", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: -p/-c pipe members to stdout without extracting, like -l/-t/-v.
	// Extraction without a read flag targets the cwd, so it blocks from outside temp.
	await assertAllowed(toolCall, `unzip -p /outside/a.zip`, tmp);
	await assertAllowed(toolCall, `unzip -c /outside/a.zip`, tmp);
	await assertBlocked(toolCall, `unzip ${tmp}/a.zip`);
});

test("blocks PowerShell and cmd launched through bash unconditionally", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: shells the classifier cannot parse are blocked by basename,
	// case-insensitively, including full Windows paths.
	await assertBlocked(toolCall, 'pwsh -c "rm /workspace/x"');
	await assertBlocked(toolCall, 'powershell.exe -Command "Set-Content -Path notes.txt -Value x"');
	await assertBlocked(toolCall, "cmd /c del x");
	await assertBlocked(toolCall, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-ChildItem");
	await assertBlocked(toolCall, "PWSH -c x");
	await assertBlocked(toolCall, "pwsh.exe -c x");
	await assertBlocked(toolCall, "powershell -Command x");
	await assertBlocked(toolCall, "/usr/bin/pwsh -c x");
	await assertBlocked(toolCall, "env pwsh -c x");
	await assertBlocked(toolCall, "exec pwsh -c x");
	await assertBlocked(toolCall, "command pwsh -c x");
	await assertBlocked(toolCall, "FOO=1 pwsh -c x");
	await assertBlocked(toolCall, "echo x | pwsh -c -");
});

test("blocks PowerShell nested in bash -c or chained after a read", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	await assertBlocked(toolCall, 'bash -c "pwsh -c Remove-Item x"');
	await assertBlocked(toolCall, "ls && pwsh -c x");
});

test("names the blocked shell in the block reason", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	const result = await toolCall({ toolName: "bash", input: { command: "cmd.exe /c dir" } }, { cwd: "/workspace" });
	assert.equal(result.block, true);
	assert.match(result.reason, /cmd\.exe blocked/);
});

test("allows read commands that mention pwsh only as an argument", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "echo pwsh");
	await assertAllowed(toolCall, "which pwsh");
});

test("classifies git commands correctly", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: immutable git commands allowed, mutable blocked.
	await assertAllowed(toolCall, "git status");
	await assertAllowed(toolCall, "git log --oneline");
	await assertBlocked(toolCall, "git add .");
	await assertBlocked(toolCall, "git commit -m 'msg'");
});

test("blocks cwd-relative downloads outside temp but allows inside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: cwd-relative downloads follow temp-dir rules.
	await assertBlocked(toolCall, "curl -O https://example.com/file.txt", "/workspace");
	await assertAllowed(toolCall, "curl -O https://example.com/file.txt", tmp);
	await assertBlocked(toolCall, "wget https://example.com/file.txt", "/workspace");
});

test("allows readonly-safe git inspection subcommands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "git reflog");
	await assertAllowed(toolCall, "git branch -l");
	await assertAllowed(toolCall, "git config -l");
});

test("allows piped read commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "cat /etc/hosts | grep localhost");
	await assertAllowed(toolCall, "ls -la | head -5");
	await assertAllowed(toolCall, "git log | grep commit");
});

test("blocks chained commands that write outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outside = shellPath(path.join(os.homedir(), "readonly-test-file"));

	await assertBlocked(toolCall, `echo a && touch ${outside}`);
	await assertBlocked(toolCall, `ls; rm -f ${outside}`);
	await assertBlocked(toolCall, `echo ok || touch ${outside}`);
});

test("allows chained commands that only read or write to temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	await assertAllowed(toolCall, "echo a && ls");
	await assertAllowed(toolCall, `echo a > ${tmp}/x && cat ${tmp}/x`);
});

test("blocks heredoc redirects outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outside = shellPath(path.join(os.homedir(), "readonly-test-file"));

	await assertBlocked(toolCall, `cat <<'EOF' > ${outside}\nhello\nEOF`);
});

test("blocks dd of= outside temp and allows it in temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const outside = shellPath(path.join(os.homedir(), "readonly-test-file"));

	await assertBlocked(toolCall, `dd if=/dev/zero of=${outside} bs=1 count=1`);
	await assertAllowed(toolCall, `dd if=/dev/zero of=${tmp}/dd-test bs=1 count=1`);
});

test("allows hidden-file globs inside temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const cwd = await mkdtemp(path.join(os.tmpdir(), "readonly-hidden-allow-"));

	try {
		await writeFile(path.join(cwd, ".secret"), "ok");
		await assertAllowed(toolCall, "rm -f *", cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("blocks hidden-file globs outside temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	// Home dir already has hidden files (.gitconfig, .ssh, etc.) and is
	// outside the temp dir — no filesystem writes needed for the glob to match.
	await assertBlocked(toolCall, "rm -f *", shellPath(os.homedir()));
});

// ── Regression tests for review findings ────────────────────────────────

// ISSUE #41: a brace/glob-dense write target made expandHiddenGlobPatterns
// enumerate 2^n dotfile-variant patterns and call globSync on each — a single
// crafted command could OOM-kill the in-process classifier (runs on every bash
// tool call). The expansion is now capped; a dense pattern falls through to the
// literal containment path, so the verdict is preserved without heap growth.

test("brace-dense glob targets do not exhaust the classifier heap (#41)", () => {
	// 2^24 dotfile variants would previously materialize and heap-OOM the in-process
	// classifier. Run in a child with a small heap: the unpatched expansion dies, the
	// capped path returns blocked immediately. A verdict-only assertion cannot tell the
	// two apart, so the heap bound is the discriminator.
	const dense = "a{b}/".repeat(24);
	const script = `import(${JSON.stringify(new URL("../../readonly-bash.ts", import.meta.url).href)}).then((m) => {`
		+ `if (m.classifyBashCommand("touch " + ${JSON.stringify(dense)} + "probe", "/workspace").ok) process.exit(3);`
		+ `process.stdout.write("blocked");});`;
	const output = execFileSync(process.execPath, [
		"--max-old-space-size=64",
		"--import", new URL("../../register-loader.mjs", import.meta.url).href,
		"-e", script,
	], { encoding: "utf8", timeout: 30000 });
	assert.equal(output, "blocked");
	// The cap must not newly over-block: a literal-in-temp target of the same density
	// still resolves through the literal containment path and is allowed.
	assert.equal(classifyBashCommand(`touch ${dense}probe`, shellPath(os.tmpdir())).ok, true, "brace-dense temp target stays allowed by literal fallback");
});

// Trailing redirects are validated on the raw segment by the redirect scanner; they
// must not reach command-operand parsers, where `2>/dev/null` would read as a git
// option or `>/dev/null` as a mutation target (false-block with a misleading reason).

test("trailing redirects never change a command's operand classification", () => {
	const tmp = shellPath(os.tmpdir());
	for (const command of [
		"git status 2>/dev/null",
		"git log --oneline 2>&1",
		`git init ${tmp}/readonly-redirect-repo 2>/dev/null`,
		`touch ${tmp}/readonly-redirect-touch >/dev/null`,
		`cp README.md ${tmp}/readonly-redirect-copy 2>&1`,
		`export D=${tmp}/readonly-redirect-dir 2>/dev/null && cd "$D" && touch f`,
	]) assert.equal(classifyBashCommand(command, "/workspace").ok, true, command);

	// An outside target keeps the real target in the reason — never the redirect token.
	// Derive it from the temp root's parent so the assertion is host-agnostic (`/etc` is POSIX-only).
	const outsideRoot = path.parse(os.tmpdir()).root;
	const outside = classifyBashCommand(`touch ${shellPath(path.join(outsideRoot, "readonly-redirect-probe"))} 2>/dev/null`, "/workspace");
	assert.equal(outside.ok, false);
	assert.match(outside.reason, /touch blocked outside temp dir: .*readonly-redirect-probe$/);
	const outsideGit = classifyBashCommand(`git init ${shellPath(path.join(outsideRoot, "readonly-redirect-repo"))} 2>/dev/null`, "/workspace");
	assert.equal(outsideGit.ok, false);
	assert.match(outsideGit.reason, /blocked outside temp dir: .*readonly-redirect-repo$/);

	// A redirect target outside temp stays blocked by the redirect scanner itself.
	const redir = classifyBashCommand(`echo hi > ${shellPath(path.join(outsideRoot, "readonly-redirect-redir"))}`, "/workspace");
	assert.equal(redir.ok, false);
	assert.match(redir.reason, /write redirect blocked outside temp dir/);
});

// ── Untested bash pattern coverage (from review findings) ──────────

test("blocks sudo commands that write outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "sudo rm /etc/passwd");
	await assertBlocked(toolCall, "sudo -u root touch /etc/test");
	await assertBlocked(toolCall, "sudo -h localhost rm /etc/test");
});

test("allows sudo commands that only read", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertAllowed(toolCall, "sudo ls /etc");
	await assertAllowed(toolCall, "sudo cat /etc/hosts");
});

test("blocks env -S with mutation command", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, 'env -S "rm -rf /"');
	await assertBlocked(toolCall, "env -S 'touch /etc/test'");
});

test("allows env with read commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertAllowed(toolCall, "env -S 'ls /etc'");
	await assertAllowed(toolCall, "env VAR=value ls /tmp");
});

test("blocks eval and exec wrappers with mutation", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "eval 'rm /etc/passwd'");
	await assertBlocked(toolCall, "exec touch /etc/test");
});

test("blocks interpreter inline execution that shells out to mutation commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "node -e 'rm /etc/passwd'");
	await assertBlocked(toolCall, "node --eval 'rm /etc/passwd'");
	await assertBlocked(toolCall, "node --eval='rm /etc/passwd'");
	await assertBlocked(toolCall, "node -e'rm /etc/passwd'");
	await assertBlocked(toolCall, "python -c 'touch /etc/test'");
	await assertBlocked(toolCall, "perl -e 'rm /etc/passwd'");
	await assertBlocked(toolCall, "ruby -e 'touch /etc/test'");
	// Bundled short flags: the exec letter is not first, or trailing letters are flags.
	await assertBlocked(toolCall, "bash -lc 'rm /etc/passwd'");
	await assertBlocked(toolCall, "bash -ce 'rm /etc/passwd'");
	await assertBlocked(toolCall, "sh -ec 'touch /etc/test'");
	await assertBlocked(toolCall, "python3 -Ic 'touch /etc/test'");
	await assertBlocked(toolCall, "perl -we 'touch /etc/test'");
	await assertBlocked(toolCall, "node -pe 'touch /etc/test'");
	// Quoted clusters and digit-bearing clusters must not hide the exec letter.
	await assertBlocked(toolCall, "perl -0we 'unlink /etc/passwd'");
	await assertBlocked(toolCall, "ruby -w0e 'unlink /etc/passwd'");
	await assertBlocked(toolCall, "perl -w'e'\"unlink /etc/passwd\"");
	await assertBlocked(toolCall, "perl '-e'\"unlink /etc/passwd\"");
	// Standard aliases for inline execution.
	await assertBlocked(toolCall, "perl -E 'unlink /etc/passwd'");
	await assertBlocked(toolCall, "node -p 'rm /etc/passwd'");
	await assertBlocked(toolCall, "node --print 'rm /etc/passwd'");
	await assertAllowed(toolCall, "node --eval 'echo ok'");
	await assertAllowed(toolCall, "bash -lc 'echo ok'");
	// Attached and clustered scripts still classify as code without over-blocking.
	await assertAllowed(toolCall, "python3 -c'print(1)'");
	await assertAllowed(toolCall, "perl -e'print 1'");
	await assertAllowed(toolCall, "ruby -e'puts 1'");
	await assertAllowed(toolCall, "node -pe '1+1'");
	await assertAllowed(toolCall, "perl -0we 'print 1'");
	await assertAllowed(toolCall, "ruby -w0e 'puts 1'");
	await assertAllowed(toolCall, "perl -w'e'\"print 1\"");
	await assertAllowed(toolCall, "node -p '1+1'");
	await assertAllowed(toolCall, "node --print '1+1'");
});

test("blocks process substitution with mutation", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "cat <(rm /etc/passwd)");
});

test("blocks xargs with mutation command", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "echo /etc/test | xargs rm");
	// xargs npm is a known L2 bypass (documented at the top of readonly-bash.ts):
	// npm alone has no verb args, so the classifier cannot detect the mutation
	// at inspection time — only L1 (OS sandbox) catches this at runtime.
	// await assertBlocked(toolCall, "printf 'install' | xargs npm");
});

test("allows xargs with read commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertAllowed(toolCall, "echo /tmp/test | xargs ls");
});

test("blocks xargs flag variants with mutation commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "printf '/etc/passwd\n' | xargs -I {} rm {} ");
	await assertBlocked(toolCall, "printf '/etc/passwd\0' | xargs -0 rm");
	await assertBlocked(toolCall, "printf '/etc/passwd\n' | xargs -n 1 rm");
});

test("blocks git branch creation", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "git branch new-branch");
	await assertBlocked(toolCall, "git checkout -b new-branch");
});

test("blocks git tag creation", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "git tag v1.0.0");
	await assertBlocked(toolCall, "git tag -a v1.0.0 -m 'release'");
});

test("blocks command substitution with nested mutation", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outside = shellPath(path.join(os.homedir(), "readonly-test-file"));
	await assertBlocked(toolCall, `echo $(touch ${outside})`);
	await assertBlocked(toolCall, `echo $(rm /etc/passwd)`);
});

test("blocks wget download-dir writes outside temp and allows them in temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	await assertBlocked(toolCall, "wget -P /workspace https://example.com/file.txt");
	await assertBlocked(toolCall, "wget --directory-prefix=/workspace https://example.com/file.txt");
	await assertAllowed(toolCall, `wget -P ${tmp} https://example.com/file.txt`);
});

test("blocks mixed curl output modes outside temp and allows them in temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const tmpOutput = shellPath(path.join(tmp, "out.txt"));
	await assertBlocked(toolCall, `curl -o ${tmpOutput} -O https://example.com/file.txt`, "/workspace");
	await assertAllowed(toolCall, `curl -o ${tmpOutput} -O https://example.com/file.txt`, tmp);
});

// ── Subshell and nested-wrapper edge cases ──────────────────────

test("blocks double-parenthesized mutation", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "((rm /etc/passwd))");
});

test("allows double-parenthesized read command", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertAllowed(toolCall, "((echo hello))");
});

test("blocks nested wrapper sudo+env+xargs", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertBlocked(toolCall, "sudo env xargs rm /etc/passwd");
});

// ── Temp-dir git and cwd tracking ───────────────────────────────

test("allows mutable git rooted inside the temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: a mutable git command's write target decides — not its name.
	await assertAllowed(toolCall, "git init", tmp);
	await assertAllowed(toolCall, "git add .", tmp);
	await assertAllowed(toolCall, "git commit -m msg", tmp);
	await assertAllowed(toolCall, `git init ${tmp}/repo`, "/workspace");
	await assertAllowed(toolCall, `git -C ${tmp} init`, "/workspace");
	await assertAllowed(toolCall, `git clone https://example.com/x ${tmp}/clone`, "/workspace");
	// Quoted operands with shell variables must resolve to the real temp path.
	await assertAllowed(toolCall, `DIR='${tmp}'; git init "$DIR/repo"`, "/workspace");
});

test("blocks mutable git rooted outside the temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	await assertBlocked(toolCall, "git init", "/workspace");
	await assertBlocked(toolCall, "git add .", "/workspace");
	await assertBlocked(toolCall, "git -C /workspace init", tmp);
	await assertBlocked(toolCall, "git init /workspace/repo", tmp);
	await assertBlocked(toolCall, "git clone https://example.com/x /workspace/clone", tmp);
	await assertBlocked(toolCall, "git config --global user.name x", tmp);
	await assertBlocked(toolCall, `DIR='/workspace'; git init "$DIR/repo"`, tmp);
});

test("allows read-only git from any directory", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	await assertAllowed(toolCall, "git status", "/workspace");
	await assertAllowed(toolCall, "git log --oneline", "/workspace");
	await assertAllowed(toolCall, "git -C /workspace diff", shellPath(os.tmpdir()));
});

test("tracks cd into the temp dir for relative mutations", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	await assertAllowed(toolCall, `cd ${tmp} && touch f`, "/workspace");
	await assertAllowed(toolCall, `cd ${tmp} && mkdir d`, "/workspace");
	await assertAllowed(toolCall, `cd ${tmp} && git init`, "/workspace");
	await assertAllowed(toolCall, `pushd ${tmp} && rm f`, "/workspace");
});

test("blocks relative mutations after cd outside the temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	const outside = JSON.stringify(path.parse(tmp).root);
	await assertBlocked(toolCall, `cd ${outside} && touch f`, tmp);
	await assertBlocked(toolCall, `cd ${outside} && git init`, tmp);
	await assertBlocked(toolCall, `pushd ${outside} && rm f`, tmp);
});

test("directory changes fail closed when Bash would not execute them", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const root = path.parse(tmp).root;

	// `command -v cd /tmp` is a lookup, not a directory change: cwd never moves.
	await assertBlocked(toolCall, `command -v cd ${tmp}; touch f`, root);
	// A single-quoted operand is literal: `$D` does not expand, the real cd fails.
	await assertBlocked(toolCall, `D=${tmp}; cd '$D'; touch f`, root);
	// `unset` drops the tracked variable, so the expansion is unprovable.
	await assertBlocked(toolCall, `D=${tmp}; unset D; cd "$D"; touch f`, root);
	// A failed input redirect aborts the command before cd runs.
	await assertBlocked(toolCall, `</pi-readonly-missing-input cd ${tmp}; touch f`, root);
	await assertBlocked(toolCall, `cd ${tmp} </pi-readonly-missing-input; touch f`, root);
	// An output redirect into a missing parent aborts the command the same way.
	await assertBlocked(toolCall, `cd ${tmp} >/pi-readonly-missing-parent/out; touch f`, root);
});

test("directory changes with provable redirects and quoted paths stay allowed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const root = path.parse(tmp).root;

	// Redirects whose application is provable do not poison the tracked cwd.
	await assertAllowed(toolCall, `cd ${tmp} >/dev/null && touch f`, root);
	// Adjacent quoted/unquoted spans concatenate into one resolvable word.
	await assertAllowed(toolCall, `cd '${tmp}'/. && touch f`, root);
});

test("treats standard temp locations as writable", { skip: process.platform === "win32" ? "POSIX temp paths" : false }, async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// /tmp is a temp root for both the kernel sandbox and the classifier.
	await assertAllowed(toolCall, "echo ok > /tmp/readonly-probe.txt");
	await assertAllowed(toolCall, "rm -f /tmp/readonly-probe.txt");
});

test("does not classify heredoc bodies as commands", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: a heredoc body is stdin data, not shell source.
	await assertAllowed(toolCall, `cat > ${tmp}/hd.txt <<'EOF'\nfoo > bar\nEOF`);
	await assertAllowed(toolCall, `cat > ${tmp}/hd.txt <<'EOF'\nrm /etc/passwd\nEOF`);
});

test("still classifies heredoc bodies passed to a shell", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: `bash <<EOF` executes the body as code.
	await assertBlocked(toolCall, `bash <<'EOF'\nrm /etc/passwd\nEOF`);
	// A quoted `)` must not truncate the body before the mutation is seen.
	await assertBlocked(toolCall, `bash <<'EOF'\necho ')'\nrm /etc/passwd\nEOF`);
});

test("awk stdin is executable code, unlike inert cat data", () => {
	// CONTRACT: awk runs its stdin (`awk '{system($0)}'`), so its heredoc body must fail
	// closed. STDIN_DATA_CONSUMERS (readonly-shell-utils.ts) must keep awk out.
	const awk = classifyBashCommand("awk '{system($0)}' <<'EOF'\nrm -rf /etc\nEOF", "/tmp");
	assert.equal(awk.ok, false, "awk heredoc must be blocked, not treated as inert data");
	assert.match(awk.reason, /fail-closed/);
	// Contrast: cat only reads stdin, so the same body stays inert data.
	assert.equal(classifyBashCommand("cat <<'EOF'\nrm -rf /etc\nEOF", "/tmp").ok, true,
		"a genuine data consumer must not be over-blocked");
});

test("env -S appends trailing argv to the wrapped command", () => {
	// GNU `env -S` splits the string then appends the remaining argv, so the trailing
	// token is still an operand of the wrapped command. Dropping it hid an outside write.
	const root = path.parse(shellPath(os.tmpdir())).root;
	assert.equal(classifyBashCommand(`env -S "touch" ${root}outside/x`, root).ok, false);
	assert.equal(classifyBashCommand(`env -S "touch ${shellPath(os.tmpdir())}/ok" ${root}outside/y`, root).ok, false);
	// A benign trailing word stays allowed; the trailing tokens are the wrapped
	// command's argv, so a `--` after the split string belongs to it, not to env.
	assert.equal(classifyBashCommand('env -S "echo hi" there', root).ok, true);
	assert.equal(classifyBashCommand('env -S"touch" -- -r /etc/hosts x', root).ok, false);
});

test("heredoc stdin escapes through groups, sed e, -c cwd, and var expansion fail closed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const root = path.parse(tmp).root;

	// B2: group members share the heredoc stdin — a shell in any member executes the body.
	await assertBlocked(toolCall, `{ :; bash; } <<'EOF'\ntouch ${root}outside\nEOF`, root);
	await assertBlocked(toolCall, `( :; bash ) <<'EOF'\ntouch ${root}outside\nEOF`, root);
	// B3: GNU sed `e` executes the pattern space (BSD sed has no `e`; classifier must assume GNU).
	await assertBlocked(toolCall, `sed -n e <<'EOF'\ntouch ${root}outside\nEOF`, root);
	await assertBlocked(toolCall, `sed '1e touch ${root}outside' <<'EOF'\nx\nEOF`, root);
	// B4: the body runs at the cwd left by the consumer's -c script, not the parent's.
	await assertBlocked(toolCall, `cd ${tmp}; bash -c 'cd ${root}; bash' <<'EOF'\ntouch rel\nEOF`, tmp);
	// B5: unquoted bodies expand tracked vars; the expanded code is classified.
	await assertBlocked(toolCall, `CMD='touch ${root}outside'; bash <<EOF\n$CMD\nEOF`, tmp);
	await assertBlocked(toolCall, `bash <<EOF\n$PI_READONLY_UNSET_CMD\nEOF`, tmp);
});

test("inert heredoc owners, provable -c cwd, and resolvable var bodies stay allowed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// Groups of pure data consumers keep the body inert.
	await assertAllowed(toolCall, `{ cat; grep x; } <<'EOF'\ntouch /outside\nEOF`);
	// sed substitutions never execute the body, even one mentioning `e`.
	await assertAllowed(toolCall, `sed 's/e/x/' <<'EOF'\ntouch /outside\nEOF`);
	// A -c script whose directory change stays inside temp keeps the body classified there.
	await assertAllowed(toolCall, `cd ${tmp}; bash -c 'cd ${tmp}; bash' <<'EOF'\ntouch rel\nEOF`, tmp);
	// A resolvable var expands to a harmless command.
	await assertAllowed(toolCall, `C='echo hi'; bash <<EOF\n$C\nEOF`, tmp);
});

test("heredoc checks retain header execution position through the readonly hook", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = quoteShellArgument(shellPath(os.tmpdir()));
	await assertBlocked(toolCall, `bash <<'EOF'; cd ${tmp}\ntouch relative\nEOF`, shellPath(os.homedir()));
	await assertAllowed(toolCall, `bash <<'EOF'; cd ${quoteShellArgument(shellPath(os.homedir()))}\ntouch relative\nEOF`, shellPath(os.tmpdir()));
	await assertAllowed(toolCall, `cd ${tmp}; bash <<'EOF'; cd /\ntouch relative\nEOF`, shellPath(os.homedir()));
});

test("unquoted shell stdin uses parent values, not child assignments", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = quoteShellArgument(shellPath(os.tmpdir()));
	await assertBlocked(toolCall, `D=/; bash <<EOF\nD=${tmp}\ntouch "$D/relative"\nEOF`, shellPath(os.tmpdir()));
	await assertAllowed(toolCall, `D=${tmp}; bash <<EOF\nD=/\ntouch "$D/relative"\nEOF`, shellPath(os.tmpdir()));
	await assertAllowed(toolCall, `D=/; bash <<EOF\nD=${tmp}\ntouch "\\$D/relative"\nEOF`, shellPath(os.tmpdir()));
	await assertBlocked(toolCall, "bash <<EOF\ntouch \"$(printf /)/relative\"\nEOF", shellPath(os.tmpdir()));
});

test("output fd failures preserve the old cwd through the readonly hook", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = quoteShellArgument(shellPath(os.tmpdir()));
	await assertBlocked(toolCall, `cd ${tmp} 3>&999; touch relative`, shellPath(os.homedir()));
	await assertAllowed(toolCall, `cd ${tmp} 3>&999; touch relative`, shellPath(os.tmpdir()));
	await assertAllowed(toolCall, `cd ${tmp} 3>&999 && touch relative`, shellPath(os.homedir()));
});

test("does not treat arithmetic shifts as heredocs", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "echo $((1 << 10))");
	// A bare arithmetic command is not a subshell or a heredoc either.
	await assertAllowed(toolCall, "(( x = 1 << 2 ))");
	// The shift must not swallow the following mutation as a heredoc body.
	await assertBlocked(toolCall, "echo $((1 << 10))\nrm /etc/passwd");
});

test("classifier agrees with the shared temp-root policy", () => {
	// Guard against the classifier and the sandbox profile drifting apart. The expectation
	// is anchored on the OS temp dir independently, so a truncated policy fails loudly
	// instead of passing vacuously.
	assert.ok(TEMP_WRITE_ROOTS_CANONICAL.length > 0, "temp-root policy must not be empty");
	assert.equal(classifyBashCommand(`touch ${shellPath(os.tmpdir())}/pi-parity-anchor`, "/workspace").ok, true, "OS temp dir must be writable");
	for (const root of TEMP_WRITE_ROOTS_CANONICAL) {
		assert.equal(classifyBashCommand(`touch ${shellPath(root)}/pi-parity`, "/workspace").ok, true, `expected ${root} to be temp`);
	}
	assert.equal(classifyBashCommand("touch /pi-outside-parity", "/workspace").ok, false, "a non-temp root must stay blocked");
});

test("group-owned heredocs and physical cd are classified against real shell semantics", () => {
	// CONTRACT: a heredoc attaches to the group's stdin, so `{ bash; }`/`(bash)` run the body.
	for (const owner of ["{ bash; }", "(bash)", "{ /bin/bash; }", "({ bash; })"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\nrm /etc/passwd\nEOF`, "/workspace").ok, false, owner);
	}
	assert.equal(classifyBashCommand("{ cat; } <<'EOF'\nfoo > bar\nEOF", "/workspace").ok, true);
	// `-P` resolves symlinks physically; the lexical tracker cannot follow it, so it fails closed.
	assert.equal(classifyBashCommand(`cd -P ${shellPath(os.tmpdir())}/.. && rm x`, "/workspace").ok, false, "cd -P must fail closed");
	assert.equal(classifyBashCommand(`cd -LP ${shellPath(os.tmpdir())}/.. && rm x`, "/workspace").ok, false, "combined -LP must fail closed");
	assert.equal(classifyBashCommand(`cd -L ${shellPath(os.tmpdir())} && rm x`, "/workspace").ok, true, "cd -L stays lexical");
	assert.equal(classifyBashCommand(`cd -LL ${shellPath(os.tmpdir())} && rm x`, "/workspace").ok, true, "logical-only flags stay tracked");
});

test("tracks multiple heredocs on one line correctly", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: multiple heredocs on one line must all be tracked.
	// Both heredoc bodies are data, not code, so mutations inside are allowed.
	await assertAllowed(toolCall, `cat <<EOF1 <<EOF2\nhello\nEOF1\necho ok\nEOF2`, tmp);
});

test("does not pass a command's heredoc to its fallback interpreter", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// Redirections belong to cat alone, including when the fallback runs.
	await assertAllowed(toolCall, "cat <<'EOF' || bash\nrm /etc/passwd\nEOF");
});

test("resolves git --git-dir relative to -C base", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: --git-dir resolves relative to the -C base, not the original cwd.
	await assertAllowed(toolCall, `git -C ${tmp} --git-dir=repo init`, "/workspace");
});

test("bare cd goes to HOME and blocks subsequent mutations from temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: bare `cd` goes to $HOME (outside temp), so mutations are blocked.
	await assertBlocked(toolCall, "cd && touch f", shellPath(os.tmpdir()));
});

test("popd restores the directory stack correctly", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	const outside = path.parse(tmp).root;
	const target = JSON.stringify(outside);
	// One pop returns to temp; two restore the original non-temp cwd.
	await assertAllowed(toolCall, `pushd ${tmp} && pushd ${target} && popd && touch f`, outside);
	await assertBlocked(toolCall, `pushd ${tmp} && pushd ${target} && popd && popd && touch f`, outside);
});

test("<<- strips leading tabs from heredoc body", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: <<- strips leading tabs before matching the delimiter.
	await assertAllowed(toolCall, `cat > ${tmp}/hd.txt <<-EOF\n\t\thello\n\t\tEOF`);
});

test("evaluates downstream commands in conditionals even when directory does not yet exist", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: pre-flight analysis must not prune && branch when dir does not yet exist.
	const fresh = shellPath(path.join(tmp, `test-fresh-dir-${process.pid}-${Date.now()}`));
	await assertBlocked(toolCall, `mkdir -p ${fresh} && cd ${fresh} && rm -rf /workspace`, "/workspace");
	await assertBlocked(toolCall, `cd ${fresh} && rm -rf /workspace`, "/workspace");
});

test("allows read-only git inspection subcommands with arguments", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: read-only git operations are allowed anywhere.
	await assertAllowed(toolCall, "git config user.name", "/workspace");
	await assertBlocked(toolCall, "git config user.name 'John Doe'", "/workspace");
	await assertAllowed(toolCall, "git branch -a", "/workspace");
	await assertAllowed(toolCall, "git branch -r", "/workspace");
	await assertAllowed(toolCall, "git branch -v", "/workspace");
	await assertAllowed(toolCall, "git remote show origin", "/workspace");
	await assertAllowed(toolCall, "git remote get-url origin", "/workspace");
	await assertAllowed(toolCall, "git stash show -p", "/workspace");
	await assertAllowed(toolCall, "git notes show HEAD", "/workspace");
});

test("distrusts command-provided GIT_CONFIG_GLOBAL for every subcommand", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: a command-provided GIT_CONFIG_GLOBAL can redirect write roots for any
	// subcommand, and the classifier's config probe cannot see it — so it fails closed.
	// (The user's own exported GIT_CONFIG_GLOBAL remains trusted process environment.)
	await assertBlocked(toolCall, `GIT_CONFIG_GLOBAL='/etc/gitconfig' git init`, tmp);
});

// ── Regression tests for review findings C1 / H1 / M1 / M2 ───────────────────

test("classifier never executes a git binary chosen by the command's own PATH", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const root = await mkdtemp(path.join(os.tmpdir(), "readonly-c1-"));
	try {
		const fakeDir = path.join(root, "fake");
		const repo = path.join(root, "repo");
		await mkdir(fakeDir);
		await mkdir(repo);
		const marker = path.join(root, "executed");
		const fakeGit = path.join(fakeDir, "git");
		await writeFile(fakeGit, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`);
		await chmod(fakeGit, 0o755);
		execFileSync("git", ["init", "--quiet"], { cwd: repo });
		// CONTRACT: classification may spawn the trusted git, never a command-selected one.
		await assertAllowed(toolCall, `PATH=${shellPath(fakeDir)}:$PATH git add .`, repo);
		assert.equal(existsSync(marker), false, "command-selected git must not run during classification");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("allows immutable git short flags the old blanket guard rejected", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: `-c`/`-u`/`-x` mean combined-diff/count etc. for immutable reads, not injection.
	for (const command of ["git status -uall", "git status -uno", "git status -unormal", "git log -c", "git diff -c", "git show -c", "git grep -c x"]) {
		await assertAllowed(toolCall, command, "/workspace");
	}
});

test("blocks env -C directory escapes regardless of the command's cwd", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const outside = "/workspace";

	// CONTRACT: `env -C` runs the child outside the tracked cwd, so `rm rel` there is a write
	// outside temp. Both separate and inline forms must fail closed.
	for (const command of [`env -C ${outside} rm rel`, `env -C${outside} rm rel`, `env --chdir=${outside} rm rel`, `env --chdir ${outside} rm rel`]) {
		await assertBlocked(toolCall, command, tmp);
	}
	await assertBlocked(toolCall, "env -C $UNKNOWN_READONLY_DIR rm rel", tmp);
	// A temp `-C` target stays writable and read-only use is unaffected.
	await assertAllowed(toolCall, `env -C ${tmp} ls`, "/workspace");
});

test("eval and source cwd changes stay unknown so later relative writes fail closed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: eval/source run code the classifier cannot see; it may cd anywhere, so a
	// following relative write must be treated as landing outside temp.
	await assertBlocked(toolCall, `eval "cd ${JSON.stringify("/workspace")}"; rm rel`, tmp);
	await assertBlocked(toolCall, "eval 'cd /workspace'; touch rel", tmp);
	await assertBlocked(toolCall, "source ./script; touch rel", tmp);
	await assertBlocked(toolCall, ". ./script; touch rel", tmp);
	// eval/source with no following mutation stays allowed.
	await assertAllowed(toolCall, "eval 'echo hi'", tmp);
});

test("unmatched globs are confined by their literal name", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = await mkdtemp(path.join(os.tmpdir(), "readonly-glob-"));
	try {
		// CONTRACT: no match means Bash passes the pattern literally, so its resolved literal
		// path decides — allowed in temp, blocked outside.
		await assertAllowed(toolCall, "rm -f readonly-absent-*", tmp);
		await assertBlocked(toolCall, `rm -f ${shellPath(os.homedir())}/readonly-absent-*`, tmp);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("tracks assignment-driven workflows inside the temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: assignments earlier in the line resolve for downstream commands —
	// the canonical mktemp scratch-repo workflow.
	await assertAllowed(toolCall, `TMPD=$(mktemp -d) && cd "$TMPD" && git init`, "/workspace");
	await assertBlocked(toolCall, `TMPD=$(mktemp -d); cd "$TMPD"; git init`, "/workspace");
	await assertAllowed(toolCall, `VAR=${tmp}/x && touch $VAR/f`, "/workspace");
	// An assignment whose command may not run must not resolve for later writes.
	await assertBlocked(toolCall, `false && D=${tmp}; touch $D/f`, tmp);
	// Prefix assignments cannot move the tracked cd: $FOO expands before FOO applies.
	await assertBlocked(toolCall, `FOO=${tmp} cd $FOO; touch rel`, "/workspace");
	await assertAllowed(toolCall, `D=${tmp}; cd "$D"; touch rel`, "/workspace");
});

test("compound command bodies run in the parent shell", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const outside = JSON.stringify(path.parse(tmp).root);

	// CONTRACT: a directory change inside a compound body can succeed, so inner
	// and later relative writes are classified against a fail-closed unknown cwd.
	await assertBlocked(toolCall, `cd ${tmp}; if cd ${outside}; then touch evil; fi`, tmp);
	await assertBlocked(toolCall, `while cd ${outside}; do touch evil; done`, tmp);
	await assertBlocked(toolCall, `until cd ${outside}; do touch evil; done`, tmp);
	await assertBlocked(toolCall, `cd ${tmp}; for i in 1; do cd ${outside}; touch evil; done`, tmp);
	await assertBlocked(toolCall, `cd ${tmp}; case x in x) cd ${outside};; esac; touch evil`, tmp);
	await assertBlocked(toolCall, `f() { cd ${outside}; touch evil; }; f`, tmp);
	// Mutations hidden behind introducer or negation keywords stay classified.
	await assertBlocked(toolCall, "if rm -rf /workspace; then :; fi", tmp);
	await assertBlocked(toolCall, "! touch /workspace/x", "/workspace");
	// Bodies that change no directory evaluate in the tracked cwd.
	await assertAllowed(toolCall, "if true; then touch ok; fi", tmp);
	await assertAllowed(toolCall, "if grep -q cd file; then touch rel; fi", tmp);
	await assertAllowed(toolCall, "if [ -d /tmp ]; then touch rel; fi", tmp);
});

test("compound inner directory changes cannot hide behind prefixes", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const outside = JSON.stringify(path.parse(tmp).root);

	// CONTRACT: prefix-wrapped and eval-driven cd inside a body still counts as
	// a directory change, so later relative writes fail closed.
	await assertBlocked(toolCall, `if true; then command cd ${outside}; fi; touch evil`, tmp);
	await assertBlocked(toolCall, `case x in a) builtin cd ${outside};; esac; touch evil`, tmp);
	await assertBlocked(toolCall, `while true; do eval 'cd ${outside}'; done; touch evil`, tmp);
	// coproc runs its command in a child — classified like eval/exec, but with
	// quote grouping intact (only eval re-parses its args as a flat word list).
	await assertBlocked(toolCall, "coproc rm /workspace/x", tmp);
	await assertBlocked(toolCall, "coproc bash -c 'touch /workspace/x'", tmp);
	await assertBlocked(toolCall, "exec bash -c 'touch /workspace/x'", "/workspace");
	await assertAllowed(toolCall, "exec bash -c 'echo hi'", "/workspace");
});

test("pushd stack rotation arguments fail closed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());
	const outside = JSON.stringify(path.parse(tmp).root);

	// CONTRACT: +N/-N operands rotate the untracked directory stack.
	await assertBlocked(toolCall, `pushd ${outside}; cd ${tmp}; pushd +1; touch evil`, outside);
	await assertAllowed(toolCall, `pushd ${tmp}; popd; touch rel`, tmp);
});

test("git merge-tree writes are path-checked", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: modern merge-tree defaults to --write-tree and writes objects.
	await assertBlocked(toolCall, "git merge-tree --write-tree HEAD HEAD~1", "/workspace");
	await assertBlocked(toolCall, "git merge-tree HEAD HEAD~1", "/workspace");
	await assertAllowed(toolCall, "git merge-tree HEAD HEAD~1", tmp);
});

test("bare git prints usage and stays allowed", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	await assertAllowed(toolCall, "git", "/workspace");
});

test("sudo-wrapped heredoc bodies are classified as code", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: the wrapper must not detach the body from classification — it
	// gets a real verdict instead of an unterminated-heredoc false block.
	await assertBlocked(toolCall, "sudo bash <<'EOF'\nrm /etc/passwd\nEOF");
	await assertAllowed(toolCall, "sudo bash <<'EOF'\necho hi\nEOF");
});

test("blocks command-executing and hook-injecting git flags", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	await assertBlocked(toolCall, "git rebase -x 'touch evil' HEAD~1", tmp);
	await assertBlocked(toolCall, "git rebase -xevil HEAD~1", tmp);
	await assertBlocked(toolCall, "git rebase --exec='touch evil' HEAD~1", tmp);
	await assertBlocked(toolCall, "git bisect run touch evil", tmp);
	await assertBlocked(toolCall, `git clone --template=/evil https://example.com/x ${tmp}/c`, tmp);
	await assertBlocked(toolCall, `git init --template=/evil ${tmp}/i`, tmp);
});

test("trap handlers are classified and poison later relative writes", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: trap handlers run later (EXIT/DEBUG), so their code is classified now
	// and a directory change inside forks UNKNOWN_CWD for subsequent segments.
	await assertBlocked(toolCall, "trap 'rm /etc/passwd' EXIT", tmp);
	await assertBlocked(toolCall, "trap 'cd /; touch evil' EXIT", tmp);
	await assertBlocked(toolCall, "trap 'cd /' DEBUG; touch evil", tmp);
	await assertAllowed(toolCall, "trap -p", tmp);
	await assertAllowed(toolCall, "trap", tmp);
	await assertAllowed(toolCall, "trap -- '' EXIT; touch evil", tmp);
	await assertAllowed(toolCall, "trap - EXIT; touch evil", tmp);
});

test("alias values are classified and directory changes poison later writes", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: alias values run on later invocation — same posture as function bodies:
	// mutations block at definition, cd forks UNKNOWN_CWD, harmless aliases stay clean.
	await assertBlocked(toolCall, "alias f='rm /etc/passwd'", tmp);
	await assertBlocked(toolCall, "alias f='cd /'; f; touch evil", tmp);
	await assertAllowed(toolCall, "alias ll='ls -la'; touch evil", tmp);
});

test("git branch and name flags are not misread as paths", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = shellPath(os.tmpdir());

	// CONTRACT: -B (worktree branch) and --name (submodule) take names, not paths.
	await assertAllowed(toolCall, `git worktree add -B foo ${tmp}/wt`, tmp);
	await assertAllowed(toolCall, `git submodule add --name myname https://example.com/x ${tmp}/sub`, tmp);
	await assertAllowed(toolCall, `git clone -o myorigin https://example.com/x ${tmp}/c`, tmp);
});

// ── Quoted redirect targets (readQuotedRedirectTarget coverage gap) ──────────

test("mixed quoted and unquoted redirect spans form one word", { skip: process.platform === "win32" ? "POSIX path separators" : false }, () => {
	const tmp = shellPath(os.tmpdir());
	const outsideFile = path.join(path.parse(os.tmpdir()).root, "readonly-mixed-outside", "pwn");
	const rel = path.relative(os.tmpdir(), outsideFile);
	assert.ok(rel.startsWith(".."), "fixture must escape the temp root");

	// Before the fix the quoted first span (`tmp`) was the only checked target.
	assert.equal(classifyBashCommand(`echo hi >"${tmp}"/${rel}`, "/workspace").ok, false);
	assert.equal(classifyBashCommand(`echo hi >"${tmp}"/allowed.txt`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`echo hi >${tmp}"/allowed.txt"`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`echo hi >>"${tmp}"/allowed.txt`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`D=${quoteShellArgument(tmp)}; echo hi >"$D"/allowed.txt`, "/workspace").ok, true);
	const outsideDir = path.dirname(outsideFile);
	assert.equal(classifyBashCommand(`D=${quoteShellArgument(outsideDir)}; echo hi >"$D"/pwn`, "/workspace").ok, false);
	// A quote boundary ends the variable name. Merging spans as one word turned `$D`+`pwn`
	// into `$Dpwn`, so an inside-temp Dpwn hid the real outside write.
	const boundary = [`>"$D"pwn`, `>"$D""pwn"`, `>$D"pwn"`, `>"$D"'pwn'`];
	for (const redirect of boundary) {
		assert.equal(classifyBashCommand(`D=/etc; Dpwn=${quoteShellArgument(tmp)}/safe; echo hi ${redirect}`, "/workspace").ok, false, redirect);
		assert.equal(classifyBashCommand(`D=${quoteShellArgument(tmp)}/safe; echo hi ${redirect}`, "/workspace").ok, true, redirect);
	}
	// A single-quoted `$` is literal, not an expansion. It stays under the temp cwd.
	assert.equal(classifyBashCommand("echo hi >'$HOME'/x", tmp).ok, true);
	// A quoted span plus an adjacent unquoted suffix is one word; the suffix decides.
	assert.equal(classifyBashCommand(`echo hi >"${tmp}"x`, "/workspace").ok, false);
	// Two adjacent quoted spans are one word; checking only the first span hid the rest.
	assert.equal(classifyBashCommand(`echo hi >"${tmp}""${path.sep}${rel}"`, "/workspace").ok, false);
	assert.equal(classifyBashCommand(`echo hi >"${tmp}""${path.sep}allowed.txt"`, "/workspace").ok, true);
	// Single-span boundary: this traversal was already checked before the mixed-span fix.
	assert.equal(classifyBashCommand(`echo hi >"${tmp}${path.sep}${rel}"`, "/workspace").ok, false);
	// An unquoted glob in a multi-span word cannot be modeled: fail closed instead of
	// checking only the quoted prefix.
	assert.equal(classifyBashCommand(`echo hi >"${tmp}"${path.sep}*.txt`, "/workspace").ok, false);
});

test("a non-leading tilde in a redirect word stays literal", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "readonly-tilde-fragment-"));
	const home = path.join(root, "home");
	await mkdir(home);
	await mkdir(path.join(root, "~"));
	const restore = setTempHome(home);
	try {
		// Bash expands a tilde only at the start of the complete word. The span decoder used
		// to expand this mid-word `~` as HOME, which shifted how the later `..` resolved.
		const depth = root.split(path.sep).length - 1;
		const escape = `"${root}/"~/${"../".repeat(depth + 1)}etc/hosts`;
		const blocked = classifyBashCommand(`echo x >${escape}`, root);
		assert.equal(blocked.ok, false);
		assert.match(blocked.reason, /\/etc\/hosts$/);
		// The same fragment grammar with a literal `~` under temp stays writable.
		assert.equal(classifyBashCommand(`echo x >"${root}/"~/inside.txt`, root).ok, true);
	} finally {
		restore();
		await rm(root, { recursive: true, force: true });
	}
});

test("tilde quoting decides between HOME expansion and a literal pathname", async () => {
	const tmp = shellPath(os.tmpdir());
	const quotedTo = ['echo pwn >~"/x"', "echo pwn >~'/x'", 'echo pwn >~\\/x', 'touch ~"/pwn"'];

	// HOME outside temp, cwd inside temp: Bash keeps a quoted tilde literal, so the write
	// lands at cwd/~/… and stays writable. Expanding HOME would block it instead.
	const outsideHome = path.join(path.parse(tmp).root, "readonly-home-outside");
	const restoreOutside = setTempHome(outsideHome);
	try {
		for (const command of quotedTo) {
			assert.equal(classifyBashCommand(command, tmp).ok, true, command);
		}
	} finally {
		restoreOutside();
	}

	// HOME inside temp, cwd outside temp: the literal tilde writes outside; expanding HOME
	// would approve a different pathname than Bash writes.
	const home = await mkdtemp(path.join(os.tmpdir(), "readonly-home-"));
	const restoreHome = setTempHome(home);
	try {
		for (const command of quotedTo) {
			assert.equal(classifyBashCommand(command, "/workspace").ok, false, command);
		}

		// An unquoted slash after `~` makes Bash expand HOME before the quoted span. Keep HOME
		// under temp so the target is writable: a normalizer that dropped the tilde would resolve
		// these under /workspace and block them, while Bash writes them under HOME.
		for (const command of ['echo pwn >~/"inside.txt"', "echo pwn >~/'inside.txt'", 'echo pwn >~/"sub"/inside.txt']) {
			assert.equal(classifyBashCommand(command, "/workspace").ok, true, command);
		}
		// Expanding home must not launder traversal out of the temp root.
		assert.equal(classifyBashCommand('echo pwn >~/"../../etc/passwd"', "/workspace").ok, false);

		// `~user` and unquoted globs stay unmodeled: the shared tilde rule fails closed.
		for (const command of ['echo pwn >~/*.txt', "echo pwn >~root/'/x'"]) {
			assert.equal(classifyBashCommand(command, tmp).ok, false, command);
		}
	} finally {
		restoreHome();
		await rm(home, { recursive: true, force: true });
	}
});

test("quoted redirect targets resolve identically to unquoted targets", () => {
	// CONTRACT: readQuotedRedirectTarget (readonly-bash.ts:464) parses quoted
	// redirect targets the same as unquoted — quotes are shell syntax, not part
	// of the resolved path. Both double and single quoted forms must yield identical
	// verdicts to their unquoted counterparts.
	const tmp = shellPath(os.tmpdir());

	// > outside temp: quoted and unquoted both block with the same resolved path.
	const qDouble = classifyBashCommand('echo hi > "/etc/probe"', "/workspace");
	const uDouble = classifyBashCommand("echo hi > /etc/probe", "/workspace");
	assert.equal(qDouble.ok, false, "double-quoted > target outside temp must block");
	assert.equal(uDouble.ok, false, "unquoted > target outside temp must block");
	assert.equal(qDouble.reason, uDouble.reason, "quoted and unquoted > must yield identical reasons");

	// Single-quoted form resolves to the same outside path.
	const qSingle = classifyBashCommand("echo hi > '/etc/probe'", "/workspace");
	assert.equal(qSingle.ok, false, "single-quoted > target outside temp must block");
	assert.match(qSingle.reason!, /write redirect blocked outside temp dir: \/etc\/probe/);

	// >> inside temp: both quoted and unquoted allow.
	for (const cmd of [`printf x >> "${tmp}/allowed"`, `printf x >> ${tmp}/allowed`, `printf x >> '${tmp}/allowed'`]) {
		assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, `expected allow: ${cmd}`);
	}

	// >& fd redirect — outside temp: quoted blocks identically to unquoted.
	const fdQuoted = classifyBashCommand('echo y >& "/etc/probe"', "/workspace");
	const fdUnquoted = classifyBashCommand("echo y >& /etc/probe", "/workspace");
	assert.equal(fdQuoted.ok, false, "double-quoted >& target outside temp must block");
	assert.equal(fdUnquoted.ok, false, "unquoted >& target outside temp must block");
	assert.equal(fdQuoted.reason, fdUnquoted.reason, "quoted and unquoted >& must yield identical reasons");

	const fdSingle = classifyBashCommand("echo y >& '/etc/probe'", "/workspace");
	assert.equal(fdSingle.ok, false, "single-quoted >& target outside temp must block");
	assert.match(fdSingle.reason!, /write redirect blocked outside temp dir: \/etc\/probe/);

	// >& fd redirect — inside temp: both allow.
	for (const cmd of [`echo y >& "${tmp}/allowed"`, `echo y >& ${tmp}/allowed`, `echo y >& '${tmp}/allowed'`]) {
		assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, `expected allow: ${cmd}`);
	}
});

// ── xargs flag variants (-L, -P, -d, -E, -s, --replace) ──────────────────────

test("xargs flag variants still block wrapped mutation commands", () => {
	// CONTRACT: every modeled xargs value option consumes its value so the real command
	// word (rm) is reached and classified. Separate, attached, and long forms must block.
	const cases = [
		// -L: max lines per command — separate and attached
		"printf x | xargs -L 1 rm",
		"printf x | xargs -L1 rm",
		// -P: max processes — separate and attached
		"printf x | xargs -P 2 rm",
		"printf x | xargs -P2 rm",
		// -d: input delimiter — separate
		"printf x | xargs -d '\n' rm",
		// -E: end-of-options marker
		"printf x | xargs -E EOF rm",
		// -s: max command size
		"printf x | xargs -s 100 rm",
		// --replace (deprecated alias for -I) — attached and separate
		"printf x | xargs --replace={} rm {}",
		"printf x | xargs --replace=% rm %",
		// --delimiter / -d, --arg-file / -a, --max-args / -n
		"printf x | xargs --delimiter X rm /etc/passwd",
		"printf x | xargs --delimiter=X rm /etc/passwd",
		"printf x | xargs --arg-file LIST rm /etc/passwd",
		"printf x | xargs -a LIST rm /etc/passwd",
		"printf x | xargs --max-args 1 rm /etc/passwd",
		"printf x | xargs -d X rm /etc/passwd",
		// Remaining required-value options must consume their value too.
		"printf x | xargs -R 1 rm /etc/passwd",
		"printf x | xargs -S 100 rm /etc/passwd",
		"printf x | xargs --max-chars 100 rm /etc/passwd",
		"printf x | xargs --max-procs 2 rm /etc/passwd",
		"printf x | xargs --process-slot-var S rm /etc/passwd",
		"printf x | xargs --eof=EOF rm /etc/passwd",
		// Unknown short options, --, and flag bundles keep the wrapped command visible.
		"printf x | xargs -Z rm /etc/passwd",
		"printf x | xargs -- rm /etc/passwd",
		"printf x | xargs -r0 rm /etc/passwd",
		// An unknown option must not let its value become the wrapped command word.
		"printf x | xargs --frobnicate echo hi",
	];
	for (const command of cases) {
		assert.equal(classifyBashCommand(command, "/workspace").ok, false, `expected block: ${command}`);
	}
	const unknown = classifyBashCommand("printf x | xargs --frobnicate echo hi", "/workspace");
	assert.ok(!unknown.ok && /xargs option blocked: cannot model/.test(unknown.reason),
		"unknown xargs option must fail closed with its own reason");
	const unknownShort = classifyBashCommand("printf x | xargs -Z rm /etc/passwd", "/workspace");
	assert.ok(!unknownShort.ok && /xargs option blocked: cannot model/.test(unknownShort.reason),
		"unknown xargs short option must fail closed with its own reason");
});

test("xargs option values keep the wrapped command word", () => {
	for (const prefix of ["--delimiter X", "--delimiter=X", "--arg-file LIST", "-a LIST", "--max-args 1", "-d X", "-R 1", "-S 100", "--max-chars 100", "--max-procs 2", "--process-slot-var S", "--eof=EOF"]) {
		const command = `printf x | xargs ${prefix} ls`;
		assert.equal(classifyBashCommand(command, "/workspace").ok, true, `expected allow: ${command}`);
	}
	assert.equal(classifyBashCommand("printf x | xargs ls", "/workspace").ok, true);
});

test("xargs without replacement mode blocks explicit mutation targets", () => {
	const target = quoteShellArgument(shellPath(path.join(os.tmpdir(), "xargs-option-value")));
	for (const prefix of ["", "--delimiter X", "--arg-file LIST", "-a LIST", "--max-args 1", "--max-lines", "-d X", "env", "env 'FOO=bar'", "env -C /tmp", "sudo"]) {
		const command = `printf x | xargs ${prefix ? `${prefix} ` : ""}rm ${target}`;
		const verdict = classifyBashCommand(command, "/workspace");
		assert.equal(verdict.ok, false, `expected block: ${command}`);
		assert.match(verdict.reason!, /stdin appends unchecked paths/, command);
	}
});

test("xargs unmodeled wrappers cannot hide a mutation", () => {
	const target = quoteShellArgument(shellPath(path.join(os.tmpdir(), "xargs-wrapper-target")));
	for (const wrapper of ["nohup", "nice", "timeout", "stdbuf", "chroot"]) {
		const command = `printf x | xargs ${wrapper} rm ${target}`;
		const verdict = classifyBashCommand(command, "/workspace");
		assert.equal(verdict.ok, false, `expected block: ${command}`);
		assert.match(verdict.reason!, /cannot model its wrapped command/, command);
	}
});

test("xargs replacement mode keeps explicit temp mutation targets writable", () => {
	const target = quoteShellArgument(shellPath(path.join(os.tmpdir(), "xargs-replacement-target")));
	for (const prefix of ["-I{}", "-i", "--replace=%"]) {
		const command = `printf x | xargs ${prefix} rm ${target}`;
		assert.equal(classifyBashCommand(command, "/workspace").ok, true, `expected allow: ${command}`);
	}
	for (const wrapper of ["env", "env -C /tmp", "sudo"]) {
		const command = `printf x | xargs -I{} ${wrapper} rm ${target}`;
		assert.equal(classifyBashCommand(command, "/workspace").ok, true, `expected allow: ${command}`);
	}
});

test("xargs -J mutations fail closed because BSD can append stdin", () => {
	const temp = os.tmpdir();
	const target = quoteShellArgument(shellPath(path.join(temp, "xargs-j-target")));
	const command = `printf /etc/passwd | xargs -J % rm ${target}`;
	const verdict = classifyBashCommand(command, temp);
	assert.equal(verdict.ok, false, command);
	assert.match(verdict.reason!, /xargs -J blocked/, command);
	assert.equal(classifyBashCommand("printf /etc/passwd | xargs -J % rm %", temp).ok, false,
		"a replacement token in the wrapped command must still block");
	assert.equal(classifyBashCommand("printf x | xargs -J % echo hi", temp).ok, true,
		"non-mutating -J commands stay allowed");
});

test("xargs later max-lines or max-args cancels replacement mode", () => {
	const target = quoteShellArgument(shellPath(path.join(os.tmpdir(), "xargs-mode-target")));
	for (const options of ["-I{} -L 1", "-I{} -l", "-I{} -n 2", "-I{} --max-lines", "-I{} --max-args 2"]) {
		const command = `printf x | xargs ${options} rm ${target}`;
		const verdict = classifyBashCommand(command, "/workspace");
		assert.equal(verdict.ok, false, `expected block: ${command}`);
		assert.match(verdict.reason!, /stdin appends unchecked paths/, command);
	}
	for (const options of ["-I{} -n1", "-I{} -n 1", "-I{} -n'1'", "-I{} --max-args=1", "-I{} --max-args 1", "-I{} --max-args '1'"]) {
		const command = `printf x | xargs ${options} rm ${target}`;
		assert.equal(classifyBashCommand(command, "/workspace").ok, true, `expected allow: ${command}`);
	}
});

test("xargs attached optional values select the right replacement token", () => {
	assert.equal(classifyBashCommand("printf x | xargs -iX echo X", "/workspace").ok, false,
		"-iX selects X as the replacement token");
	assert.equal(classifyBashCommand("printf x | xargs -eX echo hi", "/workspace").ok, true,
		"-eX consumes its optional value");
	assert.equal(classifyBashCommand("printf x | xargs -lX echo hi", "/workspace").ok, true,
		"-lX consumes its optional value");
});

test("xargs replacement placeholders fail closed at a temp cwd", () => {
	const temp = os.tmpdir();
	const target = quoteShellArgument(shellPath(path.join(temp, "xargs-replacement-f")));
	for (const command of [
		"printf /etc/passwd | xargs -I{} rm {}",
		"printf x | xargs -I{} echo {}",
		"printf x | xargs --replace=% echo %",
		"printf /etc/passwd | xargs -i rm {}",
		"printf /etc/passwd | xargs --replace={} rm {}",
		"printf /etc/passwd | xargs -I{} sh -c 'rm {}'",
		"printf /etc/passwd | xargs -I{} rm \\{\\}",
		"printf /etc/passwd | xargs -I{} rm $'\\{\\}'",
		"printf /etc/passwd | xargs -I 'X' rm X",
		"printf /etc/passwd | xargs -I \\% rm %",
		"printf /etc/passwd | xargs --replace='X' rm X",
		"printf /etc/passwd | xargs -I \"$B\" rm X",
		"printf /etc/passwd | xargs -I X<&0 rm X",
		"printf /etc/passwd | xargs -IX<&0 rm X",
		"printf /etc/passwd | xargs -I 'X'<&0 rm X",
		"printf /etc/passwd | xargs --replace=X<&0 rm X",
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, false, `expected block: ${command}`);
	}
	for (const harmless of [
		`printf /etc/passwd | xargs -I{} rm ${target}`,
		`printf /etc/passwd | xargs -I 'X' rm ${target}`,
	]) {
		assert.equal(classifyBashCommand(harmless, temp).ok, true, `expected allow: ${harmless}`);
	}
});

// ── bash <() process substitution (classifyScriptProcessSubstitution) ───────────

test("bash <() process substitution classifies inner command targets", () => {
	// CONTRACT: classifyScriptProcessSubstitution (readonly-bash-commands.ts:198) and
	// extractCommandSubstitutions both see <(...). The inner command is path-checked:
	// writes outside temp block, writes inside temp allow.
	const outside = shellPath(path.join(path.parse(os.tmpdir()).root, "readonly-ps-probe"));
	const temp = shellPath(path.join(os.tmpdir(), "readonly-ps-allowed"));
	assert.equal(classifyBashCommand(`bash <(touch ${outside})`, "/workspace").ok, false,
		"inside-substitution outside write must block");
	assert.equal(classifyBashCommand(`bash <(touch ${temp})`, "/workspace").ok, true,
		"inside-substitution temp write must allow");
});

// ── Untested command-classifier coverage (coverage research gaps) ─────────
// Covers getFindMutationTargets (find -delete/-exec/-ok/-fprint*), getSedTargets,
// and getPerlRubyTargets — dispatched from classifyGenericMutation. Pure
// classifyBashCommand checks: writes outside the temp roots must be blocked with
// a reason naming the real target path (never a flag or redirect token), and
// in-place edits inside temp stay allowed.

test("find mutations block outside temp, allow inside temp, naming real targets", () => {
	const tmp = shellPath(os.tmpdir());
	// Contract: -delete and -exec/-ok/-okdir mutate the find roots; -fprint/-fprint0/-fprintf/-fls
	// write results to a named output file (that output is the real target, not the roots).
	const blocked = [
		"find /etc -delete",
		"find /etc -exec rm {} \\;",
		"find /etc -execdir rm {} \\;",
		"find /etc -ok rm {} \\;",
		"find /etc -okdir rm {} \\;",
		"find /etc -fprint /var/log/find.out",
		"find /etc -fprint0 /var/log/find.out0",
		"find /etc -fprintf /var/log/find.out %p\\n",
		"find /etc -fls /var/log/find.lst",
		"find /etc/*.conf -delete",
		"find ~ -name .netrc -delete",
		"find -L /etc -delete",
		"find /tmp/{a,../../etc/passwd} -delete",
		// -L reaches outside temp through a symlink before the payload or -delete runs, so
		// the checked root proves only where the walk started.
		`find -L ${tmp}/x -exec rm {} \\;`,
		`find -L ${tmp}/x -ok rm {} \\;`,
		`find -L ${tmp}/x -execdir rm {} \\;`,
		`find -L ${tmp}/x -okdir rm {} \\;`,
		`find ${tmp}/x -follow -exec rm {} \\;`,
		`find -L ${tmp}/x -delete`,
		`find ${tmp}/x -follow -delete`,
		// Every mutating action contributes a target; a safe first action cannot hide a
		// later outside output file.
		`find ${tmp}/root -exec true \\; -fprint /etc/review-out`,
		`find ${tmp}/root -delete -fprint /etc/review-out`,
		`find ${tmp}/root -fprint /etc/review-out -delete`,
		`find ${tmp}/root -fprintf /etc/review-out %p\\n -exec rm {} \\;`,
		`find ${tmp}/root -fprint ${tmp}/ok -fls /etc/review-out`,
		// BSD pre-root options must not hide the root behind them. The reported exploit ran
		// from a temp cwd, where the old cwd fallback passed.
		"find -X /etc -delete", "find -E /etc -delete", "find -d /etc -delete",
		"find -s /etc -delete", "find -x /etc -delete", "find -- /etc -delete",
		"find -f /etc -delete", "find -Q /etc -delete",
		// BSD keeps its getopt phase open across `-f`, so every `-f` operand is a root and a
		// later one can point outside temp. Parsing stopped after the first and cleared it.
		`find -f ${tmp}/a -f /etc -- -delete`,
		`find -f /etc -f ${tmp}/a -- -delete`,
		`find -f ${tmp}/a -L -f /etc -- -delete`,
		`find -L -f ${tmp}/a -f /etc -- -exec rm {} \\;`,
		// Without `--` the expression is a getopt error on BSD (and -f is unknown to GNU), so
		// the unmodeled-option guard fails closed instead of guessing where the roots end.
		`find -f ${tmp}/x -delete`,
	];
	for (const cmd of blocked) assert.equal(classifyBashCommand(cmd, "/workspace").ok, false, cmd);
	// Same options with a temp cwd: the old fallback to "." allowed every one of these.
	for (const opt of ["-X", "-E", "-d", "-s", "-x", "--"]) {
		assert.equal(classifyBashCommand(`find ${opt} /etc -delete`, tmp).ok, false, opt);
	}
	// The reason must surface the real target path — never the -delete/-exec flag or the exec'd command.
	const del = classifyBashCommand("find /etc -delete", "/workspace");
	assert.equal(del.ok, false); assert.match(del.reason, /find blocked outside temp dir: \/etc$/);
	const exe = classifyBashCommand("find /etc -exec rm {} \\;", "/workspace");
	assert.equal(exe.ok, false); assert.match(exe.reason, /find blocked outside temp dir: \/etc$/);
	const fpr = classifyBashCommand("find /etc -fprint /var/log/find.out", "/workspace");
	assert.equal(fpr.ok, false); assert.match(fpr.reason, /find blocked outside temp dir: \/var\/log\/find\.out$/);
	const fls = classifyBashCommand("find /etc -fls /var/log/find.lst", "/workspace");
	assert.equal(fls.ok, false); assert.match(fls.reason, /find blocked outside temp dir: \/var\/log\/find\.lst$/);
	// A shell-expanded root is never dropped: glob parents resolve like any write target,
	// and tilde/brace expansion cannot be proven against the temp roots.
	const globRoot = classifyBashCommand("find /etc/*.conf -delete", "/workspace");
	assert.equal(globRoot.ok, false); assert.match(globRoot.reason, /find blocked outside temp dir: \/etc\/\*\.conf$/);
	const tildeRoot = classifyBashCommand("find ~ -name .netrc -delete", "/workspace");
	assert.equal(tildeRoot.ok, false); assert.match(tildeRoot.reason, /find blocked: cannot model its write target/);
	// The later `-f` root is the reported target, never the safe first root.
	const laterRoot = classifyBashCommand(`find -f ${tmp}/a -f /etc -- -delete`, "/workspace");
	assert.equal(laterRoot.ok, false); assert.match(laterRoot.reason, /find blocked outside temp dir: \/etc$/);
	// Inside temp: deletions and result files stay allowed. -fprint/-fls target the output file,
	// not the "/" search root, so a temp output is allowed even with a non-temp root.
	const allowed = [
		`find ${tmp} -delete`,
		`find ${tmp} -fprint ${tmp}/find.out`,
		`find / -fls ${tmp}/find.lst`,
		// `()` inside a name is literal (e.g. `Program Files (x86)`), not a find grouping token.
		`find ${tmp}/ProgramFiles(x86) -delete`,
		// Escaped grouping operators (`\(`/`\)`) must NOT be treated as roots either —
		// they are find syntax, not filesystem targets, so an in-temp root stays allowed.
		`find ${tmp}/safe \( -name '*.txt' \) -delete`,
		`find ${tmp}/safe \( -name '*.txt' -o -name '*.md' \) -delete`,
		`find ${tmp}/safe -name '*.txt' -delete`,
		// The modeled options keep their real root; every -f operand is a root too, and the
		// expression needs `--` after them, exactly as BSD find requires.
		`find -X ${tmp}/x -delete`,
		`find -f ${tmp}/x -- -delete`,
		`find -f ${tmp}/a -f ${tmp}/b -- -delete`,
		// Read-only payloads can use `{}`; a mutating payload cannot be proven contained.
		`find ${tmp}/x -exec cat {} \\;`,
		// A `+` not preceded by `{}` is payload, not a terminator, so the payload runs on.
		`find ${tmp}/x -exec echo BEFORE + AFTER {} \\;`,
		`find ${tmp}/x -execdir cat {} \\;`,
		// -L without a runtime pathname substitution cannot move the payload's targets.
		`find -L ${tmp}/x -exec true \\;`,
		// Output paths of later actions are checked together with the earlier mutation.
		`find ${tmp}/root -exec true \\; -fprint ${tmp}/out`,
		`find ${tmp}/root -delete -fprint ${tmp}/out`,
		// `-delete` as an -fprintf format is data, not a find action.
		`find ${tmp}/root -fprintf ${tmp}/out -delete`,
	];
	for (const cmd of allowed) assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, cmd);
	// find substitutes the runtime descendant for `{}`, not the root. A descendant symlink
	// can leave temp, so a mutating payload is unprovable even from an outside cwd.
	const touchPlaceholder = classifyBashCommand(`find ${tmp}/x -exec touch {} \\;`, "/workspace");
	assert.equal(touchPlaceholder.ok, false);
	assert.match(touchPlaceholder.reason, /descendant symlink/);
	// The hint must name a fix the classifier honors: -type predicates are never inspected.
	assert.doesNotMatch(touchPlaceholder.reason, /-type/);
	assert.equal(classifyBashCommand(`find ${tmp}/x -exec touch {} \\;`, tmp).ok, false);
	const execdirTouch = classifyBashCommand(`find ${tmp}/x -execdir touch {} \\;`, "/workspace");
	assert.equal(execdirTouch.ok, false);
	assert.match(execdirTouch.reason, /descendant symlink/);
	// A walked entry's -execdir runs in the found file's directory, so a relative target escapes
	// from the search root; command-line entries also run in the caller cwd (test below).
	const execdirEscape = classifyBashCommand(`find ${tmp}/review -type f -execdir touch ../../escape \\;`, `${tmp}/review/a/b/c`);
	assert.equal(execdirEscape.ok, false);
	assert.match(execdirEscape.reason, /touch blocked outside temp dir: \.\.\/\.\.\/escape$/);
	assert.equal(classifyBashCommand(`find ${tmp}/review -execdir touch out.txt \\;`, `${tmp}/review/a/b/c`).ok, true);
	// A shell spelling the raw scanner cannot bind is still a runtime substitution.
	assert.equal(classifyBashCommand(`find ${tmp}/x -exec touch \\{\\} \\;`, tmp).ok, false);
	// A non-placeholder payload target is still checked, and execdir's binding cannot prove
	// containment under symlink-following mode.
	assert.equal(classifyBashCommand(`find ${tmp}/x -exec rm /etc/y {} \\;`, "/workspace").ok, false);
	assert.equal(classifyBashCommand(`find -L ${tmp}/x -execdir rm {} \\;`, "/workspace").ok, false);
	// A bare `+` must not cut the payload, or the write after it is never classified.
	const afterBarePlus = classifyBashCommand(`find ${tmp}/x -exec rm + {} /etc/passwd \\;`, "/workspace");
	assert.equal(afterBarePlus.ok, false);
	// `+ {}` is not a terminator, so this action is unterminated and fails closed.
	assert.equal(classifyBashCommand(`find ${tmp}/x -exec rm + {}`, "/workspace").ok, false);
	assert.equal(classifyBashCommand(`find -L ${tmp}/x -exec rm + {} \\;`, "/workspace").ok, false);
	// The last write target names the block, never the safe search root.
	const laterPrint = classifyBashCommand(`find ${tmp}/root -exec true \\; -fprint /etc/review-out`, "/workspace");
	assert.equal(laterPrint.ok, false);
	assert.match(laterPrint.reason, /find blocked outside temp dir: \/etc\/review-out$/);
	const followPlaceholder = classifyBashCommand(`find -L ${tmp}/x -exec rm {} \\;`, "/workspace");
	assert.equal(followPlaceholder.ok, false);
	assert.match(followPlaceholder.reason, /-L\/-follow can substitute an outside pathname/);
	const followDelete = classifyBashCommand(`find -L ${tmp}/x -delete`, "/workspace");
	assert.equal(followDelete.ok, false);
	assert.match(followDelete.reason, /-L\/-follow can walk symlinks outside temp before -delete/);
	// The real search root is named, never the grouping operator token.
	const groupedOutside = classifyBashCommand(`find /etc \( -name '*.txt' \) -delete`, "/workspace");
	assert.equal(groupedOutside.ok, false);
	assert.match(groupedOutside.reason, /find blocked outside temp dir: \/etc$/);
});

// A symlink root is not a directory root: -execdir runs in the link's parent (GNU), the
// caller cwd (macOS/BSD), or the target (-H). Every candidate must be safe.
test("find -execdir checks a symlink search root in every runtime directory", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "readonly-find-link-"));
	try {
		const target = path.join(root, "target"), parent = path.join(root, "parent");
		await mkdir(target); await mkdir(parent);
		const link = path.join(parent, "link");
		await symlink(target, link, "dir");
		const outsideCwd = "/workspace";
		const escape = classifyBashCommand(`find ${quoteShellArgument(link)} -execdir touch ../escape \\;`, outsideCwd);
		assert.equal(escape.ok, false);
		assert.match(escape.reason!, /touch blocked outside temp dir: \.\.\/escape$/);
		// macOS runs the command-line symlink entry in the caller cwd, so a bare relative
		// target is outside temp even though the link's parent and target are inside.
		assert.equal(classifyBashCommand(`find ${quoteShellArgument(link)} -execdir touch marker \\;`, outsideCwd).ok, false);
		assert.equal(classifyBashCommand(`find ${quoteShellArgument(link)} -execdir touch ${quoteShellArgument(path.join(root, "ok"))} \\;`, outsideCwd).ok, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// BSD runs every command-line entry — directory or file — in the caller cwd, so a relative
// -execdir payload can write there even when the search root is inside temp. GNU runs such an
// entry in the entry's directory, so both candidates must be checked.
test("find -execdir checks the caller cwd for command-line search roots", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "readonly-find-cwd-"));
	try {
		const dir = path.join(root, "dir"), file = path.join(root, "file");
		await mkdir(dir); await writeFile(file, "data");
		for (const entry of [dir, file]) {
			const execdir = `find ${quoteShellArgument(entry)} -execdir touch marker \\;`;
			const okdir = `find ${quoteShellArgument(entry)} -okdir touch marker \\;`;
			for (const command of [execdir, okdir]) {
				const verdict = classifyBashCommand(command, "/workspace");
				assert.equal(verdict.ok, false, command);
				assert.match(verdict.reason!, /touch blocked outside temp dir: marker$/);
			}
			// A cwd inside temp makes every candidate runtime directory writable temp.
			assert.equal(classifyBashCommand(execdir, root).ok, true);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Shells expand positional parameters from argv after `-c` or from `set --`. Either source
// supplies the runtime command word, so the classifier cannot trace the write and fails closed.
test("shell -c positional parameters fail closed", () => {
	const blocked = [
		`bash -c '"$@"' 0 touch /etc/pwned`,
		`sh -c '"$1"' _ touch /etc/pwned`,
		`bash -c 'set -- touch /etc/pwned; "$@"'`,
		`bash -c 'echo "\${@}"' x y`,
	];
	for (const command of blocked) {
		const verdict = classifyBashCommand(command, "/workspace");
		assert.equal(verdict.ok, false, command);
		assert.match(verdict.reason!, /positional parameters supply the runtime command/, command);
	}
	const allowed = [
		`bash -c 'echo "$HOME"'`,
		`bash -c 'echo hi' name`,
		'bash -c "awk \'{print \\$1}\' file"',
	];
	for (const command of allowed) assert.equal(classifyBashCommand(command, "/workspace").ok, true, command);
});

// A backslash in a *quoted* assignment value is literal data (decodeShellAssignmentValue
// fails closed only for unquoted escapes). Unquoted `$VAR` usage must therefore not
// re-reject a backslash value as shell syntax — `\` is a Windows separator and a valid
// POSIX filename char. This pins the `\`-removal from decodeShellPathOperand's unquoted
// fail-closed regex; on the old regex the in-temp target below was blocked as unproven.
test("unquoted $VAR whose value holds a backslash decodes once and stays inside temp", () => {
	const tmp = shellPath(os.tmpdir());
	// The backslash sits in a subdirectory name under temp so the resolved path stays inside.
	const command = `D="${tmp}/sub\\\\dir"; touch $D/probe`;
	assert.equal(classifyBashCommand(command, "/workspace").ok, true, command);
});

test("a backslash suffix after $VAR is shell source and fails closed", () => {
	// Bash decodes `\/` to `/` in the literal suffix, but the classifier appends the suffix to
	// the assignment value verbatim. Accepting it would let `$D\/..\/..` escape temp while the
	// classified path stays inside. Both plain and braced-default spellings must fail closed.
	const tmp = shellPath(os.tmpdir());
	assert.equal(classifyBashCommand(`D=${JSON.stringify(tmp)}; touch $D\\/..\\/..\\/etc/passwd`, "/workspace").ok, false);
	assert.equal(classifyBashCommand(`touch \${N:-${JSON.stringify(tmp)}\\/..\\/..\\/etc/passwd}`, "/workspace").ok, false);
});

test("sed -i mutations block outside temp, allow inside temp, naming file operands", () => {
	const tmp = shellPath(os.tmpdir());
	// Contract: `sed -i` edits its file operands in place; the operand is the target. The backup
	// extension (`-i.bak`, `-i .bak`, `-i ""`) and expression forms (`-e`/`--expression`
	// before or after `-i`) must all resolve to the file operand.
	const blocked = [
		"sed -i 's/x/y/' /etc/passwd",
		"sed -i.bak 's/x/y/' /etc/passwd",
		// A suffix consumes exactly one operand, never the file operand itself.
		"sed -i.bak /etc/passwd",
		"sed -i .bak /etc/passwd",
		"sed -i .bak -e 's/x/y/' /etc/passwd",
		"sed -i \"\" /etc/passwd",
		"sed -i \"\" -e 's/x/y/' /etc/passwd",
		"sed -e 's/x/y/' -i /etc/passwd",
		"sed --expression 's/x/y/' -i /etc/passwd",
		"sed -i 's/x/y/' /etc/passwd 2>/dev/null",
		`sed -i 's/x/y/' /etc/passwd ${tmp}/ok`,
		// A dot-less first operand is a GNU script, not a dropped suffix: `sed -i 5d f` edits f.
		"sed -i 5d /etc/passwd",
		"sed -i d /etc/passwd",
	];
	for (const cmd of blocked) {
		const v = classifyBashCommand(cmd, "/workspace");
		assert.equal(v.ok, false, cmd);
		assert.match(v.reason, /sed blocked outside temp dir: \/etc\/passwd$/, cmd);
	}
	// With -e, GNU reads a dot-prefixed operand as an input file too. Keep the union of the
	// GNU and BSD readings instead of discarding it as a suffix.
	const gnuInput = classifyBashCommand("sed -i -e 's/x/y/' .outside /tmp/in", "/workspace");
	assert.equal(gnuInput.ok, false);
	assert.match(gnuInput.reason, /sed blocked outside temp dir: \.outside$/);
	// BSD would treat `.bak` as the suffix, but GNU edits it as a file, so the union blocks.
	const ambiguousSuffix = classifyBashCommand(`sed -i .bak -e 's/x/y/' ${tmp}/f`, "/workspace");
	assert.equal(ambiguousSuffix.ok, false);
	assert.match(ambiguousSuffix.reason, /sed blocked outside temp dir: \.bak$/);
	// No -i => sed is a stream filter (stdout), not an in-place mutation.
	assert.equal(classifyBashCommand("sed 's/x/y/' /etc/passwd", "/workspace").ok, true);
	// Inside temp: in-place edits are allowed even with a write redirect.
	assert.equal(classifyBashCommand(`sed -i 's/x/y/' ${tmp}/f > /dev/null`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`sed -i 5d ${tmp}/f`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`sed -i.bak 's/x/y/' ${tmp}/f`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`sed -i .bak 's/x/y/' ${tmp}/f`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`sed -i "" 's/x/y/' ${tmp}/f`, "/workspace").ok, true);
	// The ambiguity between a BSD suffix (`-i bak`) and a GNU script (`-i 5d`) resolves to the
	// GNU reading: the dot-less word stays a target, so the over-block is the safe direction.
	assert.equal(classifyBashCommand("sed -i bak s/a/b/ /tmp/ok", "/workspace").ok, false);
	// The redirect token must not replace the file operand in the reason.
	const redirected = classifyBashCommand("sed -i 's/x/y/' /etc/passwd 2>/dev/null", "/workspace");
	assert.equal(redirected.ok, false);
	assert.match(redirected.reason, /\/etc\/passwd$/);
	assert.doesNotMatch(redirected.reason, /2>\/dev\/null/);
});

test("bundled and long options cannot hide write targets", () => {
	const tmp = shellPath(os.tmpdir());
	const blocked = [
		"sed -Ei 's/x/y/' /etc/passwd",
		"sed --in-place 's/x/y/' /etc/passwd",
		"chmod -w /etc/passwd",
		// `--reference` consumes its value; the remaining operand is the write target.
		`chmod --reference ${tmp}/ref /etc/passwd`,
		// GNU permutes options, so --reference can follow the operand it would otherwise
		// expose as MODE; the earlier operand remains a write target.
		`chmod /etc/passwd --reference=${tmp}/ref`,
		`chmod /etc/passwd --reference ${tmp}/ref`,
		"unzip -oqd/outside a.zip",
		"find . -exec sh -c 'touch /etc/passwd' \\;",
		// The -exec family needs its terminator; missing/empty payloads fail closed.
		"find . -exec rm",
		"find . -ok rm",
		"find . -execdir rm",
		"find . -exec \\;",
		`rsync --backup-dir=/outside/bak src/ ${tmp}/dest`,
		`rsync --temp-dir=/outside/tmp src/ ${tmp}/dest`,
	];
	for (const cmd of blocked) assert.equal(classifyBashCommand(cmd, tmp).ok, false, cmd);
	// -P consumes a password before any other letters are read as flags. From an outside cwd
	// extraction targets that cwd, so a password full of read letters must not suppress the block.
	for (const cmd of ["unzip -Ppassword a.zip", "unzip -P password a.zip", "unzip -P -l a.zip", "unzip -qPplctv a.zip"]) {
		assert.equal(classifyBashCommand(cmd, "/workspace").ok, false, cmd);
	}
	const allowed = [
		`sed -Ei 's/x/y/' ${tmp}/f`,
		`sed --in-place 's/x/y/' ${tmp}/f`,
		`chmod -w ${tmp}/f`,
		// The reference operand is read, not written; only the target operand matters.
		`chmod --reference /etc/passwd ${tmp}/f`,
		`chmod --reference ${tmp}/ref ${tmp}/f`,
		`chmod ${tmp}/f --reference=${tmp}/ref`,
		`chmod ${tmp}/f --reference ${tmp}/ref`,
		// Extraction defaults to the cwd, which is inside temp here.
		"unzip a.zip",
		`unzip -oqd${tmp} a.zip`,
		`unzip -Ppassword a.zip -d ${tmp}`,
		`unzip -P password a.zip -d ${tmp}`,
		`find . -exec sh -c 'touch ${tmp}/x' \\;`,
		`rsync --backup-dir=${tmp}/bak src/ ${tmp}/dest`,
		`rsync --temp-dir=${tmp}/tmp src/ ${tmp}/dest`,
	];
	for (const cmd of allowed) assert.equal(classifyBashCommand(cmd, tmp).ok, true, cmd);
	const trailingReference = classifyBashCommand(`chmod /etc/passwd --reference=${tmp}/ref`, "/workspace");
	assert.equal(trailingReference.ok, false);
	assert.match(trailingReference.reason, /chmod blocked outside temp dir: \/etc\/passwd$/);

	// Read-mode flags suppress extraction, including inside a short bundle (`-lq`).
	for (const cmd of ["unzip -lq /outside/a.zip", "unzip -ql /outside/a.zip", "unzip -tq /outside/a.zip"]) {
		assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, cmd);
	}
	// Extraction into an outside cwd stays blocked.
	assert.equal(classifyBashCommand("unzip -q a.zip", "/workspace").ok, false);
	// Info-ZIP `-` negates the next letter: `-o-t` extracts with overwrite, so a negated
	// read spelling is extraction, not a read. Decide only after the complete argument list.
	for (const flag of ["-o-t", "-o-l", "-o-v", "-o-p", "-o-c"]) {
		assert.equal(classifyBashCommand(`unzip ${flag} /outside/a.zip`, "/workspace").ok, false, flag);
		assert.equal(classifyBashCommand(`unzip ${flag} a.zip`, tmp).ok, true, flag);
	}
	assert.equal(classifyBashCommand("unzip -o-t -d /outside a.zip", "/workspace").ok, false);
	assert.equal(classifyBashCommand("unzip -t -d /outside -o-t a.zip", "/workspace").ok, false);
	assert.equal(classifyBashCommand(`unzip -o-t -d${tmp} a.zip`, "/workspace").ok, true);
	assert.equal(classifyBashCommand("unzip -l -d /outside a.zip", "/workspace").ok, true);
	assert.equal(classifyBashCommand("unzip -t -o-q /outside/a.zip", "/workspace").ok, true);
	assert.equal(classifyBashCommand("unzip -t- /outside/a.zip", "/workspace").ok, true);
	// A negated value letter cannot be modeled, so it fails closed.
	assert.equal(classifyBashCommand("unzip -o-d/outside a.zip", "/workspace").ok, false);
	assert.equal(classifyBashCommand("unzip -o-Psecret a.zip", "/workspace").ok, false);

	// An attached -d keeps its raw quoting: single quotes and escapes make `$D` literal, so the
	// destination is the cwd-relative `$D`, not a temp path. Only double quotes expand it.
	const literalDestinations = [
		`D=${tmp}/safe unzip -d'$D' a.zip`,
		`D=${tmp}/safe unzip -d\\$D a.zip`,
		`D=${tmp}/safe unzip -oqd'$D' a.zip`,
		`D=/outside; unzip -d"$D" a.zip`,
	];
	for (const cmd of literalDestinations) assert.equal(classifyBashCommand(cmd, "/workspace").ok, false, cmd);
	assert.equal(classifyBashCommand(`D=${tmp}/safe; unzip -d"$D" a.zip`, "/workspace").ok, true);
});

test("GNU long-option abbreviations and bundled -T cannot hide sed/rsync writes", () => {
	const tmp = shellPath(os.tmpdir());
	// Contract: GNU tools resolve unique long-option prefixes (getopt_long/popt), and rsync
	// accepts `-T` inside a short bundle, so every equivalent spelling must reach the same
	// write target. The canonical spellings are covered above; this pins the aliases.
	const blocked = [
		`rsync --temp-d=/outside/bak src/ ${tmp}/dest`,
		`rsync --backup-d=/outside/bak src/ ${tmp}/dest`,
		`rsync --partial-d=/outside/partial src/ ${tmp}/dest`,
		`rsync --log-f=/outside/log src/ ${tmp}/dest`,
		`rsync --write-b=/outside/batch src/ ${tmp}/dest`,
		`rsync --only-write-b=/outside/batch src/ ${tmp}/dest`,
		`rsync --temp-d /outside/bak src/ ${tmp}/dest`,
		`rsync -aT/outside src/ ${tmp}/dest`,
		`rsync -aT /outside src/ ${tmp}/dest`,
		`rsync --b src/ ${tmp}/dest`, // ambiguous in rsync's option set: fail closed
		"sed --in-pl 's/x/y/' /etc/passwd",
		"sed --in-p=.bak 's/x/y/' /etc/passwd",
		"sed --i 's/x/y/' /etc/passwd",
		"sed -i --expr='s/x/y/' /etc/passwd",
		"sed -i --fil=/tmp/s /etc/passwd",
	];
	for (const cmd of blocked) assert.equal(classifyBashCommand(cmd, tmp).ok, false, cmd);
	for (const cmd of ["sed -i --expr='s/x/y/' /etc/passwd", "sed -i --fil=/tmp/s /etc/passwd"]) {
		const verdict = classifyBashCommand(cmd, tmp);
		assert.equal(verdict.ok, false, cmd);
		assert.match(verdict.reason, /sed blocked outside temp dir: \/etc\/passwd$/, cmd);
	}
	const allowed = [
		`rsync --temp-d=${tmp}/tmp src/ ${tmp}/dest`,
		`rsync --backup-d=${tmp}/bak src/ ${tmp}/dest`,
		`rsync -aT${tmp} src/ ${tmp}/dest`,
		// Exact non-write options that prefix a write option must not consume `src/`.
		`rsync --backup src/ ${tmp}/dest`,
		`rsync --partial src/ ${tmp}/dest`,
		// `T` belongs to the `-e` value here, so it is not --temp-dir.
		`rsync -eT/outside src/ ${tmp}/dest`,
		`sed --in-pl 's/x/y/' ${tmp}/f`,
		`sed --i 's/x/y/' ${tmp}/f`,
		`sed -i --expr='s/x/y/' ${tmp}/f`,
		`sed -i --fil=/tmp/s ${tmp}/f`,
	];
	for (const cmd of allowed) assert.equal(classifyBashCommand(cmd, tmp).ok, true, cmd);
});

test("rsync option values cannot hide the destination and relative writes resolve under it", () => {
	const tmp = shellPath(os.tmpdir());
	// Contract: popt consumes every option value before positionals are read, so a value
	// after the destination cannot stand in for it. Two passes let an outside destination
	// pass when a later write option takes its value from the next word.
	const hiddenDest = classifyBashCommand(`rsync -a ${tmp}/src/ /outside/dest/ --backup-dir ${tmp}/bak`, "/workspace");
	assert.equal(hiddenDest.ok, false);
	assert.match(hiddenDest.reason, /rsync blocked outside temp dir: \/outside\/dest\/$/);
	const hiddenByExclude = classifyBashCommand(`rsync -a ${tmp}/src/ /outside/dest --exclude ${tmp}/dest`, "/workspace");
	assert.equal(hiddenByExclude.ok, false);
	assert.match(hiddenByExclude.reason, /rsync blocked outside temp dir: \/outside\/dest$/);
	for (const cmd of [
		`rsync -a ${tmp}/src/ /outside/dest --files-from ${tmp}/list`,
		`rsync -a ${tmp}/src/ /outside/dest -B ${tmp}/size`,
		`rsync -a ${tmp}/src/ /outside/dest -@ 5`,
		`rsync -a ${tmp}/src/ /outside/dest -@5`,
	]) assert.equal(classifyBashCommand(cmd, "/workspace").ok, false, cmd);
	// The same values with an in-temp destination stay allowed.
	assert.equal(classifyBashCommand(`rsync -a ${tmp}/src/ ${tmp}/dest --exclude ${tmp}/skip`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`rsync -a ${tmp}/src/ ${tmp}/dest -@ 5`, "/workspace").ok, true);
	// rsync resolves these write options against the destination, not the caller cwd.
	const cwd = `${tmp}/review/a/b/c`;
	for (const option of ["--backup-dir", "--temp-dir", "--partial-dir"]) {
		const verdict = classifyBashCommand(`rsync -a ${option}=../../../escape ${tmp}/src/ ${tmp}/dest/`, cwd);
		assert.equal(verdict.ok, false, option);
		assert.match(verdict.reason, /rsync blocked outside temp dir: \.\.\/\.\.\/\.\.\/escape$/, option);
	}
	assert.equal(classifyBashCommand(`rsync -a --backup-dir=../bak ${tmp}/src/ ${tmp}/dest/`, cwd).ok, true);
	// --log-file stays a caller-cwd file: the same relative escape is still inside temp.
	assert.equal(classifyBashCommand(`rsync -a --log-file=../../../log ${tmp}/src/ ${tmp}/dest/`, cwd).ok, true);
	// Without a destination the relative write target cannot be bounded.
	assert.equal(classifyBashCommand(`rsync -a --backup-dir=../../escape ${tmp}/src/`, cwd).ok, false);
});

test("rsync batch replay checks its single destination", () => {
	const tmp = shellPath(os.tmpdir());
	const batch = `${tmp}/payload.batch`;
	// A replay has no source operand: one positional is the destination, and an absent
	// destination means the caller's cwd. Every spelling reaches the same write root.
	for (const cmd of [
		`rsync -a --read-batch ${batch} /outside/dest/`,
		`rsync -a --read-batch=${batch} /outside/dest/`,
		`rsync -a --read-b=${batch} /outside/dest/`,
		`rsync -a --read-ba=${batch} /outside/dest/`,
	]) {
		const verdict = classifyBashCommand(cmd, "/workspace");
		assert.equal(verdict.ok, false, cmd);
		assert.match(verdict.reason, /rsync blocked outside temp dir: \/outside\/dest\/$/, cmd);
	}
	assert.equal(classifyBashCommand(`rsync -a --read-batch ${batch}`, "/workspace").ok, false);
	for (const cmd of [
		`rsync -a --read-batch ${batch} ${tmp}/dest/`,
		`rsync -a --read-batch=${batch} ${tmp}/dest/`,
		`rsync -a --read-b=${batch} ${tmp}/dest/`,
	]) assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, cmd);
	assert.equal(classifyBashCommand(`rsync -a --read-batch ${batch}`, tmp).ok, true);
	// Write options still resolve against the replay destination.
	const cwd = `${tmp}/review/a/b/c`;
	const relative = classifyBashCommand(`rsync -a --read-batch=${batch} --backup-dir=../../../escape ${tmp}/dest/`, cwd);
	assert.equal(relative.ok, false);
	assert.match(relative.reason, /rsync blocked outside temp dir: \.\.\/\.\.\/\.\.\/escape$/);
});

test("-- ends option parsing and find '+' terminates only after {}", () => {
	const tmp = shellPath(os.tmpdir());
	// CONTRACT: after `--`, option-looking words are operands, so they neither select a
	// write mode nor consume a value. find's `+` terminator needs a preceding exact `{}`.
	const blocked = [
		"chmod -w -- /etc/passwd",
		"sed -Ei 's/x/y/' -- /etc/passwd",
		`rsync --temp-dir=/outside src/ ${tmp}/dest`,
		"unzip -d /outside a.zip",
		`find ${tmp} -exec touch + /outside/pwned \\;`,
	];
	for (const command of blocked) assert.equal(classifyBashCommand(command, tmp).ok, false, command);
	const allowed = [
		`chmod -w -- ${tmp}/f`,
		`chmod -- -w ${tmp}/f`,
		`sed -i -- ${tmp}/f`,
		"sed -- -e 's/x/y/' -i /etc/passwd",
		`rsync -- --temp-dir=/outside src/ ${tmp}/dest`,
		"unzip -- -d /outside a.zip",
		`find ${tmp} -exec echo {} +`,
	];
	for (const command of allowed) assert.equal(classifyBashCommand(command, tmp).ok, true, command);
});

test("perl/ruby -i in-place edits block outside temp, allow inside temp, naming the file", () => {
	const tmp = shellPath(os.tmpdir());
	// Contract: `-i` enables in-place file mutation; the edited file is the target. Without -i,
	// perl/ruby only print to stdout (handled by the interpreter inline-exec path, not here).
	const blocked = [
		"perl -i /etc/passwd",
		"ruby -i /etc/passwd",
		"perl -i.bak /etc/passwd",
		"ruby -i.bak /etc/passwd",
	];
	for (const cmd of blocked) {
		const v = classifyBashCommand(cmd, "/workspace");
		const subject = cmd.split(" ")[0];
		assert.equal(v.ok, false, cmd);
		assert.match(v.reason, new RegExp(`${subject} blocked outside temp dir: /etc/passwd$`), cmd);
	}
	// Inside temp: in-place edits stay allowed.
	for (const cmd of [`perl -i ${tmp}/f`, `ruby -i ${tmp}/f`]) {
		assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, cmd);
	}
	// The realistic -pe form is also blocked — but its reason is misreported (see next test).
	for (const cmd of ["perl -i -pe 's/x/y/' /etc/passwd", "ruby -i -pe 's/x/y/' /etc/passwd"]) {
		assert.equal(classifyBashCommand(cmd, "/workspace").ok, false, cmd);
	}
});

// BUG: getPerlRubyTargets uses nonOptionArgs, which does not consume the -e/-pe
// program argument, so the inline program (`s/x/y/`) leaks as the reported
// "target" instead of the edited file. That misreports the reason for
// The -e/-pe program argument is now stripped by getPerlRubyTargets, so the
// reason names the real file target and in-temp edits are allowed.
test("perl/ruby -i -pe inline edits name the edited file in the reason", () => {
	const tmp = shellPath(os.tmpdir());
	for (const cmd of ["perl", "ruby"]) {
		const outside = classifyBashCommand(`${cmd} -i -pe 's/x/y/' /etc/passwd`, "/workspace");
		assert.equal(outside.ok, false, `${cmd} -pe outside`);
		assert.match(outside.reason, new RegExp(`${cmd} blocked outside temp dir: /etc/passwd$`), `${cmd} -pe reason`);
		assert.equal(classifyBashCommand(`${cmd} -i -pe 's/x/y/' ${tmp}/f`, "/workspace").ok, true, `${cmd} -pe temp`);
	}
});

test("sed expression variants and read-only find stay on the right side of the line", () => {
	const tmp = shellPath(os.tmpdir());
	// filterSedExpressionTokens must also strip concatenated (-es/x/y/) and attached
	// (--expression=...) -e forms, so only the file operand is checked against temp.
	for (const cmd of ["sed -es/x/y/ -i /etc/passwd", "sed --expression='s/x/y/' -i /etc/passwd"]) {
		const v = classifyBashCommand(cmd, "/workspace");
		assert.equal(v.ok, false, cmd);
		assert.match(v.reason, /sed blocked outside temp dir: \/etc\/passwd$/, cmd);
	}
	assert.equal(classifyBashCommand(`sed -es/x/y/ -i ${tmp}/f`, "/workspace").ok, true);
	// find without a mutating action (no -delete/-exec/-fprint*) is not a mutation.
	assert.equal(classifyBashCommand("find /etc -name '*.txt' -print", "/workspace").ok, true);
});

test("terminal and fd redirect targets are inert, real files are not", () => {
	// Writing to a terminal/descriptor emits to an existing stream, not a new file.
	assert.equal(classifyBashCommand("echo x > /etc/passwd", "/workspace").ok, false, "outside write still blocks");
	for (const target of ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/1"]) {
		assert.equal(classifyBashCommand(`echo x > ${target}`, "/workspace").ok, true, target);
	}
});

test("backslash inside single quotes is literal, not escape", () => {
	const tmp = shellPath(os.tmpdir());

	// Backslash inside single quotes should not escape the closing quote.
	// Old bug: \' was treated as escape sequence, so the quote wasn't closed,
	// and the > was incorrectly treated as inside the quote (not a redirect).
	// New behavior: \ is literal inside single quotes, quote closes, > is a redirect.
	const cmd = `echo 'a\\' > ${tmp}/file`;
	const v = classifyBashCommand(cmd, "/workspace");
	assert.equal(v.ok, true, "redirect after single-quoted backslash should be recognized");

	// Verify the redirect is actually checked (redirect to outside should fail)
	const cmd2 = `echo 'a\\' > /etc/file`;
	const v2 = classifyBashCommand(cmd2, "/workspace");
	assert.equal(v2.ok, false, "redirect should still be checked");
	assert.match(v2.reason, /blocked outside temp/, "should block redirect outside temp");

	// Backslash before > inside single quotes should not make it a redirect
	const cmd3 = `echo 'a\\>' > ${shellPath(os.tmpdir())}/file`;
	const v3 = classifyBashCommand(cmd3, "/workspace");
	assert.equal(v3.ok, true, "> inside single quotes should not be a redirect");
});

// rejoinValueTokens contract: a quoted value split across tokens (here by an operator
// char) must rejoin before decoding, so the whole value is what gets path-checked —
// not its truncated first fragment.
test("quoted assignment value split by an operator token rejoins before decoding", () => {
	const tmp = shellPath(os.tmpdir());
	const verdict = classifyBashCommand(`D="${tmp}/a > b"; touch "$D"`, "/workspace");
	assert.equal(verdict.ok, true, "whole in-temp value must decode and pass");
});

test("nested command substitution reports its block prefix once", () => {
	const verdict = classifyBashCommand("echo $(echo $(touch /etc/passwd))", "/workspace");
	assert.equal(verdict.ok, false);
	const occurrences = verdict.reason.split("command substitution blocked").length - 1;
	assert.equal(occurrences, 1, verdict.reason);
});
