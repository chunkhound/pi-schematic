import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { TEMP_DIR } from "../../temp-dir.js";
import { posixHost } from "./readonly-git-helpers.js";
import { shellPath } from "./helpers.js";

// Coverage-gap contracts: each case pins a user-facing verdict (allow inside temp /
// block outside / fail closed) for a classifier branch the broader suites leave open.
// Path literals are POSIX; Windows has no OS sandbox and skips these by design.
const posixOnly = { skip: posixHost ? false : "POSIX path literal contracts" };
const darwinOnly = { skip: process.platform === "darwin" ? false : "macOS option contracts" };
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const outside = path.join(os.homedir(), "readonly-coverage-gaps-outside");
const outsideFile = quote(shellPath(path.join(outside, "f")));
const tempFile = quote(shellPath(path.join(TEMP_DIR, "f")));

function verdict(command: string, allowed: boolean): void {
	assert.equal(classifyBashCommand(command, outside).ok, allowed, command);
}

test("mktemp -- ends option parsing and fails closed on extra operands", posixOnly, () => {
	const template = quote(shellPath(path.join(TEMP_DIR, "x.XXXXXX")));
	// `--` makes the following word the template, even though it starts with `/`.
	verdict(`D=$(mktemp -d -- ${template}) && cd "$D" && touch f`, true);
	// A second operand cannot be modeled: mktemp accepts one template, so fail closed.
	verdict('D=$(mktemp -d -- a b) && cd "$D" && touch f', false);
});

test("bare mktemp --tmpdir defaults to temp while a foreign base blocks", posixOnly, () => {
	// No directory positional: the base falls back to the OS temp dir.
	verdict('D=$(mktemp -d --tmpdir x.XXXXXX) && cd "$D" && touch f', true);
	// A directory-looking positional becomes the base; inside temp it stays writable.
	verdict(`D=$(mktemp -d --tmpdir ${quote(shellPath(TEMP_DIR))} x.XXXXXX) && cd "$D" && touch f`, true);
	verdict(`D=$(mktemp -d --tmpdir ${quote(outside)} x.XXXXXX) && cd "$D" && touch f`, false);
});

test("mutation target extractors block outside writes and allow temp writes", posixOnly, () => {
	for (const allowed of [`chmod 644 ${tempFile}`, `truncate -s 0 ${tempFile}`, `rm -- ${tempFile}`]) {
		verdict(allowed, true);
	}
	for (const blocked of [
		`chmod 644 ${outsideFile}`,
		`truncate -s 0 ${outsideFile}`,
		`rm -- ${outsideFile}`,
		`wget -P ${quote(outside)} http://example.test/x`,
		`wget --directory-prefix ${quote(outside)} http://example.test/x`,
		`tar -xf a.tar --directory=${quote(outside)}`,
		`tar -xf a.tar -C${quote(outside)}`,
		`sudo -- touch ${outsideFile}`,
		`sudo -u root touch ${outsideFile}`,
	]) {
		verdict(blocked, false);
	}
	// Download/extract directories pointed at temp stay allowed.
	verdict(`wget --directory-prefix=${quote(shellPath(TEMP_DIR))} http://example.test/x`, true);
	verdict(`tar --directory=${quote(shellPath(TEMP_DIR))} -xf a.tar`, true);
});

test("command-substitution command words fail closed", () => {
	// The substitution's inner code is classified separately, but its OUTPUT becomes
	// argv[0]; the classifier cannot see which executable runs, so it must fail closed.
	const cwd = shellPath(os.tmpdir());
	const rmSub = classifyBashCommand("$(echo rm) -rf /etc/x", cwd);
	assert.equal(rmSub.ok, false, "$(echo rm) -rf /etc/x");
	if (!rmSub.ok) assert.match(rmSub.reason, /dynamic command blocked/);
	const cdSub = classifyBashCommand("$(echo cd) /etc && touch x", cwd);
	assert.equal(cdSub.ok, false, "$(echo cd) /etc && touch x");
	if (!cdSub.ok) assert.match(cdSub.reason, /dynamic command blocked/);
});

test("attached env split-string forms classify the wrapped command", posixOnly, () => {
	verdict(`env -S"rm -rf /etc"`, false);
	verdict('env --split-string="rm -rf /etc"', false);
	verdict(`env -S"echo hi"`, true);
	verdict('env --split-string="echo hi"', true);
});

test("chmod --reference supplies the mode so every operand is a write target", posixOnly, () => {
	const ref = quote(shellPath(path.join(outside, "ref")));
	verdict(`chmod --reference=${ref} ${outsideFile}`, false);
	verdict(`chmod --reference ${ref} ${outsideFile}`, false);
	verdict(`chmod --reference=${tempFile} ${tempFile}`, true);
	verdict(`chmod --reference ${tempFile} ${tempFile}`, true);
});

test("cp-family target-directory flags name the destination", posixOnly, () => {
	for (const cmd of ["cp", "mv", "install", "ln"]) {
		verdict(`${cmd} -t ${quote(outside)} src`, false);
		verdict(`${cmd} -t${quote(outside)} src`, false);
		verdict(`${cmd} --target-directory=${quote(outside)} src`, false);
		verdict(`${cmd} -t ${quote(shellPath(TEMP_DIR))} src`, true);
	}
});

test("macOS xargs -J mutations fail closed", darwinOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const target = quote(shellPath(path.join(TEMP_DIR, "j-target")));
	assert.equal(classifyBashCommand("printf /etc/passwd | xargs -J % rm %", temp).ok, false,
		"a replacement token in the wrapped command blocks");
	assert.equal(classifyBashCommand(`printf /etc/passwd | xargs -J % rm ${target}`, temp).ok, false,
		"BSD appends stdin when the replacement token is absent");
});

test("unterminated command and arithmetic substitutions fail closed", () => {
	// The scanner cannot find the matching delimiter, so no write may be authorized.
	verdict('touch "$(echo', false);
	verdict("echo $((1+2", false);
});

test("heredoc sed owners execute only readable exec scripts as code", posixOnly, () => {
	const body = `touch ${outsideFile}`;
	// A `-f` script file is unreadable, so the stdin body must fail closed.
	verdict(`sed -f script <<'EOF'\n${body}\nEOF`, false);
	verdict(`sed -nf script <<'EOF'\n${body}\nEOF`, false);
	// An attached-expression data script keeps the body inert.
	verdict(`sed -ne 's/a/b/' <<'EOF'\n${body}\nEOF`, true);
});

test("GNU sed s///e flag executes the pattern space, unlike a plain substitution", () => {
	const body = "touch blocked";
	// The `e` flag runs the substitution result as a shell command, so the body is code.
	for (const script of ["s/^//e", "s@/tmp/@/outside/@e", "s/a/b/ge"]) {
		verdict(`sed '${script}' <<'EOF'\n${body}\nEOF`, false);
	}
	// Without `e`, sed only transforms bytes: the attached-expression body stays inert.
	for (const script of ["s/a/b/", "s/a/b/g", "s/e/x/"]) {
		verdict(`sed '${script}' <<'EOF'\n${body}\nEOF`, true);
	}
});

test("xargs without replacement mode blocks appended stdin paths", posixOnly, () => {
	const command = `printf ${quote(shellPath(path.join(outside, "x")))} | xargs rm ${quote(shellPath(path.join(TEMP_DIR, "f")))}`;
	const verdict = classifyBashCommand(command, shellPath(TEMP_DIR));
	assert.equal(verdict.ok, false, command);
	assert.match(verdict.reason!, /stdin appends unchecked paths/, command);
});
