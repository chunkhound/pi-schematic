import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEMP_WRITE_ROOTS_CANONICAL } from "../../temp-dir.js";
import { classifyBashCommand } from "../../readonly-bash.js";
import { deriveCloneDirectoryName } from "../../readonly-bash-git.js";
import { FAIL_CLOSED_HINT } from "../../notifications.js";
import { capabilityGate, check, fixture, git, hasGit, installGitIsolation, localEnvironment, outside, outsideWritable, outsideWritesRequired, posixHost, quote, repository } from "./readonly-git-helpers.js";
import { shellPath } from "./helpers.js";

// Platform-agnostic readonly-git classifier tests: every assertion goes through
// classifyBashCommand, with fixtures built from the real `git` CLI only — no bash
// differentials, literal POSIX temp paths, symlinks, or shebang execution. Those live in
// readonly-git-regressions.test.ts behind a POSIX gate, so this suite stays runnable on
// every host with git installed.
// CONTRACT: the derived clone name mirrors git's `git_url_basename`. The platform is a
// parameter, so the Windows rules run on a POSIX host instead of only on Windows CI.
test("clone default name strips C whitespace and splits on platform separators", () => {
	// C isspace (space, \t\n\v\f\r) is stripped before the `/.git` tail test on every platform.
	assert.equal(deriveCloneDirectoryName("/x/repo.git ", false, false, "win32"), "repo");
	assert.equal(deriveCloneDirectoryName("/x/repo.git ", false, false, "darwin"), "repo");
	assert.equal(deriveCloneDirectoryName("/x/src.git\t", false, false, "win32"), "src");
	// is_dir_sep: Windows splits on `\`; POSIX keeps it literal in the file name.
	assert.equal(deriveCloneDirectoryName("remote\\x.git", false, false, "darwin"), "remote\\x");
	assert.equal(deriveCloneDirectoryName("remote\\x.git", false, false, "win32"), "x");
	// Bare appends `.git`; the `.bundle` suffix strip follows the bundle probe result.
	assert.equal(deriveCloneDirectoryName("/x/remote", false, true, "win32"), "remote.git");
	assert.equal(deriveCloneDirectoryName("/x/a.bundle", true, false, "darwin"), "a");
	assert.equal(deriveCloneDirectoryName("/x/a.git", false, false, "darwin"), "a");
});

