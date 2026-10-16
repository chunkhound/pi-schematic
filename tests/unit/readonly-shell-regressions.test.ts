import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { classifyBashCommand } from "../../readonly-bash.js";
import { TEMP_DIR, TEMP_WRITE_ROOTS_CANONICAL } from "../../temp-dir.js";
import { canWriteOutsideTemp, capabilityGate, posixHost } from "./readonly-git-helpers.js";
import { shellPath } from "./helpers.js";

// Differential fixtures intentionally write OUTSIDE the temp dir to prove real writes are
// blocked, so this suite cannot run under this extension's own readonly sandbox: expect
// EPERM there, which is the enforcement working, not a test bug.
// WHY not process.cwd(): killed runs (SIGKILL on the 3s shell timeout, CI cancellation)
// leaked .readonly-shell-test-* dirs into the repo working tree. Anchor instead at a
// unique directory under the host home — outside every temp root (asserted below), the
// same outside-fixture pattern the git suites use in readonly-git-helpers.ts. A kill before
// the exit hook runs leaves the dir behind; the startup sweep below removes stale ones.
import { FIXTURE_MARKER, sweepStaleFixtures } from "./fixture-sweep.js";

sweepStaleFixtures(shellPath(os.homedir()), ".readonly-shell-test-");
const outside = (() => {
	try {
		const root = mkdtempSync(path.join(os.homedir(), ".readonly-shell-test-"));
		writeFileSync(path.join(root, FIXTURE_MARKER), "");
		// Normal runs remove the root; a kill leaves at worst one empty home dir, not repo litter.
		process.on("exit", () => rmSync(root, { recursive: true, force: true }));
		return shellPath(root);
	}
	// Unwritable home cannot host the fixture: fall back so the gate below skips the suite.
	catch { return shellPath(os.homedir()); }
})();
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
// Unquoted Bash `\/` escapes decode to separators: the encoded spelling of `value`.
const escapeSeparators = (value: string): string => value.replaceAll("/", "\\/");

function withDirectories(run: (work: string, temp: string) => void): void {
	const work = shellPath(mkdtempSync(path.join(outside, ".readonly-shell-test-")));
	const temp = shellPath(mkdtempSync(path.join(os.tmpdir(), "readonly-shell-test-")));
	try { run(work, temp); }
	finally { rmSync(work, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }); }
}

// Startup files must not alter the shell semantics these real subprocesses verify.
const bashOptions = { env: { ...process.env, BASH_ENV: "/dev/null", ENV: "/dev/null", OLDPWD: undefined, CDPATH: "" }, timeout: 3000, killSignal: "SIGKILL" as const };

function shell(command: string, cwd: string): void {
	execFileSync("bash", ["--noprofile", "--norc", "-c", command], { ...bashOptions, cwd, stdio: "ignore" });
}

function assertShellWrite(command: string, cwd: string, target: string, allowed: boolean, unintended: string[] = [], contents = ""): void {
	for (const file of [target, ...unintended]) assert.equal(existsSync(file), false, `initially absent: ${file}`);
	shell(command, cwd);
	assert.equal(readFileSync(target, "utf8"), contents, target);
	for (const file of unintended) assert.equal(existsSync(file), false, `unintended write: ${file}`);
	assert.equal(classifyBashCommand(command, cwd).ok, allowed, command);
}

