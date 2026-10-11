import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { TEMP_DIR } from "../../temp-dir.js";

// Win32-only syntax the POSIX resolver cannot model: device prefixes (`\\?\`,
// `\\.\\`, NT `\??\`, `//?/`, `//./`), drive anchors (`C:\`, `C:/`,
// drive-relative `C:rel`), and UNC (`\\server\share`). All fail closed;
// A lone drive-rooted `\foo` stays POSIX-relative. Pure classify: no writes, temp cwd only.
const cwd = os.tmpdir();
const blocked = (command: string): void => {
	const verdict = classifyBashCommand(command, cwd);
	assert.equal(verdict.ok, false, `${command} must fail closed`);
	assert.match(verdict.reason, /fail-closed/, command);
};

test("device-prefix targets fail closed", () => {
	blocked("touch '\\\\?\\C:\\x'");
	blocked("touch '\\\\.\\C:\\x'");
	blocked("touch '//?/C:/x'");
	blocked("touch '//./C:/x'");
	blocked("touch '\\??\\C:\\x'");
	// Redirect targets share the same verdict path.
	blocked("echo hi > '//?/C:/x'");
});

test("drive-anchored and drive-relative targets fail closed", () => {
	blocked("touch 'C:\\Temp\\x'");
	blocked("touch 'c:/temp/x'");
	blocked("touch 'C:rel'");
	blocked("touch 'D:.'");
	// A drive-anchored cd proves nothing, so later relative writes fail closed.
	const verdict = classifyBashCommand("cd C:\\Temp && touch f", cwd);
	assert.equal(verdict.ok, false, "cd to a drive path must fail closed");
	assert.match(verdict.reason, /cwd unknown after cd/, "cd C:\\Temp && touch f");
});

test("UNC targets fail closed", () => {
	blocked("touch '\\\\server\\\\share\\\\f'");
	// A lone drive-rooted `\foo` stays a POSIX-relative filename and resolves normally;
	// win32 roots it to the current drive (C:\Windows\x), outside temp, so it blocks.
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
	blocked("touch '\\??\\Volume{x}\\f'");
});

test("controls: temp writes pass, outside writes block as outside", () => {
	assert.equal(classifyBashCommand(`touch ${path.join(TEMP_DIR, "f")}`, cwd).ok, true, "temp write");
	const outside = classifyBashCommand("touch /etc/readonly-win-probe", cwd);
	assert.equal(outside.ok, false, "outside write");
	assert.match(outside.reason, /blocked outside temp dir/, "proven-outside keeps its diagnosis");
});
