import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { shellPath } from "./helpers.js";

// Per-module localization probes: one verdict-level contract per split module,
// through the public classifier only (no internals). Each pins the module's
// user-facing verdict so a refactor that drops its branch fails loudly.
const workspace = shellPath(os.tmpdir());

function verdict(command: string, allowed: boolean, match?: RegExp): void {
	const result = classifyBashCommand(command, workspace);
	assert.equal(result.ok, allowed, `${command} → ${JSON.stringify(result)}`);
	if (!result.ok && match) assert.match(result.reason, match, command);
}

test("scanner: unterminated substitution fails closed", () => {
	// The segment splitter cannot close the group, so nothing may be authorized.
	verdict("echo $(unclosed", false, /unsupported shell grouping syntax/);
	verdict("echo hi", true);
});

test("heredoc: redirect target on a heredoc line is still checked", () => {
	// The body is inert data, but `> /etc/x` on the header writes outside temp.
	verdict("cat <<EOF > /etc/x\nhi\nEOF", false, /write redirect blocked outside temp dir/);
	verdict(`cat <<EOF > ${shellPath(path.join(workspace, "x"))}\nhi\nEOF`, true);
});

test("dirchange: tracked cd moves later relative writes", () => {
	verdict("cd /etc && touch f", false, /touch blocked/);
	verdict(`cd ${workspace} && touch f`, true);
});

test("git-options: unknown short flags fail closed", () => {
	// Single-dash bundles expand through the git-options walker; `-Z` is unknown.
	verdict("git add -Z file", false, /unsupported git option blocked: add -Z/);
	verdict("git log --oneline", true);
});

test("shell-utils: unprovable targets fail closed, never misdiagnosed", () => {
	// Unknown vars prove nothing; the reason must say so, not claim "outside".
	const result = classifyBashCommand('touch "$NO_SUCH_VAR_XYZ_123/x"', workspace);
	assert.equal(result.ok, false, "unknown var target must fail closed");
	if (!result.ok) {
		assert.match(result.reason, /cannot prove target stays inside temp/);
		assert.doesNotMatch(result.reason, /blocked outside temp dir/);
	}
	verdict(`touch ${shellPath(path.join(workspace, "x"))} > /dev/null`, true);
});
