import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, copyFileSync, utimesSync, chmodSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { check, fixture, git, gitSuiteOptions, gitSuiteSkipped, installGitIsolation, localEnvironment, outside, outsideWritesRequired, posixHost, quote, repository } from "./readonly-git-helpers.js";
import { shellPath } from "./helpers.js";

// POSIX-only readonly-git regression tests: they assert bash semantics via real `bash`
// differentials, literal POSIX temp paths, and shebang fixtures. The platform-agnostic
// classifier suite lives in readonly-git-classifier.test.ts.
function shell(command: string, cwd: string): string {
	return execFileSync("bash", ["--noprofile", "--norc", "-c", command], { cwd, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** An empty dir under a home-anchored fixture: git's destination must look cloneable-into
 * (the fixture root itself carries the sweep marker, so the direct premise clones need this). */
function emptyEscapeDir(t: test.TestContext): string {
	const dir = path.join(fixture(t, os.homedir()), "escape");
	mkdirSync(dir);
	return dir;
}

// Every regression below takes gitSuiteOptions, so each stays individually visible and
// skippable. Only the fail-loud guard runs unconditionally: a silent skip of the whole
// suite must fail CI, never report green. It mirrors the old POSIX condition: Windows
// skips even when CI demands outside-temp fixtures, since it lacks bash and POSIX paths.
installGitIsolation();

test("readonly git regressions refuse silent skips when outside-temp fixtures are required", () => {
	if (outsideWritesRequired && posixHost && gitSuiteSkipped !== null) {
		assert.fail(`${gitSuiteSkipped}; REQUIRE_OUTSIDE_TEMP_WRITES=1 forbids skipping`);
	}
});

test("broken .git symlink is not treated as a valid repository", (t) => {
	const root = fixture(t);
	const work = path.join(root, "work");
	mkdirSync(work, { recursive: true });
	const broken = path.join(work, ".git");
	symlinkSync(path.join(root, "nonexistent"), broken);
	assert.equal(classifyBashCommand("git init", work).ok, false,
		"broken .git symlink must fail closed");
});

test("Git rejects expansions that hide real outside config and log writes", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t)), external = fixture(t, os.homedir());
	const config = path.join(external, "config"), output = path.join(external, "log");
	const commands = [
		`ARGS=${quote(`--file ${config} demo.key changed`)}; git config $ARGS`,
		`ARGS=${quote(`--output ${output}`)}; git log $ARGS`,
	];
	for (const command of commands) { check(command, repo, false); shell(command, repo); }
	assert.equal(git(repo, "config", "--file", config, "--get", "demo.key"), "changed");
	assert.match(readFileSync(output, "utf8"), /initial/);
});

test("Git permits quoted dynamic commit messages without treating data as options", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	for (const option of ['-m "$(printf %s \'--output /outside/file\')"', '--message="$(printf %s \'--file /outside/config\')"']) {
		const command = `git -c color.ui=never commit --quiet --allow-empty ${option}`;
		check(command, repo, true);
		shell(`GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid ${command}`, repo);
		assert.match(git(repo, "log", "-1", "--format=%s"), /^--(?:output|file) \/outside\//);
	}
});

test("Git explicit directory errors become visible policy denials", gitSuiteOptions, (t) => {
	const root = fixture(t), loop = path.join(root, "loop");
	symlinkSync("loop", loop);
	const command = `git --git-dir=${quote(loop)} status`;
	const result = classifyBashCommand(command, root);
	assert.equal(result.ok, false);
	assert.match(result.reason ?? "", /ELOOP|too many symbolic links/i);
	assert.throws(() => shell(command, root), /not a git repository|too many levels of symbolic links/i);
});

test("Git filtered branch and config reads preserve outside repositories", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t, os.homedir()));
	git(repo, "branch", "feature-one");
	git(repo, "config", "user.name", "Readonly Test");
	const config = path.join(repo, ".git", "config"), before = readFileSync(config);
	for (const query of ['branch --list "feature*"', 'config --get user.name ".*"']) {
		check(`git ${query}`, repo, true);
		assert.notEqual(shell(`git ${query}`, repo), "");
	}
	for (const query of ['branch --list --delete feature-one', 'config --get --add user.name changed', 'config user.name changed']) check(`git ${query}`, repo, false);
	assert.deepEqual(readFileSync(config), before);
	assert.equal(git(repo, "branch", "--list", "feature*"), "feature-one");
});

test("Git abbreviations write outside temp while exact temp options remain allowed", gitSuiteOptions, (t) => {
	const root = fixture(t), external = fixture(t, os.homedir());
	for (const [base, abbreviated] of [[external, true], [root, false]] as const) {
		const metadata = path.join(base, "metadata"), worktree = path.join(root, abbreviated ? "abbreviated" : "exact");
		const command = `git init --quiet --${abbreviated ? "separate-git-d" : "separate-git-dir"}=${quote(metadata)} ${quote(worktree)}`;
		check(command, root, !abbreviated);
		shell(command, root);
		assert.ok(existsSync(path.join(metadata, "HEAD")));
		assert.match(readFileSync(path.join(worktree, ".git"), "utf8"), /^gitdir: /);
		const config = path.join(base, "config");
		const write = `git config --${abbreviated ? "fil" : "file"}=${quote(config)} test.key verified`;
		check(write, root, !abbreviated);
		shell(write, root);
		assert.equal(git(root, "config", "--file", config, "--get", "test.key"), "verified");
	}
});

test("Git decodes unquoted path escapes before checking containment", gitSuiteOptions, (t) => {
	const root = fixture(t), external = fixture(t, os.homedir());
	const target = path.join(external, "escaped-repo");
	const canonicalRoot = realpathSync.native(root);
	const relative = path.relative(canonicalRoot, target).split(path.sep).map((part) => part === ".." ? "\\.." : part).join("/");
	const operand = `${quote(canonicalRoot)}/${relative}`;
	const command = `git init --quiet ${operand}`;
	check(command, root, false);
	shell(command, root);
	assert.ok(existsSync(path.join(target, ".git", "HEAD")));
	const config = `git config --file=${operand}/settings test.key escaped`;
	check(config, root, false);
	shell(config, root);
	assert.equal(git(root, "config", "--file", path.join(target, "settings"), "--get", "test.key"), "escaped");
});

