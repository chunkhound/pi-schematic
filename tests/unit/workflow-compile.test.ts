import { expect, test } from "vitest";
import fc from "fast-check";
import { compileWorkflow, WorkflowCompileError } from "../../workflow/compile.js";
import { WORKFLOW_DRIVER, composeWorkflow } from "../../workflow/driver.js";
import { WORKFLOW_HANDLE_NAMES } from "../../workflow/types.js";

// ── helpers ───────────────────────────────────────────────────────

function wrapBody(body: string, isAsync = false): string {
	return `return defineWorkflow(${isAsync ? "async " : ""}(workflow) => {\n${body}\n});\n`;
}

/** Assert `source` fails to compile as a `WorkflowCompileError`; returns true when it does. */
function rejects(source: string, match?: RegExp): boolean {
	let err: unknown;
	try {
		compileWorkflow(source);
	} catch (e) {
		err = e;
	}
	if (err instanceof WorkflowCompileError) {
		if (match && !match.test(err.message)) {
			throw new Error(`expected the error message to match ${String(match)}, got: ${err.message}`);
		}
		return true;
	}
	throw new Error(`expected WorkflowCompileError, got ${String(err)}`);
}

function countNewlines(text: string): number {
	return (text.match(/\n/g) ?? []).length;
}

/** Compile `code` with the driver into an invoker whose host scope provides `workflow`. */
function makeInvoke(code: string): (w: unknown) => Promise<unknown> {
	const evaluate = new Function("workflow", code);
	return async (w: unknown): Promise<unknown> => {
		const result: unknown = await Reflect.apply(evaluate, null, [w]);
		return result;
	};
}

/** Control-flow wrapping source: every head/test/update/iterable form, plus a checkpoint. */
const WORKFLOW_HEAD_SOURCE = [
	"return defineWorkflow((workflow) => {",
	"  for (let i = workflow.state(); i < workflow.budget(); i = workflow.shell(i)) {}",
	"  for (const x of workflow.entries()) {}",
	"  while (workflow.state()) {}",
	"  switch (workflow.state()) { case workflow.budget(): break; }",
	"  workflow.checkpoint(null);",
	"});",
	"",
].join("\n");

// Each builder stays syntactically valid when combined, and gives every local a unique name.
const STATEMENT_BUILDERS: ((i: number) => string)[] = [
	(i) => `const v${i} = workflow.run("x");`,
	(i) => `const v${i} = workflow.shell("ls");`,
	() => `workflow.handoff("d");`,
	() => `if (workflow.state()) { workflow.run("y"); }`,
	() => `for (const e of workflow.entries()) { workflow.run(e); }`,
	(i) => `const v${i} = workflow.state() ? workflow.budget() : workflow.state();`,
	() => `try { workflow.run("t"); } catch (err) { workflow.run("c"); } finally { workflow.run("f"); }`,
	(i) => `const v${i} = workflow.run(workflow.state());`,
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
	expect(WORKFLOW_DRIVER).toBe("function defineWorkflow(fn){return fn(workflow)};");
	expect(WORKFLOW_DRIVER.endsWith(";")).toBe(true);
	expect(!WORKFLOW_DRIVER.includes("\n")).toBe(true);
});

test("composeWorkflow concatenates the driver with no separator", () => {
	expect(composeWorkflow("abc")).toBe("function defineWorkflow(fn){return fn(workflow)};abc");
});

// WHY: nothing else asserts the shipped program actually runs. `composeWorkflow` output
// must be valid JS in the host scope: the driver has to reach the host's `workflow`, and
// the injected awaits have to unwrap host promises. A slip feeds Promises to the author.
test("composed driver plus compiled body executes as real JS", async () => {
	const source = 'return defineWorkflow((workflow) => {\n  const r = workflow.run("x");\n  workflow.checkpoint({ r });\n  return workflow.exit(r);\n});\n';
	const effects: string[] = [];
	const workflow = {
		run: async (text: string) => {
			effects.push(`run:${text}`);
			return `result-of-${text}`;
		},
		checkpoint: async (metadata: unknown) => {
			effects.push("checkpoint");
			return metadata;
		},
		exit: async (value: unknown) => {
			effects.push("exit");
			return value;
		},
	};
	// `workflow` is the single free name the driver reads: the host scope the sandbox builds.
	const invoke = makeInvoke(composeWorkflow(compileWorkflow(source).code));

	expect(await invoke(workflow), "the awaited value, never a Promise: the compiler's inserts are load-bearing").toBe("result-of-x");
	expect(effects, "the driver reached the host object; each effect ran once in author order").toStrictEqual(["run:x", "checkpoint", "exit"]);
});

