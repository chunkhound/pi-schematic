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
const gnuOnly = { skip: process.platform === "linux" ? false : "GNU coreutils option contracts" };
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
	const temp = shellPath(TEMP_DIR);
	for (const [cmd, flags] of [["cp", "-rt"], ["mv", "-ft"], ["cp", "-rvt"], ["install", "-vt"], ["ln", "-rt"]] as const) {
		verdict(`${cmd} ${flags} ${quote(outside)} src`, false);
		verdict(`${cmd} ${flags}${quote(outside)} src`, false);
		verdict(`${cmd} ${flags} ${quote(temp)} src`, true);
		verdict(`${cmd} ${flags}${quote(temp)} src`, true);
		// At a temp cwd the old parser checked the misread trailing operand `src`.
		assert.equal(classifyBashCommand(`${cmd} ${flags} ${quote(outside)} src`, temp).ok, false,
			`${cmd} ${flags} <outside> src at temp cwd`);
		assert.equal(classifyBashCommand(`${cmd} ${flags}${quote(outside)} src`, temp).ok, false,
			`${cmd} ${flags}<outside> src at temp cwd`);
	}
	// An unknown option letter makes the destination unprovable, even with a temp target.
	assert.equal(classifyBashCommand(`cp -qt ${quote(temp)} src`, temp).ok, false,
		"unknown cp option letter must fail closed");
});

test("GNU cp -S value consumes a trailing t", gnuOnly, () => {
	const temp = shellPath(TEMP_DIR);
	assert.equal(classifyBashCommand(`cp -St ${quote(outside)} src`, temp).ok, true,
		"cp -St must treat t as the -S value");
});

test("cp-family value options after the destination cannot hide it", gnuOnly, () => {
	const temp = shellPath(TEMP_DIR);
	for (const tail of ["-S .bak", "--suffix .bak", "--sparse always"]) {
		const command = `cp src ${quote(outside)} ${tail}`;
		assert.equal(classifyBashCommand(command, temp).ok, false, command);
	}
	for (const tail of ["-m 755", "-S .bak", "--suffix .bak"]) {
		const command = `install src ${quote(outside)} ${tail}`;
		assert.equal(classifyBashCommand(command, temp).ok, false, command);
	}
	for (const command of [
		`cp src ${tempFile} -S .bak`,
		`cp src ${tempFile} --sparse always`,
		`install src ${tempFile} -m 755`,
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, true, command);
	}
});

test("cp-family remaining value options after the destination cannot hide it", gnuOnly, () => {
	const temp = shellPath(TEMP_DIR);
	for (const command of [
		`mv src ${quote(outside)} -S .bak`,
		`ln src ${quote(outside)} -S .bak`,
		`mv src ${quote(outside)} --suffix .bak`,
		`ln src ${quote(outside)} --suffix .bak`,
		`cp src ${quote(outside)} --preserve=all`,
		`cp src ${quote(outside)} --no-preserve=mode`,
		`cp src ${quote(outside)} --reflink=auto`,
		`cp src ${quote(outside)} --backup=numbered`,
		`install src ${quote(outside)} --mode 755`,
		`install src ${quote(outside)} --owner root`,
		`install src ${quote(outside)} --group root`,
		`install src ${quote(outside)} --strip-program prog`,
		`install src ${quote(outside)} --suffix .bak`,
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, false, command);
	}
	for (const command of [
		`mv -S .bak src ${tempFile}`,
		`ln -S .bak src ${tempFile}`,
		`mv --suffix .bak src ${tempFile}`,
		`ln --suffix .bak src ${tempFile}`,
		`cp --preserve=all src ${tempFile}`,
		`cp --no-preserve=mode src ${tempFile}`,
		`cp --reflink=auto src ${tempFile}`,
		`cp --backup=numbered src ${tempFile}`,
		`install --mode 755 src ${tempFile}`,
		`install --owner root src ${tempFile}`,
		`install --group root src ${tempFile}`,
		`install --strip-program prog src ${tempFile}`,
		`install --suffix .bak src ${tempFile}`,
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, true, command);
	}
});

test("cp-family last target-directory wins", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	assert.equal(classifyBashCommand(`cp -t ${quote(temp)} -t ${quote(outside)} src`, temp).ok, false,
		"last -t is outside temp");
	assert.equal(classifyBashCommand(`cp -t ${quote(outside)} -t ${quote(temp)} src`, temp).ok, true,
		"last -t is inside temp");
});

test("cp-family long-option abbreviations cannot hide the destination", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	for (const command of [
		`cp --target-dir ${quote(outside)} src`,
		`cp --targ=${quote(outside)} src`,
		`cp src ${quote(outside)} --suff .bak`,
		`cp src ${quote(outside)} --spar always`,
		`install src ${quote(outside)} --strip-prog prog`,
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, false, command);
	}
	for (const command of [
		`cp --target-directory ${quote(temp)} src`,
		`cp --targ=${quote(temp)} src`,
		`cp --suff .bak src ${tempFile}`,
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, true, command);
	}
});

test("unknown cp-family long options fail closed", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const result = classifyBashCommand(`cp --frobnicate src ${tempFile}`, temp);
	assert.equal(result.ok, false, "unknown long option must block");
	assert.ok(!result.ok && /cannot model/.test(result.reason), "reason must not name a fake path");
});

test("cp-family long and -- forms name the destination", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	assert.equal(classifyBashCommand(`cp --target-directory ${quote(outside)} src`, temp).ok, false);
	assert.equal(classifyBashCommand("cp --target-directory", temp).ok, false);
	assert.equal(classifyBashCommand(`cp -- src ${quote(outside)}`, temp).ok, false);
	assert.equal(classifyBashCommand(`cp -- src ${tempFile}`, temp).ok, true);
});