test("Git preserves quoted backslashes and decodes escaped spaces in temp paths", gitSuiteOptions, (t) => {
	const root = fixture(t);
	for (const [operand, target] of [
		[`${quote(root)}/safe\\ space`, path.join(root, "safe space")],
		[`"${root}/\\../double"`, path.join(root, "\\..", "double")],
		[quote(path.join(root, "\\..", "single")), path.join(root, "\\..", "single")],
	] as const) {
		const command = `git init --quiet ${operand}`;
		check(command, root, true);
		shell(command, root);
		assert.ok(existsSync(path.join(target, ".git", "HEAD")));
	}
});

// Execute rejected commands only in disposable fixtures to prove their actual write effects.
test("Git bundle unbundle checks the repository that receives objects", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const source = repository(root);
	const bundle = path.join(root, "source.bundle");
	git(source, "bundle", "create", bundle, "HEAD");
	for (const [base, allowed] of [[root, true], [fixture(t, os.homedir()), false]] as const) {
		const target = path.join(base, "empty");
		mkdirSync(target);
		git(target, "init", "--quiet");
		const command = `git bundle unbundle ${quote(bundle)}`;
		check(command, target, allowed);
		const head = git(source, "rev-parse", "HEAD");
		assert.match(git(target, "count-objects", "-v"), /in-pack: 0\n/);
		shell(command, target);
		assert.equal(git(target, "cat-file", "-t", head), "commit");
	}
});

test("Git bundle create checks its positional output independently of the repository", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	for (const [base, allowed] of [[root, true], [fixture(t, os.homedir()), false]] as const) {
		const output = path.join(base, "output.bundle");
		const command = `git bundle create --version=2 ${quote(output)} HEAD`;
		check(command, repo, allowed);
		check(`git bundle create --version 2 ${quote(output)} HEAD`, repo, allowed);
		assert.equal(existsSync(output), false);
		shell(command, repo);
		assert.match(git(repo, "bundle", "list-heads", output), / HEAD$/);
	}
});

test("Git maintenance register checks the global configuration it changes", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	for (const [base, allowed] of [[root, true], [fixture(t, os.homedir()), false]] as const) {
		const config = path.join(base, "global-config");
		process.env.GIT_CONFIG_GLOBAL = config;
		const command = "git maintenance register";
		check(command, repo, allowed);
		assert.equal(existsSync(config), false);
		shell(command, repo);
		assert.equal(git(repo, "config", "--global", "--get", "maintenance.repo"), realpathSync.native(repo));
	}
});

test("Git maintenance register checks default user configuration paths", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	delete process.env.GIT_CONFIG_GLOBAL;
	for (const [base, allowed] of [[root, true], [fixture(t, os.homedir()), false]] as const) {
		const config = path.join(base, ".gitconfig");
		const command = `HOME=${quote(base)} XDG_CONFIG_HOME=${quote(path.join(base, ".config"))} git maintenance register`;
		check(command, repo, allowed);
		assert.equal(existsSync(config), false);
		shell(command, repo);
		assert.equal(git(repo, "config", "--file", config, "--get", "maintenance.repo"), realpathSync.native(repo));
	}
});

test("Git push probes the repository selected by command-provided GIT_DIR", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwdRepo = repository(root);
	const selectedRoot = fixture(t);
	const selected = repository(selectedRoot);
	const tempRemote = path.join(root, "remote.git");
	git(root, "init", "--quiet", "--bare", tempRemote);
	git(cwdRepo, "remote", "add", "origin", tempRemote);
	git(selected, "remote", "add", "origin", tempRemote);
	for (const [base, allowed] of [[root, true], [fixture(t, os.homedir()), false]] as const) {
		const remote = path.join(base, "selected-remote.git");
		git(base, "init", "--quiet", "--bare", remote);
		git(selected, "remote", "set-url", "origin", remote);
		assertSelectedPush(selected, cwdRepo, remote, allowed);
	}
	assert.equal(git(root, "--git-dir", tempRemote, "for-each-ref"), "");
});

function assertSelectedPush(selected: string, cwd: string, remote: string, allowed: boolean): void {
	for (const prefix of localEnvironment("GIT_DIR", path.join(selected, ".git"))) {
		const command = `${prefix} git push --quiet origin HEAD:refs/heads/verified`;
		check(command, cwd, allowed);
		assert.equal(git(cwd, "--git-dir", remote, "for-each-ref"), "");
		shell(command, cwd);
		assert.equal(git(cwd, "--git-dir", remote, "rev-parse", "verified"), git(selected, "rev-parse", "HEAD"));
		git(cwd, "--git-dir", remote, "update-ref", "-d", "refs/heads/verified");
	}
}

test("Git global and system writes use their effective inherited destinations", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	for (const scope of ["global", "system"]) {
		for (const [base, allowed] of [[fixture(t), true], [fixture(t, os.homedir()), false]] as const) {
			const config = path.join(base, `${scope}-config`);
			process.env[`GIT_CONFIG_${scope.toUpperCase()}`] = config;
			assertScopeWrite(repo, scope, config, allowed);
		}
	}
});

function assertScopeWrite(repo: string, scope: string, config: string, allowed: boolean): void {
	const command = `git config --${scope} user.name Scoped`;
	check(command, repo, allowed);
	assert.equal(existsSync(config), false);
	shell(command, repo);
	assert.equal(git(repo, "config", "--file", config, "--get", "user.name"), "Scoped");
}

test("Git global writes use command-selected HOME and XDG destinations", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	delete process.env.GIT_CONFIG_GLOBAL;
	for (const [base, allowed] of [[fixture(t), true], [fixture(t, os.homedir()), false]] as const) {
		const config = path.join(base, ".gitconfig");
		const command = `HOME=${quote(base)} XDG_CONFIG_HOME=${quote(path.join(base, ".config"))} git config --global user.name Scoped`;
		check(command, repo, allowed);
		shell(command, repo);
		assert.equal(git(repo, "config", "--file", config, "--get", "user.name"), "Scoped");
	}
});