// ── explicit compile behavior ─────────────────────────────────────

test("adds ASI barriers to statement-start calls in lists and branches", async () => {
	const source = `return defineWorkflow((workflow) => {\n  const r = workflow.run("a")\n  workflow.run("b")\n  switch (r) { case 1: workflow.run("c")\n  }\n  if (r) workflow.run("d")\n  else workflow.run("e")\n});\n`;
	const code = compileWorkflow(source).code;
	expect(code).toMatch(/const r = \(await workflow\.run\("a"\)\)\n {2};\(await workflow\.run\("b"\)\)/);
	expect(code).toMatch(/case 1: ;\(await workflow\.run\("c"\)\)/);
	expect(code).toMatch(/if \(r\) \(await workflow\.run\("d"\)\)\n {2}else \(await workflow\.run\("e"\)\)/);
	const calls: string[] = [];
	const invoke = makeInvoke(composeWorkflow(code));
	await invoke({
		run: async (s: string) => {
			calls.push(s);
			return s;
		},
	});
	expect(calls).toStrictEqual(["a", "b", "d"]);
});

test("rejects defineWorkflow references except the entry point and property keys", () => {
	expect(rejects("return defineWorkflow((workflow) => { const d = defineWorkflow; });\n", /defineWorkflow may only/)).toBe(true);
	rejects("return defineWorkflow((workflow) => { consume(defineWorkflow); });\n", /defineWorkflow may only/);
	expect(() => compileWorkflow("return defineWorkflow((workflow) => ({ defineWorkflow: 1 }));\n")).not.toThrow();
});

test("wraps direct calls and marks the workflow lambda async", () => {
	const source = 'return defineWorkflow((workflow) => {\n  const r = workflow.run("x");\n  workflow.checkpoint(null);\n  return r;\n});\n';
	const out = compileWorkflow(source).code;
	expect(out, "arrow made async").toContain("async (workflow) =>");
	expect(out, "await inserted on run").toContain("(await workflow.run(");
	expect(out, "await inserted on checkpoint").toContain("(await workflow.checkpoint(");
});

test("a workflow without a checkpoint compiles and reports hasCheckpoint: false", () => {
	const source = "return defineWorkflow((workflow) => {\n  const x = 1;\n  return x;\n});\n";
	const compiled = compileWorkflow(source);
	expect(compiled.hasCheckpoint, "checkpoints are optional: no checkpoint leaves the run unbounded").toBe(false);
	expect(compiled.code, "no checkpoint and no workflow calls: the source is returned unchanged").toBe(source);
});

test("workflow.exit is terminal and does not count as a checkpoint", () => {
	// `exit` stops a run but is never a safe exit point (docs/workflows.md: Targets, exit, cancellation, salvage): a workflow with only an exit still lacks checkpoint coverage.
	const source = 'return defineWorkflow((workflow) => {\n  workflow.exit({ reason: "done" });\n});\n';
	const compiled = compileWorkflow(source);
	expect(compiled.hasCheckpoint, "exit is terminal, not a checkpoint").toBe(false);
	expect(compiled.code, "direct workflow calls are still await-inserted").toContain("(await workflow.exit(");
	expect(compiled.code, "the lambda is still made async when it has direct calls").toContain("async (workflow) =>");
});

test("a workflow declaring a checkpoint reports hasCheckpoint: true", () => {
	const source = 'return defineWorkflow((workflow) => {\n  workflow.checkpoint({ phase: "ready" });\n  return workflow.exit({ reason: "ok" });\n});\n';
	const compiled = compileWorkflow(source);
	expect(compiled.hasCheckpoint, "a declared checkpoint marks the run bounded").toBe(true);
	expect(compiled.code, "the declared checkpoint is still await-inserted").toContain("(await workflow.checkpoint(");
});