test("cp-family ambiguous long options fail closed", gnuOnly, () => {
	const temp = shellPath(TEMP_DIR);
	for (const command of [
		`cp --no- src ${quote(outside)}`,
		`cp --s src ${quote(outside)}`,
		`install --p src ${quote(outside)}`,
	]) {
		const verdict = classifyBashCommand(command, temp);
		assert.equal(verdict.ok, false, command);
		assert.match(verdict.reason!, /cannot model/, command);
	}
});

test("a >| redirect target cannot hide the copy destination", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const log = quote(shellPath(path.join(TEMP_DIR, "log")));
	assert.equal(classifyBashCommand(`cp src ${quote(outside)} >| ${log}`, temp).ok, false,
		"the redirect target must not replace the checked destination");
	assert.equal(classifyBashCommand(`cp src ${tempFile} >| ${log}`, temp).ok, true,
		"a temp destination and temp redirect stay allowed");
});

test("install -d and one-operand ln check every write target", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	assert.equal(classifyBashCommand(`install -d ${quote(outside)} ${quote(temp)}`, temp).ok, false,
		"install -d checks every created directory");
	assert.equal(classifyBashCommand(`install -d ${quote(temp)} ${quote(shellPath(path.join(TEMP_DIR, "d")))}`, temp).ok, true,
		"temp install -d targets stay allowed");
	assert.equal(classifyBashCommand(`install --directory ${quote(outside)} ${quote(temp)}`, temp).ok, false,
		"install --directory checks every created directory");
	assert.equal(classifyBashCommand(`install --directory ${quote(temp)} ${quote(shellPath(path.join(TEMP_DIR, "d2")))}`, temp).ok, true,
		"temp install --directory targets stay allowed");
	assert.equal(classifyBashCommand(`install -d -t ${quote(outside)} ${quote(temp)}`, temp).ok, false,
		"install -d -t checks the target directory");
	assert.equal(classifyBashCommand(`install -d -t ${quote(temp)} ${quote(shellPath(path.join(TEMP_DIR, "d3")))}`, temp).ok, true,
		"temp install -d -t targets stay allowed");
	assert.equal(classifyBashCommand(`ln ${tempFile}`, outside).ok, false,
		"one-operand ln writes in the cwd");
	assert.equal(classifyBashCommand(`ln ${tempFile}`, temp).ok, true,
		"one-operand ln in temp stays allowed");
});

test("macOS copy-family flags stay usable inside temp", darwinOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const dest = quote(shellPath(path.join(TEMP_DIR, "dest")));
	for (const command of [
		`cp -c src ${dest}`,
		`cp -N src ${dest}`,
		`cp -X src ${dest}`,
		`mv -h src ${dest}`,
		`ln -h src ${dest}`,
		`ln -w src ${dest}`,
	]) {
		assert.equal(classifyBashCommand(command, temp).ok, true, command);
	}
});

test("macOS install -M metalog is a checked write target", darwinOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const dest = quote(shellPath(path.join(TEMP_DIR, "dest")));
	const meta = quote(shellPath(path.join(TEMP_DIR, "meta")));
	const outsideMeta = quote(shellPath(path.join(outside, "meta")));
	assert.equal(classifyBashCommand(`install -M ${meta} src ${dest}`, temp).ok, true,
		"temp metalog and temp destination stay allowed");
	assert.equal(classifyBashCommand(`install -M${meta} src ${dest}`, temp).ok, true,
		"attached temp metalog stays allowed");
	assert.equal(classifyBashCommand(`install -M ${outsideMeta} src ${dest}`, temp).ok, false,
		"outside metalog must block");
	assert.equal(classifyBashCommand(`install -M${outsideMeta} src ${dest}`, temp).ok, false,
		"attached outside metalog must block");
});

test("macOS install value options after the destination cannot hide it", darwinOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const dest = quote(shellPath(path.join(TEMP_DIR, "dest")));
	const meta = quote(shellPath(path.join(TEMP_DIR, "meta")));
	for (const tail of ["-B .bak", "-D meta", "-f flags", "-h sha256", "-l r", "-T tags"]) {
		const command = `install src ${quote(outside)} ${tail}`;
		assert.equal(classifyBashCommand(command, temp).ok, false, command);
	}
	assert.equal(classifyBashCommand(`install src ${dest} -D ${meta}`, temp).ok, true);
});

test("GNU install -D stays usable inside temp", gnuOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const dest = quote(shellPath(path.join(TEMP_DIR, "dest")));
	assert.equal(classifyBashCommand(`install -D src ${dest}`, temp).ok, true);
});

test("macOS xargs -J mutations fail closed", darwinOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const target = quote(shellPath(path.join(TEMP_DIR, "j-target")));
	assert.equal(classifyBashCommand("printf /etc/passwd | xargs -J % rm %", temp).ok, false,
		"a replacement token in the wrapped command blocks");
	assert.equal(classifyBashCommand(`printf /etc/passwd | xargs -J % rm ${target}`, temp).ok, false,
		"BSD appends stdin when the replacement token is absent");
});

test("unmodeled copy options fail closed with a truthful reason", posixOnly, () => {
	const temp = shellPath(TEMP_DIR);
	const result = classifyBashCommand(`cp -qt ${tempFile} src`, temp);
	assert.equal(result.ok, false, "unknown option letter must block");
	assert.ok(!result.ok && /cannot model/.test(result.reason), "reason must not name a fake path");
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