test("Git config output modifiers cannot disguise a write as a read", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const outsideRoot = fixture(t, os.homedir());
	const outsideRepo = repository(outsideRoot);
	const sentinel = "[user]\nname = Preserved\n";
	// CONTRACT: these flags only shape output, and current Git really does write for them (proved
	// by the real run). `--show-origin` rejects a value today, but a version difference must never
	// buy immutability, so every modifier plus a `<key> <value>` pair fails closed as a write.
	const write = (modifier: string, file: string) => `git config ${modifier} --file ${quote(file)} user.name Written`;
	const modifiers: [string, boolean][] = [["--show-scope", true], ["--show-names", true], ["-z", true], ["--show-origin", false]];
	for (const [index, [modifier, reallyWrites]] of modifiers.entries()) {
		const target = path.join(root, `modifier-${index}.cfg`);
		if (reallyWrites) shell(write(modifier, target), root);
		check(write(modifier, target), root, true);
		assert.equal(existsSync(target), reallyWrites);
		const preserved = path.join(outsideRoot, `preserved-${index}.cfg`);
		writeFileSync(preserved, sentinel);
		check(write(modifier, preserved), root, false);
		check(`git config ${modifier} user.name Written`, outsideRepo, false);
		assert.equal(readFileSync(preserved, "utf8"), sentinel);
	}
});

test("Git config read forms with output modifiers really only read", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	git(repo, "config", "user.name", "Readonly Test");
	const config = path.join(repo, ".git", "config");
	const before = readFileSync(config, "utf8");
	for (const query of ["--show-scope --get user.name", "--show-origin user.name", "--show-scope --list"]) {
		check(`git config ${query}`, repo, true);
		assert.match(shell(`git config ${query}`, repo), /Readonly Test/);
	}
	assert.equal(readFileSync(config, "utf8"), before);
	// Modifiers and scope selectors stay readable in any combination, and an explicit outside
	// file is still only read — the destination is path-checked only when the form writes.
	for (const query of ["--show-scope -l", "--show-scope -z --name-only --list", "--show-origin --type=int core.fsmonitor", "--show-scope --local user.name"]) {
		check(`git config ${query}`, repo, true);
	}
	check(`git config --show-scope --file ${quote(shellPath(path.join(fixture(t, os.homedir()), "config")))} --get user.name`, repo, true);
});

test("Git format-patch honors configured format.outputDirectory", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	const inside = path.join(root, "patches");
	git(repo, "config", "format.outputDirectory", inside);
	check("git format-patch -1", repo, true);
	shell("git format-patch -1", repo);
	assert.equal(existsSync(path.join(inside, "0001-initial.patch")), true);
	// CONTRACT: the config really redirects output outside temp, so reading it is mandatory.
	const outsideRoot = fixture(t, os.homedir());
	git(repo, "config", "format.outputDirectory", outsideRoot);
	check("git format-patch -1", repo, false);
	check("git format-patch --signature -h -1", repo, false);
	for (const command of ["git clone -h", "git clone --help", "git status -h", "git commit --help"]) {
		check(command, repo, true);
		check(command, outsideRoot, true);
	}
	check("git commit -m -h", repo, true);
	check("git commit -m -h", outsideRoot, false);
	check("git diff -- -h", repo, true);
	shell("git format-patch -1", repo);
	assert.equal(existsSync(path.join(outsideRoot, "0001-initial.patch")), true);
});

function assertPatchOutput(command: string, cwd: string, output: string, allowed: boolean): void {
	const patch = path.join(output, "0001-initial.patch");
	check(command, cwd, allowed);
	assert.equal(existsSync(patch), false);
	shell(command, cwd);
	assert.equal(existsSync(patch), true);
	rmSync(patch);
}

function configLocationFile(name: string, root: string): string {
	return name === "HOME" ? path.join(root, ".gitconfig") : path.join(root, "git", "config");
}

function writeLocationConfig(name: string, root: string, key: string, value: string): void {
	const file = configLocationFile(name, root);
	mkdirSync(path.dirname(file), { recursive: true });
	git(root, "config", "--file", file, key, value);
}

function assertLocationOutput(t: test.TestContext, name: string): void {
	const repo = repository(fixture(t));
	const home = fixture(t);
	const output = fixture(t, os.homedir());
	writeLocationConfig(name, home, "format.outputDirectory", output);
	delete process.env.GIT_CONFIG_GLOBAL;
	process.env.HOME = fixture(t);
	process.env.XDG_CONFIG_HOME = fixture(t);
	for (const prefix of localEnvironment(name, home)) {
		assertPatchOutput(`${prefix} git format-patch -1`, repo, output, false);
	}
}

test("Git probes command-selected HOME and XDG output configuration", gitSuiteOptions, (t) => {
	for (const name of ["HOME", "XDG_CONFIG_HOME"]) assertLocationOutput(t, name);
});

function assertOutsidePush(command: string, repo: string, remote: string): void {
	check(command, repo, false);
	assert.equal(git(remote, "for-each-ref"), "");
	shell(command, repo);
	assert.equal(git(remote, "rev-parse", "verified"), git(repo, "rev-parse", "HEAD"));
	git(remote, "update-ref", "-d", "refs/heads/verified");
}

function assertLocationPush(t: test.TestContext, name: string, rule: string): void {
	const root = fixture(t);
	const repo = repository(root);
	const configRoot = fixture(t);
	const remote = path.join(fixture(t, os.homedir()), "remote.git");
	git(root, "init", "--bare", "--quiet", remote);
	const prefix = path.join(root, "apparent-remote");
	writeLocationConfig(name, configRoot, `url.${remote}.${rule}`, prefix);
	delete process.env.GIT_CONFIG_GLOBAL;
	process.env.HOME = fixture(t);
	process.env.XDG_CONFIG_HOME = fixture(t);
	git(repo, "remote", "add", "origin", prefix);
	for (const env of localEnvironment(name, configRoot)) {
		assertOutsidePush(`${env} git push --quiet origin HEAD:refs/heads/verified`, repo, remote);
	}
}

test("Git probes HOME and XDG push URL rewrites to outside repositories", gitSuiteOptions, (t) => {
	for (const name of ["HOME", "XDG_CONFIG_HOME"]) {
		for (const rule of ["insteadOf", "pushInsteadOf"]) assertLocationPush(t, name, rule);
	}
});

test("Git format-patch probes selected metadata rather than the cwd repository", gitSuiteOptions, (t) => {
	const cwd = repository(fixture(t));
	const selected = repository(fixture(t));
	const output = fixture(t, os.homedir());
	git(selected, "config", "format.outputDirectory", output);
	for (const prefix of localEnvironment("GIT_DIR", path.join(selected, ".git"))) {
		assertPatchOutput(`${prefix} git format-patch -1`, cwd, output, false);
	}
	assertPatchOutput(`git --git-dir=${quote(path.join(selected, ".git"))} format-patch -1`, cwd, output, false);
});

