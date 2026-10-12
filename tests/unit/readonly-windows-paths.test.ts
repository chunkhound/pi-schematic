import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { quoteShellArgument } from "../../os-sandbox.js";
import { classifyBashCommand } from "../../readonly-bash.js";
import { TEMP_DIR } from "../../temp-dir.js";
import { isCrossDriveRelative, isWindowsRiskyPathTarget } from "../../readonly-shell-utils.js";
import { shellPath, shellPathFor, tmpDir } from "./helpers.js";

// Win32 syntax splits into two classes:
//  - device namespaces (`\\?\`, `\\.\`, `\??\`, `//?/`, `//./`) name the NT object manager,
//    which no resolver can prove; they fail closed on every host.
//  - drive anchors (`C:\`, `C:/`, `C:rel`) and backslash-UNC (`\\server\share`) are modelable
//    by the win32 resolver but not by a POSIX one, so they fail closed only off Windows.
//    Forward-slash `//server/share` matches neither pattern; both resolvers land it outside temp.
// Commands are classified, never executed. Only temp directory fixtures are created.
const cwd = os.tmpdir();
const windowsOnly = { skip: process.platform !== "win32" && "native Windows path resolution required" };
const posixOnly = { skip: process.platform === "win32" && "POSIX cannot resolve Windows paths" };

function assertVerdict(command: string, workingDirectory: string, allowed: boolean, reason?: RegExp): void {
	const verdict = classifyBashCommand(command, workingDirectory);
	assert.equal(verdict.ok, allowed, command);
	if (reason) {
		assert.equal(verdict.ok, false, command);
		assert.match(verdict.reason, reason, command);
	}
}

const unprovable = (command: string): void => assertVerdict(command, cwd, false, /fail-closed/);
const blockedOutside = (command: string, workingDirectory = cwd): void =>
	assertVerdict(command, workingDirectory, false, /blocked outside temp dir/);

function assertWrites(target: string, workingDirectory: string, allowed: boolean): void {
	for (const command of [`touch ${quoteShellArgument(target)}`, `echo hi > ${quoteShellArgument(target)}`]) {
		assertVerdict(command, workingDirectory, allowed, allowed ? undefined : /blocked outside temp dir/);
	}
}

async function tempWorkspace(t: TestContext): Promise<string> {
	const root = await tmpDir();
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspace = path.join(root, "directory with spaces");
	await mkdir(workspace);
	return workspace;
}

test("device-prefix targets fail closed", () => {
	unprovable("touch '\\\\?\\C:\\x'");
	unprovable("touch '\\\\.\\C:\\x'");
	unprovable("touch '//?/C:/x'");
	unprovable("touch '//./C:/x'");
	unprovable("touch '\\??\\C:\\x'");
	// Redirect targets share the same verdict path.
	unprovable("echo hi > '//?/C:/x'");
});

test("drive-anchored and drive-relative targets fail closed off Windows", posixOnly, () => {
	unprovable("touch 'C:\\Temp\\x'");
	unprovable("touch 'c:/temp/x'");
	unprovable("touch 'C:rel'");
	unprovable("touch 'D:.'");
	// A drive-anchored cd proves nothing, so later relative writes fail closed.
	const verdict = classifyBashCommand("cd C:\\Temp && touch f", cwd);
	assert.equal(verdict.ok, false, "cd to a drive path must fail closed");
	assert.match(verdict.reason, /cwd unknown after cd/, "cd C:\\Temp && touch f");
});

test("UNC targets fail closed off Windows", posixOnly, () => {
	unprovable("touch '\\\\server\\\\share\\\\f'");
});

test("Windows UNC operands and redirects block as outside temp", windowsOnly, () => {
	// A missing local share avoids remote-network dependencies; no command is executed.
	const target = `\\\\localhost\\pi-readonly-missing-share-${process.pid}\\file with spaces`;
	assertWrites(target, cwd, false);
	assertWrites(shellPath(target), cwd, false);
});

test("Windows native and slash paths preserve temp containment", windowsOnly, async (t) => {
	const workspace = await tempWorkspace(t);
	const outside = path.join(path.parse(workspace).root, "readonly win probe");
	for (const target of [path.join(workspace, "file with spaces"), outside]) {
		for (const spelling of [target, shellPath(target)]) assertWrites(spelling, cwd, target !== outside);
	}
});

test("Windows short (8.3) and long temp spellings canonicalize identically", windowsOnly, (t) => {
	// The runner's tmpdir may be the 8.3 short name (`RUNNER~1`). The classifier must expand it
	// exactly like the OS resolver, or a git-written long path canonicalizes differently and is
	// judged outside. Before the native resolver, the long spelling blocked here.
	const short = os.tmpdir();
	const long = fs.realpathSync.native(short);
	// The two spellings must differ, or this test proves nothing. Skip honestly on a long-name runner.
	if (short === long) return t.skip("runner tmpdir is already long; no 8.3 spelling to compare");
	for (const spelling of [short, long]) {
		assert.equal(classifyBashCommand(`touch ${quoteShellArgument(spelling)}/readonly-83-probe`, short).ok, true, spelling);
	}
});