if (!hasGit()) capabilityGate("readonly git classifier requires git", "git unavailable");
else {
	installGitIsolation();

	// A mis-resolved `outside` fixture (HOME or temp dirs inside a temp root) would invert every
	// expectation, so fail loudly instead of reporting green on meaningless fixtures.
	test("outside fixture is not inside the shared temp-root policy", () => {
		for (const root of TEMP_WRITE_ROOTS_CANONICAL) {
			const relative = path.relative(root, outside);
			assert.ok(relative.startsWith("..") || path.isAbsolute(relative), `${outside} must be outside ${root}`);
		}
	});

	test("Git expands directory variables before resolving chained global paths", (t) => {
		const root = fixture(t);
		check(`DIR=${quote(root)}; git -C "$DIR" init --quiet`, outside, true);
		check(`DIR=${quote(outside)}; git -C "$DIR" init --quiet`, root, false);
		check(`DIR=${quote(root)}; git -C "$DIR" -C child init`, outside, true);
		check(`git -C "$UNKNOWN_READONLY_GIT_DIR" init`, root, false);
		check(`git --git-dir=meta -C ${quote(root)} init ${quote(path.join(root, "new"))}`, outside, true);
		check(`git --git-dir=meta -C ${quote(outside)} init ${quote(path.join(root, "new"))}`, root, false);
		check(`DIR=${quote(root)}; git -C '$DIR' init`, outside, false);
		check(`git init --separate-git-dir=${quote(outside + " space")} ${quote(root)}`, root, false);
	});

	test("Git rejects unknown options, abbreviations, and disguised executable options", (t) => {
		const root = fixture(t);
		for (const command of [
			`init --separate-git-d=${quote(outside)} ${quote(root)}`,
			`init --separate-git-d=${quote(path.join(root, "meta"))} ${quote(root)}`,
			`config --fil=${quote(outside)} test.key value`,
			`config --fil=${quote(path.join(root, "config"))} test.key value`,
			`init --unknown-option ${quote(root)}`,
			`clone --upload-p=evil source ${quote(root)}`,
			`clone '--upload-pack=evil' source ${quote(root)}`,
			`diff --ext-diff`, `log --out=${quote(outside)}`, `grep --open-files-in-pager=evil text`,
		]) check(`git ${command}`, root, false);
		check(`git init --quiet ${quote(root)}`, outside, true);
		check(`git config --file=${quote(path.join(root, "config"))} test.key value`, outside, true);
	});

	test("Git blocks shell operands with unproven expansions", (t) => {
		const root = fixture(t);
		for (const operand of ["$UNKNOWN_READONLY_GIT_PATH", `${shellPath(root)}/$UNKNOWN_READONLY_GIT_PATH`, `${shellPath(root)}/*`, String.raw`$'${shellPath(root)}/\x2e\x2e'`]) {
			check(`git init ${operand}`, root, false);
		}
		check(String.raw`DIR=${shellPath(root)}/\../escape; git init "$DIR"`, root, false);
	});

	test("Git unknown expansions cannot supply hidden options or change argument count", (t) => {
		const root = fixture(t);
		for (const command of [
			`ARGS="--file ${shellPath(outside)} demo.key changed"; git config $ARGS`,
			`ARGS="--output ${shellPath(outside)}"; git log $ARGS`,
			`git log $UNKNOWN_READONLY_GIT_ARGS`,
			`git config "$UNKNOWN_READONLY_GIT_ARGS"`,
			`git commit -m $UNKNOWN_READONLY_GIT_MESSAGE`,
			`git commit -m '-m' "$UNKNOWN_READONLY_GIT_MESSAGE"`,
			`git commit -- '-m' "$UNKNOWN_READONLY_GIT_MESSAGE"`,
		]) check(command, root, false);
	});

	test("Git creation checks both visible destination and separate metadata", (t) => {
		const root = fixture(t);
		for (const command of ["init", `clone ${quote(repository(root))}`]) {
			for (const flag of ["--separate-git-dir", "--git-dir"]) {
				const prefix = flag === "--git-dir" ? `git ${flag}=` : `git ${command} ${flag}=`;
				const suffix = flag === "--git-dir" ? ` ${command}` : "";
				check(`${prefix}${quote(path.join(root, "meta"))}${suffix} ${quote(path.join(root, "new"))}`, outside, true);
				check(`${prefix}${quote(outside)}${suffix} ${quote(path.join(root, "new"))}`, root, false);
			}
		}
	});

	test("Git explicit config destinations are checked independently of cwd", (t) => {
		const root = fixture(t);
		for (const flag of ["--file", "-f"]) {
			check(`git config ${flag} ${quote(path.join(root, "config"))} user.name test`, outside, true);
			check(`git config ${flag} ${quote(outside)} user.name test`, root, false);
		}
		check(`git config --file=${quote(path.join(root, "config"))} user.name test`, outside, true);
		check("git config --global user.name test", root, true);
		for (const flag of [`--file=${quote(outside)}`, `-f${quote(outside)}`, `--file ${quote(outside)}`, `-f ${quote(outside)}`]) {
			check(`git config ${flag} --get user.name`, root, true);
		}
		check(`git config --file=${quote(outside)} user.name test`, root, false);
		check(`git config -f${quote(outside)} user.name test`, root, false);
	});

	test("Git destination flags cannot escape a temp repository", (t) => {
		const repo = repository(fixture(t));
		for (const command of ["apply --directory", "apply --build-fake-ancestor", "diff --output", "format-patch -o"]) {
			check(`git ${command} ${quote(repo)} HEAD`, repo, true);
			check(`git ${command} ${quote(outside)} HEAD`, repo, false);
		}
		check(`git apply --unsafe-paths patch`, repo, false);
		check(`git -c core.worktree=${quote(outside)} checkout HEAD`, repo, false);
		check(`git format-patch -o${quote(outside)} HEAD`, repo, false);
		check(`git submodule add ${quote(repo)} ${quote(outside)}`, repo, false);
	});

	test("Git checks metadata as well as worktree add and move destinations", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		for (const action of ["add", "move"]) {
			check(`git worktree ${action} ${quote(path.join(root, "new"))}`, repo, true);
			check(`git worktree ${action} ${quote(outside)}`, repo, false);
		}
		// A real linked worktree discovers its common repository, not merely its .git file.
		const linked = path.join(root, "linked");
		git(repo, "worktree", "add", "--quiet", "--detach", linked);
		check("git reset --hard HEAD", linked, true);
		check(`git worktree add ${quote(path.join(root, "other"))}`, linked, true);
	});

	test("Git discovers an ancestor repository rather than trusting a temp-looking cwd", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const nested = path.join(repo, "nested", "child");
		mkdirSync(nested, { recursive: true });
		check("git add .", nested, true);
		writeFileSync(path.join(repo, ".git", "commondir"), outside);
		check("git add .", nested, false);
	});

	test("Git checks explicit worktree and environment-provided write roots", (t) => {
		const repo = repository(fixture(t));
		for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"]) {
			check(`${name}=${quote(repo)}; git add file`, repo, true);
			check(`${name}=${quote(outside)}; git add file`, repo, false);
		}
		check(`git --work-tree=${quote(repo)} add file`, repo, true);
		check(`git --work-tree=${quote(outside)} add file`, repo, false);
	});

	test("Git command-provided env values with a backslash decode as literal data", (t) => {
		// A backslash in a command-provided env value is literal data (decodeShellAssignmentValue
		// fails closed only for unquoted escapes; quoted values keep the `\` as a path char).
		// The fail-closed regex no longer rejects `\`, so an in-temp index file with a
		// backslash-bearing name resolves inside temp. This mirrors the decodeShellPathOperand
		// backslash pin for the git env path; the old regex blocked the in-temp value as unproven.
		const repo = repository(fixture(t));
		const backslashInsideTemp = path.join(repo, "idx\\file");
		check(`${"GIT_INDEX_FILE"}=${quote(backslashInsideTemp)}; git add file`, repo, true);
	});

	test("Git rejects backslash-escaped suffixes after a dynamic assignment", (t) => {
		// Bash decodes `\/` to `/` in the literal suffix, but the classifier appends the suffix to
		// the assignment value verbatim. Accepting it would let `$D\/..\/..` escape temp while the
		// classified path stays inside. Both plain and braced-default spellings must block.
		const repo = repository(fixture(t));
		const inside = path.join(os.tmpdir(), "pi-escape-probe");
		check(`D=${quote(inside)}; git -C $D\\/..\\/..\\/etc init`, repo, false);
		check(`D=${quote(inside)}; git --git-dir=$D\\/..\\/..\\/etc init`, repo, false);
		check(`git -C \${NOVAR:-${quote(inside)}\\/..\\/..\\/etc} init`, repo, false);
		// Control: the same traversal in plain form blocks too, and the Windows value case stays allowed.
		check(`git -C ${quote(inside + "/../../etc")} init`, repo, false);
		check(`D=${quote(inside)}; git -C $D/sub init`, repo, true);
	});

	test("Git local pushes check destination repositories, including configured remotes", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const remote = path.join(root, "remote.git");
		git(root, "init", "--bare", "--quiet", remote);
		git(repo, "remote", "add", "origin", remote);
		check("git push origin HEAD:refs/heads/verified", repo, true);
		git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/verified");
		assert.equal(git(remote, "rev-parse", "verified"), git(repo, "rev-parse", "HEAD"));
		check(`git push --repo=${quote(remote)}`, repo, true);
		check(`git push --repo=${quote(outside)}`, repo, false);
		git(repo, "remote", "set-url", "origin", outside);
		check("git push origin HEAD", repo, false);
		check("git push --repo=origin", repo, false);
		check(`git push ${quote(outside)} HEAD`, repo, false);
		check("git push ext::unsupported HEAD", repo, false);
		if (process.platform !== "win32") check("git push C:/x HEAD", repo, false);
		// CONTRACT: a bare remote NAME resolves through repo config; with unreadable metadata a
		// configured network remote is indistinguishable from a local path, so it fails closed.
		check("git push origin main", root, false);
		// A drive-letter remote (`C:\Users\outside`) is absolute only on win32; on POSIX it
		// resolves inside temp, so the block expectation holds only where it is absolute.
		if (process.platform === "win32") check('git push "C:\\Users\\outside" HEAD', repo, false);
	});

	test("Git anchors relative push destinations at the repository top level", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const sub = path.join(repo, "sub");
		mkdirSync(sub);
		// CONTRACT: Git resolves a relative remote URL against the repository top level, not the
		// cwd, so `../remote.git` lands beside the repository and stays writable.
		const remote = path.join(root, "remote.git");
		git(root, "init", "--bare", "--quiet", remote);
		check("git push ../remote.git HEAD", sub, true);
		// A destination that escapes temp at the top level must block. Nest the cwd as deep as the
		// relative path climbs so that cwd anchoring would land back inside temp: only top-level
		// anchoring can block it, which makes this differential rather than merely positional.
		// The outside fixture requires writing to os.homedir(); a sandboxed runner may not.
		// REQUIRE_OUTSIDE_TEMP_WRITES=1 turns that capability gap into a hard failure.
		if (!outsideWritable) {
			if (outsideWritesRequired) assert.fail("cannot write outside temp; REQUIRE_OUTSIDE_TEMP_WRITES=1 forbids skipping");
			return;
		}
		const outsideRoot = fixture(t, os.homedir());
		const outsideRemote = path.join(outsideRoot, "remote.git");
		git(outsideRoot, "init", "--bare", "--quiet", outsideRemote);
		const relative = path.relative(repo, outsideRemote);
		const climbs = relative.split(path.sep).filter((part) => part === "..").length;
		let cwd = repo;
		for (let level = 1; level < Math.max(2, climbs - 1); level++) cwd = path.join(cwd, `d${level}`);
		mkdirSync(cwd, { recursive: true });
		check(`git push ${quote(relative)} HEAD`, cwd, false);
	});

	test("Git network push transports fail closed even from a temp repository", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: unprovable transport locations fail closed — network pushes write only
		// temp-local refs, but their destination cannot be path-checked.
		git(repo, "remote", "add", "origin", "https://github.com/example/repo.git");
		// file:// names a real destination path, so keep one pointed at the outside fixture
		// instead of a POSIX-only literal path.
		const fileUrl = `file://${outside.split(path.sep).join("/")}`;
		for (const url of ["https://github.com/example/repo.git", "git@github.com:example/repo.git", "ssh://git@github.com/example/repo.git", fileUrl]) {
			git(repo, "remote", "set-url", "origin", url);
			check("git push origin HEAD", repo, false);
			check(`git push ${quote(url)} HEAD`, repo, false);
		}
	});

	test("Git option block reasons name the offending subcommand and flag", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: a blocked option reason identifies which subcommand and flag failed closed,
		// instead of the opaque shared string that hid the cause.
		for (const [command, reason] of [
			["git clone -c advice.detachedHead=false /nonexistent", `unsupported git option blocked: clone -c${FAIL_CLOSED_HINT}`],
			["git log --lost-found", `unsupported git option blocked: log --lost-found${FAIL_CLOSED_HINT}`],
		] as const) {
			const result = classifyBashCommand(command, repo);
			assert.equal(result.ok, false, command);
			assert.equal(result.reason, reason, command);
		}
	});

	test("Git flag arity is per-subcommand, not a flat value table", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		git(repo, "remote", "add", "origin", "https://github.com/example/repo.git");
		// CONTRACT: `-u`/`-f` are boolean for `push`. Treating them as value flags consumed
		// `origin`, so the remote resolved as a branch name and a network push looked local.
		for (const args of ["push -u origin HEAD", "push -f origin HEAD", "push --push-option ci origin HEAD"]) {
			check(`git ${args}`, repo, false);
		}
		// CONTRACT: `-f` is also boolean (force) for `worktree add`/`remove`.
		check(`git worktree add -f ${quote(path.join(root, "forced"))}`, repo, true);
		check(`git worktree add -f ${quote(outside)}`, repo, false);
		check(`git worktree remove -f ${quote(outside)}`, repo, false);
		// Value flags still consume their operand: `-b` is a branch, so the real destination is checked.
		check(`git worktree add -b fixture-branch ${quote(outside)}`, repo, false);
		const source = repository(fixture(t));
		check(`git clone -b main ${quote(source)} ${quote(path.join(root, "clone"))}`, root, true);
		check(`git clone -b main ${quote(source)} ${quote(outside)}`, root, false);
		// Unmodeled valued flags must not shift the destination: trailing values are parsed and
		// an over-long operand list fails closed instead of guessing.
		check(`git clone ${quote(source)} ${quote(path.join(root, "clone2"))} --server-option foo`, root, true);
		check(`git clone ${quote(source)} ${quote(outside)} --server-option foo`, root, false);
		check(`git clone ${quote(source)} ${quote(outside)} --revision main`, root, false);
		check(`git init ${quote(path.join(root, "init-many"))} extra`, root, false);
	});

	test("Git bundled and attached short flags keep per-subcommand arity", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: bundled short flags split by each option's own arity. `-am` is `-a`
		// (boolean) plus `-m` (valued), so the message operand is not read as a destination.
		for (const command of ["commit -am msg", "checkout -b feat", "switch -c feat", "merge -m m other", "tag -a v1 -m m", "stash push -m wip"]) {
			check(`git ${command}`, repo, true);
			check(`git ${command}`, outside, false);
		}
		// Equivalent value spellings keep read-only queries immutable from any cwd.
		for (const flag of ["-tbool", "-t bool", "--type=bool", "--type bool"]) {
			check(`git config ${flag} --get core.bare`, repo, true);
			check(`git config ${flag} --get core.bare`, outside, true);
		}
	});

	test("Git attached dynamic option values cannot hide a destination or executable option", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: a dynamic attached value keeps its flag name, so the destination/injection
		// option is still vetted instead of collapsing into an inert positional.
		for (const command of [
			"log --output=$(pwd)",
			"diff --output=$(pwd)",
			"format-patch --output-directory=$(pwd) HEAD",
			"format-patch -o$(pwd) HEAD",
			"config --file=$(pwd) user.name test",
			"apply --directory=$(pwd) patch",
			"apply --build-fake-ancestor=$(pwd) patch",
			"log --output \"$(pwd)\"",
		]) check(`git ${command}`, repo, false);
		// CONTRACT: grep's -O executes a pager; log's -O only orders reads, so only grep denies it.
		check("git grep -O evil text", repo, false);
		check("git grep -Oevil text", repo, false);
		check("git grep --open-files-in-pager=evil text", repo, false);
		check("git log -O orderfile", repo, true);
	});

	test("Git applies url rewrite rules before judging a push destination", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const prefix = path.join(root, "prefix");
		mkdirSync(prefix);
		git(repo, "remote", "add", "evil", path.join(prefix, "out.git"));
		git(repo, "config", `url.${outside}.insteadOf`, prefix);
		// CONTRACT: the configured remote URL looks local, but git rewrites it to `outside`.
		check("git push evil HEAD", repo, false);
		// A positional <repository> overrides --repo in Git, so the option form carries no refspec.
		check("git push --repo=evil", repo, false);
		git(repo, "config", "--unset", `url.${outside}.insteadOf`);
		const local = path.join(root, "local.git");
		git(root, "init", "--bare", "--quiet", local);
		git(repo, "remote", "set-url", "evil", local);
		check("git push evil HEAD", repo, true);
	});

	test("Git honors repository-configured worktree destinations", (t) => {
		const repo = repository(fixture(t));
		git(repo, "config", "core.worktree", repo);
		check("git reset --hard HEAD", repo, true);
		git(repo, "config", "core.worktree", outside);
		check("git reset --hard HEAD", repo, false);
	});

	test("Git allowed operations actually write only their local destinations", (t) => {
		const root = fixture(t);
		const worktree = path.join(root, "new");
		const metadata = path.join(root, "metadata");
		check(`git init --separate-git-dir=${quote(metadata)} ${quote(worktree)}`, root, true);
		git(root, "init", "--quiet", `--separate-git-dir=${metadata}`, worktree);
		assert.equal(existsSync(path.join(metadata, "HEAD")), true);
		assert.match(readFileSync(path.join(worktree, ".git"), "utf8"), /^gitdir: /);
		const config = path.join(root, "explicit-config");
		check(`git config --file=${quote(config)} user.name fixture`, root, true);
		git(root, "config", `--file=${config}`, "user.name", "fixture");
		assert.equal(git(root, "config", `--file=${config}`, "--get", "user.name"), "fixture");
	});

	test("Git command-local config environment overrides block even immutable queries", (t) => {
		const repo = repository(fixture(t));
		const config = `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${quote(outside)}`;
		for (const prefix of [config, `env ${config}`]) {
			for (const query of ["status", "log -1", "rev-parse HEAD", "diff", "config --get user.name"]) {
				check(`${prefix} git ${query}`, repo, false);
			}
		}
	});

	test("Git executable hook environment blocks even immutable queries", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: Git executes these values from read-only subcommands (pager on log/diff,
		// askpass/ssh on fetch), so command-provided assignments fail closed like `-c core.pager`.
		const hooks: [string, string][] = [
			["GIT_PAGER", "log -1"],
			["PAGER", "log -1"],
			["GIT_EDITOR", "commit"],
			["EDITOR", "commit"],
			["GIT_SEQUENCE_EDITOR", "rebase -i HEAD"],
			["GIT_EXTERNAL_DIFF", "diff"],
			["GIT_SSH_COMMAND", "fetch"],
			["GIT_ASKPASS", "fetch"],
		];
		for (const [name, query] of hooks) {
			for (const prefix of localEnvironment(name, "evil")) {
				check(`${prefix} git ${query}`, repo, false);
			}
			check(`export ${name}=evil; git ${query}`, repo, false);
		}
	});

	test("Git action words are parsed past leading options", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: `submodule`/`bisect` action words follow options; keying on args[0] let a
		// leading option shift the action and slip the guard.
		check("git submodule --quiet foreach true", repo, false);
		check("git bisect --first-parent run true", repo, false);
		check("git submodule --quiet status", repo, true);
	});

	test("Git trusted process-environment hooks do not block read-only queries", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: the user's own exported environment is trusted; only assignments inside
		// the classified command string are distrusted.
		const editor = process.env.EDITOR;
		t.after(() => { if (editor === undefined) delete process.env.EDITOR; else process.env.EDITOR = editor; });
		process.env.GIT_PAGER = "evil";
		process.env.EDITOR = "evil";
		check("git log -1", repo, true);
		check("git status", repo, true);
	});

	test("Git persistent config environment overrides also block immutable queries", (t) => {
		const repo = repository(fixture(t));
		check(`GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=core.worktree; GIT_CONFIG_VALUE_0=${quote(outside)}; git status`, repo, false);
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = "core.worktree";
		process.env.GIT_CONFIG_VALUE_0 = outside;
		check("git status", repo, false);
	});

	test("Git command-provided config environment blocks any subcommand", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const config = path.join(root, "evil-config");
		// CONTRACT: GIT_CONFIG/GLOBAL/SYSTEM redirect the effective config for every
		// subcommand, not only `config`; direct config injection remains blocked.
		for (const prefix of localEnvironment("GIT_CONFIG_GLOBAL", config)) {
			check(`${prefix} git -C ${quote(repo)} push origin main`, outside, false);
		}
		check(`GIT_CONFIG_SYSTEM=${quote(config)} git -C ${quote(repo)} push origin main`, outside, false);
		check(`GIT_CONFIG=${quote(config)} git status`, repo, false);
	});

	test("Git fetch and pull write only local repository metadata", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const remote = path.join(root, "remote.git");
		git(root, "init", "--bare", "--quiet", remote);
		git(repo, "remote", "add", "origin", remote);
		// Unlike push, fetch/pull never write the remote — only local refs and metadata.
		check("git fetch origin", repo, true);
		check("git pull origin", repo, true);
		git(repo, "remote", "set-url", "origin", outside);
		check("git fetch origin", repo, true); // the remote location is only read
		check("git pull origin", repo, true);
	});

	test("Git executable-injection flags fail closed", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const remote = path.join(root, "remote.git");
		git(root, "init", "--bare", "--quiet", remote);
		git(repo, "remote", "add", "origin", remote);
		check("git fetch --upload-pack=evil origin", repo, false);
		check("git fetch --exec=evil origin", repo, false);
		check("git push --receive-pack=evil origin", repo, false);
		check("git push --exec=evil origin", repo, false);
		check(`git clone --config user.name=x ${quote(remote)} ${quote(path.join(root, "c1"))}`, root, false);
		check(`git clone --config-env=A=B ${quote(remote)} ${quote(path.join(root, "c2"))}`, root, false);
		check(`git clone -c user.name=x ${quote(remote)} ${quote(path.join(root, "c3"))}`, root, false);
		// Bundled short forms must not slip past the per-subcommand prefix check.
		check(`git clone -cuser.name=x ${quote(remote)} ${quote(path.join(root, "c4"))}`, root, false);
		check(`git clone -u${quote(path.join(root, "evil"))} ${quote(remote)} ${quote(path.join(root, "c5"))}`, root, false);
		check("git rebase --exec=evil HEAD~1", repo, false);
		check("git rebase -x evil HEAD~1", repo, false);
		check("git rebase -xevil HEAD~1", repo, false);
		check("git bisect run evil", repo, false);
		check(`git clone --template=${quote(path.join(root, "tpl"))} ${quote(remote)} ${quote(path.join(root, "c6"))}`, root, false);
		check(`git init --template=${quote(path.join(root, "tpl"))} ${quote(path.join(root, "init-tpl"))}`, root, false);
	});

	test("Git template directory environment blocks repository creation", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		const target = path.join(root, "newrepo");
		// CONTRACT: GIT_TEMPLATE_DIR installs hooks like --template, so a command-provided
		// value must fail closed even though the destination is inside temp.
		check(`git -C ${quote(repo)} init ${quote(target)}`, outside, true);
		check(`GIT_TEMPLATE_DIR=${quote(path.join(root, "evil"))} git -C ${quote(repo)} init ${quote(target)}`, outside, false);
	});

	test("Git unknown, write-redirection, and executable config overrides stay blocked", (t) => {
		const repo = repository(fixture(t));
		for (const config of ["unknown.setting=value", `core.worktree=${outside}`, `core.hooksPath=${outside}`, "core.fsmonitor=touch", "core.pager=touch", "diff.external=touch", "alias.inspect=!touch"]) {
			check(`git -c ${quote(config)} status`, repo, false);
			check(`git -c ${quote(config)} add file`, repo, false);
		}
		check("git -c color.ui=never -c core.fsmonitor=touch status", repo, false);
	});

	test("Git mutable short flags are context-dependent, not blanket injection", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		// CONTRACT: `-c`/`-x`/`-u` mean commit-reuse/cherry-pick-origin/set-upstream for these
		// subcommands. They are allowed when the write roots resolve inside temp and blocked
		// outside, while `clone -c/-u` and the long injection flags stay blocked (see the
		// executable-injection test above).
		for (const command of ["commit -c HEAD~1", "cherry-pick -x HEAD~1", "branch -c copy HEAD", "push -u origin main", "fetch -u origin"]) {
			check(`git ${command}`, repo, true);
			check(`git -C ${quote(outside)} ${command}`, repo, false);
		}
	});

	test("Git proxy-command hook environment blocks transport delegation", (t) => {
		const root = fixture(t);
		const remote = path.join(fixture(t), "remote.git");
		git(fixture(t), "init", "--bare", "--quiet", remote);
		// C1: GIT_PROXY_COMMAND is an executable hook on clone/fetch — command-provided blocks.
		for (const prefix of localEnvironment("GIT_PROXY_COMMAND", "evil-cmd")) {
			check(`${prefix} git clone ${quote(remote)} ${quote(path.join(root, "c"))}`, root, false);
			check(`${prefix} git fetch ${quote(remote)}`, root, false);
		}
		check(`export GIT_PROXY_COMMAND=evil-cmd; git clone ${quote(remote)} ${quote(path.join(root, "c2"))}`, root, false);
		// Positive control: the user's own exported GIT_PROXY_COMMAND is trusted process env.
		const saved = process.env.GIT_PROXY_COMMAND;
		t.after(() => { if (saved === undefined) delete process.env.GIT_PROXY_COMMAND; else process.env.GIT_PROXY_COMMAND = saved; });
		process.env.GIT_PROXY_COMMAND = "evil-cmd";
		check(`git clone ${quote(remote)} ${quote(path.join(root, "c3"))}`, root, true);
		delete process.env.GIT_PROXY_COMMAND;
	});

	test("Git trace/redirect environment blocks file creation even on read-only commands", (t) => {
		const repo = repository(fixture(t));
		const traces = [
			"GIT_TRACE", "GIT_TRACE_PACK_ACCESS", "GIT_TRACE_PACKET", "GIT_TRACE_PERFORMANCE",
			"GIT_TRACE_SETUP", "GIT_TRACE_SHALLOW", "GIT_TRACE_CURL", "GIT_TRACE_CURL_NOISE",
			"GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF",
			"GIT_REDIRECT_STDOUT", "GIT_REDIRECT_STDERR",
		];
		// C2: command-provided trace/redirect names a path git opens from any subcommand, including reads.
		for (const name of traces) {
			for (const prefix of localEnvironment(name, outside)) {
				check(`${prefix} git log -1`, repo, false);
				check(`${prefix} git status`, repo, false);
				check(`${prefix} git rev-parse HEAD`, repo, false);
			}
			check(`export ${name}=${outside}; git log -1`, repo, false);
		}
		// Positive control: the user's exported env is trusted and does not block classification.
		const saved = process.env.GIT_TRACE;
		t.after(() => { if (saved === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = saved; });
		process.env.GIT_TRACE = outside;
		check("git log -1", repo, true);
		check("git status", repo, true);
		delete process.env.GIT_TRACE;
	});

	test("Git command-provided temp directories join the write roots", (t) => {
		const repo = repository(fixture(t));
		// TMPDIR/TEMP/TMP name where git stages transient files; an outside value is an outside write.
		for (const name of ["TMPDIR", "TEMP", "TMP"]) {
			for (const prefix of localEnvironment(name, outside)) {
				check(`${prefix} git commit -m x`, repo, false);
			}
			check(`${name}=${quote(repo)} git commit -m x`, repo, true);
		}
		// Positive control: the user's exported env stays trusted, like HOME/XDG and GIT_TRACE.
		const saved = process.env.TMPDIR;
		t.after(() => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; });
		process.env.TMPDIR = outside;
		check("git commit -m x", repo, true);
		delete process.env.TMPDIR;
	});

	test("Git config read modifiers and value flags are recognized as reads", (t) => {
		const repo = repository(fixture(t));
		// E4: --fixed-value, --default and attached -t/--type are output shapings, not writes.
		for (const query of [
			"config --get --fixed-value --default " + quote("x") + " user.name",
			"config --type=bool --get core.bare",
			"config -tbool --get core.bare",
			"config --default " + quote("x") + " --get user.name",
			"config --name-only --show-scope --list",
		]) {
			check(`git ${query}`, repo, true);
		}
		// A write disguised with read modifiers fails closed outside temp and writes only in temp.
		check(`git config --fixed-value --default ${quote("x")} user.name Written`, repo, true);
		check(`git config --fixed-value --default ${quote("x")} user.name Written`, outside, false);
		check(`git config --get --fixed-value user.name Written`, outside, true);
		check(`git config --get --add user.name Written`, outside, false);
		check(`git config --get user.name Written extra`, outside, false);
	});

	test("Git maintenance scheduler commands fail closed", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: start/stop install or remove an OS scheduler outside temp; only
		// `git maintenance run` executes work inside the repository (see the everyday
		// subcommands test below).
		check("git maintenance start", repo, false);
		check("git maintenance stop", repo, false);
	});

	test("Git everyday subcommands are recognized and path-checked", (t) => {
		const repo = repository(fixture(t));
		// E1: write-capable subcommands are allowed in temp and blocked outside.
		for (const command of ["gc", "maintenance run"]) {
			check(`git ${command}`, repo, true);
			check(`git ${command}`, outside, false);
		}
		// Read sub-actions are immutable: recognized (no "unrecognized" block), allowed anywhere.
		for (const query of ["bundle list-heads HEAD", "sparse-checkout list", "maintenance list"]) {
			check(`git ${query}`, repo, true);
			check(`git ${query}`, outside, true);
		}
		// Write sub-actions of mixed subcommands are path-checked; in-temp allowed, outside blocked.
		check(`git bundle create ${quote(path.join(repo, "b.bundle"))} HEAD`, repo, true);
		check(`git sparse-checkout set src`, repo, true);
		check(`git sparse-checkout set src`, outside, false);
		// CONTRACT: `info` is not a real git-bundle subcommand (git errors before any write), so
		// it gets no read trust: an unproven write-path verb must not enter the read allowlist.
		check("git bundle info b.bundle", repo, true);
	});

	test("Git current mutable option forms stay allowed inside a temp repository", (t) => {
		const repo = repository(fixture(t));
		for (const command of [
			"git notes add -m note",
			"git reflog expire --all",
			"git restore --source=HEAD file",
			"git bundle create bundle.bin --all",
			"git sparse-checkout set --cone",
			"git am --abort",
		]) check(command, repo, true);
	});

	test("Git read-only subcommands are allowed anywhere; unmodeled ones fail closed", (t) => {
		const root = fixture(t);
		const repo = repository(root);
		// CONTRACT: proven pure-read subcommands print to stdout and never block — anywhere.
		for (const query of ["check-ignore foo", "check-attr user.path", "show-ref", "cherry upstream", "ls-remote"]) {
			check(`git ${query}`, outside, true);
			check(`git ${query}`, repo, true);
		}
		// CONTRACT: a subcommand this table does not model fails closed everywhere — its
		// implicit destination (credential-store writes $HOME/.git-credentials) is unprovable.
		check("git madeup-subcommand", repo, false);
		check("git madeup-subcommand", outside, false);
		check("git credential-store store", repo, false);
	});

	test("Git global version/help and per-subcommand help are read-only from any cwd", (t) => {
		const root = fixture(t);
		const outsideDest = path.join(outside, "help-target");
		// CONTRACT: `--version`/`--help` print and exit, so they are read-only even with no
		// subcommand and even when the cwd sits outside every writable temp root.
		for (const command of ["git --version", "git --help", "git -h", "git --bare"]) {
			check(command, root, true);
			check(command, outside, true);
		}
		// CONTRACT: per-subcommand help is read-only for immutable and MUTABLE subcommands alike.
		// `clone`/`init` default their destination to cwd, so help must short-circuit BEFORE the
		// write-root check; a help flag makes git ignore every operand.
		for (const command of [
			"git clone -h", "git clone --help", `git clone -h ${quote(outsideDest)}`,
			"git init -h", "git init --help",
			"git status -h", "git status --help", "git log -h", "git commit -h", "git add --help",
		]) {
			check(command, root, true);
			check(command, outside, true);
		}
		// CONTRACT: unknown subcommands stay fail-closed even with a help flag.
		check("git frobnicate -h", root, false);
		check("git frobnicate -h", outside, false);
		// CONTRACT: a help token consumed as a value is data, not a help invocation. `git commit
		// -m -h` really commits with message "-h", so it must still be path-checked.
		check("git commit -m -h", repository(fixture(t)), true);
		check("git commit -m -h", outside, false);
	});

	test("Git outside-temp block wording names metadata anchors distinctly from destinations", (t) => {
		const repo = repository(fixture(t));
		// CONTRACT: a pinned `.git` metadata anchor reads as "git metadata location"; a real
		// subcommand destination keeps the per-subcommand "git <sub> output" wording.
		const anchor = classifyBashCommand(`git --git-dir=${quote(path.join(outside, ".git"))} status`, repo);
		assert.equal(anchor.ok, false, "metadata anchor must block");
		assert.match(anchor.reason, /git metadata location blocked outside temp/);
		const output = classifyBashCommand(`git format-patch -o ${quote(path.join(outside, "out.patch"))} HEAD`, repo);
		assert.equal(output.ok, false, "output destination must block");
		assert.match(output.reason, /git format-patch output blocked outside temp/);
	});

	// These tests materialize real fixtures outside the temp roots (a bare remote, an outside
	// repository, an outside index) to prove the classifier blocks the writes they enable.
	if (outsideWritable) {
		test("Git real linked worktrees outside temp block metadata writes but not reads", (t) => {
			const root = fixture(t);
			const outsideRoot = fixture(t, os.homedir());
			const repo = repository(outsideRoot);
			const linked = path.join(root, "linked");
			git(repo, "worktree", "add", "--quiet", "--detach", linked);
			check("git reset --hard HEAD", linked, false);
			check(`git worktree add ${quote(path.join(root, "other"))}`, repo, false);
			check("git status", linked, true);
		});

		test("Git push checks the repository selected by the resolved remote name", (t) => {
			const root = fixture(t);
			const repo = repository(root);
			// P0-1: quoting or indirection previously hid the remote name, so a configured
			// outside remote was bypassed. Every spelled form must resolve to the config entry.
			const outsideRemote = path.join(fixture(t, os.homedir()), "remote.git");
			git(root, "init", "--bare", "--quiet", outsideRemote);
			git(repo, "remote", "add", "origin", outsideRemote);
			check('git push "origin" HEAD', repo, false);
			check("git push 'origin' HEAD", repo, false);
			check("R=origin; git push \"$R\" HEAD", repo, false);
			check('git push --repo="origin"', repo, false);
			// Positive control: the same quoted name against a temp-local remote stays allowed.
			const tempRemote = path.join(root, "temp-remote.git");
			git(root, "init", "--bare", "--quiet", tempRemote);
			git(repo, "remote", "set-url", "origin", tempRemote);
			check('git push "origin" HEAD:refs/heads/x', repo, true);
		});

		test("Git command-local index destinations outside temp are blocked and preserved", (t) => {
			const repo = repository(fixture(t));
			const index = path.join(fixture(t, os.homedir()), "index");
			writeFileSync(index, "outside contents must survive\n");
			for (const prefix of localEnvironment("GIT_INDEX_FILE", index)) {
				check(`${prefix} git add file`, repo, false);
				assert.equal(readFileSync(index, "utf8"), "outside contents must survive\n");
				assert.equal(existsSync(`${index}.lock`), false);
			}
		});

		test("Git explicit .git metadata anchors are path-checked for read-only commands", (t) => {
			const repo = repository(fixture(t));
			// D1: --git-dir / GIT_DIR / GIT_COMMON_DIR pin the .git metadata, where `status` refreshes the
			// index and `fsck --lost-found` writes lost-found — so an outside metadata anchor blocks reads.
			for (const prefix of [
				`git --git-dir=${quote(outside)} log -1`,
				`GIT_DIR=${quote(outside)} git status`,
				`GIT_COMMON_DIR=${quote(outside)} git log -1`,
			]) {
				check(prefix, repo, false);
			}
			for (const prefix of localEnvironment("GIT_DIR", outside)) {
				check(`${prefix} git status`, repo, false);
				check(`${prefix} git fsck --lost-found`, repo, false);
			}
			// Worktree/cwd anchors (-C, --work-tree, GIT_WORK_TREE) are read contexts: read-only git stays
			// allowed from any directory, and an ambient outside repo is the accepted limitation.
			check(`git -C ${quote(outside)} log -1`, repo, true);
			check(`git --work-tree=${quote(outside)} log -1`, repo, true);
			check("git log -1", repository(fixture(t, os.homedir())), true);
		});

		test("Git accepts attached short flags and follows --git-dir gitfile pointers", (t) => {
			const root = fixture(t);
			const repo = repository(root);
			// E2: `-C<dir>` and `-t<type>` attach the value to a short flag.
			check(`git -C${quote(repo)} init`, outside, true);
			check(`git -C${quote(outside)} init`, repo, false);
			check(`git config -tbool --get core.bare`, repo, true);
			check(`git config -t bool --get core.bare`, repo, true);
			// E3: --git-dir a gitfile (a linked worktree's .git file) is followed to the real repo.
			const outsideRepo = repository(fixture(t, os.homedir()));
			const linked = path.join(root, "linked");
			git(outsideRepo, "worktree", "add", "--quiet", "--detach", linked);
			check(`git --git-dir=${quote(path.join(linked, ".git"))} log -1`, root, false);
			const tempLinked = path.join(root, "temp-linked");
			git(repo, "worktree", "add", "--quiet", "--detach", tempLinked);
			check(`git --git-dir=${quote(path.join(tempLinked, ".git"))} log -1`, root, true);
			// D2: GIT_DIR / GIT_COMMON_DIR follow the same gitdir: pointer file as --git-dir, so the
			// env form cannot dodge the anchor check by naming a pointer file.
			for (const name of ["GIT_DIR", "GIT_COMMON_DIR"]) {
				for (const prefix of localEnvironment(name, path.join(linked, ".git"))) {
					check(`${prefix} git status`, root, false);
					check(`${prefix} git fsck --lost-found`, root, false);
				}
			}
			for (const prefix of localEnvironment("GIT_DIR", path.join(tempLinked, ".git"))) {
				check(`${prefix} git status`, root, true);
			}
		});

		test("Git read-only tag, worktree, and color queries stay immutable in outside repositories", (t) => {
			const repo = repository(fixture(t, os.homedir()));
			git(repo, "tag", "v1.0");
			const config = path.join(repo, ".git", "config"), before = readFileSync(config);
			for (const query of ['tag -l "v*"', "tag --list", "worktree list", "worktree list --porcelain", "config --get-color color.diff red"]) {
				check(`git ${query}`, repo, true);
			}
			assert.deepEqual(readFileSync(config), before);
		});
	} else capabilityGate("readonly git classifier requires outside-temp writes", "cannot write outside temp");

	// Measurement, not a behavior oracle: instrumentation (STEP A of the probe audit) counts how
	// many `git config` subprocesses ONE classification pass spawns. A PATH shim wraps only the
	// classifier's `git` spawns (fixture builds finish before PATH changes), appends one byte per
	// spawn, and execs the real git, so probes still return real config. The bound pins the
	// measured count; raise it deliberately after an optimization, never by drift.
	test("Git classification spawns a bounded number of config probes per command", (t) => {
		if (!posixHost) return;
		const root = fixture(t);
		const repo = repository(root);
		const remote = path.join(root, "remote.git");
		git(root, "init", "--bare", "--quiet", remote);
		git(repo, "remote", "add", "origin", remote);
		// Two metadata directories in one pass: a linked worktree classifies its worktree gitdir
		// plus the common repository.
		const linked = path.join(root, "linked");
		git(repo, "worktree", "add", "--quiet", "--detach", linked);
		const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		const bin = path.join(root, "bin"), counter = path.join(root, "probes");
		mkdirSync(bin);
		writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf %s x >> "$COUNTER_FILE"\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
		const savedPath = process.env.PATH;
		const savedCounter = process.env.COUNTER_FILE;
		t.after(() => {
			process.env.PATH = savedPath;
			if (savedCounter === undefined) delete process.env.COUNTER_FILE;
			else process.env.COUNTER_FILE = savedCounter;
		});
		process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
		process.env.COUNTER_FILE = counter;
		// Prove the shim fires with a direct spawn, not with a classifier pass: the classifier
		// can legitimately spawn zero probes for a command (cache, no config read), so a
		// probe-count lower bound would be timing-dependent and flaky.
		execFileSync("git", ["--version"], { stdio: "ignore" });
		assert.ok(existsSync(counter) && readFileSync(counter, "utf8").length > 0, "git PATH shim did not record a spawn");
		rmSync(counter, { force: true });
		const observed: Record<string, number> = {};
		for (const command of [
			"git log -1",
			"git push origin HEAD:refs/heads/x",
			`git -C ${quote(linked)} reset --hard HEAD`,
		]) {
			rmSync(counter, { force: true });
			classifyBashCommand(command, repo);
			observed[command] = existsSync(counter) ? readFileSync(counter, "utf8").length : 0;
		}
		for (const [command, count] of Object.entries(observed)) {
			assert.ok(count <= PROBE_BOUND, `${command} spawned ${count} > ${PROBE_BOUND} git probes`);
		}
	});
}

// Upper bound only. Lower bounds are deliberately absent: whether a given command probes once or
// four times depends on the repository fixture, so pinning a minimum would make this test
// refactor-hostile. Raise PROBE_BOUND only after a deliberate optimization, never by drift.
const PROBE_BOUND = 4;