test("Git config probes do not execute command-provided PATH binaries", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	const marker = path.join(root, "executed");
	const binary = path.join(root, "git");
	writeFileSync(binary, `#!/bin/sh\n: > ${quote(marker)}\n`);
	chmodSync(binary, 0o755);
	git(repo, "config", "format.outputDirectory", fixture(t, os.homedir()));
	check(`PATH=${quote(root)} git format-patch -1`, repo, false);
	assert.equal(existsSync(marker), false);
});

test("Git status checks incidental writes to explicit indexes", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	assertStatusIndex(repo, path.join(root, "index"), true);
	assertStatusIndex(repo, path.join(fixture(t, os.homedir()), "index"), false);
});

function assertStatusIndex(repo: string, index: string, allowed: boolean): void {
	copyFileSync(path.join(repo, ".git", "index"), index);
	const before = readFileSync(index);
	utimesSync(path.join(repo, "file"), new Date(0), new Date(0));
	for (const prefix of localEnvironment("GIT_INDEX_FILE", index)) {
		const command = `${prefix} git status --porcelain`;
		check(command, repo, allowed);
		assert.equal(shell(command, repo), "");
	}
	assert.notDeepEqual(readFileSync(index), before, "status refreshes the explicit index");
	assert.equal(existsSync(`${index}.lock`), false);
}

test("Git command-local temp indexes are allowed and really stage only there", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	writeFileSync(path.join(repo, "file"), "changed\n");
	for (const [number, prefixKind] of ["", "env "].entries()) {
		const index = path.join(root, `index-${number}`);
		const prefix = `${prefixKind}GIT_INDEX_FILE=${quote(index)}`;
		const command = `${prefix} git add file`;
		assert.equal(existsSync(index), false);
		check(command, repo, true);
		shell(command, repo);
		assert.equal(existsSync(index), true);
		assert.equal(shell(`${prefix} git show :file`, repo), "changed");
		assert.equal(git(repo, "show", ":file"), "initial");
	}
});

test("Git command-local environment does not leak to following commands", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	const index = path.join(fixture(t), "index");
	for (const prefix of localEnvironment("GIT_INDEX_FILE", index)) {
		const command = `${prefix} git status --porcelain; git add file`;
		check(command, repo, true);
		shell(command, repo);
		assert.equal(existsSync(index), false);
		check(`${prefix} git add file; git status`, repo, true);
	}
});

test("Git vetted color.ui overrides allow real read queries", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	for (const query of ["status --porcelain", "log -1 --format=%s", "rev-parse HEAD", "diff", "config --get color.ui"]) {
		const command = `git -c color.ui=never ${query}`;
		check(command, repo, true);
		shell(command, repo);
	}
	assert.equal(shell("git -c color.ui=never config --get color.ui", repo), "never");
});

test("Git resolves core.worktree against repository metadata", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	// Absolute and metadata-relative values must match Git's actual reset destination.
	git(repo, "config", "core.worktree", repo);
	check("git reset --hard HEAD", repo, true);
	git(repo, "config", "core.worktree", outside);
	check("git reset --hard HEAD", repo, false);
	git(repo, "config", "--unset", "core.worktree");
	git(repo, "config", "core.worktree", "..");
	writeFileSync(path.join(repo, "file"), "changed\n");
	check("git reset --hard HEAD", repo, true);
	shell("git reset --hard HEAD", repo);
	assert.equal(readFileSync(path.join(repo, "file"), "utf8"), "initial\n");
	const destination = fixture(t, os.homedir());
	git(repo, "config", "core.worktree", path.relative(realpathSync.native(path.join(repo, ".git")), realpathSync.native(destination)));
	check("git reset --hard HEAD", repo, false);
	shell("git reset --hard HEAD", repo);
	assert.equal(readFileSync(path.join(destination, "file"), "utf8"), "initial\n");
});

test("Git decodes escaped and quoted output option names before checking destinations", gitSuiteOptions, (t) => {
	const root = fixture(t), repo = repository(root), external = fixture(t, os.homedir());
	for (const name of [String.raw`--out\put`, '--out""put']) {
		for (const [base, allowed] of [[external, false], [root, true]] as const) {
			const target = path.join(base, "diff-output");
			writeFileSync(path.join(repo, "file"), "changed\n");
			const command = `git diff HEAD ${name}=${quote(target)} -- file`;
			check(command, repo, allowed);
			shell(command, repo);
			assert.match(readFileSync(target, "utf8"), /\+changed/);
		}
	}
});

test("Git preserves standalone values for immutable short-option parsing", gitSuiteOptions, (t) => {
	const root = fixture(t);
	for (const command of ["git grep -e '-nOinitial'", "git grep -f '-nOinitial'", "git log -S '-nOinitial'"]) check(command, root, true);
});

test("Git decoded and bundled grep pager options cannot hide executable commands", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t)), external = fixture(t, os.homedir());
	for (const option of [String.raw`--open-files-in\-pager=`, '--open-files-in""-pager=', "-nO"]) {
		const marker = path.join(external, "pager-marker");
		const command = `git grep ${option}${quote(`touch ${quote(marker)}`)} initial`;
		check(command, repo, false);
		assert.equal(existsSync(marker), false);
		shell(command, repo);
		assert.ok(existsSync(marker));
		rmSync(marker);
	}
});

test("Git bundled format-patch output checks its destination and preserves read bundles", gitSuiteOptions, (t) => {
	const root = fixture(t), repo = repository(root), external = fixture(t, os.homedir());
	for (const [base, allowed] of [[external, false], [root, true]] as const) {
		const command = `git format-patch -ko${quote(base)} --root HEAD`;
		check(command, repo, allowed);
		const patch = shell(command, repo);
		assert.match(readFileSync(patch, "utf8"), /\+initial/);
	}
	for (const command of ["git status -sb", "git grep -ne initial", "git log -n1 --oneline"]) {
		check(command, repo, true);
		assert.notEqual(shell(command, repo), "");
	}
});


test("Git bisect view and visualize take the mutable path because they exec gitk", gitSuiteOptions, (t) => {
	const root = fixture(t), repo = repository(root), outsideRepo = repository(fixture(t, os.homedir()));
	// CONTRACT: `view`/`visualize` exec gitk from PATH and persist per-repo options into
	// `.git/gitk`, the same exec/write vector `run` is denied — so they are blocked for a
	// repository outside temp and allowed only when every write root stays inside temp.
	for (const action of ["view", "visualize"]) {
		check(`git bisect ${action}`, outsideRepo, false);
		check(`git bisect ${action}`, repo, true);
	}
	// Only the help/printing actions stay immutable; `log` must keep reading anywhere.
	check("git bisect log", outsideRepo, true);
});

