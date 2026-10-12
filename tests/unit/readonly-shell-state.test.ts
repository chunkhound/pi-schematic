import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { shellPath } from "./helpers.js";

// Contracts under test: every operator chain returns a DEFINITIVE verdict, never a vacuous
// {ok:true} from classifying zero states. Each blocked case is a benign prefix chained to an
// outside-temp write, so a missing classification is directly observable; each allowed case is a
// benign chain whose permission must survive later refactors.
//
// NOT claimed here: that these commands reach the empty-set fallback guarded in
// classifyShellGroup. That edge is currently unreachable — every shell part yields at least one
// success state by induction — so the guard is defence in depth, and no test can fail without it.
test("operator chains keep a definitive verdict instead of passing vacuously", (t) => {
	const workspace = shellPath(path.join(os.tmpdir(), `readonly-shell-state-${process.pid}`));
	mkdirSync(workspace, { recursive: true });
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const blocked = [
		"cd /nonexistent-xyz && rm -rf /etc", "true && rm -rf /etc", "false && rm -rf /etc",
		"false || rm -rf /etc", "true || rm -rf /etc", "echo a | echo b; rm -rf /etc",
		"echo a | echo b & rm -rf /etc", "true && { echo in-group; }; rm -rf /etc",
		"true && { ; }; rm -rf /etc", "false || echo x; rm -rf /etc",
	];
	const allowed = [
		"cd /nonexistent-xyz && echo hi", "true && { ; }", "false && echo hi",
		"false || echo x", "echo a | echo b & echo c", "true && { echo in-group; }",
	];
	for (const command of blocked) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, false, `${command} → ${JSON.stringify(verdict)}`);
		assert.ok(verdict.reason.length > 0, command);
	}
	for (const command of allowed) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, true, `${command} → ${JSON.stringify(verdict)}`);
	}
});

// These chains each have a failure branch whose cwd the classifier used to lose: a brace body
// that moved the shell, an eval/source child, and a `$VAR` command word. The failure branch must
// still classify at the moved cwd so a relative write there cannot pass as a temp write.
test("failure branches retain the cwd a group, eval, or dynamic command word moved to", (t) => {
	const workspace = shellPath(path.join(os.tmpdir(), `readonly-shell-state-moved-${process.pid}`));
	mkdirSync(workspace, { recursive: true });
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	// Sibling of the workspace root, never inside a temp root, so relative writes resolve outside.
	const outside = shellPath(path.join(path.parse(workspace).root, `readonly-shell-state-outside-${process.pid}`));
	const blocked = [
		`{ cd ${outside}; false; } || touch leak`,
		`eval "cd ${outside}; false" || touch leak`,
		`cmd=cd; $cmd ${outside}; touch leak`,
		`cmd=$(cat missing); $cmd ${outside}; touch leak`,
	];
	const allowed = [
		`{ cd ${workspace}; } || touch fallback`,
		`cmd=echo; $cmd hi`,
		`eval "true" || echo x`,
		`{ cd ${workspace}; false; }; touch after`,
	];
	for (const command of blocked) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, false, `${command} → ${JSON.stringify(verdict)}`);
	}
	for (const command of allowed) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, true, `${command} → ${JSON.stringify(verdict)}`);
	}
});

// `command eval`, `builtin eval`, and a quoted command word all leave the tracked cwd
// unprovable. The wrapper/quotes must not hide that, or a later relative write runs there.
test("wrapper prefixes and double-quoted command words cannot hide an unknown cwd", (t) => {
	const workspace = shellPath(path.join(os.tmpdir(), `readonly-shell-state-wrapped-${process.pid}`));
	mkdirSync(workspace, { recursive: true });
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const outside = shellPath(path.join(path.parse(workspace).root, `readonly-shell-state-wrapped-out-${process.pid}`));
	const blocked = [
		`command eval "cd ${outside}"; touch leak`,
		`builtin eval "cd ${outside}"; touch leak`,
		`C=cd; "$C" ${outside}; touch leak`,
	];
	const allowed = [
		"command echo hi",
		"builtin true",
		'C=echo; "$C" hi',
	];
	for (const command of blocked) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, false, `${command} → ${JSON.stringify(verdict)}`);
	}
	for (const command of allowed) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, true, `${command} → ${JSON.stringify(verdict)}`);
	}
});

// A dynamic cd behind a `command`/`builtin` wrapper still executes in the parent shell.
// The wrapper must not hide the `$VAR` command word from cwd tracking, or a chained
// relative write classifies at the caller cwd instead of the real one.
test("a dynamic cd wrapped in command/builtin still moves the tracked cwd", (t) => {
	const workspace = shellPath(path.join(os.tmpdir(), `readonly-shell-state-wrap-cd-${process.pid}`));
	mkdirSync(workspace, { recursive: true });
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const outside = shellPath(path.join(path.parse(workspace).root, `readonly-shell-state-wrap-out-${process.pid}`));
	const blocked = [
		`C=cd; command "$C" ${outside}; touch leak`,
		`C=cd; builtin "$C" ${outside}; touch leak`,
	];
	const allowed = [
		`C=cd; command "$C" ${workspace} && touch leak`,
		`command echo hi`,
	];
	for (const command of blocked) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, false, `${command} → ${JSON.stringify(verdict)}`);
	}
	for (const command of allowed) {
		const verdict = classifyBashCommand(command, workspace);
		assert.equal(verdict.ok, true, `${command} → ${JSON.stringify(verdict)}`);
	}
});

// Single quotes make the variable literal: Bash never expands them, so a single-quoted
// wrapper argument must NOT be expanded into a tracked `cd` — that would move the cwd to
// temp while the real shell never ran `cd`, letting `;`-chained writes pass as temp writes.
test("a single-quoted wrapper argument stays literal and keeps the caller cwd", (t) => {
	const outside = shellPath(path.join(path.parse(shellPath(os.tmpdir())).root, `readonly-shell-state-sq-${process.pid}`));
	const blocked = [
		`C=cd; command '$C' /tmp; touch leak`,
		`C=cd; builtin '$C' /tmp; touch leak`,
	];
	const allowed = [
		`C=cd; command "$C" /tmp; touch leak`,
		`C=cd; command "$C" ${shellPath(os.tmpdir())} && touch leak`,
	];
	for (const command of blocked) {
		const verdict = classifyBashCommand(command, outside);
		assert.equal(verdict.ok, false, `${command} → ${JSON.stringify(verdict)}`);
	}
	for (const command of allowed) {
		const verdict = classifyBashCommand(command, outside);
		assert.equal(verdict.ok, true, `${command} → ${JSON.stringify(verdict)}`);
	}
});