function hasBash(): boolean {
	try {
		execFileSync("bash", ["--noprofile", "--norc", "-c", "true"], { ...bashOptions, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const outsideWritable = canWriteOutsideTemp(outside);

const trackedShellNames = ["cd", "pushd", "popd", "command", "builtin"];

function assertTrackedDefinitionBlocked(command: string, cwd: string): void {
	// WHY no prose assertion here: only the fail-closed verdict is a user-facing contract.
	assert.equal(classifyBashCommand(command, cwd).ok, false, command);
}

if (!posixHost) capabilityGate("readonly shell regressions require a POSIX host", "POSIX bash and temp-path semantics required", true);
else if (!outsideWritable) capabilityGate("readonly shell regressions require outside-temp writes", "cannot write outside temp", true);
else if (!hasBash()) capabilityGate("readonly shell regressions require POSIX bash", "POSIX bash unavailable", true);
else {
// A mis-resolved `outside` fixture (cwd inside a temp root) would invert every
// expectation, so fail loudly instead of reporting green on meaningless fixtures.
test("outside fixture is not inside the shared temp-root policy", () => {
	for (const root of TEMP_WRITE_ROOTS_CANONICAL) {
		const relative = path.relative(root, outside);
		assert.ok(relative.startsWith("..") || path.isAbsolute(relative), `${outside} must be outside ${root}`);
	}
});
function shadowedDirectoryWrite(name: string, work: string, temp: string, file: string): string {
	if (name === "popd") return `pushd ${quote(temp)}; pushd ${quote(work)}; popd; touch ${file}`;
	const invocation = name === "command" || name === "builtin" ? `${name} cd` : name;
	return `${invocation} ${quote(temp)}; touch ${file}`;
}

for (const form of ["function", "alias"]) {
	test(`${form} replacements of directory commands and wrappers cannot authorize outside-temp writes`, () => {
		withDirectories((work, temp) => {
			for (const name of trackedShellNames) {
				const file = `${form}-${name}`;
				const definition = form === "function" ? `${name}() { :; };` : `shopt -s expand_aliases\nalias ${name}=':'\n`;
				const command = `${definition} ${shadowedDirectoryWrite(name, work, temp, file)}`;
				assertShellWrite(command, work, path.join(work, file), false, [path.join(temp, file)]);
				assertTrackedDefinitionBlocked(command, work);
			}
		});
	});
}

test("ordinary functions and aliases preserve positive temp writes", () => {
	withDirectories((work, temp) => {
		const command = `f() { :; }; f; shopt -s expand_aliases\nalias noop=':'\nnoop; command builtin cd ${quote(temp)}; touch positive`;
		assertShellWrite(command, work, path.join(temp, "positive"), true, [path.join(work, "positive")]);
	});
});

test("cwd follows successful sequential changes but not pipeline or background children", () => {
	withDirectories((work, temp) => {
		for (const [index, separator] of [";", "&&", "\n"].entries()) {
			const name = `sequential-${index}`;
			const command = `cd ${quote(temp)} ${separator} touch ${name}`;
			assertShellWrite(command, work, path.join(temp, name), true, [path.join(work, name)]);
		}
		for (const [index, separator] of ["| cat;", "& wait;"].entries()) {
			const name = `isolated-${index}`;
			const command = `cd ${quote(temp)} ${separator} touch ${name}`;
			assertShellWrite(command, work, path.join(work, name), false, [path.join(temp, name)]);
		}
	});
});

test("directory provenance never leaks through a pipeline stage", () => {
	withDirectories((work, temp) => {
		// Real bash: the assignment runs in a forked stage, so the parent keeps no value;
		// the later cd expands empty and a relative write stays in the old cwd.
		assert.equal(classifyBashCommand(`D=$(mktemp -d) | cat && cd "$D" && touch rel`, work).ok, false);
		assert.equal(classifyBashCommand(`cd ${quote(temp)} | cat && touch rel`, work).ok, false);
	});
});

test("compound command bodies are classified in the parent shell", () => {
	withDirectories((work, temp) => {
		// Real bash: the inner cd succeeds, so touch writes into work — the tracked
		// cwd must not stay temp for inner or later relative writes.
		assert.equal(classifyBashCommand(`cd ${quote(temp)}; if cd ${quote(work)}; then touch rel; fi`, temp).ok, false);
		assert.equal(classifyBashCommand(`while cd ${quote(work)}; do touch rel; done`, temp).ok, false);
		assert.equal(classifyBashCommand(`f() { cd ${quote(work)}; touch rel; }; f`, temp).ok, false);
		// A body that changes no directory evaluates in the tracked cwd.
		assert.equal(classifyBashCommand(`if true; then touch rel; fi`, temp).ok, true);
		assert.equal(classifyBashCommand(`if grep -q cd ${quote(temp)}; then touch rel; fi`, temp).ok, true);
		// Mutations hidden behind an introducer or negation keyword stay blocked.
		assert.equal(classifyBashCommand(`if rm ${quote(path.join(work, "blocked"))}; then :; fi`, temp).ok, false);
		assert.equal(classifyBashCommand(`! touch ${quote(path.join(work, "blocked"))}`, temp).ok, false);
	});
});

test("pushd stack rotation arguments fail closed", () => {
	withDirectories((work, temp) => {
		// Real bash: pushd +1 rotates the untracked stack, moving the cwd outside temp.
		assert.equal(classifyBashCommand(`pushd ${quote(work)}; cd ${quote(temp)}; pushd +1; touch rel`, work).ok, false);
	});
});

test("assignments made earlier in the line resolve for downstream commands", () => {
	withDirectories((work, temp) => {
		// Real bash: mktemp creates the directory, cd succeeds, git writes there.
		assert.equal(classifyBashCommand(`TMPD=$(mktemp -d) && cd "$TMPD" && git init`, work).ok, true);
		assert.equal(classifyBashCommand(`TMPD=$(mktemp -d); cd "$TMPD"; git init`, work).ok, false);
		assert.equal(classifyBashCommand(`VAR=${quote(path.join(temp, "x"))} && touch $VAR/f`, work).ok, true);
		// An assignment whose command may not run must not resolve for later writes.
		assert.equal(classifyBashCommand(`false && D=${quote(temp)}; touch $D/f`, temp).ok, false);
		// Prefix assignments cannot move the tracked cd: $FOO expands before FOO applies.
		assert.equal(classifyBashCommand(`FOO=${quote(temp)} cd $FOO; touch rel`, work).ok, false);
		assert.equal(classifyBashCommand(`D=${quote(temp)}; cd "$D"; touch rel`, work).ok, true);
	});
});

test("external wrappers cannot change cwd and uncertain stack arguments stay conservative", () => {
	withDirectories((work, temp) => {
		assert.equal(classifyBashCommand(`env cd ${quote(temp)}; touch blocked`, work).ok, false);
		assert.equal(classifyBashCommand(`cd ${quote(temp)} extra; touch blocked`, work).ok, false);
		assert.equal(classifyBashCommand(`pushd ${quote(temp)}; popd; touch restored`, work).ok, false);
		assert.equal(classifyBashCommand(`pushd ${quote(temp)}; pushd ${quote(work)}; popd; touch restored`, work).ok, true);
		assert.equal(classifyBashCommand(`DIR=${quote(temp)}; false || DIR=${quote(work)}; cd "$DIR"; touch blocked`, work).ok, false);
	});
});

test("failed cd and mixed conditionals retain every reachable cwd", () => {
	withDirectories((work, temp) => {
		const missing = quote(path.join(temp, "missing"));
		assert.equal(classifyBashCommand(`cd ${missing}; touch failed`, work).ok, false);
		assert.equal(classifyBashCommand(`cd ${missing} && touch unreachable`, work).ok, true);
		assert.equal(classifyBashCommand(`cd ${missing} || cd ${quote(temp)}; touch recovered`, work).ok, true);
		// CONTRACT: a reachable directory change can still fail at runtime, so the `||`
		// branch runs in the pre-command cwd and must be classified, never skipped.
		assert.equal(classifyBashCommand(`cd ${quote(temp)} || touch ${quote(path.join(work, "fallback"))}`, work).ok, false);
		assert.equal(classifyBashCommand(`pushd ${quote(temp)} || rm ${quote(path.join(work, "always"))}`, work).ok, false);
		// A `{ ...; }` group runs in the parent shell, so the same runtime failure applies and
		// the `||` branch must still be classified in the pre-group cwd.
		assert.equal(classifyBashCommand(`{ cd ${quote(temp)}; } || touch ${quote(path.join(work, "brace-fallback"))}`, work).ok, false);
		assert.equal(classifyBashCommand(`{ cd ${quote(temp)}; } && touch rel`, work).ok, true);
		// Proven success still authorizes relative writes in `&&` and `;` chains.
		assert.equal(classifyBashCommand(`cd ${quote(temp)} && touch rel`, work).ok, true);
		assert.equal(classifyBashCommand(`cd ${quote(temp)}; touch rel`, work).ok, true);
		assert.equal(classifyBashCommand(`false && cd ${quote(temp)} || touch branch`, work).ok, false);
		assertShellWrite(`cd ${missing}; touch failed`, work, path.join(work, "failed"), false, [path.join(temp, "failed")]);
	});
});

function redirectFixtures(temp: string): { failed: string[]; successful: string[] } {
	const existing = path.join(temp, "existing");
	writeFileSync(existing, "keep");
	return {
		failed: [`<${quote(path.join(temp, "missing"))}`, `>${quote(path.join(temp, "missing", "out"))}`,
			`>${quote(temp)}`, `9>&8`, `>${quote(existing)}`, `&>${quote(existing)}`],
		successful: [`<${quote(existing)}`, `>${quote(path.join(temp, "created"))}`,
			`>>${quote(existing)}`, `>|${quote(existing)}`],
	};
}

function assertFailedCdRedirect(work: string, temp: string, redirect: string, index: number): void {
	const name = `failed-redirect-${index}`;
	// Close fd 8 explicitly; noclobber makes existing output targets fail deterministically.
	const prefix = `set -C; exec 8>&-; cd ${quote(temp)} ${redirect}`;
	assertShellWrite(`${prefix}; touch ${name}`, work, path.join(work, name), false, [path.join(temp, name)]);
	const conditional = `${prefix} && touch ${name}-conditional; :`;
	shell(conditional, work);
	for (const cwd of [work, temp]) assert.equal(existsSync(path.join(cwd, `${name}-conditional`)), false);
	assert.equal(classifyBashCommand(conditional, work).ok, true, conditional);
}

test("failed cd redirects retain the original cwd, while && excludes failure", () => {
	withDirectories((work, temp) => {
		for (const [index, redirect] of redirectFixtures(temp).failed.entries()) {
			assertFailedCdRedirect(work, temp, redirect, index);
		}
	});
});

test("successful cd redirects allow temp writes through && under noclobber", () => {
	withDirectories((work, temp) => {
		for (const [index, redirect] of redirectFixtures(temp).successful.entries()) {
			const name = `successful-redirect-${index}`;
			assertShellWrite(`set -C; cd ${quote(temp)} ${redirect} && touch ${name}`, work,
				path.join(temp, name), true, [path.join(work, name)]);
		}
	});
});

test("heredoc data is inert but expanding bodies and normalized stdin interpreters execute", () => {
	const write = `touch ${quote(path.join(outside, "blocked"))}`;
	for (const delimiter of ["'EOF'", '"EOF"', "'E'OF", "E\\OF"]) {
		assert.equal(classifyBashCommand(`cat <<${delimiter}\n$(${write})\nEOF`, outside).ok, true);
		assert.equal(classifyBashCommand(`/bin/bash <<${delimiter}\n${write}\nEOF`, outside).ok, false);
	}
	assert.equal(classifyBashCommand(`cat <<EOF\n$(${write})\nEOF`, outside).ok, false);
	assert.equal(classifyBashCommand(`cat <<-EOF\n\t$(${write})\n\tEOF`, outside).ok, false);
	for (const command of ["/usr/bin/env /bin/bash", "/usr/bin/env -S '/bin/bash'", "command /bin/bash", "exec /bin/bash", "sudo /bin/bash"]) {
		assert.equal(classifyBashCommand(`${command} <<'EOF'\n${write}\nEOF`, outside).ok, false);
	}
});

test("heredoc bodies reaching executing consumers are not inert", () => {
	const write = `touch ${quote(path.join(outside, "blocked"))}`;
	// stdin flows down the pipeline: the body is code for the downstream shell.
	assert.equal(classifyBashCommand(`cat <<EOF | bash\n${write}\nEOF`, outside).ok, false);
	assert.equal(classifyBashCommand(`cat <<EOF | xargs sh\n${write}\nEOF`, outside).ok, false);
	// Read loops may execute stdin lines; xargs feeds them to an unanalyzable command.
	assert.equal(classifyBashCommand(`while read l; do $l; done <<EOF\n${write}\nEOF`, outside).ok, false);
	assert.equal(classifyBashCommand(`xargs sh <<EOF\n${write}\nEOF`, outside).ok, false);
	// List-connected fallbacks never receive the heredoc, so the body stays inert.
	assert.equal(classifyBashCommand(`cat <<'EOF' || bash\n${write}\nEOF`, outside).ok, true);
});

test("sudo long flags with space-separated values skip to the wrapped command", () => {
	withDirectories((work, temp) => {
		for (const flag of ["--chdir", "--user", "--group", "--host", "--prompt"]) {
			assert.equal(classifyBashCommand(`sudo ${flag} ${quote(work)} touch ${quote(path.join(work, "blocked"))}`, temp).ok, false,
				`sudo ${flag} <outside> touch ... must block`);
		}
		assert.equal(classifyBashCommand(`sudo --chdir=${quote(work)} touch ${quote(path.join(temp, "ok"))}`, temp).ok, true,
			"sudo --chdir=<outside> touch <temp> attached form still allows temp");
	});
});

test("heredoc owners wrapped in a brace group or subshell are not inert", () => {
	const write = `touch ${quote(path.join(outside, "blocked"))}`;
	// CONTRACT: a heredoc attaches to the group's stdin, so `{ bash; }` runs the body.
	for (const owner of ["{ bash; }", "(bash)", "{ /bin/bash; }", "({ bash; })"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${write}\nEOF`, outside).ok, false, owner);
	}
	// A group that never reads stdin keeps the body inert.
	for (const owner of ["{ cat; }", "(cat)"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${write}\nEOF`, outside).ok, true, owner);
	}
});

test("a definition that shadows an allowlisted stdin consumer cannot keep a heredoc inert", () => {
	const write = `touch ${quote(path.join(outside, "blocked"))}`;
	for (const owner of ["cat", "head", "tee", "sed", "grep", "sort"]) {
		assert.equal(classifyBashCommand(`${owner}() { bash; };\n${owner} <<'EOF'\n${write}\nEOF`, outside).ok, false, owner);
	}
	// A genuine data consumer still keeps an inert body inert.
	assert.equal(classifyBashCommand("cat <<'EOF'\ndata > inert\nEOF", outside).ok, true);
});

test("physical cd (-P) through a symlink fails closed", () => {
	withDirectories((work, temp) => {
		const link = path.join(temp, "link");
		symlinkSync(work, link);
		// Real `-P` resolves the symlink before applying `..`, landing outside temp.
		// Build the path textually: path.join would collapse `..` lexically and defeat the probe.
		const target = `${link}/..`;
		const physicalOf = (dir: string) => execFileSync("bash", ["--noprofile", "--norc", "-c", `cd -P ${quote(dir)} && pwd -P`], { ...bashOptions, encoding: "utf8" }).trim();
		assert.equal(physicalOf(target), physicalOf(path.dirname(work)), "-P must resolve the symlink then apply ..");
		// The lexical tracker stays at temp, so it must fail closed rather than trust it.
		assert.equal(classifyBashCommand(`cd -P ${quote(target)} && touch escaped`, temp).ok, false);
		assert.equal(classifyBashCommand(`cd -L ${quote(target)} && touch escaped`, temp).ok, true);
	});
});

test("heredoc preprocessing never hides subsequent commands or changes the parent's cwd", () => {
	const write = `touch ${quote(path.join(outside, "blocked"))}`;
	for (const prefix of ["cat <<< hello", "echo ok # <<EOF", "cat <<'E'OF\nhello\nEOF", "cat <<-EOF\n\thello\n\tEOF"]) {
		assert.equal(classifyBashCommand(`${prefix}\n${write}`, outside).ok, false);
	}
	assert.equal(classifyBashCommand("cat <<EOF || bash\ndata > inert\nEOF", outside).ok, true);
	assert.equal(classifyBashCommand("cat <<EOF\nincomplete", outside).ok, false);
	assert.equal(classifyBashCommand(`echo $((1 + $(${write})))`, outside).ok, false);
	assert.equal(classifyBashCommand("bash <<'EOF'\ncd /tmp\nEOF\ntouch later", outside).ok, false);
});

test("real bash confirms quoted heredoc data and unquoted expansion ownership", () => {
	withDirectories((work, temp) => {
		const command = `cat <<'E'OF\n$(touch quoted)\nEOF\ncat <<EOF\n$(touch expanded)\nEOF`;
		assert.equal(classifyBashCommand(command, work).ok, false);
		assertShellWrite(command, temp, path.join(temp, "expanded"), true,
			[path.join(temp, "quoted"), path.join(work, "quoted"), path.join(work, "expanded")]);
	});
});

test("non-shell stdin source fails closed rather than being classified as Bash", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "non-shell");
		for (const [interpreter, body] of [
			["python3", `open(${JSON.stringify(target)}, 'w').close()`],
			["node", `require('fs').writeFileSync(${JSON.stringify(target)}, '')`],
			["perl", `open(my $f, '>', ${JSON.stringify(target)}) or die $!; close($f);`],
			["ruby", `File.write(${JSON.stringify(target)}, '')`],
		]) assert.equal(classifyBashCommand(`${interpreter} <<'EOF'\n${body}\nEOF`, temp).ok, false);
		assertShellWrite(`node <<'EOF'\nrequire('fs').writeFileSync(${JSON.stringify(target)}, '')\nEOF`, temp, target, false,
			[path.join(temp, "non-shell")]);
	});
});

