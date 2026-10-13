import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { compileWorkflow, WorkflowCompileError } from "../../workflow/compile.js";
import { WORKFLOW_DRIVER, composeWorkflow } from "../../workflow/driver.js";

// ── helpers ───────────────────────────────────────────────────────

function wrapBody(body: string, isAsync = false): string {
	return `return defineWorkflow(${isAsync ? "async " : ""}(workflow) => {\n${body}\n});\n`;
}

function rejects(source: string, match?: RegExp): void {
	assert.throws(
		() => compileWorkflow(source),
		(error: unknown) => {
			assert.ok(error instanceof WorkflowCompileError, `expected WorkflowCompileError, got ${String(error)}`);
			if (match) assert.match((error as Error).message, match);
			return true;
		},
		`expected rejection for:\n${source}`,
	);
}

function countNewlines(text: string): number {
	return (text.match(/\n/g) ?? []).length;
}

// Each builder stays syntactically valid when combined, and gives every local a unique name.
const STATEMENT_BUILDERS: Array<(i: number) => string> = [
	(i) => `const v${i} = workflow.run("x");`,
	(i) => `const v${i} = workflow.shell("ls");`,
	() => `workflow.handoff("d");`,
	() => `if (workflow.state()) { workflow.run("y"); }`,
	() => `for (const e of workflow.entries()) { workflow.run(e); }`,
	(i) => `const v${i} = workflow.a() ? workflow.b() : workflow.c();`,
	() => `try { workflow.run("t"); } catch (err) { workflow.run("c"); } finally { workflow.run("f"); }`,
	(i) => `const v${i} = workflow.outer(workflow.inner(${i}));`,
	(i) => `switch (workflow.state()) { case ${i}: workflow.run("a"); break; default: workflow.run("b"); }`,
	() => `while (workflow.budget()) { break; }`,
	() => `do { workflow.run("d"); } while (false);`,
	() => `workflow["run"]("computed");`,
	() => `workflow?.run("optional");`,
	() => `workflow.run?.("optional-call");`,
	(i) => `const v${i} = { k: workflow.state(), arr: [workflow.shell("q")] };`,
	(i) => `const v${i} = 1 + ${i};`,
];

const arbBody = fc
	.array(fc.integer({ min: 0, max: STATEMENT_BUILDERS.length - 1 }), { maxLength: 12 })
	.map((kinds) => kinds.map((kind, i) => STATEMENT_BUILDERS[kind](i)).join("\n"));

// ── driver ────────────────────────────────────────────────────────

test("driver is one line ending in a semicolon, with no trailing newline", () => {
	assert.equal(WORKFLOW_DRIVER, "function defineWorkflow(fn){return fn(workflow)};");
	assert.ok(WORKFLOW_DRIVER.endsWith(";"));
	assert.ok(!WORKFLOW_DRIVER.includes("\n"));
});

test("composeWorkflow concatenates the driver with no separator", () => {
	assert.equal(composeWorkflow("abc"), "function defineWorkflow(fn){return fn(workflow)};abc");
});

// WHY: nothing else asserts the shipped program actually runs. `composeWorkflow` output
// must be valid JS in the host scope: the driver has to reach the host's `workflow`, and
// the injected awaits have to unwrap host promises. A slip feeds Promises to the author.
test("composed driver plus compiled body executes as real JS", async () => {
	const source = 'return defineWorkflow((workflow) => {\n  const r = workflow.run("x");\n  workflow.checkpoint({ r });\n  return workflow.exit(r);\n});\n';
	const effects: string[] = [];
	const workflow = {
		run: async (text: string) => { effects.push(`run:${text}`); return `result-of-${text}`; },
		checkpoint: async (metadata: unknown) => { effects.push("checkpoint"); return metadata; },
		exit: async (value: unknown) => { effects.push("exit"); return value; },
	};
	// `workflow` is the single free name the driver reads: the host scope the sandbox builds.
	const invoke = new Function("workflow", composeWorkflow(compileWorkflow(source).code)) as (w: typeof workflow) => Promise<unknown>;

	assert.deepEqual(await invoke(workflow), "result-of-x", "the awaited value, never a Promise: the compiler's inserts are load-bearing");
	assert.deepEqual(effects, ["run:x", "checkpoint", "exit"], "the driver reached the host object; each effect ran once in author order");
});

