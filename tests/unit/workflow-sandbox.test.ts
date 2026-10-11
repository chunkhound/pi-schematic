// WHY: the real CodemodeSandbox (QuickJS WASM + worker) must load under the
// node:test custom loader, and the host's own timeout clamp must prevent Node's
// timer overflow. This is the only test that touches the real sandbox.
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowSandbox, clampTimeoutMs, hardDeadlineMs, MAX_TIMEOUT_MS } from "../../workflow/sandbox.js";
import { compileWorkflow, WorkflowCompileError } from "../../workflow/compile.js";
import { composeWorkflow } from "../../workflow/driver.js";
import { mapSandboxError } from "../../workflow/host.js";
import type { WorkflowSandboxFactory } from "../../workflow/types.js";

test("sandbox loads wasm+worker under node:test and runs host globals", async () => {
	let calls = 0;
	const sandbox = createWorkflowSandbox({
		globals: [
			{
				name: "workflow.echo",
				spread: true,
				execute: (args: unknown) => {
					calls += 1;
					return { got: args };
				},
			},
		],
		timeoutMs: 30_000,
		memoryLimitBytes: 256 * 1024 * 1024,
	});
	const result = await sandbox.execute(`const a = await workflow.echo("x", 2); return a.got;`, {
		store: { intent: JSON.stringify("hello") },
	});
	await sandbox.close();
	assert.equal(result.ok, true);
	if (result.ok) assert.deepEqual(result.value, ["x", 2]);
	assert.equal(calls, 1);
});

test("sandbox reports a timeout kind when the deadline expires", async () => {
	const sandbox = createWorkflowSandbox({ timeoutMs: 200 });
	const result = await sandbox.execute(`while (true) {}`);
	await sandbox.close();
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.kind, "timeout");
});

test("createWorkflowSandbox clamps an overflowing explicit deadline to the timer max", () => {
	const captured: Array<{ timeoutMs?: number }> = [];
	const factory = (options: { timeoutMs?: number }) => {
		captured.push(options);
		return {} as never;
	};
	createWorkflowSandbox({ timeoutMs: MAX_TIMEOUT_MS + 1 }, factory as never);
	assert.equal(captured[0].timeoutMs, MAX_TIMEOUT_MS);
});

