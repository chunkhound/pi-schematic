import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
	READONLY_CHILD_AUTHORITY_NOTE,
	READONLY_WRITE_EDIT_SUMMARY,
	READONLY_INVALID_BASH_COMMAND_REASON,
} from "../../notifications.js";
import {
	buildChildToolNames,
	filterReadonlyToolNames,
} from "../../spawn/index.js";
import { applyReadonlyBashGuard } from "../../readonly-bash.js";
import { runRealChildInvocation } from "./helpers.js";

// ── Tool filtering ───────────────────────────────────────────────────

test("filterReadonlyToolNames removes write, edit, and powershell in readonly mode", () => {
	const tools = ["read", "bash", "write", "edit", "powershell", "notebook_read"];
	const filtered = filterReadonlyToolNames(tools, true);
	assert.equal(filtered.includes("write"), false);
	assert.equal(filtered.includes("edit"), false);
	assert.equal(filtered.includes("powershell"), false);
	assert.equal(filtered.includes("read"), true);
	assert.equal(filtered.includes("bash"), true);
	assert.equal(filtered.includes("notebook_read"), true);
});

test("filterReadonlyToolNames preserves all tools when readonly is off", () => {
	const tools = ["read", "bash", "write", "edit", "powershell"];
	assert.deepEqual(filterReadonlyToolNames(tools, false), tools);
});

// ── Child tool names ─────────────────────────────────────────────────

test("buildChildToolNames excludes spawn and handoff from inherited tools", () => {
	const parentTools = ["read", "bash", "write", "edit", "spawn", "handoff"];
	const result = buildChildToolNames(parentTools, []);
	assert.equal(result.includes("spawn"), false);
	assert.equal(result.includes("handoff"), false);
	assert.equal(result.includes("read"), true);
	assert.equal(result.includes("bash"), true);
	assert.equal(result.includes("write"), true);
});

// ── Readonly prompt constants ────────────────────────────────────────

test("readonly child authority note communicates readonly inheritance", () => {
	assert.match(READONLY_CHILD_AUTHORITY_NOTE, /inherit readonly authority/i);
});

test("readonly write/edit summary communicates blocked mutations", () => {
	assert.match(READONLY_WRITE_EDIT_SUMMARY, /\[readonly\] write\/edit\/powershell blocked/i);
	assert.match(READONLY_WRITE_EDIT_SUMMARY, /bash writes\/deletions outside temp blocked/i);
});

// ── Readonly bash guard ──────────────────────────────────────────────

test("readonly bash guard rejects non-string commands", () => {
	const cwd = process.cwd();
	for (const command of [undefined, null, 42, { command: "ls" }]) {
		const result = applyReadonlyBashGuard(command, cwd);
		assert.equal(result.action, "block", `expected block for ${String(command)}`);
		assert.match(result.reason, new RegExp(READONLY_INVALID_BASH_COMMAND_REASON));
	}
});

test("readonly bash guard blocks non-temp writes and allows temp writes", () => {
	const outsideTemp = path.join(os.homedir(), `readonly-child-test-${process.pid}-${Date.now()}`);
	const insideTemp = path.join(os.tmpdir(), `readonly-child-test-${Date.now()}`);
	const cwd = process.cwd();

	const blockResult = applyReadonlyBashGuard(`touch ${outsideTemp}`, cwd);
	assert.equal(blockResult.action, "block");
	assert.match(blockResult.reason, /Readonly mode:/);

	const tempResult = applyReadonlyBashGuard(`touch ${insideTemp} && rm ${insideTemp}`, cwd);
	assert.notEqual(tempResult.action, "block", "temp dir writes should not be blocked");
});

// ── Integration ──────────────────────────────────────────────────────

test("real readonly child omits write/edit/powershell and blocks a non-temp bash write", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Attempt the requested bash command and report its result.",
		readonly: true,
		invokeReadonlyBash: true,
		cwdOutsideTemp: true,
		activeTools: ["read", "bash", "write", "edit", "powershell", "agentic_e2e_probe", "spawn", "handoff"],
	});

	assert.equal(proof.result.details.model, proof.modelId);
	assert.match(proof.result.content[0].text, /READONLY_BASH_BLOCKED/);
	assert.equal(proof.bashWriteExists, false, "readonly child bash must not write to its cwd");
	assert.ok(proof.observedToolSets.length > 0);
	for (const toolNames of proof.observedToolSets) {
		assert.equal(toolNames.includes("write"), false);
		assert.equal(toolNames.includes("edit"), false);
		assert.equal(toolNames.includes("powershell"), false);
		assert.equal(toolNames.includes("spawn"), false);
		assert.equal(toolNames.includes("handoff"), false);
		assert.equal(toolNames.includes("bash"), true);
	}
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});