// ── explicit compile behavior ─────────────────────────────────────

test("wraps direct calls and marks the workflow lambda async", () => {
	const source = 'return defineWorkflow((workflow) => {\n  const r = workflow.run("x");\n  workflow.checkpoint(null);\n  return r;\n});\n';
	const out = compileWorkflow(source).code;
	assert.ok(out.includes("async (workflow) =>"), "arrow made async");
	assert.ok(out.includes("(await workflow.run("), "await inserted on run");
	assert.ok(out.includes("(await workflow.checkpoint("), "await inserted on checkpoint");

});

test("a workflow without a checkpoint compiles and reports hasCheckpoint: false", () => {
	const source = "return defineWorkflow((workflow) => {\n  const x = 1;\n  return x;\n});\n";
	const compiled = compileWorkflow(source);
	assert.equal(compiled.hasCheckpoint, false, "checkpoints are optional: no checkpoint leaves the run unbounded");
	assert.equal(compiled.code, source, "no checkpoint and no workflow calls: the source is returned unchanged");
});

test("workflow.exit is terminal and does not count as a checkpoint", () => {
	// `exit` stops a run but is never a safe exit point (docs/workflows.md: Targets, exit, cancellation, salvage): a workflow with only an exit still lacks checkpoint coverage.
	const source = 'return defineWorkflow((workflow) => {\n  workflow.exit({ reason: "done" });\n});\n';
	const compiled = compileWorkflow(source);
	assert.equal(compiled.hasCheckpoint, false, "exit is terminal, not a checkpoint");
	assert.ok(compiled.code.includes("(await workflow.exit("), "direct workflow calls are still await-inserted");
	assert.ok(compiled.code.includes("async (workflow) =>"), "the lambda is still made async when it has direct calls");
});

test("a workflow declaring a checkpoint reports hasCheckpoint: true", () => {
	const source = 'return defineWorkflow((workflow) => {\n  workflow.checkpoint({ phase: "ready" });\n  return workflow.exit({ reason: "ok" });\n});\n';
	const compiled = compileWorkflow(source);
	assert.equal(compiled.hasCheckpoint, true, "a declared checkpoint marks the run bounded");
	assert.ok(compiled.code.includes("(await workflow.checkpoint("), "the declared checkpoint is still await-inserted");
});

test("accepts a computed checkpoint name and still reports the run as bounded", () => {
	const source = 'return defineWorkflow((workflow) => {\n  workflow["checkpoint"](null);\n});\n';
	const compiled = compileWorkflow(source);
	assert.equal(compiled.hasCheckpoint, true, "a computed checkpoint marks the run bounded");
	assert.equal(compiled.code, 'return defineWorkflow(async (workflow) => {\n  (await workflow["checkpoint"](null));\n});\n');
});

test("rejects a checkpoint inside a nested scope before the presence check", () => {
	rejects(wrapBody("[1].map(() => workflow.checkpoint(null));"), /nested scope/);
});

test("accepts an already-awaited direct workflow call byte-identically", () => {
	const source = 'return defineWorkflow(async (workflow) => {\n  const x = await workflow.run("x");\n  await workflow.checkpoint(null);\n  return x;\n});\n';
	assert.equal(compileWorkflow(source).code, source);
});

test("allows the identifier `workflow` as a non-reference property key", () => {
	const source = "return defineWorkflow(async (workflow) => {\n  await workflow.checkpoint(null);\n  return { workflow: 1 };\n});\n";
	assert.equal(compileWorkflow(source).code, source);
});
test("rejects a bare workflow(...) expression statement (docs/workflows.md File and entry point requires a return)", () => {
	// `return` is mandatory: a bare statement resolves the codemode wrapper to undefined
	// before the workflow's effects settle, silently truncating the run as a "returned" exit.
	const source = 'defineWorkflow((workflow) => {\n  workflow.run("x");\n  workflow.checkpoint(null);\n});\n';
	rejects(source, /exactly one top-level/);
});

