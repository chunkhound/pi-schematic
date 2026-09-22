import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerReadonlyPI, makeReadonlyUICtx } from "./helpers.js";
import type { ToolCall } from "./helpers.js";
import type { TestPI } from "./test-host.js";

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

// ── Behavioral contract tests (via tool_call hook — real code path) ──

test("blocks bash writes outside temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = path.join(os.homedir(), "readonly-test-file");

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
	const tmp = os.tmpdir();

	// CONTRACT: temp dir writes are allowed.
	await assertAllowed(toolCall, `echo ok > ${tmp}/readonly-test.txt`);
	await assertAllowed(toolCall, `rm ${tmp}/readonly-test.txt`);
});

test("blocks command substitutions that write outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = path.join(os.homedir(), "readonly-test-file");

	// CONTRACT: evasion via command substitution is caught.
	await assertBlocked(toolCall, `touch $(echo ${outsideTemp})`);
});

test("blocks write redirects outside temp dir", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outsideTemp = path.join(os.homedir(), "readonly-test-file");

	// CONTRACT: write redirects to non-temp paths are blocked.
	await assertBlocked(toolCall, `echo hello > ${outsideTemp}`);
});

test("blocks package managers unconditionally", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);

	// CONTRACT: package managers blocked regardless of target path.
	await assertBlocked(toolCall, "npm install lodash");
	await assertBlocked(toolCall, "pip install requests");
	await assertBlocked(toolCall, "yarn add lodash");
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
	const tmp = os.tmpdir();

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
	const outside = path.join(os.homedir(), "readonly-test-file");

	await assertBlocked(toolCall, `echo a && touch ${outside}`);
	await assertBlocked(toolCall, `ls; rm -f ${outside}`);
	await assertBlocked(toolCall, `echo ok || touch ${outside}`);
});

test("allows chained commands that only read or write to temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();

	await assertAllowed(toolCall, "echo a && ls");
	await assertAllowed(toolCall, `echo a > ${tmp}/x && cat ${tmp}/x`);
});

test("blocks heredoc redirects outside temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const outside = path.join(os.homedir(), "readonly-test-file");

	await assertBlocked(toolCall, `cat <<'EOF' > ${outside}\nhello\nEOF`);
});

test("blocks dd of= outside temp and allows it in temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();
	const outside = path.join(os.homedir(), "readonly-test-file");

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
	await assertBlocked(toolCall, "rm -f *", os.homedir());
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
	const outside = path.join(os.homedir(), "readonly-test-file");
	await assertBlocked(toolCall, `echo $(touch ${outside})`);
	await assertBlocked(toolCall, `echo $(rm /etc/passwd)`);
});

test("blocks wget download-dir writes outside temp and allows them in temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();
	await assertBlocked(toolCall, "wget -P /workspace https://example.com/file.txt");
	await assertBlocked(toolCall, "wget --directory-prefix=/workspace https://example.com/file.txt");
	await assertAllowed(toolCall, `wget -P ${tmp} https://example.com/file.txt`);
});

test("blocks mixed curl output modes outside temp and allows them in temp", async () => {
	const { pi, toolCall } = await registerReadonlyPI();
	await enableReadonly(pi);
	const tmp = os.tmpdir();
	const tmpOutput = path.join(tmp, "out.txt");
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