test("accepts a computed checkpoint name and still reports the run as bounded", () => {
	const source = 'return defineWorkflow((workflow) => {\n  workflow["checkpoint"](null);\n});\n';
	const compiled = compileWorkflow(source);
	expect(compiled.hasCheckpoint, "a computed checkpoint marks the run bounded").toBe(true);
	expect(compiled.code).toBe('return defineWorkflow(async (workflow) => {\n  ;(await workflow["checkpoint"](null));\n});\n');
});

test("rejects a checkpoint inside a nested scope before the presence check", () => {
	expect(rejects(wrapBody("[1].map(() => workflow.checkpoint(null));"), /nested scope/)).toBe(true);
});

test("accepts an already-awaited direct workflow call byte-identically", () => {
	const source = 'return defineWorkflow(async (workflow) => {\n  const x = await workflow.run("x");\n  await workflow.checkpoint(null);\n  return x;\n});\n';
	expect(compileWorkflow(source).code).toBe(source);
});

test("allows the identifier `workflow` as a non-reference property key", () => {
	const source = "return defineWorkflow(async (workflow) => {\n  await workflow.checkpoint(null);\n  return { workflow: 1 };\n});\n";
	expect(compileWorkflow(source).code).toBe(source);
});
test("rejects a bare workflow(...) expression statement (docs/workflows.md File and entry point requires a return)", () => {
	// `return` is mandatory: a bare statement resolves the codemode wrapper to undefined
	// before the workflow's effects settle, silently truncating the run as a "returned" exit.
	const source = 'defineWorkflow((workflow) => {\n  workflow.run("x");\n  workflow.checkpoint(null);\n});\n';
	expect(rejects(source, /exactly one top-level/)).toBe(true);
});

test("wraps computed string keys and optional chains", () => {
	const source =
		'return defineWorkflow((workflow) => {\n  workflow["state"]();\n  workflow?.budget();\n  workflow.run?.();\n  workflow.checkpoint(null);\n});\n';
	expect(compileWorkflow(source).code).toBe(
		'return defineWorkflow(async (workflow) => {\n  ;(await workflow["state"]());\n  ;(await workflow?.budget());\n  ;(await workflow.run?.());\n  ;(await workflow.checkpoint(null));\n});\n',
	);
});

test("wraps workflow calls in workflow heads, tests, updates, and iterables", () => {
	const out = compileWorkflow(WORKFLOW_HEAD_SOURCE).code;
	expect(out).toContain("for (let i = (await workflow.state()); i < (await workflow.budget()); i = (await workflow.shell(i))) {}");
	expect(out).toContain("for (const x of (await workflow.entries())) {}");
	expect(out).toContain("while ((await workflow.state())) {}");
	expect(out).toContain("switch ((await workflow.state())) { case (await workflow.budget()): break; }");
	expect(out).toContain("(await workflow.checkpoint(null));");
});

test("compilation preserves the line count across control-flow wrapping", () => {
	const out = compileWorkflow(WORKFLOW_HEAD_SOURCE).code;
	expect(countNewlines(out)).toBe(countNewlines(WORKFLOW_HEAD_SOURCE));
});

test("rejects unknown workflow members before execution", () => {
	expect(rejects(wrapBody('workflow.nope("x");'), /unknown workflow member "nope"/)).toBe(true);
});

test("accepts every declared handle name", () => {
	for (const name of WORKFLOW_HANDLE_NAMES) {
		expect(() => compileWorkflow(wrapBody(`workflow.${name}();`))).not.toThrow();
	}
});

test("error message carries the line and column of the violation", () => {
	expect(rejects("return defineWorkflow((workflow) => {\n  workflow = 1;\n});\n", /at 2:2/)).toBe(true);
});

test("whole-program violation reports the stray statement's own line, not 1:0", () => {
	expect(rejects("\n\nreturn workflow((workflow) => {});\n", /at 3:0/)).toBe(true);
});

test("rejects shorthand capture of workflow, which aliases the namespace", () => {
	expect(rejects(wrapBody("const o = { workflow };"))).toBe(true);
	rejects(wrapBody("({ workflow });"));
});

// ── whole-program contract ────────────────────────────────────────