test("wraps computed string keys and optional chains", () => {
	const source = 'return defineWorkflow((workflow) => {\n  workflow["a"]();\n  workflow?.b();\n  workflow.c?.();\n  workflow.checkpoint(null);\n});\n';
	assert.equal(
		compileWorkflow(source).code,
		'return defineWorkflow(async (workflow) => {\n  (await workflow["a"]());\n  (await workflow?.b());\n  (await workflow.c?.());\n  (await workflow.checkpoint(null));\n});\n',
	);
});

test("wraps workflow calls in workflow heads, tests, updates, and iterables", () => {
	const source = [
		"return defineWorkflow((workflow) => {",
		"  for (let i = workflow.start(); i < workflow.limit(); i = workflow.step(i)) {}",
		"  for (const x of workflow.items()) {}",
		"  while (workflow.more()) {}",
		"  switch (workflow.tag()) { case workflow.case1(): break; }",
		"  workflow.checkpoint(null);",
		"});",
		"",
	].join("\n");
	const out = compileWorkflow(source).code;
	assert.ok(out.includes("for (let i = (await workflow.start()); i < (await workflow.limit()); i = (await workflow.step(i))) {}"));
	assert.ok(out.includes("for (const x of (await workflow.items())) {}"));
	assert.ok(out.includes("while ((await workflow.more())) {}"));
	assert.ok(out.includes("switch ((await workflow.tag())) { case (await workflow.case1()): break; }"));
	assert.ok(out.includes("(await workflow.checkpoint(null));"));
	assert.equal(countNewlines(out), countNewlines(source));
});

test("error message carries the line and column of the violation", () => {
	rejects("return defineWorkflow((workflow) => {\n  workflow = 1;\n});\n", /at 2:2/);
});

test("whole-program violation reports the stray statement's own line, not 1:0", () => {
	rejects("\n\nreturn workflow((workflow) => {});\n", /at 3:0/);
});

test("rejects shorthand capture of workflow, which aliases the namespace", () => {
	rejects(wrapBody("const o = { workflow };"));
	rejects(wrapBody("({ workflow });"));
});

// ── whole-program contract ────────────────────────────────────────

test("rejects any top-level statement besides the single workflow call", () => {
	rejects('workflow.shell("ls");\nreturn defineWorkflow((workflow) => {});\n');
	rejects('return defineWorkflow((workflow) => {});\nworkflow.shell("ls");\n');
	rejects("const x = 1;\nreturn defineWorkflow((workflow) => {});\n");
	rejects("function helper() {}\nreturn defineWorkflow((workflow) => {});\n");
	rejects('"use strict";\nreturn defineWorkflow((workflow) => {});\n');
});

test("rejects raw global-object access (globalThis/global namespace bypass)", () => {
	rejects(wrapBody('globalThis.workflow.shell("x");'));
	rejects(wrapBody("const f = globalThis.workflow.run;"));
	rejects(wrapBody("global.workflow.run('x');"));
	rejects(wrapBody("const g = globalThis;"));
});

test("rejects `this` as a global-object bypass", () => {
	rejects(wrapBody('this.workflow.run("x");'), /this is not allowed/);
	rejects(wrapBody('this["workflow"].run("x");'), /this is not allowed/);
	rejects(wrapBody("const g = this;"), /this is not allowed/);
});

test("rejects a sloppy `await` binding that the injected async would reserve", () => {
	rejects(wrapBody('const await = 1;\n  workflow.run("x");'));
});

test("rejects `with` statements, which are outside docs/workflows.md (Accepted control flow)", () => {
	rejects(wrapBody('with (Math) { workflow.checkpoint(null); }'), /with is not allowed/);
});

test("rejects eval/Function, which can hide a workflow call from the compile checks", () => {
	rejects(wrapBody('eval("workflow.run(\\"x\\")");'), /eval is not allowed/);
	rejects(wrapBody('Function("workflow.run(\\"x\\")")();'), /Function is not allowed/);
	rejects(wrapBody('const f = eval;'), /eval is not allowed/);
});