test("Windows mktemp ambient base keeps a native backslash TMPDIR proven", windowsOnly, () => {
	// A bare `mktemp -d` builds its name under the host temp dir. That base must not be
	// shell-decoded: decoding would strip `C:\Users\...` separators and lose temp provenance.
	assert.equal(classifyBashCommand(`D=$(mktemp -d) && cd "$D" && touch f`, os.tmpdir()).ok, true);
});

test("Windows drive-relative writes follow an explicit same-drive cwd", windowsOnly, async (t) => {
	const workspace = await tempWorkspace(t);
	const root = path.parse(workspace).root;
	if (!/^[A-Za-z]:\\$/.test(root)) t.skip("fixture needs a local drive");
	// Same-drive cwd removes the ambient per-drive working-directory dependency.
	const target = `${root.slice(0, 2)}file with spaces`;
	assertWrites(target, workspace, true);
	assertWrites(target, root, false);
});

test("Windows native cd paths determine later relative writes", windowsOnly, async (t) => {
	const workspace = await tempWorkspace(t);
	const outside = path.parse(workspace).root;
	const command = (directory: string) => `cd ${quoteShellArgument(directory)} && touch 'file with spaces'`;
	// Existing directories ensure && reaches the write instead of passing vacuously.
	assertVerdict(command(workspace), outside, true);
	blockedOutside(command(outside), workspace);
});

test("a lone drive-rooted backslash name follows the host resolver", () => {
	// A lone `\foo` stays a POSIX-relative filename and resolves normally; win32 roots it
	// to the current drive (C:\Windows\x), outside temp, so it blocks.
	const backslashName = classifyBashCommand("touch '\\Windows\\\\x'", cwd);
	if (process.platform === "win32") {
		assert.equal(backslashName.ok, false, "win32 roots the backslash name outside temp");
	} else {
		assert.equal(backslashName.ok, true, "POSIX-relative backslash name");
	}
});

test("junction traversal stays unproven without filesystem data", () => {
	// True reparse-point detection needs FS reads (POSIX skip by design); the
	// syntactic namespace forms above are the classifier's whole junction story.
	unprovable("touch '\\??\\Volume{x}\\f'");
});

test("controls: temp writes pass, outside writes block as outside", () => {
	assertVerdict(`touch ${quoteShellArgument(shellPath(path.join(TEMP_DIR, "f")))}`, cwd, true);
	const outside = classifyBashCommand("touch /etc/readonly-win-probe", cwd);
	assert.equal(outside.ok, false, "outside write");
	assert.match(outside.reason, /blocked outside temp dir/, "proven-outside keeps its diagnosis");
});

// Pure, host-independent contracts for the win32 split: the platform flag is explicit, so
// Linux CI exercises the win32 branch without a Windows runner.
test("risky-target split is platform-gated", () => {
	for (const target of ["\\\\?\\C:\\x", "\\\\.\\C:\\x", "//?/C:/x", "//./C:/x", "\\??\\C:\\x"]) {
		assert.equal(isWindowsRiskyPathTarget(target, "win32"), true, `${target} fails closed on win32`);
		assert.equal(isWindowsRiskyPathTarget(target, "linux"), true, `${target} fails closed on posix`);
	}
	for (const target of ["C:\\Temp\\x", "c:/temp/x", "C:rel", "D:.", "\\\\server\\share\\f"]) {
		assert.equal(isWindowsRiskyPathTarget(target, "linux"), true, `${target} fails closed off Windows`);
		assert.equal(isWindowsRiskyPathTarget(target, "win32"), false, `${target} defers to win32 resolver`);
	}
	assert.equal(isWindowsRiskyPathTarget("\\foo", "win32"), false, "lone backslash stays host-resolved");
	assert.equal(isWindowsRiskyPathTarget("//server/share", "win32"), false, "slash UNC resolves, never gates");
});

test("cross-drive-relative needs another drive's ambient cwd", () => {
	assert.equal(isCrossDriveRelative("D:rel", "C:\\ws"), true, "D:rel from C: is unprovable");
	assert.equal(isCrossDriveRelative("d:rel", "C:\\ws"), true, "drive compare is case-insensitive");
	assert.equal(isCrossDriveRelative("C:rel", "C:\\ws"), false, "same-drive stays provable");
	assert.equal(isCrossDriveRelative("C:\\abs", "D:\\ws"), false, "absolute drive path is not relative");
	assert.equal(isCrossDriveRelative("rel", "C:\\ws"), false, "bare relative has no drive");
	assert.equal(isCrossDriveRelative("D:rel", "/tmp/ws"), false, "posix cwd has no drive");
});

test("shellPathFor maps separators without a Windows host", () => {
	assert.equal(shellPathFor("C:\\Temp\\x", "\\"), "C:/Temp/x", "backslash to slash");
	assert.equal(shellPathFor("\\\\server\\share\\f", "\\"), "//server/share/f", "UNC to slash");
	assert.equal(shellPathFor("/tmp/x", "/"), "/tmp/x", "posix identity");
	assert.equal(shellPathFor(shellPathFor("C:\\Temp\\x", "\\"), "/"), "C:/Temp/x", "double apply is idempotent");
});
