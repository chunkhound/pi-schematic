import { expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";

// Rows call the classifier directly with cwd /workspace unless the row names another. Block rows
// assert the reason, so a row cannot pass through a different block path.

type Verdict = ReturnType<typeof classifyBashCommand>;

const ALLOW: Verdict = { ok: true };

function block(reason: string): Verdict {
	return { ok: false, reason };
}

const tmp = os.tmpdir();
const outside = path.join(os.homedir(), "readonly-test-file");

/** `command` wrapped in `levels` nested `$(echo …)` command substitutions. */
function nestedInEcho(command: string, levels: number): string {
	return Array.from({ length: levels }).reduce<string>((inner) => `echo $(${inner})`, command);
}

// ── Behavioral contract ───────────────────────────────────────────

test.each([
	[`touch ${outside}`, block(`touch blocked outside temp dir: ${outside}`)],
	[`rm -f ${outside}`, block(`rm blocked outside temp dir: ${outside}`)],
	[`echo "test" > ${outside}`, block(`write redirect blocked outside temp dir: ${outside}`)],
])("blocks bash writes outside temp dir: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["ls -la", "echo hello", "git status", "git log --oneline", "git stash list"])("allows bash reads and non-mutating commands: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([`echo ok > ${tmp}/readonly-test.txt`, `rm ${tmp}/readonly-test.txt`])("allows bash writes to temp dir: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([[`touch $(echo ${outside})`, block("touch blocked outside temp dir: $(echo")]])(
	"blocks command substitutions that write outside temp: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

test.each([
	["npm install lodash", block("npm install lodash is blocked in readonly mode")],
	["pip install requests", block("pip install requests is blocked in readonly mode")],
	["yarn add lodash", block("yarn add lodash is blocked in readonly mode")],
])("blocks package manager mutation verbs regardless of target: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

// Shells the classifier cannot parse are blocked by basename, case-insensitively, including full
// Windows paths.
test.each([
	['pwsh -c "rm /workspace/x"', "pwsh"],
	['powershell.exe -Command "Set-Content -Path notes.txt -Value x"', "powershell.exe"],
	["cmd /c del x", "cmd"],
	["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-ChildItem", "powershell.exe"],
	["PWSH -c x", "pwsh"],
	["pwsh.exe -c x", "pwsh.exe"],
	["powershell -Command x", "powershell"],
	["/usr/bin/pwsh -c x", "pwsh"],
	["env pwsh -c x", "pwsh"],
	["exec pwsh -c x", "pwsh"],
	["command pwsh -c x", "pwsh"],
	["FOO=1 pwsh -c x", "pwsh"],
	["echo x | pwsh -c -", "pwsh"],
])("blocks PowerShell and cmd launched through bash unconditionally: %s", (command, shell) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(block(`${shell} blocked: readonly cannot inspect commands run through ${shell}`));
});

test.each([
	['bash -c "pwsh -c Remove-Item x"', block("bash -c blocked: pwsh blocked: readonly cannot inspect commands run through pwsh")],
	["ls && pwsh -c x", block("pwsh blocked: readonly cannot inspect commands run through pwsh")],
])("blocks PowerShell nested in bash -c or chained after a read: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([["cmd.exe /c dir", block("cmd.exe blocked: readonly cannot inspect commands run through cmd.exe")]])(
	"names the blocked shell in the block reason: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

test.each(["echo pwsh", "which pwsh"])("allows read commands that mention pwsh only as an argument: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each(["git add .", "git commit -m 'msg'"])("blocks staging and committing git commands: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(block("mutable git command blocked outside temp dir"));
});

test.each([
	["curl -O https://example.com/file.txt", "/workspace", block("curl blocked outside temp dir: current directory (use -o /tmp/... to write to temp)")],
	["curl -O https://example.com/file.txt", tmp, ALLOW],
	["wget https://example.com/file.txt", "/workspace", block("wget blocked outside temp dir: .")],
])("blocks cwd-relative downloads outside temp but allows inside temp: %s in %s", (command, cwd, expected) => {
	expect(classifyBashCommand(command, cwd)).toStrictEqual(expected);
});

test.each(["git reflog", "git branch -l", "git config -l"])("allows readonly-safe git inspection subcommands: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each(["cat /etc/hosts | grep localhost", "ls -la | head -5", "git log | grep commit"])("allows piped read commands: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([
	[`echo a && touch ${outside}`, block(`touch blocked outside temp dir: ${outside}`)],
	[`ls; rm -f ${outside}`, block(`rm blocked outside temp dir: ${outside}`)],
	[`echo ok || touch ${outside}`, block(`touch blocked outside temp dir: ${outside}`)],
])("blocks chained commands that write outside temp: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["echo a && ls", `echo a > ${tmp}/x && cat ${tmp}/x`])("allows chained commands that only read or write to temp: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([[`cat <<'EOF' > ${outside}\nhello\nEOF`, block(`write redirect blocked outside temp dir: ${outside}`)]])(
	"blocks heredoc redirects outside temp: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

test.each([
	[`dd if=/dev/zero of=${outside} bs=1 count=1`, block(`dd output blocked outside temp dir: ${outside}`)],
	[`dd if=/dev/zero of=${tmp}/dd-test bs=1 count=1`, ALLOW],
])("blocks dd of= outside temp and allows it in temp: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["rm -f *"])("allows hidden-file globs inside temp dir: %s", async (command) => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "readonly-hidden-allow-"));
	try {
		await writeFile(path.join(cwd, ".secret"), "ok");
		expect(classifyBashCommand(command, cwd)).toStrictEqual(ALLOW);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

// The home directory already holds hidden files (.gitconfig, .ssh and so on) and is outside the
// temp dir, so the glob matches without any filesystem writes.
test.each([["rm -f *", block("rm blocked outside temp dir: *")]])("blocks hidden-file globs outside temp dir: %s", (command, expected) => {
	expect(classifyBashCommand(command, os.homedir())).toStrictEqual(expected);
});

// ── Wrappers, interpreters and substitutions ──────────────────────

test.each([
	["sudo rm /etc/passwd", block("rm blocked outside temp dir: /etc/passwd")],
	["sudo -u root touch /etc/test", block("touch blocked outside temp dir: /etc/test")],
	["sudo -h localhost rm /etc/test", block("rm blocked outside temp dir: /etc/test")],
])("blocks sudo commands that write outside temp: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["sudo ls /etc", "sudo cat /etc/hosts"])("allows sudo commands that only read: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([
	['env -S "rm -rf /"', block("rm blocked outside temp dir: /")],
	["env -S 'touch /etc/test'", block("touch blocked outside temp dir: /etc/test")],
])("blocks env -S with mutation command: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["env -S 'ls /etc'", "env VAR=value ls /tmp"])("allows env with read commands: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([
	["eval 'rm /etc/passwd'", block("rm blocked outside temp dir: /etc/passwd")],
	["exec touch /etc/test", block("touch blocked outside temp dir: /etc/test")],
])("blocks eval and exec wrappers with mutation: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["node -e 'rm /etc/passwd'", block("node -e blocked: rm blocked outside temp dir: /etc/passwd")],
	["python -c 'touch /etc/test'", block("python -c blocked: touch blocked outside temp dir: /etc/test")],
	["perl -e 'rm /etc/passwd'", block("perl -e blocked: rm blocked outside temp dir: /etc/passwd")],
	["ruby -e 'touch /etc/test'", block("ruby -e blocked: touch blocked outside temp dir: /etc/test")],
])("blocks interpreter inline execution that shells out to mutation commands: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([["cat <(rm /etc/passwd)", block("command substitution blocked: rm blocked outside temp dir: /etc/passwd")]])(
	"blocks process substitution with mutation: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

test.each([["echo /etc/test | xargs rm", block("xargs rm blocked: mutation command via xargs")]])(
	"blocks xargs with mutation command: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

test.each(["echo /tmp/test | xargs ls"])("allows xargs with read commands: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each(["printf '/etc/passwd\n' | xargs -I {} rm {} ", "printf '/etc/passwd\0' | xargs -0 rm", "printf '/etc/passwd\n' | xargs -n 1 rm"])(
	"blocks xargs flag variants with mutation commands: %s",
	(command) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(block("xargs rm blocked: mutation command via xargs"));
	},
);

test.each(["git branch new-branch", "git checkout -b new-branch"])("blocks git branch creation: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(block("mutable git command blocked outside temp dir"));
});

test.each(["git tag v1.0.0", "git tag -a v1.0.0 -m 'release'"])("blocks git tag creation: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(block("mutable git command blocked outside temp dir"));
});

test.each([[`echo $(touch ${outside})`, block(`command substitution blocked: touch blocked outside temp dir: ${outside}`)]])(
	"blocks command substitution with nested mutation: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

test.each([
	["wget -P /workspace https://example.com/file.txt", block("wget download dir blocked outside temp dir: /workspace")],
	["wget --directory-prefix=/workspace https://example.com/file.txt", block("wget download dir blocked outside temp dir: /workspace")],
	[`wget -P ${tmp} https://example.com/file.txt`, ALLOW],
])("blocks wget download-dir writes outside temp and allows them in temp: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	[
		`curl -o ${path.join(tmp, "out.txt")} -O https://example.com/file.txt`,
		"/workspace",
		block("curl blocked outside temp dir: current directory (use -o /tmp/... to write to temp)"),
	],
	[`curl -o ${path.join(tmp, "out.txt")} -O https://example.com/file.txt`, tmp, ALLOW],
])("blocks mixed curl output modes outside temp and allows them in temp: %s in %s", (command, cwd, expected) => {
	expect(classifyBashCommand(command, cwd)).toStrictEqual(expected);
});

test.each(["curl -o /etc/x https://example.com/file.txt"])("blocks curl output files outside temp dir: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(block("curl blocked outside temp dir: /etc/x"));
});

// ── Subshell and nested-wrapper edge cases ────────────────────────

test.each([["((rm /etc/passwd))", block("rm blocked outside temp dir: /etc/passwd")]])("blocks double-parenthesized mutation: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["((echo hello))"])("allows double-parenthesized read command: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([["sudo env xargs rm /etc/passwd", block("rm blocked outside temp dir: /etc/passwd")]])(
	"blocks nested wrapper sudo+env+xargs: %s",
	(command, expected) => {
		expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
	},
);

// ── Mutation targets per command ──────────────────────────────────

test.each([
	["truncate -s 0 /etc/x", block("truncate blocked outside temp dir: /etc/x")],
	[`truncate -s 0 ${tmp}/x`, ALLOW],
])("classifies truncate targets: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["chmod 644 /etc/x", block("chmod blocked outside temp dir: /etc/x")],
	["chown user /etc/x", block("chown blocked outside temp dir: /etc/x")],
	["chgrp staff /etc/x", block("chgrp blocked outside temp dir: /etc/x")],
	[`chmod 644 ${tmp}/x`, ALLOW],
])("classifies chmod, chown and chgrp targets after the mode or owner: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["cp a /etc/x", block("cp blocked outside temp dir: /etc/x")],
	["mv a /etc/x", block("mv blocked outside temp dir: /etc/x")],
	["install a /etc/x", block("install blocked outside temp dir: /etc/x")],
	["ln -s a /etc/x", block("ln blocked outside temp dir: /etc/x")],
	[`cp /etc/hosts ${tmp}/x`, ALLOW],
])("classifies cp, mv, install and ln by their destination: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["echo x | tee /etc/x", block("tee blocked outside temp dir: /etc/x")],
	[`echo x | tee ${tmp}/x`, ALLOW],
])("classifies tee targets: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["sed -i 's/a/b/' /etc/x", block("sed blocked outside temp dir: /etc/x")],
	["sed -i '' 's/a/b/' /etc/x", block("sed blocked outside temp dir: /etc/x")],
	[`sed -i 's/a/b/' ${tmp}/x`, ALLOW],
	["sed 's/a/b/' /etc/x", ALLOW],
])("classifies sed -i targets without the expression or backup suffix: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

// The block rows check only the verdict: the classifier passes the script as a target, so the
// reason names the script rather than the file.
test.each([
	["perl -pi -e 's/a/b/' /etc/x", false],
	["ruby -i -pe 'x' /etc/x", false],
	["perl -ne 'print' /etc/x", true],
])("classifies perl and ruby as mutations only with an in-place flag: %s", (command, ok) => {
	expect(classifyBashCommand(command, "/workspace")).toMatchObject({ ok });
});

test.each([
	["find /etc -delete", block("find blocked outside temp dir: /etc")],
	["find /etc -exec rm {} \\;", block("find blocked outside temp dir: /etc")],
	[`find ${tmp} -fprint /etc/x`, block("find blocked outside temp dir: /etc/x")],
	[`find ${tmp} -fprint ~/x`, block("find blocked outside temp dir: ~/x")],
	["find /etc -name '*.ts'", ALLOW],
])("classifies find by its mutating actions: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

// The root is relative to a temp working directory: an absolute temp root containing `~`, as
// Windows 8.3 short paths do, is not read as a root.
test("allows find -delete under the temp dir", () => {
	expect(classifyBashCommand("find . -delete", tmp)).toStrictEqual(ALLOW);
});

test.each([
	["git -C /repo status", ALLOW],
	["git -c core.pager=cat log", ALLOW],
	["git --git-dir /repo/.git log", ALLOW],
	["git -C /repo commit -m x", block("mutable git command blocked outside temp dir")],
])("skips git global flags with a value before the subcommand: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

// The reason names the target as written: variables are expanded only to decide whether the
// target is inside the temp dir.
test.each([
	[`D=${tmp}/d; touch "$D/x"`, ALLOW],
	[`export D=${tmp}/d; touch $D/x`, ALLOW],
	[`D=${tmp}/d; touch \${D}/x`, ALLOW],
	['D=/etc; touch "$D/x"', block("touch blocked outside temp dir: $D/x")],
	["touch $PISCHEMATIC_TEST_DIR/x", ALLOW],
])("expands shell variables from standalone assignments and the environment: %s", (command, expected) => {
	vi.stubEnv("PISCHEMATIC_TEST_DIR", tmp);

	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	['D=$(mktemp -d); touch "$D/x"', ALLOW],
	['F=$(mktemp); echo x > "$F"', ALLOW],
	['D=$(mktemp -d /etc/dXXXXXX); touch "$D/x"', block("touch blocked outside temp dir: $D/x")],
])("treats mktemp results as temp paths: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["echo x >> /etc/x", block("write redirect blocked outside temp dir: /etc/x")],
	["ls 2> /etc/x", block("write redirect blocked outside temp dir: /etc/x")],
	["ls &> /etc/x", block("write redirect blocked outside temp dir: /etc/x")],
	[`echo x >> ${tmp}/x`, ALLOW],
	["ls 2>/dev/null", ALLOW],
	["ls 2>&1", ALLOW],
])("classifies append and stream redirects: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each([
	["RM /etc/x", block("rm blocked outside temp dir: /etc/x")],
	["Touch /etc/x", block("touch blocked outside temp dir: /etc/x")],
	["echo /etc/x | xargs RM", block("xargs rm blocked: mutation command via xargs")],
	["npm INSTALL lodash", block("npm INSTALL lodash is blocked in readonly mode")],
])("compares command names case-insensitively: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});

test.each(["npm list", "npm ls", "npm view lodash", "pip show requests", "brew list"])("allows package manager read verbs: %s", (command) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(ALLOW);
});

test.each([
	[nestedInEcho("ls", 10), ALLOW],
	[
		nestedInEcho("ls", 11),
		block(
			"command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: command substitution blocked: recursion depth exceeded in command classification",
		),
	],
])("blocks command substitution nested past the recursion limit: %s", (command, expected) => {
	expect(classifyBashCommand(command, "/workspace")).toStrictEqual(expected);
});