test("interpreter here strings fail closed while ordinary stdin data remains supported", () => {
	withDirectories((work, temp) => {
		assertShellWrite(`bash <<< ${quote(`touch ${quote(path.join(work, "herestring"))}`)}`, temp, path.join(work, "herestring"), false,
			[path.join(temp, "herestring")]);
		assert.equal(classifyBashCommand("bash <<< 'echo safe'", temp).ok, false);
		assert.equal(classifyBashCommand("cat <<< 'touch outside'", work).ok, true);
	});
});

test("continued interpreter headers retain ownership without changing quoted heredoc data", () => {
	withDirectories((work, temp) => {
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			const name = `continued-${allowed}`;
			const command = `bash \\\n<<'EOF'\ntouch ${name}\nEOF`;
			assertShellWrite(command, cwd, path.join(cwd, name), allowed, [path.join(cwd === work ? temp : work, name)]);
		}
		assert.equal(classifyBashCommand("cat <<'EOF'\nbash \\\n<<INNER\ntouch inert\nINNER\nEOF", work).ok, true);
		assertShellWrite("echo harmless # \\\ntouch uncommented", work, path.join(work, "uncommented"), false,
			[path.join(temp, "uncommented")]);
	});
});

test("process wrappers retain shell heredoc ownership and safe paired writes", () => {
	withDirectories((work, temp) => {
		for (const wrapper of ["nohup", "timeout 2", "nice -n 1", "stdbuf -o0", "time -p"]) {
			for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
				const command = `${wrapper} bash <<'EOF'\ntouch wrapped\nEOF`;
				assert.equal(classifyBashCommand(command, cwd).ok, allowed, wrapper);
			}
		}
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			const name = `wrapped-${allowed}`;
			assertShellWrite(`nice -n 1 bash <<'EOF'\ntouch ${name}\nEOF`, cwd, path.join(cwd, name), allowed,
				[path.join(cwd === work ? temp : work, name)]);
		}
	});
});

test("redirect-first and multiple-redirect headers preserve shell stdin ownership", () => {
	withDirectories((work, temp) => {
		for (const [index, header] of ["<<'EOF' /bin/bash", "3</dev/null <<'EOF' /bin/bash 2>/dev/null", "<<'IGNORED' /bin/bash <<'EOF'", "<<'EOF' command /bin/bash | cat"].entries()) {
			const unused = header.includes("IGNORED") ? "inert\nIGNORED\n" : "";
			for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
				const name = `redirect-first-${index}-${allowed}`;
				const other = cwd === work ? temp : work;
				assertShellWrite(`${header}\n${unused}touch ${name}\nEOF`, cwd, path.join(cwd, name), allowed, [path.join(other, name)]);
			}
		}
	});
});

test("redirect-first ordinary commands keep quoted heredoc bodies inert", () => {
	withDirectories((work) => {
		for (const [index, header] of ["<<'EOF' cat", "3</dev/null <<'EOF' cat 2>/dev/null", "<<'IGNORED' cat <<'EOF'"].entries()) {
			const unused = header.includes("IGNORED") ? "inert\nIGNORED\n" : "";
			const targets = ["inert", "expanded"].map((name) => `${name}-${index}`);
			const command = `${header}\n${unused}touch ${targets[0]}\n$(touch ${targets[1]})\nEOF`;
			for (const target of targets) assert.equal(existsSync(path.join(work, target)), false);
			assert.equal(classifyBashCommand(command, work).ok, true);
			shell(command, work);
			for (const target of targets) assert.equal(existsSync(path.join(work, target)), false);
		}
	});
});

test("redirect-first non-shell code and interpreter here strings fail closed", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "redirect-code");
		assertShellWrite(`<<'EOF' node\nrequire('fs').writeFileSync(${JSON.stringify(target)}, '')\nEOF`, temp, target, false,
			[path.join(temp, "redirect-code")]);
		const hereStringTarget = path.join(work, "redirect-here-string");
		assertShellWrite(`<<< ${quote(`touch ${quote(hereStringTarget)}`)} /bin/bash`, temp, hereStringTarget, false,
			[path.join(temp, "redirect-here-string")]);
		assert.equal(classifyBashCommand("<<< 'touch inert' cat", work).ok, true);
		assert.equal(classifyBashCommand("{input}</dev/null <<'EOF' /bin/bash\ntouch uncertain\nEOF", work).ok, false);
		for (const executable of ["/bin/ba'sh'", "/bin/ba\\sh", '"$SHELL"']) {
			assert.equal(classifyBashCommand(`<<'EOF' ${executable}\ntouch uncertain\nEOF`, work).ok, false);
		}
	});
});

test("CDPATH cannot redirect tracked relative cd writes outside the current directory", () => {
	withDirectories((work, temp) => {
		mkdirSync(path.join(work, "repo")); mkdirSync(path.join(temp, "repo"));
		for (const [index, prefix] of [`CDPATH=${quote(work)};`, `CDPATH=${quote(work)}`].entries()) {
			const name = `cdpath-${index}`;
			assertShellWrite(`${prefix} cd repo; touch ${name}`, temp, path.join(work, "repo", name), false,
				[path.join(temp, "repo", name), path.join(temp, name)]);
		}
		assertShellWrite(`CDPATH=${quote(work)}; cd ./repo; touch explicit`, temp, path.join(temp, "repo", "explicit"), true,
			[path.join(work, "repo", "explicit"), path.join(temp, "explicit")]);
		assertShellWrite("CDPATH=''; cd repo; touch empty", temp, path.join(temp, "repo", "empty"), true,
			[path.join(work, "repo", "empty"), path.join(temp, "empty")]);
	});
});

test("brace groups classify their writes in the real parent shell cwd", () => {
	withDirectories((work, temp) => {
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			const name = `brace-${allowed}`;
			assertShellWrite(`{ echo harmless; printf 'brace contents' > ${name}; }`, cwd, path.join(cwd, name), allowed,
				[path.join(cwd === work ? temp : work, name)], "brace contents");
		}
	});
});

test("brace groups cannot hide explicit outside writes from a temp cwd", () => {
	withDirectories((work, temp) => {
		for (const [destination, allowed] of [[work, false], [temp, true]] as const) {
			const name = `brace-absolute-${allowed}`;
			const target = path.join(destination, name);
			assertShellWrite(`{ echo harmless; printf 'absolute contents' > ${quote(target)}; }`, temp, target, allowed,
				[path.join(destination === work ? temp : work, name)], "absolute contents");
		}
	});
});

test("cd inside braces changes cwd for commands after the group", () => {
	withDirectories((work, temp) => {
		for (const [cwd, destination, allowed] of [[work, temp, true], [temp, work, false]] as const) {
			const name = `brace-cd-${allowed}`;
			assertShellWrite(`{ echo harmless; cd ${quote(destination)}; }; printf 'following contents' > ${name}`,
				cwd, path.join(destination, name), allowed, [path.join(cwd, name)], "following contents");
		}
	});
});

test("nested brace groups preserve directory stack effects in the parent", () => {
	withDirectories((work, temp) => {
		for (const [cwd, destination, allowed] of [[work, temp, false], [temp, work, true]] as const) {
			const name = `brace-stack-${allowed}`;
			const command = `{ pushd ${quote(destination)}; { echo harmless; }; }; popd; printf 'restored contents' > ${name}`;
			assertShellWrite(command, cwd, path.join(cwd, name), allowed, [path.join(destination, name)], "restored contents");
		}
	});
});

test("unsupported brace syntax fails closed instead of hiding shell effects", () => {
	withDirectories((work, temp) => {
		const target = path.join(temp, "brace-redirection");
		// Safe trailing redirects are supported: the body runs and stdout lands in temp.
		assertShellWrite(`{ printf 'redirected contents'; } > ${quote(target)}`, work, target, true,
			[path.join(work, "brace-redirection")], "redirected contents");
		for (const command of ["{ echo safe;", "{ };", "{ echo safe; } trailing"]) {
			assert.throws(() => shell(command, temp), command);
			assert.equal(classifyBashCommand(command, temp).ok, false, command);
		}
	});
});

test("literal brace arguments never hide following writes or heredoc execution", () => {
	withDirectories((work, temp) => {
		for (const [index, brace] of ["{", "}"].entries()) {
			const target = path.join(work, `literal-brace-${index}`);
			assertShellWrite(`echo ${brace}; printf 'literal contents' > ${quote(target)}`, temp, target, false, [], "literal contents");
			const heredoc = path.join(work, `brace-heredoc-${index}`);
			assertShellWrite(`echo ${brace}; bash <<'EOF'\nprintf 'heredoc contents' > ${quote(heredoc)}\nEOF`, temp, heredoc, false, [], "heredoc contents");
		}
		assert.equal(classifyBashCommand("{ echo safe;", temp).ok, false);
		assert.equal(classifyBashCommand("(echo safe;", temp).ok, false);
	});
});

test("cwd scope across operator and quoting combinations", () => {
	withDirectories((work, temp) => {
		for (const operator of [";", "&&", "| cat;", "& wait;"]) {
			for (const quoted of [false, true]) {
				const destination = quoted ? quote(temp) : temp;
				const command = `cd ${destination} ${operator} touch grammar`;
				assert.equal(classifyBashCommand(command, work).ok, operator === ";" || operator === "&&", command);
			}
		}
	});
});

test("builtin-wrapped and escaped directory changes are tracked in the parent shell", () => {
	withDirectories((work, temp) => {
		for (const [index, form] of ["builtin cd", "\\cd", "c\\d", 'c""d'].entries()) {
			assertShellWrite(`${form} ${quote(temp)}; touch in-${index}`, work, path.join(temp, `in-${index}`), true,
				[path.join(work, `in-${index}`)]);
			assertShellWrite(`${form} ${quote(work)}; touch out-${index}`, temp, path.join(work, `out-${index}`), false,
				[path.join(temp, `out-${index}`)]);
		}
		assertShellWrite(`builtin pushd ${quote(temp)}; touch stacked`, work, path.join(temp, "stacked"), true,
			[path.join(work, "stacked")]);
		assertShellWrite(`builtin pushd ${quote(work)}; touch stacked-out`, temp, path.join(work, "stacked-out"), false,
			[path.join(temp, "stacked-out")]);
	});
});