test("clampTimeoutMs clamps finite values to the timer max; only explicit no-limit disables the deadline", () => {
	assert.equal(clampTimeoutMs(1), 1);
	assert.equal(clampTimeoutMs(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
	assert.equal(clampTimeoutMs(MAX_TIMEOUT_MS + 1), MAX_TIMEOUT_MS);
	assert.equal(clampTimeoutMs(Number.MAX_SAFE_INTEGER), MAX_TIMEOUT_MS);
	assert.equal(clampTimeoutMs(0), Number.POSITIVE_INFINITY);
	assert.equal(clampTimeoutMs(-5), Number.POSITIVE_INFINITY);
	assert.equal(clampTimeoutMs(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
	assert.equal(clampTimeoutMs(Number.NaN), Number.POSITIVE_INFINITY);
});

test("hardDeadlineMs doubles the budget as a sanity deadline; unlimited disables it", () => {
	assert.equal(hardDeadlineMs(1_000), 2_000);
	assert.equal(hardDeadlineMs(Number.MAX_SAFE_INTEGER), MAX_TIMEOUT_MS, "overflow clamps to the timer max");
	assert.equal(hardDeadlineMs(null), Number.POSITIVE_INFINITY);
	assert.equal(hardDeadlineMs(0), Number.POSITIVE_INFINITY);
	assert.equal(hardDeadlineMs(-1), Number.POSITIVE_INFINITY);
});

test("a memory-limit OOM maps to error and surfaces its message", async () => {
	const oomResult = { ok: false as const, error: { kind: "memory", message: "oom" } };
	const sandbox = createWorkflowSandbox({
		timeoutMs: Infinity,
		memoryLimitBytes: 1,
	}, (() => ({
		execute: async () => oomResult,
		close: async () => {},
	})) as unknown as WorkflowSandboxFactory);
	const result = await sandbox.execute("code");
	await sandbox.close();
	assert.equal(result.ok, false);
	if (!result.ok) assert.deepEqual(result.error, oomResult.error);
	assert.equal(mapSandboxError(result.error, null), "error");
});

test("compile gate rejects globalThis/alias bypasses before runtime; direct calls still run", async () => {
	// WHY: the sandbox puts `workflow` on the global object, so `globalThis.workflow`
	// would reach the same handles without the serial contract. The compile gate is the
	// only enforcement, and every runtime execution passes through it first (see
	// readAndCompile: compile before execute), so its rejection must hold for bypasses.
	for (const body of [
		`workflow.checkpoint(null); globalThis.workflow.checkpoint(null);`,
		`workflow.checkpoint(null); const w = workflow; w.checkpoint(null);`,
	]) {
		assert.throws(() => compileWorkflow(`return defineWorkflow((workflow) => {\n${body}\n});\n`), WorkflowCompileError);
	}
	// Control: the gated direct-call shape still executes in the real sandbox.
	let calls = 0;
	const sandbox = createWorkflowSandbox({
		globals: [
			{
				name: "workflow.echo",
				spread: true,
				execute: () => {
					calls += 1;
					return "ok";
				},
			},
		],
		timeoutMs: 30_000,
		memoryLimitBytes: 256 * 1024 * 1024,
	});
	const result = await sandbox.execute(`const a = await workflow.echo(); return a;`, {
		store: { intent: JSON.stringify("hello") },
	});
	await sandbox.close();
	assert.equal(result.ok, true);
	assert.equal(calls, 1);
});

test("abort maps to cancelled; timeout, memory, and unknown kinds keep their mapping", () => {
	assert.equal(mapSandboxError({ kind: "aborted" }, null), "cancelled");
	assert.equal(mapSandboxError({ kind: "aborted" }, "cost-limit"), "cost-limit");
	assert.equal(mapSandboxError({ kind: "timeout" }, null), "time-limit");
	assert.equal(mapSandboxError({ kind: "timeout" }, "error"), "time-limit", "a pending stop never relabels a timeout");
	assert.equal(mapSandboxError({ kind: "script" }, null), "error");
	assert.equal(mapSandboxError({ kind: "memory" }, null), "error", "an OOM aborts as a reserved error");
	assert.equal(mapSandboxError({ kind: "memory" }, "time-limit"), "time-limit", "a pending stop wins over a later failure");
	assert.equal(mapSandboxError({ kind: "unknown-kind" }, null), "error", "unrecognized failures abort as errors");
});

// Regression guard for the codemode wrapper contract (worker.js wraps the script body in
// `(async (tools, console) => { <code> })` and posts `done` when the wrapper settles).
// docs/workflows.md (File and entry point) requires the file to RETURN defineWorkflow(fn): only a return propagates the
// workflow's promise, so the wrapper settles when the WORKFLOW finishes. A bare
// statement would let the wrapper resolve to undefined and fire `done` before the
// effects settle, silently truncating the run as a "returned" exit.

test("a returned workflow runs every effect through the wrapper; a bare statement is rejected", async () => {
	let calls = 0;
	const sandbox = createWorkflowSandbox({
		globals: [
			{ name: "workflow.echo", spread: true, execute: async () => { calls += 1; return "ok"; } },
			{ name: "workflow.checkpoint", spread: false, execute: async () => null },
		],
		timeoutMs: 30_000,
		memoryLimitBytes: 256 * 1024 * 1024,
	});
	const source = 'return defineWorkflow((workflow) => {\n  workflow.echo("a");\n  workflow.echo("b");\n  workflow.checkpoint(null);\n});\n';
	const result = await sandbox.execute(composeWorkflow(compileWorkflow(source)), { store: { intent: "x", args: "x" } });
	await sandbox.close();
	assert.equal(result.ok, true, "a returned workflow settles the wrapper only after the workflow completes");
	assert.equal(calls, 2, "both effects observe through the wrapper");
	// The bare (non-return) form must be rejected at compile time, never silently truncated.
	assert.throws(() => compileWorkflow('defineWorkflow((workflow) => {\n  workflow.checkpoint(null);\n});\n'), (error) => error instanceof WorkflowCompileError);
});