test("Git push without a positional remote checks the effective branch push selector", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
	const tempRemote = path.join(root, "temp-remote.git");
	git(root, "init", "--bare", "--quiet", tempRemote);
	git(repo, "remote", "add", "origin", tempRemote);
	git(repo, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
	// Positive control: a selector naming a configured remote resolves through its URL.
	git(repo, "config", `branch.${branch}.remote`, "origin");
	check("git push", repo, true);
	// A selector that names no configured remote holds the destination path itself.
	const outsideRoot = fixture(t, os.homedir());
	const outsideRemote = path.join(outsideRoot, "outside-remote.git");
	git(outsideRoot, "init", "--bare", "--quiet", outsideRemote);
	for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
		git(repo, "config", key, outsideRemote);
		check("git push", repo, false);
		assert.equal(git(outsideRemote, "for-each-ref"), "");
		shell("git push --quiet", repo);
		assert.equal(git(outsideRemote, "rev-parse", branch), git(repo, "rev-parse", "HEAD"));
		git(outsideRemote, "update-ref", "-d", `refs/heads/${branch}`);
		git(repo, "config", "--unset", key);
	}
});

test("Git submodule update and recursive checkout check .gitmodules paths", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
	const modules = path.join(repo, ".gitmodules");
	const outsidePath = path.relative(repo, fixture(t, os.homedir()));
	// Declared paths inside temp stay writable for both submodule-materializing commands.
	writeFileSync(modules, `[submodule "safe"]\n\tpath = subdir\n\turl = ./subdir\n`);
	check("git submodule update --init", repo, true);
	check(`git checkout --recurse-submodules ${branch}`, repo, true);
	// A declared path that climbs outside temp blocks; git runs it from the discovered worktree.
	writeFileSync(modules, `[submodule "unsafe"]\n\tpath = ${outsidePath}\n\turl = ./unsafe\n`);
	check("git submodule update --init", repo, false);
	check(`git checkout --recurse-submodules ${branch}`, repo, false);
	// A malformed or unreadable file cannot be trusted, so both actions fail closed.
	writeFileSync(modules, `[submodule "broken"]\n\tpath\n`);
	check("git submodule update --init", repo, false);
	check(`git checkout --recurse-submodules ${branch}`, repo, false);
	// A quoted value would need Git's config unescaping, so it cannot be resolved reliably.
	writeFileSync(modules, `[submodule "quoted"]\n\tpath = "../quoted"\n\turl = ./q\n`);
	check("git submodule update --init", repo, false);
	rmSync(modules);
	mkdirSync(modules);
	check("git submodule update --init", repo, false);
});

test("Git clone default destination follows a symlink outside temp", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const remote = path.join(root, "remote.git");
	git(root, "init", "--quiet", "--bare", remote);
	const outsideDir = emptyEscapeDir(t);
	// Premise: git really writes the derived name — a direct clone lands in the linked
	// directory, so the block verdicts below guard a real escape, not a guard-internal guess.
	symlinkSync(outsideDir, path.join(cwd, "remote"));
	git(cwd, "clone", remote);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	// Premise for the bare variant: git appends `.git` to the derived name.
	const bareOutside = emptyEscapeDir(t);
	symlinkSync(bareOutside, path.join(cwd, "remote.git"));
	git(cwd, "clone", "--bare", remote);
	assert.ok(existsSync(path.join(bareOutside, "HEAD")), "bare git must append .git and write through the symlink");
	// A plain clone derives `remote`; `--bare`/`--mirror` append `.git`. A value-flag value that
	// looks like `--bare` (`git clone -o --bare`) is NOT the flag, so the name stays bare. A
	// symlink at that exact derived name redirects git's write outside temp, so the guard must
	// resolve and block it. Every candidate link is cleared per case: a stale link must never
	// block for the wrong name.
	for (const [flags, derived] of [["", "remote"], ["--bare", "remote.git"], ["--mirror", "remote.git"], ["-o --bare", "remote"]]) {
		for (const name of ["remote", "remote.git"]) rmSync(path.join(cwd, name), { force: true });
		symlinkSync(outsideDir, path.join(cwd, derived!));
		check(`git clone ${flags ? `${flags} ` : ""}${shellPath(remote)}`, cwd, false);
	}
});

test("Git clone strips trailing spaces from the source operand", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const remote = path.join(root, "repo.git ");
	git(root, "init", "--quiet", "--bare", remote);
	const outsideDir = emptyEscapeDir(t);
	// Git derives `repo` (space stripped, `.git` stripped). A symlink at `<cwd>/repo` redirects
	// the write outside temp, so the guard must derive the same name git writes and block it.
	symlinkSync(outsideDir, path.join(cwd, "repo"));
	// Premise: a direct clone proves git really writes the stripped name through the symlink.
	git(cwd, "clone", remote);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	check(`git clone ${quote(shellPath(remote))}`, cwd, false);
});

test("Git clone finds a repository through the appended .git/.git suffix", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// git's get_repo_path_1 APPENDS each probe suffix to the source, so `dir/a.git` probes
	// `dir/a.git.git/.git`. The source is a plain file, so only that appended probe anchors a
	// repository; git keeps is_bundle=0 and derives the `.git`-stripped name `a`. Checking the
	// wrong probe (`dir/a.git/.git`) mis-reads the source as a bundle and checks `a.git` instead.
	mkdirSync(path.join(root, "dir"));
	writeFileSync(path.join(root, "dir", "a.git"), "not a gitfile\n");
	git(root, "init", "--quiet", path.join(root, "dir", "a.git.git"));
	const outsideDir = emptyEscapeDir(t);
	// Premise: a direct clone proves git derives `a` and writes it through the symlink.
	const probe = path.join(root, "probe");
	mkdirSync(probe);
	symlinkSync(outsideDir, path.join(probe, "a"));
	git(probe, "clone", path.join(root, "dir", "a.git"));
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must derive `a` and write through the symlink");
	assert.equal(existsSync(path.join(probe, "a.git")), false, "git must not derive `a.git`");
	symlinkSync(outsideDir, path.join(cwd, "a"));
	check(`git clone ${quote(shellPath(path.join(root, "dir", "a.git")))}`, cwd, false);
});