test("env-forked directory changes never move the tracked cwd", () => {
	withDirectories((work, temp) => {
		// env cannot exec a shell builtin; even a hypothetical exec would run in a child,
		// so the parent cwd must stay put. `command env cd` previously fooled the tracker.
		for (const [index, form] of ["env cd", "command env cd", "env builtin cd"].entries()) {
			assertShellWrite(`${form} ${quote(temp)}; touch fork-out-${index}`, work, path.join(work, `fork-out-${index}`), false,
				[path.join(temp, `fork-out-${index}`)]);
			assertShellWrite(`${form} ${quote(work)}; touch fork-in-${index}`, temp, path.join(temp, `fork-in-${index}`), true,
				[path.join(work, `fork-in-${index}`)]);
		}
	});
});

test("escaped and builtin-wrapped mutation commands stay recognized", () => {
	withDirectories((work) => {
		// `builtin` only accepts shell builtins, so `builtin rm` errors in real Bash —
		// the classifier blocks it anyway (conservative over-block, fail closed).
		for (const command of ["builtin rm /etc/passwd", "builtin touch /etc/x"]) {
			assert.equal(classifyBashCommand(command, work).ok, false, command);
		}
		for (const [index, form] of ["\\rm", "r\\m", 'r""m'].entries()) {
			const target = path.join(work, `victim-${index}`);
			writeFileSync(target, "contents");
			const command = `${form} ${quote(target)}`;
			assert.equal(classifyBashCommand(command, work).ok, false, command);
			shell(command, work); // real Bash resolves the same executable the classifier blocked
			assert.equal(existsSync(target), false, `${form} really deletes`);
		}
		// The outer shell strips the escape before xargs execs, so xargs runs the real rm.
		const target = path.join(work, "xargs-victim");
		writeFileSync(target, "contents");
		const command = `echo ${quote(target)} | xargs \\rm`;
		assert.equal(classifyBashCommand(command, work).ok, false, command);
		shell(command, work);
		assert.equal(existsSync(target), false, "xargs \\rm really deletes");
		// Arg-form target: the nested builtin unwrap must expose rm to classification.
		assert.equal(classifyBashCommand(`xargs builtin rm ${quote(target)}`, work).ok, false);
		// xargs execs external programs, so `builtin` is not executable here — allowed matches reality.
		assert.equal(classifyBashCommand(`echo ${quote(target)} | xargs builtin rm`, work).ok, true);
	});
});

test("escaped flags before directory builtins stay parsed as flags", () => {
	withDirectories((work, temp) => {
		// `command` flags precede the builtin in the parent shell; Bash strips the escape.
		for (const [index, form] of ["command -p cd", "command \\-p cd", "builtin command -p cd"].entries()) {
			assertShellWrite(`${form} ${quote(temp)}; touch cflag-${index}`, work, path.join(temp, `cflag-${index}`), true,
				[path.join(work, `cflag-${index}`)]);
		}
		// Operand-less `cd \-L` is really `cd -L` (goes to $HOME): classifier-only, since a
		// differential run would touch the real home directory. Fail closed to home, not cwd.
		for (const command of ["cd \\-L; touch home-x", 'cd "-P"; touch home-x', "builtin cd \\-P; touch home-x"]) {
			assert.equal(classifyBashCommand(command, temp).ok, false, command);
		}
		// Escaped `=` is a command word: Bash does not run the following cd.
		assertShellWrite("A\\=b cd /tmp; touch assignment-command", work, path.join(work, "assignment-command"), false);
		assertShellWrite(`cd \\-L ${quote(temp)}; touch escaped-flag-target`, work, path.join(temp, "escaped-flag-target"), true,
			[path.join(work, "escaped-flag-target")]);
	});
});

test("escaped flags of wrapper commands cannot hide the mutation", () => {
	withDirectories((work) => {
		for (const [index, command] of [
			(t: string) => `env \\-i rm ${quote(t)}`,
			(t: string) => `command \\-p rm ${quote(t)}`,
		].entries()) {
			const target = path.join(work, `flag-victim-${index}`);
			writeFileSync(target, "contents");
			const cmd = command(target);
			assert.equal(classifyBashCommand(cmd, work).ok, false, cmd);
			shell(cmd, work); // Bash strips the escape; the real flag and command execute
			assert.equal(existsSync(target), false, cmd);
		}
		// Classifier-only: BSD xargs skips the command on empty stdin, and sudo prompts.
		for (const command of [
			`xargs \\-0 rm ${quote(path.join(work, "x"))}`,
			`xargs "-0" rm ${quote(path.join(work, "x"))}`,
			"sudo \\-u root rm /etc/passwd",
			'sudo "-u" root rm /etc/passwd',
		]) assert.equal(classifyBashCommand(command, work).ok, false, command);
	});
});

test("escaped wrapper flags retain shell heredoc ownership", () => {
	withDirectories((work, temp) => {
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			const name = `escaped-wrapper-${allowed}`;
			assertShellWrite(`nice \\-n 1 bash <<'EOF'\ntouch ${name}\nEOF`, cwd, path.join(cwd, name), allowed,
				[path.join(cwd === work ? temp : work, name)]);
		}
	});
});

test("escaped download flags cannot redirect wget or curl writes", () => {
	withDirectories((work, temp) => {
		for (const command of [
			`wget \\-P ${quote(work)} https://example.com/x`,
			`wget "-P" ${quote(work)} https://example.com/x`,
			`curl \\-o ${quote(path.join(work, "curl-out"))} https://example.com/x`,
		]) assert.equal(classifyBashCommand(command, temp).ok, false, command);
		// -O writes to the cwd: blocked outside temp, allowed inside — escaped form must match.
		assert.equal(classifyBashCommand("curl \\-O https://example.com/x", work).ok, false);
		assert.equal(classifyBashCommand("curl \\-O https://example.com/x", temp).ok, true);
		// Unescaped forms keep their existing verdicts.
		assert.equal(classifyBashCommand(`wget -P ${quote(temp)} https://example.com/x`, work).ok, true);
		assert.equal(classifyBashCommand(`curl -o ${quote(path.join(temp, "ok"))} https://example.com/x`, work).ok, true);
	});
});

test("download and mktemp option values retain quotes until path decoding", () => {
	withDirectories((work, temp) => {
		const outsideValue = quote("/tmp\\/x"), insideValue = quote(path.join(temp, "out"));
		for (const value of [outsideValue, insideValue]) {
			for (const command of [
				`curl -o${value} https://example.com/x`, `curl --output=${value} https://example.com/x`,
				`curl --output-dir=${value} -O https://example.com/x`,
				`wget -P${value} https://example.com/x`, `wget --directory-prefix=${value} https://example.com/x`,
				`D=$(mktemp -d -p ${value}) && touch "$D/probe"`,
				`env -C${value} curl -O https://example.com/x`, `env --chdir=${value} curl -O https://example.com/x`,
				`D=${value} touch "$D"`,
			]) assert.equal(classifyBashCommand(command, work).ok, value === insideValue, command);
		}
	});
});

test("double-quoted assignment values preserve ordinary backslashes", () => {
	withDirectories((work, temp) => {
		for (const separator of [" ", "; "]) {
			const command = `D="/tmp\\/x"${separator}touch "$D/probe"`;
			assert.equal(classifyBashCommand(command, temp).ok, false, command);
		}
		mkdirSync(path.join(temp, "\\"));
		const command = `D="${temp}/\\/literal"; touch "$D"`;
		assertShellWrite(command, work, path.join(temp, "\\", "literal"), true);
	});
});

test("standalone escaped assignments cannot authorize outside-temp writes", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "assignment-probe");
		const command = `D=${escapeSeparators(target)} && touch "$D"`;
		assertShellWrite(command, temp, target, false, [path.join(temp, "assignment-probe")]);
	});
});

test("wget output flag spellings cannot hide an outside destination", () => {
	for (const flag of ['"-O/etc/probe"', '\\-O/etc/probe', '"--output-document=/etc/probe"', '"-O" /etc/probe']) {
		const command = `wget ${flag} https://example.com/x`;
		assert.equal(classifyBashCommand(command, shellPath(TEMP_DIR)).ok, false, command);
	}
});

test("cd - resolves to an unknown directory and blocks subsequent writes", () => {
	withDirectories((work, temp) => {
		// OLDPWD is untracked, so the classifier must fail closed even though a fresh
		// shell happens to error and stay in place.
		assertShellWrite("cd -; touch oldpwd", temp, path.join(temp, "oldpwd"), false, [path.join(work, "oldpwd")]);
	});
});

test("commands following concatenated heredoc delimiters stay classified", () => {
	for (const delimiter of ["EOF", "'E'OF", 'E"O"F', "E\\OF"]) {
		for (const tabs of [false, true]) {
			const operator = tabs ? "<<-" : "<<";
			const prefix = tabs ? "\t" : "";
			const command = `cat ${operator}${delimiter}\n${prefix}inert data\n${prefix}EOF\ntouch blocked`;
			assert.equal(classifyBashCommand(command, outside).ok, false, command);
		}
	}
});

test("escaped and ANSI-C substitutions and source-stdin owners are classified", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "blocked");
		const write = `touch ${quote(target)}`;
		// The outer shell turns \$( into $( for the nested -c/eval argument.
		assert.equal(classifyBashCommand(`bash -c "echo \\$(rm ${quote(target)})"`, temp).ok, false);
		assert.equal(classifyBashCommand(`eval "echo \\$(rm ${quote(target)})"`, temp).ok, false);
		// ANSI-C quoting decodes to code before the nested shell runs it.
		assert.equal(classifyBashCommand(`bash -c $'echo $(rm ${quote(target)})'`, temp).ok, false);
		// source/. execute their stdin in the current shell.
		assert.equal(classifyBashCommand(`source /dev/stdin <<'EOF'\n${write}\nEOF`, temp).ok, false);
		assert.equal(classifyBashCommand(`. /dev/stdin <<'EOF'\n${write}\nEOF`, temp).ok, false);
	});
});

test("heredocs left on a persistent exec fd or stdin fail closed", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "blocked");
		const write = `touch ${quote(target)}`;
		// `exec` without a command does not run the body: it keeps the heredoc on the
		// shell's stdin (or the named fd) so a later command can execute it.
		for (const owner of ["exec <<", "exec 3<<", "exec {fd}<<", "command exec 3<<", "builtin exec <<"]) {
			assert.equal(classifyBashCommand(`${owner}'EOF'\n${write}\nEOF\nsource /dev/stdin`, work).ok, false, owner);
		}
		assert.equal(classifyBashCommand(`exec <<< ${quote(write)}\nbash`, work).ok, false);
		// Real bash executes the persisted body when a later command reads the fd.
		assertShellWrite(`exec 3<<'EOF'\n${write}\nEOF\nsource /dev/fd/3`, work, target, false, [path.join(temp, "blocked")]);
	});
});