test("rejects any top-level statement besides the single workflow call", () => {
	expect(rejects('workflow.shell("ls");\nreturn defineWorkflow((workflow) => {});\n')).toBe(true);
	rejects('return defineWorkflow((workflow) => {});\nworkflow.shell("ls");\n');
	rejects("const x = 1;\nreturn defineWorkflow((workflow) => {});\n");
	rejects("function helper() {}\nreturn defineWorkflow((workflow) => {});\n");
	rejects('"use strict";\nreturn defineWorkflow((workflow) => {});\n');
});

test("rejects raw global-object access (globalThis/global namespace bypass)", () => {
	expect(rejects(wrapBody('globalThis.workflow.shell("x");'))).toBe(true);
	rejects(wrapBody("const f = globalThis.workflow.run;"));
	rejects(wrapBody("global.workflow.run('x');"));
	rejects(wrapBody("const g = globalThis;"));
});

test("rejects `this` as a global-object bypass", () => {
	expect(rejects(wrapBody('this.workflow.run("x");'), /this is not allowed/)).toBe(true);
	rejects(wrapBody('this["workflow"].run("x");'), /this is not allowed/);
	rejects(wrapBody("const g = this;"), /this is not allowed/);
});

test("rejects a sloppy `await` binding that the injected async would reserve", () => {
	expect(rejects(wrapBody('const await = 1;\n  workflow.run("x");'))).toBe(true);
});

test("rejects `with` statements, which are outside docs/workflows.md (Accepted control flow)", () => {
	expect(rejects(wrapBody("with (Math) { workflow.checkpoint(null); }"), /with is not allowed/)).toBe(true);
});

test("rejects eval/Function, which can hide a workflow call from the compile checks", () => {
	expect(rejects(wrapBody('eval("workflow.run(\\"x\\")");'), /eval is not allowed/)).toBe(true);
	rejects(wrapBody('Function("workflow.run(\\"x\\")")();'), /Function is not allowed/);
	rejects(wrapBody("const f = eval;"), /eval is not allowed/);
});

test("rejects constructor and __proto__ member access, which reaches Function without a banned identifier", () => {
	expect(rejects(wrapBody("({}).constructor.constructor(\"return workflow.shell('x')\")();"), /constructor member access is not allowed/)).toBe(true);
	rejects(wrapBody('const c = ({})["constructor"];'), /constructor member access is not allowed/);
	rejects(wrapBody("const p = workflow.run.__proto__;"), /__proto__ member access is not allowed/);
	rejects(wrapBody("const p = ({}).__proto__;"), /__proto__ member access is not allowed/);
	rejects(wrapBody('const p = ({}["__proto__"]);'), /__proto__ member access is not allowed/);
});

test("rejects computed member keys that cannot be statically resolved", () => {
	expect(rejects(wrapBody('const k = "constructor"; const c = ({}[k][k]);'), /computed member keys must be a literal or constant template string/)).toBe(true);
	rejects(wrapBody('const c = ({}["const" + "ructor"]);'), /computed member keys must be a literal or constant template string/);
	rejects(wrapBody("const c = ({}[`con${1}structor`]);"), /computed member keys must be a literal or constant template string/);
});

test("rejects constant template and dot forms of the prototype-escape names", () => {
	expect(rejects(wrapBody("const c = ({}[`constructor`]);"), /constructor member access is not allowed/)).toBe(true);
	rejects(wrapBody("const p = ({}[`__proto__`]);"), /__proto__ member access is not allowed/);
});

test("rejects reflection that reads a member by a runtime string", () => {
	expect(rejects(wrapBody('const c = Reflect.get(({}), "constructor");'), /Reflect is not allowed/)).toBe(true);
	rejects(wrapBody("const { get } = Reflect;"), /Reflect is not allowed/);
	rejects(wrapBody('const d = Object.getOwnPropertyDescriptor(Object, "constructor");'), /getOwnPropertyDescriptor member access is not allowed/);
	rejects(wrapBody('const d = Object?.getOwnPropertyDescriptor(Object, "constructor");'), /getOwnPropertyDescriptor member access is not allowed/);
	rejects(wrapBody('const d = Object[`getOwnPropertyDescriptor`](Object, "constructor");'), /getOwnPropertyDescriptor member access is not allowed/);
	rejects(wrapBody('const d = Object["getOwnPropertyDescriptors"](Object);'), /getOwnPropertyDescriptors member access is not allowed/);
});