test("Git clone default destination inside temp stays allowed", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const remote = path.join(root, "remote.git");
	git(root, "init", "--quiet", "--bare", remote);
	for (const flags of ["", "--bare", "--mirror"]) check(`git clone ${flags ? `${flags} ` : ""}${shellPath(remote)}`, cwd, true);
	// A source whose name git's own stripping cannot prove must fail closed.
	check("git clone", cwd, false);
	check("git clone /", cwd, false);
	check("git clone https://example.invalid/repo.git?ref=main", cwd, false);
	check("git clone https://example.invalid/repo.git#frag", cwd, false);
});

test("Git clone derived name keeps a POSIX backslash literal", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// POSIX keeps `\` literal in filenames: git derives `remote\x`, not `x`. A symlink at the
	// real derived name must be found — splitting on `\` would check `<cwd>/x` and miss it.
	const source = path.join(root, "remote\\x.git");
	git(root, "init", "--quiet", "--bare", source);
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "remote\\x"));
	// Premise: a direct clone proves git really writes the backslash name through the symlink.
	git(cwd, "clone", source);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	check(`git clone ${quote(shellPath(source))}`, cwd, false);
});

test("Git clone strips only separators after a `/.git` tail", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// A source whose pre-strip tail ends in whitespace: git removes the trailing `/.git` and
	// then strips separators only, so the whitespace survives into the component and blocks
	// the `.git` suffix strip. git derives `b.git`, not `b` (reusing the whitespace-stripping
	// first rule here would derive `b` and check a path git never writes).
	const repo = path.join(root, "b.git ");
	mkdirSync(repo);
	git(repo, "init", "--quiet");
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "b.git"));
	// Premise: a direct clone proves git derives the whitespace-then-`.git` name through the link.
	git(cwd, "clone", path.join(repo, ".git"));
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must derive `b.git` through the symlink");
	check(`git clone ${quote(shellPath(path.join(repo, ".git")))}`, cwd, false);
});

test("Git clone skips the scheme, auth, and port when deriving the name", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const outsideDir = emptyEscapeDir(t);
	// A symlink at the DERIVED name is the premise: a wrong derivation misses the link and
	// allows the command. Remote URLs cannot be cloned, so the assertion itself proves the name.
	for (const [source, derived] of [["https://host:8080/", "host"], ["https://user:pw@host/", "host"], ["ssh://git@host:2222/x.git", "x"], ["git@host:2222/x.git", "x"]] as const) {
		symlinkSync(outsideDir, path.join(cwd, derived));
		check(`git clone ${quote(source)}`, cwd, false);
		rmSync(path.join(cwd, derived), { force: true });
	}
});

test("Git clone treats a HEAD-only directory as not a repository", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// git's is_bundle probe needs a real git directory. A directory holding only HEAD is not
	// one, so the sibling `a.git.bundle` regular file wins and git derives `a.git`, not `a`.
	const fake = path.join(root, "src", "a.git");
	mkdirSync(fake, { recursive: true });
	writeFileSync(path.join(fake, "HEAD"), "ref: refs/heads/main\n");
	git(repository(root), "bundle", "create", path.join(root, "src", "a.git.bundle"), "--all");
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "a.git"));
	// Premise: a direct clone proves git derives `a.git` from the bundle probe through the link.
	git(cwd, "clone", path.join(root, "src", "a.git"));
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must derive `a.git` through the symlink");
	check(`git clone ${quote(shellPath(path.join(root, "src", "a.git")))}`, cwd, false);
});

test("Git clone treats an invalid-HEAD directory with objects as a bundle", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// is_git_directory also needs a valid HEAD ref (validate_headref) and a refs/ dir. A
	// directory with a garbage HEAD and objects/ but no refs/ is not a repository, so its
	// sibling bundle wins and git derives `x.git`. A looser probe derived `x` and missed the
	// symlink at the real name.
	const source = path.join(root, "src", "x.git");
	mkdirSync(path.join(source, "objects"), { recursive: true });
	writeFileSync(path.join(source, "HEAD"), "not a ref\n");
	git(repository(root), "bundle", "create", path.join(root, "src", "x.git.bundle"), "--all");
	const outsideDir = emptyEscapeDir(t);
	// Premise: a direct clone proves git treats the crafted directory as a bundle and writes `x.git`.
	const probe = path.join(root, "probe");
	mkdirSync(probe);
	symlinkSync(outsideDir, path.join(probe, "x.git"));
	git(probe, "clone", source);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must derive x.git through the symlink");
	assert.equal(existsSync(path.join(probe, "x")), false, "git must not derive x");
	// A symlink at the derived `x.git` redirects git's write outside temp, so the guard must
	// resolve that exact name and block.
	symlinkSync(outsideDir, path.join(cwd, "x.git"));
	check(`git clone ${quote(shellPath(source))}`, cwd, false);
});

test("Git clone rejects a HEAD that only JS whitespace accepts", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// git's validate_headref skips byte-wise C isspace, which rejects NBSP after `ref:`. A
	// directory that only a looser (JS `\s`) match accepts is not a repository, so the sibling
	// bundle wins and git derives `x.git`, not `x`. A looser HEAD check missed the real name.
	const source = path.join(root, "src", "x.git");
	mkdirSync(path.join(source, "objects"), { recursive: true });
	mkdirSync(path.join(source, "refs"), { recursive: true });
	writeFileSync(path.join(source, "HEAD"), "ref:\u00a0refs/heads/main\n");
	git(repository(root), "bundle", "create", path.join(root, "src", "x.git.bundle"), "--all");
	const outsideDir = emptyEscapeDir(t);
	// Premise: a direct clone proves git treats the crafted directory as a bundle and writes `x.git`.
	const probe = path.join(root, "probe");
	mkdirSync(probe);
	symlinkSync(outsideDir, path.join(probe, "x.git"));
	git(probe, "clone", source);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must derive x.git through the symlink");
	assert.equal(existsSync(path.join(probe, "x")), false, "git must not derive x");
	// A symlink at the derived `x.git` redirects git's write outside temp, so the guard must
	// resolve that exact name and block.
	symlinkSync(outsideDir, path.join(cwd, "x.git"));
	check(`git clone ${quote(shellPath(source))}`, cwd, false);
});