test("heredocs and redirections cannot hide an outside write", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "blocked");
		const write = `touch ${quote(target)}`;
		// B3: a quoted `)` must not truncate the heredoc body before the mutation is seen.
		assert.equal(classifyBashCommand(`bash <<'EOF'\necho ')'\n${write}\nEOF`, temp).ok, false);
		// B4: an operator-continued header keeps the body as executable shell stdin.
		assert.equal(classifyBashCommand(`cat <<'EOF' |\nbash\n${write}\nEOF`, temp).ok, false);
		// B5a: a leading redirect must not hide a directory change.
		assert.equal(classifyBashCommand(`> ${quote(temp)}/out cd ${quote(work)}; touch rel`, temp).ok, false);
		// B5b: a subshell with a trailing redirect is still classified.
		assert.equal(classifyBashCommand(`(cd ${quote(work)}; touch rel) > ${quote(temp)}/out`, temp).ok, false);
		// Every leading redirect operator leaves the command word visible.
		for (const operator of [">", ">>", ">|", "<", "<>", "&>"]) {
			assert.equal(classifyBashCommand(`${operator} ${quote(temp)}/out cd ${quote(work)}; touch rel`, temp).ok, false, operator);
		}
		// `|&` pipes stdout+stderr into the shell, so the body executes.
		assert.equal(classifyBashCommand(`cat <<'EOF' |& bash\n${write}\nEOF`, temp).ok, false);
		// A command substitution inside double quotes is still active.
		assert.equal(classifyBashCommand(`bash -c "$(rm ${quote(target)})"`, temp).ok, false);
	});
});

// A data-consumer heredoc is inert to its own command, but when an outer shell consumes the
// substitution result as its script (`bash -c`, `eval`, `<(…)`), that body becomes the child's
// program text. It must be classified as code, or `bash -c "$(cat <<EOF … rm … EOF)"` escapes.
test("substitution results consumed as shell scripts classify their heredoc bodies as code", () => {
	withDirectories((work, temp) => {
		const target = path.join(work, "subst-heredoc");
		const write = `touch ${quote(target)}`;
		const commands = [
			`bash -c "$(cat <<'EOF'\n${write}\nEOF\n)"`,
			`eval "$(cat <<'EOF'\n${write}\nEOF\n)"`,
			`bash <(cat <<'EOF'\n${write}\nEOF\n)`,
			`source <(cat <<'EOF'\n${write}\nEOF\n)`,
		];
		for (const command of commands) assert.equal(classifyBashCommand(command, temp).ok, false, command);
		// Benign and inside-temp bodies stay allowed, so real workflows keep working.
		assert.equal(classifyBashCommand(`bash -c "$(cat <<'EOF'\necho ok\nEOF\n)"`, temp).ok, true);
		const inside = path.join(temp, "subst-inside");
		assertShellWrite(`bash -c "$(cat <<'EOF'\ntouch ${quote(inside)}\nEOF\n)"`, temp, inside, true, [target]);
	});
});

test("trailing redirects agree with real bash and never become command operands", () => {
	withDirectories((work, temp) => {
		// The redirect is validated on the raw segment; the operand stays classified.
		// Real bash writes only inside temp — the classifier must allow the same command.
		assertShellWrite(`touch redirected 2>/dev/null`, temp, path.join(temp, "redirected"), true,
			[path.join(work, "redirected")]);
		assertShellWrite(`printf 'redirected contents' > out.txt 2>/dev/null`, temp, path.join(temp, "out.txt"), true,
			[path.join(work, "out.txt")], "redirected contents");
		// An outside write with a trailing redirect: bash really writes it (differential),
		// so the classifier must block — and name the file, not the redirect token.
		const target = path.join(work, "redirect-outside");
		const verdict = classifyBashCommand(`touch ${quote(target)} 2>/dev/null`, work);
		assert.equal(verdict.ok, false);
		// The reason names the real write target, never the `2>/dev/null` token.
		assert.ok(verdict.reason.includes(`touch blocked outside temp dir: ${target}`), verdict.reason);
		assert.ok(!verdict.reason.includes("2>/dev/null"), verdict.reason);
		// Immutable git with a trailing redirect stays classified by its subcommand.
		assert.equal(classifyBashCommand("git status 2>/dev/null", work).ok, true);
		assert.equal(classifyBashCommand("git init 2>/dev/null", work).ok, false);
	});
});

test("cd and pushd through a missing or non-directory intermediate fail closed", () => {
	withDirectories((work, temp) => {
		const missing = `${quote(path.join(temp, "missing"))}/..`;
		const file = `${quote(path.join(temp, "afile"))}/..`;
		writeFileSync(path.join(temp, "afile"), "");
		// Real bash rejects the missing/ENOTDIR intermediate and stays in work, so the
		// trailing write lands outside temp; the lexical target inside temp must not fool us.
		assertShellWrite(`cd ${missing}; touch traversed-missing`, work, path.join(work, "traversed-missing"), false,
			[path.join(temp, "traversed-missing")]);
		assertShellWrite(`pushd ${missing}; touch traversed-pushd`, work, path.join(work, "traversed-pushd"), false,
			[path.join(temp, "traversed-pushd")]);
		assert.equal(classifyBashCommand(`cd ${file}; touch traversed-file`, work).ok, false);
		// Positive control: an existing intermediate collapses to its parent, inside temp.
		mkdirSync(path.join(temp, "real"));
		const real = `${quote(path.join(temp, "real"))}/..`;
		assertShellWrite(`cd ${real}; touch reached`, temp, path.join(temp, "reached"), true, [path.join(work, "reached")]);
	});
});

test("missing synthetic-looking paths cannot establish directory provenance", () => {
	withDirectories((work) => {
		const missing = shellPath(path.join(TEMP_DIR, `.pi-mktemp-missing-${process.pid}`));
		assert.equal(existsSync(missing), false);
		assertShellWrite(`cd ${quote(missing)}; touch escaped`, work, path.join(work, "escaped"), false);
	});
});

test("literal mktemp substitutions cannot grant directory provenance", () => {
	withDirectories((work) => {
		const values = [
			["$(mktemp -d)", "'$(mktemp -d)'"],
			["`mktemp -d`", "'`mktemp -d`'"],
			["$(mktemp -d)", "'$('\"mktemp -d)\""],
			["`mktemp -d`", "'`'\"mktemp -d\"'`'"],
			["$(mktemp -d)", "'$(mktemp -d)'\"\""],
		];
		for (const [index, [literal, value]] of values.entries()) {
			const directory = path.join(work, literal!);
			mkdirSync(directory, { recursive: true });
			assertShellWrite(`D=${value} && cd "$D" && touch escaped-${index}`,
				work, path.join(directory, `escaped-${index}`), false);
		}
	});
});

test("file mktemp and dry-run directories cannot move later writes into temp", () => {
	withDirectories((work, temp) => {
		for (const [index, flags] of ["", "-d -u"].entries()) {
			const template = path.join(temp, `file-${index}.XXXXXX`);
			assertShellWrite(`D=$(mktemp ${flags} ${quote(template)}); cd "$D"; touch escaped-${index}`,
				work, path.join(work, `escaped-${index}`), false);
		}
	});
});

test("redirected mktemp output cannot give an empty assignment directory provenance", () => {
	withDirectories((work, temp) => {
		const template = path.join(temp, "redirected.XXXXXX"), record = path.join(temp, "created-path");
		const command = `D=$(mktemp -d ${quote(template)} > ${quote(record)}); touch "$D${work}/escaped"`;
		assertShellWrite(command, work, path.join(work, "escaped"), false);
	});
});

test("failed mktemp creation preserves assignment and cd failure branches", () => {
	withDirectories((work, temp) => {
		const template = path.join(temp, "missing-parent", "dir.XXXXXX");
		const create = `D=$(mktemp -d ${quote(template)})`;
		assertShellWrite(`${create}; cd "$D"; touch escaped`, work, path.join(work, "escaped"), false);
		assertShellWrite(`${create} || touch fallback`, work, path.join(work, "fallback"), false);
		const guarded = `${create} && cd "$D" && touch skipped`;
		assert.throws(() => shell(guarded, work));
		assert.equal(existsSync(path.join(work, "skipped")), false);
		assert.equal(classifyBashCommand(guarded, work).ok, true);
	});
});

test("declaration builtins cannot use their status to prove mktemp success", () => {
	withDirectories((work, temp) => {
		const create = `mktemp -d ${quote(path.join(temp, "missing-parent", "dir.XXXXXX"))}`;
		for (const [index, declaration] of ["export", "declare", "typeset", "readonly", "declare -r", "typeset -r"].entries()) {
			assertShellWrite(`${declaration} D=$(${create}) && touch "$D$PWD/escaped-${index}"`,
				work, path.join(work, `escaped-${index}`), false);
		}
		// local is valid only in a function, but masks substitution failure there too.
		assertShellWrite(`f() { local D=$(${create}) && touch "$D$PWD/escaped-local"; }; f`,
			work, path.join(work, "escaped-local"), false);
	});
});

test("multiple substitutions do not prove earlier mktemp success", () => {
	withDirectories((work, temp) => {
		const create = `mktemp -d ${quote(path.join(temp, "missing-parent", "dir.XXXXXX"))}`;
		for (const [index, value] of ["$(printf x)", "`printf x`"].entries()) {
			assertShellWrite(`D=$(${create}) E=${value} && touch "$D$PWD/escaped-${index}"`,
				work, path.join(work, `escaped-${index}`), false);
		}
	});
});

test("successful mktemp directory chains write only after guarded creation and cd", () => {
	withDirectories((work, temp) => {
		const record = path.join(temp, "created-path");
		const create = `mktemp -d ${quote(path.join(temp, "dir.XXXXXX"))}`;
		for (const value of [`$(${create})`, `"$(${create})"`, `\`${create}\``, `"\`${create}\`"`]) {
			const command = `D=${value} && cd "$D" && touch reached && printf '%s' "$D" > ${quote(record)}`;
			shell(command, work);
			assert.equal(readFileSync(path.join(readFileSync(record, "utf8"), "reached"), "utf8"), "");
			assert.equal(existsSync(path.join(work, "reached")), false);
			assert.equal(classifyBashCommand(command, work).ok, true, command);
		}
	});
});