test("rejects prototype/reflection names in destructuring patterns", () => {
	expect(rejects(wrapBody("const { constructor } = Object;"), /constructor destructuring is not allowed/)).toBe(true);
	rejects(wrapBody("const { constructor: F } = ({});"), /constructor destructuring is not allowed/);
	rejects(wrapBody('const { ["constructor"]: F } = ({});'), /constructor destructuring is not allowed/);
	// WHY: a non-computed string-literal key is parsed as computed:false, so it must be resolved too.
	rejects(wrapBody('const { "constructor": F } = (()=>{});'), /constructor destructuring is not allowed/);
	rejects(wrapBody('const { "__proto__": p } = ({});'), /__proto__ destructuring is not allowed/);
	rejects(wrapBody('const { "getOwnPropertyDescriptor": g } = Object;'), /getOwnPropertyDescriptor destructuring is not allowed/);
	rejects(wrapBody('const { "getOwnPropertyDescriptors": g } = Object;'), /getOwnPropertyDescriptors destructuring is not allowed/);
	rejects(wrapBody("const { getOwnPropertyDescriptor: g } = Object;"), /getOwnPropertyDescriptor destructuring is not allowed/);
	rejects(wrapBody('let F; ({ "constructor": F } = (()=>{}));'), /constructor destructuring is not allowed/);
	rejects(wrapBody('for (const { "constructor": F } of []) {}'), /constructor destructuring is not allowed/);
	rejects(wrapBody('try {} catch ({ "constructor": F }) {}'), /constructor destructuring is not allowed/);
	rejects(wrapBody("const { [k]: c } = ({});"), /computed destructuring keys must be a literal or constant template string/);
});

test("accepts ordinary member access, numeric keys, and safe reflection-free reads", () => {
	const source = wrapBody(
		"const o = { constructorName: 1 };\n" +
			"const a = [1, 2];\n" +
			'const n = o.constructorName + o["constructorName"] + o.constructorName;\n' +
			"const first = a[0];\n" +
			"const p = Object.getPrototypeOf(o);\n" +
			"const keys = Object.keys(o);\n" +
			"const t = o[`constructorName`];",
	);
	expect(() => compileWorkflow(source)).not.toThrow();
});

test("rejects dynamic import, which can hide a workflow call from the compile checks", () => {
	expect(rejects(wrapBody('  const m = import("x");'), /dynamic import is not allowed/)).toBe(true);
});

// ── rejection contract ────────────────────────────────────────────

test("rejects files without exactly one top-level workflow call", () => {
	expect(rejects("const x = 1;\n")).toBe(true);
	rejects(wrapBody("") + wrapBody(""));
	rejects("return defineWorkflow((workflow) => {}, (workflow) => {});\n");
});

test("rejects a non-arrow argument or wrong workflow parameter", () => {
	expect(rejects("return workflow(function (workflow) {});\n")).toBe(true);
	rejects("return defineWorkflow((l) => {});\n");
	rejects("return defineWorkflow((workflow, extra) => {});\n");
	rejects("return defineWorkflow(({ workflow }) => {});\n");
});

test("rejects author async, await, and for await outside the direct-call rule", () => {
	expect(rejects(wrapBody("const f = async () => 1;"))).toBe(true);
	rejects(wrapBody('await fetch("x");', true));
	rejects(wrapBody("for await (const x of workflow.entries()) {}", true));
});

test("rejects aliasing, destructuring, dynamic keys, new, and tagged templates", () => {
	expect(rejects(wrapBody("const f = workflow.run; f();"))).toBe(true);
	rejects(wrapBody("const { run } = workflow;"));
	rejects(wrapBody('const k = "run"; workflow[k]();'));
	rejects(wrapBody("workflow[0]();"));
	rejects(wrapBody("new workflow.R();"));
	rejects(wrapBody("workflow.tag`x`;"));
});

test("rejects indirect calls, reassignment, and non-call member access", () => {
	expect(rejects(wrapBody('workflow.run.call(null, "x");'))).toBe(true);
	rejects(wrapBody("workflow = 1;"));
	rejects(wrapBody("const f = workflow.run;"));
	rejects(wrapBody("workflow.a.b();"));
});