test("Git submodule update checks the submodule metadata location", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	const source = repository(fixture(t));
	const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "outer");
	// Real metadata lives under the superproject's `.git/modules`, inside temp: both commands stay allowed.
	check("git submodule update --force", repo, true);
	check(`git checkout --recurse-submodules ${branch}`, repo, true);
	// `=none` disables recursion, so no submodule roots join and the command stays allowed.
	check(`git checkout --recurse-submodules=none ${branch}`, repo, true);
	// `--track` takes an OPTIONAL argument (binds only with `=`), so it never consumes the
	// next token: the recursion flag after it must still count. The allowed control pins
	// that removing `--track` from the value-flag set introduced no over-block.
	check(`git checkout --track ${branch}`, repo, true);
	// A path declared twice must not re-walk the same repository (visited-set dedup). Save the
	// clean file first: the direct git run below needs a single-entry .gitmodules.
	const gitmodules = readFileSync(path.join(repo, ".gitmodules"), "utf8");
	writeFileSync(path.join(repo, ".gitmodules"), `[submodule "outer"]\n\tpath = outer\n\turl = ./outer\n[submodule "outer-again"]\n\tpath = outer\n\turl = ./outer\n`);
	check("git submodule update --force", repo, true);
	writeFileSync(path.join(repo, ".gitmodules"), gitmodules);
	// Repointing the worktree's `.git` file outside temp makes git write metadata (and its index)
	// there; the guard discovers the pointer and must block. Relocate the real metadata first so
	// the direct git run proves git really writes there, not merely that the guard denies.
	const outsideMetadata = path.join(fixture(t, os.homedir()), "modules", "outer");
	const insideMetadata = path.join(repo, ".git", "modules", "outer");
	cpSync(insideMetadata, outsideMetadata, { recursive: true });
	rmSync(insideMetadata, { recursive: true, force: true });
	const metadataConfig = path.join(outsideMetadata, "config");
	writeFileSync(metadataConfig, readFileSync(metadataConfig, "utf8").replace(/worktree = .*/, `worktree = ${path.join(repo, "outer")}`));
	writeFileSync(path.join(repo, "outer", ".git"), `gitdir: ${outsideMetadata}\n`);
	rmSync(path.join(outsideMetadata, "index"), { force: true });
	// Premise: git really writes the outside metadata (the deleted index reappears).
	git(repo, "submodule", "update", "--force");
	assert.ok(existsSync(path.join(outsideMetadata, "index")), "git must write the outside metadata index");
	check("git submodule update --force", repo, false);
	check(`git checkout --recurse-submodules ${branch}`, repo, false);
	// The value form recurses like the bare flag: without it the escape would reopen.
	check(`git checkout --recurse-submodules=checkout ${branch}`, repo, false);
	// `--track` must not swallow a following `--recurse-submodules` as an optional value.
	check(`git checkout --track --recurse-submodules ${branch}`, repo, false);
	check(`git checkout --track=direct --recurse-submodules ${branch}`, repo, false);
});

test("Git recursive checkout checks nested submodule metadata", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	const source = repository(fixture(t));
	const nested = repository(fixture(t));
	const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "outer");
	const outer = path.join(repo, "outer");
	git(outer, "-c", "protocol.file.allow=always", "submodule", "add", nested, "inner");
	check(`git checkout --recurse-submodules ${branch}`, repo, true);
	check("git submodule update --recursive --force", repo, true);
	// The escape sits one level down: only a recursive walk reaches and blocks it.
	const outsideMetadata = path.join(fixture(t, os.homedir()), "modules", "inner");
	writeFileSync(path.join(outer, "inner", ".git"), `gitdir: ${outsideMetadata}\n`);
	check(`git checkout --recurse-submodules ${branch}`, repo, false);
	check("git submodule update --recursive --force", repo, false);
});

test("Git recursive submodule walk terminates on a cycle", gitSuiteOptions, (t) => {
	const repoA = repository(fixture(t));
	const repoB = repository(fixture(t));
	// B must declare A BEFORE A clones B, or A/b's checkout lacks the `a` submodule and the
	// walked graph is not a cycle: the visited-realpath set would never be exercised.
	git(repoB, "-c", "protocol.file.allow=always", "submodule", "add", repoA, "a");
	git(repoB, "-c", "user.name=Readonly Test", "-c", "user.email=readonly@example.invalid", "commit", "--quiet", "-m", "add a");
	git(repoA, "-c", "protocol.file.allow=always", "submodule", "add", repoB, "b");
	git(repoA, "-c", "user.name=Readonly Test", "-c", "user.email=readonly@example.invalid", "commit", "--quiet", "-m", "add b");
	// A declares B, and the cloned A/b declares A again: the visited-realpath set must
	// terminate the recursive walk instead of recursing without bound.
	check("git submodule update --recursive --force", repoA, true);
	// An outside-metadata escape inside the cycle still blocks.
	const outsideMetadata = path.join(fixture(t, os.homedir()), "modules", "b");
	writeFileSync(path.join(repoA, "b", ".git"), `gitdir: ${outsideMetadata}\n`);
	check("git submodule update --recursive --force", repoA, false);
});

test("Git clone drops a trailing scp-style port from the derived name", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// A local repository named `x:2222`: the source has no `/`, so git's port rule treats the
	// digits as a legacy port and clones into `x` (`x.git` when bare). A symlink at the derived
	// name redirects that write outside temp, so the guard must derive the same name.
	const source = path.join(cwd, "x:2222");
	mkdirSync(source);
	git(source, "init", "--quiet", "--bare");
	const outsideDir = emptyEscapeDir(t);
	const outsideBare = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "x"));
	symlinkSync(outsideBare, path.join(cwd, "x.git"));
	// Premise: direct clones prove git really writes the port-stripped names.
	git(cwd, "clone", "x:2222");
	git(cwd, "clone", "--bare", "x:2222");
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	assert.ok(existsSync(path.join(outsideBare, "HEAD")), "bare git must write through the symlink");
	// One link at a time: a stale link must never block for the wrong name.
	for (const [command, derived, target] of [["git clone x:2222", "x", outsideDir], ["git clone --bare x:2222", "x.git", outsideBare]] as const) {
		rmSync(path.join(cwd, "x"), { force: true });
		rmSync(path.join(cwd, "x.git"), { force: true });
		symlinkSync(target, path.join(cwd, derived));
		check(command, cwd, false);
	}
});

test("Git clone of a bundle derives the bundle stem", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const repo = repository(root);
	const bundle = path.join(root, "s.bundle");
	git(repo, "bundle", "create", bundle, "--all");
	const outsideDir = emptyEscapeDir(t);
	// A bundle source makes git strip `.bundle` (is_bundle), so the clone writes into `s`.
	symlinkSync(outsideDir, path.join(cwd, "s"));
	// Premise: a direct clone proves git really writes the stem through the symlink.
	git(cwd, "clone", bundle);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	check(`git clone ${quote(bundle)}`, cwd, false);
});