test("rejects constructor and __proto__ member access, which reaches Function without a banned identifier", () => {
	rejects(wrapBody('({}).constructor.constructor("return workflow.shell(\'x\')")();'), /constructor member access is not allowed/);
	rejects(wrapBody('const c = ({})["constructor"];'), /constructor member access is not allowed/);
	rejects(wrapBody('const p = workflow.run.__proto__;'), /__proto__ member access is not allowed/);
	rejects(wrapBody('const p = ({}).__proto__;'), /__proto__ member access is not allowed/);
	rejects(wrapBody('const p = ({}["__proto__"]);'), /__proto__ member access is not allowed/);
});

test("rejects computed member keys that cannot be statically resolved", () => {
	rejects(wrapBody('const k = "constructor"; const c = ({}[k][k]);'), /computed member keys must be a literal or constant template string/);
	rejects(wrapBody('const c = ({}["const" + "ructor"]);'), /computed member keys must be a literal or constant template string/);
	rejects(wrapBody('const c = ({}[`con${1}structor`]);'), /computed member keys must be a literal or constant template string/);
});

test("rejects constant template and dot forms of the prototype-escape names", () => {
	rejects(wrapBody('const c = ({}[`constructor`]);'), /constructor member access is not allowed/);
	rejects(wrapBody('const p = ({}[`__proto__`]);'), /__proto__ member access is not allowed/);
});

test("rejects reflection that reads a member by a runtime string", () => {
	rejects(wrapBody('const c = Reflect.get(({}), "constructor");'), /Reflect is not allowed/);
	rejects(wrapBody('const { get } = Reflect;'), /Reflect is not allowed/);
	rejects(wrapBody('const d = Object.getOwnPropertyDescriptor(Object, "constructor");'), /getOwnPropertyDescriptor member access is not allowed/);
	rejects(wrapBody('const d = Object?.getOwnPropertyDescriptor(Object, "constructor");'), /getOwnPropertyDescriptor member access is not allowed/);
	rejects(wrapBody('const d = Object[`getOwnPropertyDescriptor`](Object, "constructor");'), /getOwnPropertyDescriptor member access is not allowed/);
	rejects(wrapBody('const d = Object["getOwnPropertyDescriptors"](Object);'), /getOwnPropertyDescriptors member access is not allowed/);
});

test("rejects prototype/reflection names in destructuring patterns", () => {
	rejects(wrapBody('const { constructor } = Object;'), /constructor destructuring is not allowed/);
	rejects(wrapBody('const { constructor: F } = ({});'), /constructor destructuring is not allowed/);
	rejects(wrapBody('const { ["constructor"]: F } = ({});'), /constructor destructuring is not allowed/);
	// WHY: a non-computed string-literal key is parsed as computed:false, so it must be resolved too.
	rejects(wrapBody('const { "constructor": F } = (()=>{});'), /constructor destructuring is not allowed/);
	rejects(wrapBody('const { "__proto__": p } = ({});'), /__proto__ destructuring is not allowed/);
	rejects(wrapBody('const { "getOwnPropertyDescriptor": g } = Object;'), /getOwnPropertyDescriptor destructuring is not allowed/);
	rejects(wrapBody('const { "getOwnPropertyDescriptors": g } = Object;'), /getOwnPropertyDescriptors destructuring is not allowed/);
	rejects(wrapBody('const { getOwnPropertyDescriptor: g } = Object;'), /getOwnPropertyDescriptor destructuring is not allowed/);
	rejects(wrapBody('let F; ({ "constructor": F } = (()=>{}));'), /constructor destructuring is not allowed/);
	rejects(wrapBody('for (const { "constructor": F } of []) {}'), /constructor destructuring is not allowed/);
	rejects(wrapBody('try {} catch ({ "constructor": F }) {}'), /constructor destructuring is not allowed/);
	rejects(wrapBody('const { [k]: c } = ({});'), /computed destructuring keys must be a literal or constant template string/);
});

test("accepts ordinary member access, numeric keys, and safe reflection-free reads", () => {
	const source = wrapBody(
		'const o = { constructorName: 1 };\n' +
		'const a = [1, 2];\n' +
		'const n = o.constructorName + o["constructorName"] + o.constructorName;\n' +
		'const first = a[0];\n' +
		'const p = Object.getPrototypeOf(o);\n' +
		'const keys = Object.keys(o);\n' +
		'const t = o[`constructorName`];',
	);
	assert.doesNotThrow(() => compileWorkflow(source));
});

