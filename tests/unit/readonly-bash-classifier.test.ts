import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { registerReadonlyPI, makeReadonlyUICtx, shellPath } from "./helpers.js";
import type { ToolCall } from "./helpers.js";
import type { TestPI } from "./test-host.js";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
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
	await assertBlocked(toolCall, "python -c 'touch /etc/test'");
	await assertBlocked(toolCall, "perl -e 'rm /etc/passwd'");
	await assertBlocked(toolCall, "ruby -e 'touch /etc/test'");
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
	];
	for (const cmd of blocked) assert.equal(classifyBashCommand(cmd, "/workspace").ok, false, cmd);
	// The reason must surface the real target path — never the -delete/-exec flag or the exec'd command.
	const del = classifyBashCommand("find /etc -delete", "/workspace");
	assert.equal(del.ok, false); assert.match(del.reason, /find blocked outside temp dir: \/etc$/);
	const exe = classifyBashCommand("find /etc -exec rm {} \\;", "/workspace");
	assert.equal(exe.ok, false); assert.match(exe.reason, /find blocked outside temp dir: \/etc$/);
	const fpr = classifyBashCommand("find /etc -fprint /var/log/find.out", "/workspace");
	assert.equal(fpr.ok, false); assert.match(fpr.reason, /find blocked outside temp dir: \/var\/log\/find\.out$/);
	const fls = classifyBashCommand("find /etc -fls /var/log/find.lst", "/workspace");
	assert.equal(fls.ok, false); assert.match(fls.reason, /find blocked outside temp dir: \/var\/log\/find\.lst$/);
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
	];
	for (const cmd of allowed) assert.equal(classifyBashCommand(cmd, "/workspace").ok, true, cmd);
	// The real search root is named, never the grouping operator token.
	const groupedOutside = classifyBashCommand(`find /etc \( -name '*.txt' \) -delete`, "/workspace");
	assert.equal(groupedOutside.ok, false);
	assert.match(groupedOutside.reason, /find blocked outside temp dir: \/etc$/);
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
	// extension (`-i.bak`) and expression forms (`-e`/`--expression` before or after `-i`)
	// must all resolve to the file operand.
	const blocked = [
		"sed -i 's/x/y/' /etc/passwd",
		"sed -i.bak 's/x/y/' /etc/passwd",
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
	// No -i => sed is a stream filter (stdout), not an in-place mutation.
	assert.equal(classifyBashCommand("sed 's/x/y/' /etc/passwd", "/workspace").ok, true);
	// Inside temp: in-place edits are allowed even with a write redirect.
	assert.equal(classifyBashCommand(`sed -i 's/x/y/' ${tmp}/f > /dev/null`, "/workspace").ok, true);
	assert.equal(classifyBashCommand(`sed -i 5d ${tmp}/f`, "/workspace").ok, true);
	// The ambiguity between a BSD suffix (`-i bak`) and a GNU script (`-i 5d`) resolves to the
	// GNU reading: the dot-less word stays a target, so the over-block is the safe direction.
	assert.equal(classifyBashCommand("sed -i bak s/a/b/ /tmp/ok", "/workspace").ok, false);
	// The redirect token must not replace the file operand in the reason.
	const redirected = classifyBashCommand("sed -i 's/x/y/' /etc/passwd 2>/dev/null", "/workspace");
	assert.equal(redirected.ok, false);
	assert.match(redirected.reason, /\/etc\/passwd$/);
	assert.doesNotMatch(redirected.reason, /2>\/dev\/null/);
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