test("Git clone strips full whitespace tails, not just spaces", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// C `isspace` covers tabs too: git derives `src` from a source named `src.git<TAB>`.
	const source = `${path.join(root, "src.git")}\t`;
	mkdirSync(source);
	git(source, "init", "--quiet", "--bare");
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "src"));
	// Premise: a direct clone proves git really writes the tab-stripped name. Single quotes
	// keep the tab verbatim through bash, matching what the classifier must decode.
	git(cwd, "clone", source);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	check(`git clone '${source}'`, cwd, false);
});

test("Git clone collapses embedded control characters to one space", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// git collapses control/whitespace runs in the derived name to one space and trims the
	// ends: a source named `src<TAB>x.git` clones into `src x`. A symlink at that exact name
	// redirects the write outside temp, so the guard must collapse the same way.
	const source = path.join(root, "src\tx.git");
	mkdirSync(source);
	git(source, "init", "--quiet", "--bare");
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "src x"));
	// Premise: a direct clone proves git really writes the collapsed name. Single quotes
	// keep the tab verbatim through bash, matching what the classifier must decode.
	git(cwd, "clone", source);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	check(`git clone '${source}'`, cwd, false);
});

test("Git clone keeps DEL literal in the derived name", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	// git's collapse maps only bytes below 0x20 (plus space) to a space: DEL (0x7f) stays
	// literal in the derived name, so the guard must check that exact name.
	const source = `${path.join(root, "src\x7f.git")}`;
	mkdirSync(source);
	git(source, "init", "--quiet", "--bare");
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(cwd, "src\x7f"));
	// Premise: a direct clone proves git really writes the DEL-bearing name.
	git(cwd, "clone", source);
	assert.ok(existsSync(path.join(outsideDir, ".git", "HEAD")), "git must write through the symlink");
	check(`git clone '${source}'`, cwd, false);
});

test("Git clone bare abbreviations derive the .git name", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const remote = path.join(root, "remote.git");
	git(root, "init", "--quiet", "--bare", remote);
	// Premise: git treats `--ba`/`--mir` as `--bare`/`--mirror` and appends `.git`.
	const probe = path.join(root, "probe");
	mkdirSync(probe);
	const outsideDir = emptyEscapeDir(t);
	symlinkSync(outsideDir, path.join(probe, "remote.git"));
	git(probe, "clone", "--ba", remote);
	assert.ok(existsSync(path.join(outsideDir, "HEAD")), "git must treat --ba as --bare");
	// A symlink at the derived `.git` name redirects the abbreviated bare clone outside
	// temp, so the guard must derive the same name. A value-flag value that merely looks
	// like `--bare` is not the flag, and `--bare=x` is rejected by git, not a flag.
	for (const flags of ["--ba", "--mir", "--bare", "--mirror"]) {
		rmSync(path.join(cwd, "remote"), { force: true });
		rmSync(path.join(cwd, "remote.git"), { force: true });
		symlinkSync(outsideDir, path.join(cwd, "remote.git"));
		check(`git clone ${flags} ${shellPath(remote)}`, cwd, false);
	}
});

test("Git rejects non-vetted -c overrides fail closed", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	// PIN: safeGitConfig only vets color.ui, so any other -c key fails closed.
	check("git -c submodule.recurse=true checkout", repo, false);
	check("git -c protocol.file.allow=always status", repo, false);
});

test("Git clone with recurse-submodules stays allowed inside temp", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const cwd = path.join(root, "cwd");
	mkdirSync(cwd);
	const source = repository(root);
	check(`git clone --recurse-submodules ${shellPath(source)}`, cwd, true);
});

test("Git -C resolves link/.. with Git's traversal, not lexical collapse", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const repo = repository(root);
	const outsideRepo = repository(fixture(t, os.homedir()));
	const child = path.join(outsideRepo, "child");
	mkdirSync(child);
	symlinkSync(child, path.join(repo, "link"));
	const anchor = `${repo}${path.sep}link${path.sep}..`;
	const config = path.join(outsideRepo, ".git", "config");
	const before = readFileSync(config);
	check(`git -C ${quote(anchor)} config demo.proof written`, repo, false);
	// Premise: git chdirs through the symlink, so the write lands in the outside repo.
	shell(`git -C ${quote(anchor)} config demo.proof written`, repo);
	assert.notDeepEqual(readFileSync(config), before, "git must write the outside repo config");
});

test("Git rejects executable clone transports and command protocol overrides", gitSuiteOptions, (t) => {
	const root = fixture(t);
	const marker = path.join(fixture(t, os.homedir()), "marker");
	const target = (name: string) => quote(path.join(root, name));
	const source = path.join(root, "source.git");
	git(root, "init", "--quiet", "--bare", source);
	for (const command of [
		`GIT_ALLOW_PROTOCOL=ext git clone ${quote(`ext::touch ${marker}`)} ${target("c1")}`,
		`env GIT_ALLOW_PROTOCOL=ext git clone ${quote(`ext::touch ${marker}`)} ${target("c2")}`,
		`git clone ${quote(`ext::touch ${marker}`)} ${target("c3")}`,
		`git clone ${quote("fd::3")} ${target("c4")}`,
		`GIT_PROTOCOL=version=2 git clone ${quote(source)} ${target("c5")}`,
	]) check(command, root, false);
	assert.equal(existsSync(marker), false, "no blocked command may run the helper");
	// Premise: with the override the ext helper really runs, so the block guards a real effect.
	// `|| true` tolerates git's expected failure after the helper already ran.
	shell(`GIT_ALLOW_PROTOCOL=ext git clone ${quote(`ext::touch ${marker}`)} ${target("c6")} || true`, root);
	assert.ok(existsSync(marker), "git must run the ext helper when the override is present");
});

test("Git preserves a trailing space in a probed core.worktree", gitSuiteOptions, (t) => {
	const repo = repository(fixture(t));
	const outsideDir = fixture(t, os.homedir());
	const link = path.join(repo, "worktree-link ");
	symlinkSync(outsideDir, link);
	git(repo, "config", "core.worktree", link);
	check("git clean -fd", repo, false);
	// Premise: git resolves the untrimmed symlink and deletes the outside stray file.
	const stray = path.join(outsideDir, "stray");
	writeFileSync(stray, "x");
	shell("git clean -fd", repo);
	assert.equal(existsSync(stray), false, "git must operate through the untrimmed worktree");
});