test("rejects dynamic import, which can hide a workflow call from the compile checks", () => {
	rejects(wrapBody('  const m = import("x");'), /dynamic import is not allowed/);
});

// ── rejection contract ────────────────────────────────────────────

test("rejects files without exactly one top-level workflow call", () => {
	rejects("const x = 1;\n");
	rejects(wrapBody("") + wrapBody(""));
	rejects("return defineWorkflow((workflow) => {}, (workflow) => {});\n");
});

test("rejects a non-arrow argument or wrong workflow parameter", () => {
	rejects("return workflow(function (workflow) {});\n");
	rejects("return defineWorkflow((l) => {});\n");
	rejects("return defineWorkflow((workflow, extra) => {});\n");
	rejects("return defineWorkflow(({ workflow }) => {});\n");
});

test("rejects author async, await, and for await outside the direct-call rule", () => {
	rejects(wrapBody("const f = async () => 1;"));
	rejects(wrapBody('await fetch("x");', true));
	rejects(wrapBody("for await (const x of workflow.entries()) {}", true));
});

test("rejects aliasing, destructuring, dynamic keys, new, and tagged templates", () => {
	rejects(wrapBody("const f = workflow.run; f();"));
	rejects(wrapBody("const { run } = workflow;"));
	rejects(wrapBody('const k = "run"; workflow[k]();'));
	rejects(wrapBody("workflow[0]();"));
	rejects(wrapBody("new workflow.R();"));
	rejects(wrapBody("workflow.tag`x`;"));
});

test("rejects indirect calls, reassignment, and non-call member access", () => {
	rejects(wrapBody('workflow.run.call(null, "x");'));
	rejects(wrapBody("workflow = 1;"));
	rejects(wrapBody("const f = workflow.run;"));
	rejects(wrapBody("workflow.a.b();"));
});

test("rejects workflow calls and references inside nested scopes", () => {
	rejects(wrapBody("[1].map((x) => workflow.run(x));"));
	rejects(wrapBody("class C { m() { return workflow.run('x'); } }"));
	rejects(wrapBody("class C { x = workflow.state(); }"));
	rejects(wrapBody("class C { static { workflow.run('x'); } }"));
	rejects(wrapBody("const f = (x = workflow.state()) => x;"));
	rejects(wrapBody("const g = function (x) { return workflow.state(); };"));
});

test("rejects any workflow binding other than the workflow parameter", () => {
	rejects(wrapBody("const workflow = 1;"));
	rejects(wrapBody("let workflow;"));
	rejects(wrapBody("var workflow;"));
	rejects(wrapBody("function workflow() {}"));
	rejects(wrapBody("class workflow {}"));
	rejects(wrapBody("const f = (workflow) => workflow;"));
	rejects("const workflow = 1;\nreturn defineWorkflow((workflow) => {});\n");
});

// ── fast-check invariants ─────────────────────────────────────────

test("compilation is idempotent and line-preserving for arbitrary valid bodies", () => {
	fc.assert(
		fc.property(arbBody, (body) => {
			const source = wrapBody(`workflow.checkpoint(null);\n${body}`);
			const once = compileWorkflow(source).code;
			const twice = compileWorkflow(once).code;
			assert.equal(twice, once, `not idempotent for:\n${source}`);
			assert.equal(countNewlines(once), countNewlines(source), `newline count changed for:\n${source}`);
			assert.match(once, /async \(workflow\)/);
			assert.ok(once.includes("(await "), `missing await for:\n${source}`);
		}),
		{ seed: 424242, numRuns: 250 },
	);
});

test("compiling an already-compiled body is byte-identical", () => {
	fc.assert(
		fc.property(arbBody, (body) => {
			const once = compileWorkflow(wrapBody(`workflow.checkpoint(null);\n${body}`)).code;
			assert.equal(compileWorkflow(once).code, once);
		}),
		{ seed: 424242, numRuns: 250 },
	);
});