test("mktemp templates select the synthetic directory and its write roots", () => {
	withDirectories((work, temp) => {
		// An absolute template outside temp creates the directory outside; the synthetic
		// stand-in must not claim it is inside a temp root.
		assert.equal(classifyBashCommand(`D=$(mktemp -d /etc/pi-x.XXXXXX); cd "$D"; touch f`, work).ok, false);
		// A relative template resolves against the outside cwd and is equally unsafe.
		assert.equal(classifyBashCommand(`D=$(mktemp -d pi-x.XXXXXX); cd "$D"; touch f`, work).ok, false);
		// -p pins the base inside temp, so a relative template under it stays safe.
		assert.equal(classifyBashCommand(`D=$(mktemp -d -p ${quote(temp)} pi-x.XXXXXX) && cd "$D" && git init`, work).ok, true);
	});
});

test("unknown heredoc stdin owners fail closed while data consumers stay inert", () => {
	const write = `touch ${quote(path.join(outside, "blocked"))}`;
	// Unlisted interpreters execute their stdin but cannot be classified, so block.
	for (const owner of ["fish", "ash", "./script.sh"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${write}\nEOF`, outside).ok, false, owner);
	}
	// Allowlisted data consumers keep the body inert.
	for (const owner of ["cat", "grep pattern", "sed s/a/b/", "tee", ":"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${write}\nEOF`, outside).ok, true, owner);
	}
	for (const owner of ["true", "false"]) assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${write}\nEOF`, outside).ok, true, owner);
	// tee's own file target is still checked in the header regardless of the inert body.
	assert.equal(classifyBashCommand(`tee ${quote(path.join(outside, "blocked"))} <<'EOF'\nbody\nEOF`, outside).ok, false);
});

test("heredoc execution precedes trailing commands and follows earlier header commands", () => {
	withDirectories((work, temp) => {
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			const other = allowed ? work : temp;
			for (const [index, prefix] of ["", `cd ${quote(cwd)}; `].entries()) {
				const name = `header-order-${index}-${allowed}`;
				const command = `${prefix}bash <<'EOF'; cd ${quote(other)}\ntouch ${name}\nEOF`;
				assertShellWrite(command, index ? other : cwd, path.join(cwd, name), allowed, [path.join(other, name)]);
			}
		}
	});
});

test("multiple heredocs execute at their own header positions", () => {
	withDirectories((work, temp) => {
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			const first = `first-header-${allowed}`, second = `second-header-${allowed}`;
			const command = `bash <<'ONE'; cd ${quote(temp)}; bash <<'TWO'\ntouch ${first}\nONE\ntouch ${second}\nTWO`;
			assertShellWrite(command, cwd, path.join(cwd, first), allowed);
			assert.equal(readFileSync(path.join(temp, second), "utf8"), "");
			if (!allowed) assert.equal(existsSync(path.join(temp, first)), false);
		}
	});
});

test("unquoted shell heredocs expand parent variables before child assignments", () => {
	withDirectories((work, temp) => {
		for (const [parent, allowed] of [[work, false], [temp, true]] as const) {
			const child = allowed ? work : temp;
			for (const [index, reference] of ["$D", "${D}"].entries()) {
				const name = `parent-expansion-${index}-${allowed}`;
				const command = `D=${quote(parent)}; bash <<EOF\nD=${quote(child)}\ntouch "${reference}/${name}"\nEOF`;
				assertShellWrite(command, temp, path.join(parent, name), allowed, [path.join(child, name)]);
			}
		}
	});
});

test("heredoc quotes do not suppress parent expansion but backslashes do", () => {
	withDirectories((work, temp) => {
		for (const [target, allowed] of [[work, false], [temp, true]] as const) {
			const other = allowed ? work : temp;
			const single = `single-quote-${allowed}`, escaped = `escaped-parent-${allowed}`;
			assertShellWrite(`D=${quote(target)}; bash <<EOF\nD=${quote(other)}\ntouch '$D/${single}'\nEOF`, temp,
				path.join(target, single), allowed, [path.join(other, single)]);
			assertShellWrite(`D=${quote(other)}; bash <<EOF\nD=${quote(target)}\ntouch "\\$D/${escaped}"\nEOF`, temp,
				path.join(target, escaped), allowed, [path.join(other, escaped)]);
		}
	});
});

test("failed output fd duplication cannot leak a directory change", () => {
	withDirectories((work, temp) => {
		for (const [cwd, allowed] of [[work, false], [temp, true]] as const) {
			for (const [index, duplicate] of ["3>&999", "3>&$FD"].entries()) {
				const name = `failed-output-fd-${index}-${allowed}`;
				// Both possible cwd states are temp in the allowed case.
				const destination = path.join(temp, "fd-destination");
				mkdirSync(destination, { recursive: true });
				assertShellWrite(`FD=999; cd ${quote(destination)} ${duplicate}; touch ${name}`, cwd,
					path.join(cwd, name), allowed, [path.join(destination, name)]);
			}
		}
	});
});

test("group, -c cwd, and var-expansion heredoc escapes match real bash", () => {
	withDirectories((work, temp) => {
		// Group members share the heredoc stdin: the bash member executes the body.
		assertShellWrite(`{ :; bash; } <<'EOF'\ntouch group-shared\nEOF`, work, path.join(work, "group-shared"), false,
			[path.join(temp, "group-shared")]);
		// The body runs at the cwd left by the consumer's -c script, not the parent's.
		assertShellWrite(`cd ${quote(temp)}; bash -c 'cd ${quote(work)}; bash' <<'EOF'\ntouch dash-c-cwd\nEOF`, work,
			path.join(work, "dash-c-cwd"), false, [path.join(temp, "dash-c-cwd")]);
		// Unquoted bodies expand tracked variables into executable code.
		const expanded = path.join(work, "var-expanded");
		assertShellWrite(`CMD='touch ${quote(expanded)}'; bash <<EOF\n$CMD\nEOF`, work, expanded, false,
			[path.join(temp, "var-expanded")]);
		// No differential for GNU sed `e` here: BSD sed (macOS) lacks the command, while
		// the classifier must assume GNU semantics (covered in the classifier suite).
		// A group of pure data consumers keeps the body inert in both classifier and bash.
		const inert = `inert-${process.pid}`;
		assert.equal(classifyBashCommand(`{ cat; cat; } <<'EOF'\ntouch ${inert}\nEOF`, work).ok, true);
		shell(`{ cat; cat; } <<'EOF'\ntouch ${inert}\nEOF`, work);
		assert.equal(existsSync(path.join(work, inert)), false);
	});
});

// Multiline quoted sed headers leave the header line inside an open quote, so heredoc
// detection bails and the body must be classified as code (fail closed) — never inert.
test("multiline quoted sed scripts over-block their heredoc bodies", () => {
	const target = path.join(outside, "blocked");
	const write = `touch ${quote(target)}`;
	for (const header of [
		"sed 's/a/b\ns/c/d' <<EOF",
		"sed 's/a/b\ne' <<EOF",
		"sed 's/a/b\\\ns/c/d' <<EOF",
		"sed 's/a/b\ns/c/d' <<EOF |",
	]) {
		const command = `${header}\n${write}\nEOF`;
		const verdict = classifyBashCommand(command, outside);
		assert.equal(verdict.ok, false, command);
		assert.ok(verdict.reason.includes(`touch blocked outside temp dir: ${target}`), verdict.reason);
	}
	// Single-line `; e` is still parseable, so it hits the GNU-`e` detection instead.
	const verdict = classifyBashCommand(`sed 's/a/b; e' <<EOF\n${write}\nEOF`, outside);
	assert.equal(verdict.ok, false);
	assert.ok(verdict.reason.includes("unsupported stdin code"), verdict.reason);
});

test("file mktemp provenance allows file writes without proving directories", () => {
	withDirectories((work, temp) => {
		const record = path.join(temp, "file-content");
		const template = quote(path.join(temp, "f.XXXXXX"));
		const command = `f=$(mktemp ${template}) && printf 'file contents' > "$f" && cat "$f" > ${quote(record)}`;
		shell(command, work);
		assert.equal(readFileSync(record, "utf8"), "file contents");
		assert.equal(existsSync(path.join(work, "file-content")), false);
		assert.equal(classifyBashCommand(command, work).ok, true, command);
		// A file path never proves a directory: the cd fails in real bash, so `;` keeps the outside cwd.
		assertShellWrite(`f=$(mktemp ${template}); cd "$f"; touch escaped-file`, work, path.join(work, "escaped-file"), false);
	});
});

test("failed double-quoted directory change with ordinary backslashes keeps the caller cwd", () => {
	withDirectories((work, temp) => {
		// Real Bash keeps an ordinary quoted backslash: `/\tmp` is a missing root entry,
		// so the cd fails and the relative write lands back in the caller cwd. Command-word
		// unescaping must not rewrite the operand to the real /tmp.
		const missing = "\\tmp";
		assert.equal(existsSync(`/${missing}`), false);
		assertShellWrite(`cd "/${missing}"; touch dq`, work, path.join(work, "dq"), false, [path.join(temp, "dq")]);
		assertShellWrite(`cd '/${missing}'; touch sq`, work, path.join(work, "sq"), false, [path.join(temp, "sq")]);
		// Double-quoted and escaped-separator cd positives are differential-checked against
		// the mkdtemp temp dir below; `/tmp` itself is excluded because the node runner
		// cannot read root-level /tmp files under the extension's own sandbox.
		// Escaped separators in the operand decode to the temp directory itself.
		assertShellWrite(`cd ${escapeSeparators(temp)}; touch in`, work, path.join(temp, "in"), true,
			[path.join(work, "in")]);
	});
});

test("ordinary quoted backslashes cannot invent a directory builtin or flag", () => {
	withDirectories((work, temp) => {
		for (const [index, invocation] of ['"\\\\cd"', 'cd "\\\\-L"', 'command "\\\\-p" cd', '"A=b" cd', 'command -z cd', 'command -pv cd'].entries()) {
			const file = `quoted-builtin-${index}`;
			assertShellWrite(`${invocation} ${quote(temp)}; touch ${file}`, work, path.join(work, file), false,
				[path.join(temp, file)]);
		}
	});
});

test("escaped separators in operands decode to the real write location", () => {
	withDirectories((work, temp) => {
		// Unquoted `\/` decodes to `/`: real Bash writes the work file although the raw
		// operand text has no bare separator, so the decoded path must be checked.
		assertShellWrite(`cd ${quote(temp)} && touch ${escapeSeparators(work)}/operand`, work,
			path.join(work, "operand"), false, [path.join(temp, "operand")]);
		assertShellWrite(`touch ${escapeSeparators(temp)}/allowed-operand`, work, path.join(temp, "allowed-operand"), true,
			[path.join(work, "allowed-operand")]);
	});
});

test("escaped separators in redirects decode to the real write location", () => {
	withDirectories((work, temp) => {
		assertShellWrite(`cd ${quote(temp)} && echo escaped > ${escapeSeparators(work)}/redirect`, work,
			path.join(work, "redirect"), false, [path.join(temp, "redirect")], "escaped\n");
		assertShellWrite(`echo escaped > ${escapeSeparators(temp)}/allowed-redirect`, work, path.join(temp, "allowed-redirect"), true,
			[path.join(work, "allowed-redirect")], "escaped\n");
		assertShellWrite(`cd ${quote(temp)} && echo escaped >> ${escapeSeparators(work)}/append`, work,
			path.join(work, "append"), false, [path.join(temp, "append")], "escaped\n");
	});
});

test("variable values with literal backslashes stay data and decode once", () => {
	withDirectories((work, temp) => {
		// The single-quoted value keeps `\/` as data: real Bash writes through the literal
		// `\` directory, while decoding the expansion again would follow the `x` symlink
		// outside temp. Allowing proves the expanded value is not re-decoded.
		mkdirSync(path.join(temp, "\\"));
		symlinkSync(work, path.join(temp, "x"));
		const value = quote(path.join(temp, "\\/x"));
		assertShellWrite(`D=${value} && touch "$D"`, work, path.join(temp, "\\", "x"), true, [path.join(work, "x")]);
	});
});

test("quoted escaped separators are literal relative paths, not absolute ones", () => {
	withDirectories((work, temp) => {
		// Double quotes keep `\/`: real Bash resolves a RELATIVE path whose components are
		// named `\` and `etc\` — decoding it again would invent an absolute /etc path.
		for (const base of [work, temp]) {
			mkdirSync(path.join(base, "\\"));
			mkdirSync(path.join(base, "\\", "etc\\"));
		}
		assertShellWrite('touch "\\/etc\\/probe-w"', work, path.join(work, "\\", "etc\\", "probe-w"), false,
			[path.join(temp, "\\", "etc\\", "probe-w")]);
		assertShellWrite('touch "\\/etc\\/probe-t"', temp, path.join(temp, "\\", "etc\\", "probe-t"), true,
			[path.join(work, "\\", "etc\\", "probe-t")]);
	});
});

test("glob-matched operands act on every matched temp file", () => {
	withDirectories((work, temp) => {
		// `*` only matches existing entries, so the targets must exist first. A redirect
		// over multiple matches would be an ambiguous redirect; rm fans out over both.
		const dirs = ["glob\\one", "glob'\"two", "$LITERAL"];
		for (const dir of dirs) {
			mkdirSync(path.join(temp, dir));
			writeFileSync(path.join(temp, dir, "out"), "kept");
		}
		const command = `rm ${temp}/*/out`;
		assert.equal(classifyBashCommand(command, work).ok, true, command);
		shell(command, work);
		for (const dir of dirs) assert.equal(existsSync(path.join(temp, dir, "out")), false);
	});
});

test("brace trailing redirects run the body unless the redirect aborts", () => {
	withDirectories((work, temp) => {
		const log = quote(path.join(temp, "outer"));
		assertShellWrite(`{ printf 'brace-redirect' > inner; } > ${log}`, temp, path.join(temp, "inner"), true,
			[path.join(work, "inner")], "brace-redirect");
		assert.equal(readFileSync(path.join(temp, "outer"), "utf8"), "");
		assert.equal(classifyBashCommand(`{ printf 'x'; } >${log}`, work).ok, true);
		// A failing trailing redirect skips the body: the cwd stays outside for `;` chains.
		const name = "brace-abort";
		assertShellWrite(`{ cd ${quote(temp)}; } >${quote(path.join(temp, "missing", "out"))}; touch ${name}`, work,
			path.join(work, name), false, [path.join(temp, name)]);
		const conditional = `{ cd ${quote(temp)}; } >${quote(path.join(temp, "missing", "out"))} && touch ${name}-conditional; :`;
		shell(conditional, work);
		for (const cwd of [work, temp]) assert.equal(existsSync(path.join(cwd, `${name}-conditional`)), false);
		assert.equal(classifyBashCommand(conditional, work).ok, true, conditional);
	});
});

// These need home-dir fixtures and a real bash, exactly what the gate above proves.
test("a brace group failure branch classifies in the body's moved cwd", () => {
	withDirectories((work, temp) => {
		// Real bash: `cd` moves the parent shell, `false` fails the group, and the `||`
		// branch writes in the moved (outside) cwd. Reusing the caller cwd let it pass.
		assertShellWrite(`{ cd ${quote(work)}; false; } || touch leaked`, temp,
			path.join(work, "leaked"), false, [path.join(temp, "leaked")]);
		// A body that ends in a directory change keeps the caller-cwd fallback: the failed
		// `cd` leaves the caller cwd, and the successful case never runs the branch.
		assert.equal(classifyBashCommand(`{ cd ${quote(temp)}; } || touch fallback`, work).ok, false);
		assert.equal(classifyBashCommand(`{ cd ${quote(temp)}; } || touch fallback`, temp).ok, true);
		// A following `;` command inherits the body's final cwd.
		assertShellWrite(`{ cd ${quote(temp)}; false; }; touch after`, work,
			path.join(temp, "after"), true, [path.join(work, "after")]);
	});
});

test("a failed redirect inside a brace group keeps the intermediate cwd for the fallback", () => {
	withDirectories((work, temp) => {
		// Real bash: `cd work` runs first, the missing redirect aborts `cd temp`, so the group
		// fails while the shell stays in work and `|| touch rel` writes outside temp.
		const missing = quote(path.join(temp, "pi-definitely-missing-input"));
		assertShellWrite(`cd ${quote(temp)} && { cd ${quote(work)}; cd ${quote(temp)} <${missing}; } || touch rel`,
			work, path.join(work, "rel"), false, [path.join(temp, "rel")]);
		// The all-inside variant stays allowed because the fallback runs in temp.
		assertShellWrite(`cd ${quote(temp)} && { cd ${quote(temp)}; cd ${quote(temp)} <${missing}-inside; } || touch rel-inside`,
			work, path.join(temp, "rel-inside"), true, [path.join(work, "rel-inside")]);
	});
});

test("an eval failure branch keeps the unknown cwd so `||` writes fail closed", () => {
	withDirectories((work, temp) => {
		// Real bash: eval moves the shell outside, fails, and the `||` branch writes there.
		assertShellWrite(`eval "cd ${quote(work)}; false" || touch leaked`, temp,
			path.join(work, "leaked"), false, [path.join(temp, "leaked")]);
		// Non-mutating fallbacks stay allowed at the unknown cwd.
		assert.equal(classifyBashCommand(`eval "cd ${quote(work)}; false" || echo ok`, temp).ok, true);
		assert.equal(classifyBashCommand('eval "true" || echo x', temp).ok, true);
	});
});

test("a provable brace success still checks the fallback in the caller cwd", () => {
	withDirectories((work, temp) => {
		// CONTRACT: the `||` union over-blocks provable success by design. Real bash
		// never takes the branch, so no file lands anywhere; the classifier still
		// checks the fallback in the caller cwd. A runtime failure the classifier
		// cannot model would run the fallback there, so the superset stays safe.
		const target = path.join(work, "rel-pinned");
		const command = `cd ${quote(work)} && { cd ${quote(temp)}; } || touch rel-pinned`;
		shell(command, work);
		assert.equal(existsSync(target), false);
		assert.equal(existsSync(path.join(temp, "rel-pinned")), false);
		assert.equal(classifyBashCommand(command, work).ok, false, command);
	});
});

test("a resolved dynamic command word moves the tracked cwd", () => {
	withDirectories((work, temp) => {
		// Real bash expands `$cmd` to `cd` and moves the parent shell.
		assertShellWrite(`cmd=cd; $cmd ${quote(work)}; touch leaked`, temp,
			path.join(work, "leaked"), false, [path.join(temp, "leaked")]);
		assertShellWrite(`cmd=cd; $cmd ${quote(temp)}; touch inside`, work,
			path.join(temp, "inside"), true, [path.join(work, "inside")]);
		// A dynamic word that resolves to a non-builtin keeps the cwd.
		assert.equal(classifyBashCommand('cmd=echo; $cmd hi', temp).ok, true);
		// An unresolvable command word fails closed for later relative writes.
		assert.equal(classifyBashCommand(`cmd=$(cat missing); $cmd ${quote(work)}; touch leaked`, temp).ok, false);
	});
});

test("a double-quoted heredoc delimiter keeps backslashes exactly like Bash", () => {
	withDirectories((work, temp) => {
		// Bash keeps `\` before ordinary chars inside double quotes, so the delimiter is
		// `E\q`: the first `E\q` line closes the heredoc and the next line executes.
		const command = `cat <<"E\\q"\nE\\q\ntouch ${quote(path.join(work, "leaked"))}\nEq\n:`;
		assertShellWrite(command, temp, path.join(work, "leaked"), false, [path.join(temp, "leaked")]);
	});
});

test("an ANSI-C fragment does not truncate a heredoc delimiter word", () => {
	withDirectories((work, temp) => {
		// Bash joins `$'E'` and the adjoining literal `O` into the delimiter `EO`. A guard that
		// returns at the ANSI-C fragment reads `E` and treats the real command as inert body data.
		const command = `cat <<$'E'O\ndata\nEO\ntouch ${quote(path.join(work, "blocked"))}\nE\nexit 0`;
		assertShellWrite(command, work, path.join(work, "blocked"), false, [path.join(temp, "blocked")]);
		const control = `cat <<$'E'O\ndata\nEO\ntouch ${quote(path.join(temp, "control"))}\nE\nexit 0`;
		assertShellWrite(control, work, path.join(temp, "control"), true, [path.join(work, "control")]);
	});
});
}

// ── Classifier-only coverage ──────────────────────────────────────
// These call classifyBashCommand directly with string fixtures: no subprocesses and no
// outside-temp writes, so they run on every host instead of behind the capability gate above.
// `JSON.stringify` quotes paths portably (the gate above uses POSIX single quotes).
const classifierQuote = (value: string): string => JSON.stringify(value);

test("tracked command definitions fail closed even without a subsequent write", () => {
	for (const name of trackedShellNames) {
		for (const definition of [
			`${name}() { :; }`, `function ${name} { :; }`, `function ${name} () { :; }`,
			`'${name}' () { :; }`, `if true; then ${name}() { :; }; fi`,
			`f() { ${name}() { :; }; }`, `alias '${name}=:'`, `builtin alias ${name}=:`,
			`if true; then alias ${name}=:; fi`,
		]) assertTrackedDefinitionBlocked(definition, shellPath(TEMP_DIR));
	}
	for (const dynamic of ['alias "$NAME=:"', 'alias "$NAME"', "ARGS='cd=:'; alias $ARGS"]) assertTrackedDefinitionBlocked(dynamic, shellPath(TEMP_DIR));
	assert.equal(classifyBashCommand("echo 'cd() { :; }'; alias cd", shellPath(TEMP_DIR)).ok, true);
});

test("mktemp option forms resolve a temp base and fail closed on a foreign base", () => {
	const foreign = path.join(os.homedir(), "readonly-mktemp-foreign");
	// CONTRACT: every base option the parser accepts keeps the synthetic in-temp directory.
	for (const base of [`-p ${classifierQuote(shellPath(TEMP_DIR))}`, `-p${classifierQuote(shellPath(TEMP_DIR))}`, `--tmpdir ${classifierQuote(shellPath(TEMP_DIR))}`, `--tmpdir=${classifierQuote(shellPath(TEMP_DIR))}`]) {
		assert.equal(classifyBashCommand(`D=$(mktemp -d ${base} pi-x.XXXXXX) && cd "$D" && touch f`, outside).ok, true, base);
	}
	// A base outside temp makes the created directory unprovable, so the later write blocks.
	for (const base of [`-p ${classifierQuote(foreign)}`, `--tmpdir=${classifierQuote(foreign)}`]) {
		assert.equal(classifyBashCommand(`D=$(mktemp -d ${base} pi-x.XXXXXX) && cd "$D" && touch f`, outside).ok, false, base);
	}
	// An absolute template is resolved against the base, so an outside template blocks.
	const absTemplate = classifierQuote(path.join(foreign, "abs.XXXXXX"));
	assert.equal(classifyBashCommand(`D=$(mktemp -d -p ${classifierQuote(shellPath(TEMP_DIR))} ${absTemplate}) && cd "$D" && touch f`, outside).ok, false);
	// `-t` names the OS temp dir on darwin; every other platform rejects the form and fails closed.
	assert.equal(classifyBashCommand("D=$(mktemp -d -t pi-x.XXXXXX) && cd \"$D\" && touch f", outside).ok, process.platform === "darwin");
});

test("heredoc stdin owners decide whether the body is code or inert", () => {
	const body = `touch ${classifierQuote(path.join(outside, "blocked"))}`;
	// Unknown interpreters cannot be classified, so their stdin body fails closed.
	for (const owner of ["fish", "ash", "./script.sh"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${body}\nEOF`, outside).ok, false, owner);
	}
	// Explicit data consumers keep the body inert.
	for (const owner of ["cat", "grep x", "sed s/a/b/", "tee", ":"]) {
		assert.equal(classifyBashCommand(`${owner} <<'EOF'\n${body}\nEOF`, outside).ok, true, owner);
	}
	// A shell owner executes the body as code.
	assert.equal(classifyBashCommand(`bash <<'EOF'\n${body}\nEOF`, outside).ok, false);
});

test("file mktemp proves file paths without proving directories", () => {
	// The fixed regression: a bare `mktemp` file supports writes through the variable.
	assert.equal(classifyBashCommand(`f=$(mktemp) && printf x > "$f"`, outside).ok, true);
	assert.equal(classifyBashCommand(`f=$(mktemp ${classifierQuote(`${shellPath(TEMP_DIR)}/f.XXXXXX`)}) && printf x > "$f"`, outside).ok, true);
	// File provenance never proves a directory, even with a temp template.
	assert.equal(classifyBashCommand(`D=$(mktemp) && cd "$D" && touch f`, outside).ok, true);
	assert.equal(classifyBashCommand(`D=$(mktemp); cd "$D"; touch f`, outside).ok, false);
	// Unsafe templates and foreign bases stay blocked for files too.
	const foreignFile = classifierQuote(`${shellPath(TEMP_DIR)}/../readonly-mktemp-foreign.XXXXXX`);
	assert.equal(classifyBashCommand(`f=$(mktemp ${foreignFile}) && printf x > "$f"`, outside).ok, false);
	assert.equal(classifyBashCommand(`f=$(mktemp -p ${classifierQuote(outside)} f.XXXXXX) && printf x > "$f"`, outside).ok, false);
	// Failed-substitution guards apply to files: masked status and extra substitutions prove nothing.
	assert.equal(classifyBashCommand(`export f=$(mktemp -d /nope/x.XXXXXX) && printf x > "$f"`, outside).ok, false);
	assert.equal(classifyBashCommand(`f=$(mktemp) e=$(printf x) && printf y > "$f"`, outside).ok, false);
	assert.equal(classifyBashCommand(`f=$(mktemp > /tmp/rec) && printf x > "$f"`, outside).ok, false);
});

test("no-sandbox classifier decodes escaped separators in operands and redirects", {
	skip: posixHost ? false : "POSIX path literals",
}, () => {
	// L2 contract with no OS sandbox: the decoded targets are /etc paths, so
	// classification alone must reject them from both the temp root and outside.
	for (const cwd of [outside, shellPath(TEMP_DIR)]) {
		for (const command of [
			`touch ${escapeSeparators("/etc/no-sandbox")}`,
			`cd /tmp && touch ${escapeSeparators("/etc/no-sandbox")}`,
			`rm ${escapeSeparators("/etc/no-sandbox")}`,
			`echo hi > ${escapeSeparators("/etc/no-sandbox")}`,
			`cd /tmp && echo hi > ${escapeSeparators("/etc/no-sandbox")}`,
			`touch ${shellPath(TEMP_DIR)}/*/../../etc/no-sandbox`,
		]) assert.equal(classifyBashCommand(command, cwd).ok, false, command);
	}
});

test("no-sandbox classifier allows decoded escaped temp targets and keeps quoted literals relative", {
	skip: posixHost ? false : "POSIX path literals",
}, () => {
	// Unquoted escapes decode to the real temp path and stay allowed.
	for (const command of [
		`touch ${escapeSeparators(shellPath(TEMP_DIR))}/allowed`,
		`cd ${escapeSeparators(shellPath(TEMP_DIR))}; touch allowed`,
		`echo hi > ${escapeSeparators(shellPath(TEMP_DIR))}/allowed`,
	]) assert.equal(classifyBashCommand(command, outside).ok, true, command);
	// Quoted ordinary backslashes keep `cd` on a missing root entry: the change fails
	// and later relative writes keep the caller cwd, while the plain form reaches /tmp.
	assert.equal(classifyBashCommand('cd "/\\tmp"; touch rel', outside).ok, false);
	assert.equal(classifyBashCommand('cd "/tmp"; touch rel', outside).ok, true);
	// A double-quoted `\/` operand is a relative path, so its verdict follows the cwd:
	// inside the temp root it may write, from outside it must stay blocked.
	assert.equal(classifyBashCommand('touch "\\/etc\\/probe"', shellPath(TEMP_DIR)).ok, true);
	assert.equal(classifyBashCommand('touch "\\/etc\\/probe"', outside).ok, false);
});

test("brace trailing redirects share redirect checks and preserve abort state", () => {
	const log = classifierQuote(`${shellPath(TEMP_DIR)}/brace.log`);
	// Safe trailing redirects are allowed and the body stays parent-shell.
	assert.equal(classifyBashCommand(`{ touch ${log}; } >${log}`, outside).ok, true);
	assert.equal(classifyBashCommand(`{ cd ${classifierQuote(shellPath(TEMP_DIR))}; }; touch rel`, outside).ok, true);
	// Unsafe trailing targets block; non-redirect trailing words fail closed.
	assert.equal(classifyBashCommand(`{ printf x; } >${classifierQuote(`${outside}/blocked`)}`, outside).ok, false);
	assert.equal(classifyBashCommand(`{ echo safe; } trailing`, outside).ok, false);
	// An aborting redirect keeps the caller state: `;` stays blocked, `&&` skips vacuously.
	const abort = `{ cd ${classifierQuote(shellPath(TEMP_DIR))}; } >${classifierQuote(`${shellPath(TEMP_DIR)}/missing/out`)}`;
	assert.equal(classifyBashCommand(`${abort}; touch rel`, outside).ok, false);
	assert.equal(classifyBashCommand(`${abort} && touch rel`, outside).ok, true);
});

test("a double-quoted heredoc delimiter with an ordinary backslash is not dropped", () => {
	// Bash's delimiter is `E\q`; folding it to `Eq` made the body look inert and let a
	// later command escape classification.
	const blocked = `touch ${classifierQuote(path.join(outside, "blocked"))}`;
	const command = `cat <<"E\\q"\nE\\q\n${blocked}\nEq\n:`;
	assert.equal(classifyBashCommand(command, outside).ok, false, command);
});

test("a heredoc body reaches a downstream shell only through byte-preserving stages", () => {
	const body = `touch ${classifierQuote(path.join(outside, "blocked"))}`;
	// A transforming stage before the shell changes the bytes the shell runs, so fail closed.
	assert.equal(classifyBashCommand(`cat <<'EOF' | sed 's@/tmp/@/outside/@' | bash\n${body}\nEOF`, outside).ok, false);
	assert.equal(classifyBashCommand(`cat <<'EOF' | tr a b | bash\n${body}\nEOF`, outside).ok, false);
	// Pure `cat` pass-throughs still hand the exact body to a shell: classified as code.
	assert.equal(classifyBashCommand(`cat <<'EOF' | cat | bash\n${body}\nEOF`, outside).ok, false);
	// With no shell stage, the transformed body is inert data.
	assert.equal(classifyBashCommand(`cat <<'EOF' | sed 's@a@b@' | cat\n${body}\nEOF`, outside).ok, true);
});

test("shell state expansion stays bounded and fails closed", () => {
	// Each alternation keeps a success and an aborting-redirect failure branch, so directory
	// histories multiply without a budget. Classification runs synchronously in the host: an
	// unbounded set would hang or OOM it. The command must fail closed promptly and cheaply.
	const root = mkdtempSync(path.join(os.tmpdir(), "readonly-shell-budget-"));
	const first = path.join(root, "first"), second = path.join(root, "second");
	mkdirSync(first);
	mkdirSync(second);
	try {
		const command = Array.from({ length: 18 }, (_, index) => `pushd ${quote(index % 2 ? second : first)} <&0`).join("; ");
		const before = process.memoryUsage().heapUsed;
		const result = classifyBashCommand(command, root);
		const grown = process.memoryUsage().heapUsed - before;
		assert.equal(result.ok, false, "an unbounded state set must fail closed");
		assert.match(result.reason ?? "", /state expansion/);
		assert.ok(grown < 64 * 1024 * 1024, `budget must bound heap growth, grew ${grown} bytes`);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
