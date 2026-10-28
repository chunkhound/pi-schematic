// WHY: the real CodemodeSandbox (QuickJS WASM + worker) must load under the
// node:test custom loader, and the host's own timeout clamp must prevent Node's
// timer overflow. This is the only test that touches the real sandbox.
import { expect, test } from "vitest";
import type { CodemodeResult } from "@earendil-works/pi-codemode";
import { createWorkflowSandbox, clampTimeoutMs, hardDeadlineMs, MAX_TIMEOUT_MS } from "../../workflow/sandbox.js";
import { compileWorkflow, WorkflowCompileError } from "../../workflow/compile.js";
import { composeWorkflow } from "../../workflow/driver.js";
import { mapSandboxError } from "../../workflow/host.js";
import type { WorkflowSandboxFactory } from "../../workflow/types.js";

function assertOk(result: CodemodeResult): asserts result is Extract<CodemodeResult, { ok: true }> {
	if (!result.ok) {
		throw new Error("expected an ok sandbox result");
	}
}

function assertError(result: CodemodeResult): asserts result is Extract<CodemodeResult, { ok: false }> {
	if (result.ok) {
		throw new Error("expected an errored sandbox result");
	}
}

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
	assertOk(result);
	expect(result.value).toStrictEqual(["x", 2]);
	expect(calls).toBe(1);
});

test("sandbox reports a timeout kind when the deadline expires", async () => {
	const sandbox = createWorkflowSandbox({ timeoutMs: 200 });
	const result = await sandbox.execute(`while (true) {}`);
	await sandbox.close();
	assertError(result);
	expect(result.error.kind).toBe("timeout");
});

test("createWorkflowSandbox clamps an overflowing explicit deadline to the timer max", () => {
	const captured: { timeoutMs?: number }[] = [];
	const factory = (options: { timeoutMs?: number }) => {
		captured.push(options);
		return {} as never;
	};
	createWorkflowSandbox({ timeoutMs: MAX_TIMEOUT_MS + 1 }, factory);
	expect(captured[0].timeoutMs).toBe(MAX_TIMEOUT_MS);
});

test("clampTimeoutMs clamps finite values to the timer max", () => {
	expect(clampTimeoutMs(1)).toBe(1);
	expect(clampTimeoutMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
	expect(clampTimeoutMs(MAX_TIMEOUT_MS + 1)).toBe(MAX_TIMEOUT_MS);
	expect(clampTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_MS);
});

test("clampTimeoutMs treats non-positive and non-finite input as no-limit", () => {
	expect(clampTimeoutMs(0)).toBe(Number.POSITIVE_INFINITY);
	expect(clampTimeoutMs(-5)).toBe(Number.POSITIVE_INFINITY);
	expect(clampTimeoutMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
	expect(clampTimeoutMs(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
});

test("hardDeadlineMs prefers an explicit deadline, else doubles the budget", () => {
	expect(hardDeadlineMs({ timeBudgetMs: 1_000 }), "the soft budget derives a doubled deadline").toBe(2_000);
	expect(hardDeadlineMs({ timeBudgetMs: 1_000, hardDeadlineMs: 5_000 }), "an explicit hard deadline wins over the derived one").toBe(5_000);
	expect(hardDeadlineMs({ timeBudgetMs: 1_000, hardDeadlineMs: MAX_TIMEOUT_MS + 1 }), "overflow clamps to the timer max").toBe(MAX_TIMEOUT_MS);
	expect(hardDeadlineMs({ timeBudgetMs: Number.MAX_SAFE_INTEGER }), "overflow clamps to the timer max").toBe(MAX_TIMEOUT_MS);
});

test("hardDeadlineMs treats unlimited budgets as no deadline", () => {
	expect(hardDeadlineMs({ timeBudgetMs: null })).toBe(Number.POSITIVE_INFINITY);
	expect(hardDeadlineMs({ timeBudgetMs: null, hardDeadlineMs: null })).toBe(Number.POSITIVE_INFINITY);
	expect(hardDeadlineMs({ timeBudgetMs: 0 })).toBe(Number.POSITIVE_INFINITY);
	expect(hardDeadlineMs({ timeBudgetMs: -1 })).toBe(Number.POSITIVE_INFINITY);
	expect(hardDeadlineMs({ timeBudgetMs: 1_000, hardDeadlineMs: -1 }), "an invalid explicit deadline falls back to the derived one").toBe(2_000);
});

test("a memory-limit OOM maps to error and surfaces its message", async () => {
	const oomResult = { ok: false as const, error: { kind: "memory", message: "oom" } };
	const sandbox = createWorkflowSandbox(
		{
			timeoutMs: Infinity,
			memoryLimitBytes: 1,
		},
		(() => ({
			execute: async () => oomResult,
			close: async () => {},
		})) as unknown as WorkflowSandboxFactory,
	);
	const result = await sandbox.execute("code");
	await sandbox.close();
	assertError(result);
	expect(result.error).toStrictEqual(oomResult.error);
	expect(mapSandboxError(result.error, null)).toBe("error");
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
		expect(() => compileWorkflow(`return defineWorkflow((workflow) => {\n${body}\n});\n`)).toThrow(WorkflowCompileError);
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
	expect(result.ok).toBe(true);
	expect(calls).toBe(1);
});

test("sandbox aborts and timeouts map to cancelled and time-limit", () => {
	expect(mapSandboxError({ kind: "aborted" }, null)).toBe("cancelled");
	expect(mapSandboxError({ kind: "aborted" }, "cost-limit")).toBe("cost-limit");
	expect(mapSandboxError({ kind: "timeout" }, null)).toBe("time-limit");
	expect(mapSandboxError({ kind: "timeout" }, "error"), "a pending stop never relabels a timeout").toBe("time-limit");
});

test("sandbox script, memory, and unknown kinds map to error", () => {
	expect(mapSandboxError({ kind: "script" }, null)).toBe("error");
	expect(mapSandboxError({ kind: "memory" }, null), "an OOM aborts as a reserved error").toBe("error");
	expect(mapSandboxError({ kind: "memory" }, "time-limit"), "a pending stop wins over a later failure").toBe("time-limit");
	expect(mapSandboxError({ kind: "unknown-kind" }, null), "unrecognized failures abort as errors").toBe("error");
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
			{
				name: "workflow.run",
				spread: true,
				execute: async () => {
					calls += 1;
					return "ok";
				},
			},
			{ name: "workflow.checkpoint", spread: false, execute: async () => null },
		],
		timeoutMs: 30_000,
		memoryLimitBytes: 256 * 1024 * 1024,
	});
	const source = 'return defineWorkflow((workflow) => {\n  workflow.run("a");\n  workflow.run("b");\n  workflow.checkpoint(null);\n});\n';
	const result = await sandbox.execute(composeWorkflow(compileWorkflow(source).code), { store: { intent: "x", args: "x" } });
	await sandbox.close();
	expect(result.ok, "a returned workflow settles the wrapper only after the workflow completes").toBe(true);
	expect(calls, "both effects observe through the wrapper").toBe(2);
	// The bare (non-return) form must be rejected at compile time, never silently truncated.
	expect(() => compileWorkflow("defineWorkflow((workflow) => {\n  workflow.checkpoint(null);\n});\n")).toThrow(WorkflowCompileError);
});