test("rejects workflow calls and references inside nested scopes", () => {
	expect(rejects(wrapBody("[1].map((x) => workflow.run(x));"))).toBe(true);
	rejects(wrapBody("class C { m() { return workflow.run('x'); } }"));
	rejects(wrapBody("class C { x = workflow.state(); }"));
	rejects(wrapBody("class C { static { workflow.run('x'); } }"));
	rejects(wrapBody("const f = (x = workflow.state()) => x;"));
	rejects(wrapBody("const g = function (x) { return workflow.state(); };"));
});

test("rejects any workflow binding other than the workflow parameter", () => {
	expect(rejects(wrapBody("const workflow = 1;"))).toBe(true);
	rejects(wrapBody("let workflow;"));
	rejects(wrapBody("var workflow;"));
	rejects(wrapBody("function workflow() {}"));
	rejects(wrapBody("class workflow {}"));
	rejects(wrapBody("const f = (workflow) => workflow;"));
	rejects("const workflow = 1;\nreturn defineWorkflow((workflow) => {});\n");
});

test("rejects workflow bindings in every remaining binding position, including nested defineWorkflow", () => {
	expect(rejects(wrapBody("try {} catch (workflow) {}"))).toBe(true);
	rejects(wrapBody("const [workflow] = [];"));
	rejects(wrapBody("const { workflow } = x;"));
	rejects(wrapBody("function f(workflow) {}"));
	rejects(wrapBody("return defineWorkflow((workflow) => { return defineWorkflow((w) => {}); });"));
});

test("labels and class members named workflow compile (acorn-walk never visits them as references)", () => {
	const source = wrapBody("workflow: for (;;) { break workflow; }\n" + "class C { workflow() {} static workflow = 1; }\n" + "workflow.checkpoint(null);");
	expect(() => compileWorkflow(source)).not.toThrow();
});

test("compiled calls execute correctly at statement boundaries (ASI hazard coverage)", async () => {
	// WHY: ASI hazards occur when a call starts a statement after an unsemicolon'd call.
	// Table-driven execution test verifies the invariant ("compiled output executes with
	// author-intended sequencing") instead of the rewrite shape.
	const cases = [
		{ body: "workflow.run('a')\nworkflow.run('b')", expected: ["a", "b"] },
		{ body: "const x = workflow.run('a')\nworkflow.run('b')", expected: ["a", "b"] },
		{ body: "if (true) workflow.run('a')\nelse workflow.run('b')", expected: ["a"] },
		{ body: "switch (1) { case 1: workflow.run('a')\nbreak; }", expected: ["a"] },
	];
	for (const { body, expected } of cases) {
		const source = `return defineWorkflow((workflow) => {\n${body}\n});\n`;
		const code = compileWorkflow(source).code;
		const calls: string[] = [];
		const invoke = makeInvoke(composeWorkflow(code));
		await invoke({
			run: async (s: string) => {
				calls.push(s);
				return s;
			},
		});
		expect(calls, `execution mismatch for:\n${body}`).toStrictEqual(expected);
	}
});

// ── fast-check invariants ─────────────────────────────────────────

test("compilation is idempotent and line-preserving for arbitrary valid bodies", () => {
	fc.assert(
		fc.property(arbBody, (body) => {
			const source = wrapBody(`workflow.checkpoint(null);\n${body}`);
			const once = compileWorkflow(source).code;
			const twice = compileWorkflow(once).code;
			expect(twice, `not idempotent for:\n${source}`).toBe(once);
			expect(countNewlines(once), `newline count changed for:\n${source}`).toBe(countNewlines(source));
			expect(once).toMatch(/async \(workflow\)/);
			expect(once, `missing await for:\n${source}`).toContain("(await ");
		}),
		{ seed: 424242, numRuns: 250 },
	);
});

test("compiling an already-compiled body is byte-identical", () => {
	fc.assert(
		fc.property(arbBody, (body) => {
			const once = compileWorkflow(wrapBody(`workflow.checkpoint(null);\n${body}`)).code;
			expect(compileWorkflow(once).code).toBe(once);
		}),
		{ seed: 424242, numRuns: 250 },
	);
});
