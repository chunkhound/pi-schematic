// WHY: workflows are written as plain synchronous JavaScript. This compiler proves the
// synchronous contract (acorn) across the WHOLE program — exactly one top-level
// `defineWorkflow(...)` statement, no raw global-object access — and rewrites every direct
// `workflow.*` call into an awaited call (magic-string), so the author can never omit an
// await or run an unawaited host effect. Pure: no pi runtime imports.
import { parse } from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

/** Every workflow contract violation surfaces here. The message carries `line:column`. */
export class WorkflowCompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowCompileError";
	}
}

// ESTree nodes: acorn's discriminated union is too noisy for a generic ancestor walk.
type Ast = { type: string; start: number; end: number; loc?: { start: { line: number; column: number } } | null; [key: string]: any };

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

// Scopes where a wrapped `await` would silently change a callback/getter/field contract.
const FORBIDDEN_TYPES = new Set([
	...FUNCTION_TYPES,
	"ClassDeclaration",
	"ClassExpression",
	"ClassBody",
	"MethodDefinition",
	"PropertyDefinition",
	"StaticBlock",
]);

function fail(node: Ast, message: string): never {
	const line = node.loc?.start.line ?? 1;
	const column = node.loc?.start.column ?? 0;
	throw new WorkflowCompileError(`${message} at ${line}:${column}`);
}

function parseProgram(source: string): Ast {
	try {
		return parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowReturnOutsideFunction: true,
			locations: true,
		}) as unknown as Ast;
	} catch (error) {
		const e = error as { message: string; loc?: { line: number; column: number } };
		const at = e.loc ? ` at ${e.loc.line}:${e.loc.column}` : "";
		throw new WorkflowCompileError(`parse error: ${e.message}${at}`);
	}
}

function isWorkflowCall(node: Ast | undefined | null): boolean {
	return node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "defineWorkflow";
}

// docs/workflows.md (File and entry point): "The file returns defineWorkflow(fn)." The codemode wrapper
// `(async (tools, console) => { <code> })` settles only when the wrapper promise
// settles, so a `return` is required: the wrapper must propagate the workflow's
// promise for the host to observe completion. A bare `defineWorkflow(...)` statement
// would let the wrapper resolve to undefined before any effect settles, silently
// truncating the run as a "returned" exit.
function isWorkflowStatement(s: Ast): boolean {
	return s.type === "ReturnStatement" && isWorkflowCall(s.argument);
}

// The whole file is the workflow. Any other top-level statement escapes the serial
// contract: its effects (e.g. a bare `workflow.shell(...)`) run unawaited and unchecked.
function findWorkflowStatement(program: Ast): Ast {
	const statement = program.body[0];
	if (program.body.length !== 1 || !isWorkflowStatement(statement))
		// WHY: a lone stray statement (e.g. a stale `workflow(...)` wrapper) is the common
		// case, and the program's 1:0 hides its real line. Empty/multi-statement files
		// have no single offender, so they stay at the program.
		fail(program.body.length === 1 ? statement : program, "file must be exactly one top-level return defineWorkflow(...) statement");
	return statement;
}

function extractLambda(statement: Ast): Ast {
	const call = statement.argument;
	if (call.arguments.length !== 1 || call.arguments[0].type !== "ArrowFunctionExpression")
		fail(call, "defineWorkflow requires a single arrow function argument");
	const fn = call.arguments[0];
	const param = fn.params[0];
	if (fn.params.length !== 1 || param.type !== "Identifier" || param.name !== "workflow")
		fail(fn, "defineWorkflow arrow must take exactly one parameter named workflow");
	return fn;
}

function isMemberOnWorkflow(node: Ast | undefined): boolean {
	if (node?.type !== "MemberExpression" || node.object.type !== "Identifier" || node.object.name !== "workflow") return false;
	if (!node.computed) return node.property.type === "Identifier";
	return node.property.type === "Literal" && typeof node.property.value === "string";
}

// Optional-chain wrapper: `await workflow?.run(...)` awaits the ChainExpression,
// so the inner CallExpression is what `insertAwaits` sees when walking the AST.
function isDirectWorkflowCall(node: Ast | undefined): boolean {
	return node?.type === "CallExpression" && isMemberOnWorkflow(node.callee);
}

/** The `workflow.<member>` name a member expression names, or null when it is not the workflow object. */
function workflowMemberName(member: Ast | undefined | null): string | null {
	if (!member || !isMemberOnWorkflow(member)) return null;
	return staticMemberKey(member.property, member.computed);
}

// Optional chains wrap the call; `await workflow?.run()` awaits the ChainExpression.
function isAwaitedDirectWorkflowCall(node: Ast | undefined): boolean {
	return isDirectWorkflowCall(node) || (node?.type === "ChainExpression" && isDirectWorkflowCall(node.expression));
}

function inForbiddenContext(ancestors: Ast[]): boolean {
	for (let i = 1; i < ancestors.length; i++) {
		if (FORBIDDEN_TYPES.has(ancestors[i].type)) return true;
	}
	return false;
}

function isNonReference(node: Ast, parent: Ast | undefined): boolean {
	if (!parent) return false;
	if (parent.type === "MemberExpression") return parent.property === node && !parent.computed;
	if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type)) {
		// Shorthand `{ workflow }` is also a value read — a capture, not a key.
		if (parent.shorthand && parent.value === node) return false;
		return parent.key === node && !parent.computed;
	}
	if (parent.type === "LabeledStatement") return parent.label === node;
	if (parent.type === "BreakStatement" || parent.type === "ContinueStatement") return parent.label === node;
	return false;
}

function isWorkflowCalleeObject(node: Ast, ancestors: Ast[]): boolean {
	const member = ancestors[ancestors.length - 2];
	const call = ancestors[ancestors.length - 3];
	return (
		member?.type === "MemberExpression" &&
		member.object === node &&
		call?.type === "CallExpression" &&
		call.callee === member &&
		isMemberOnWorkflow(member)
	);
}

function checkNode(node: Ast, ancestors: Ast[], lambda: Ast, allowedParam: Ast): void {
	if (FUNCTION_TYPES.has(node.type) && node.async && node !== lambda)
		fail(node, "async is only allowed on the workflow arrow");
	// `with` is outside docs/workflows.md (Accepted control flow): it makes scope resolution
	// runtime-dependent, so the compiler's direct-call contract stops being auditable.
	if (node.type === "WithStatement") fail(node, "with is not allowed");
	if (node.type === "ForOfStatement" && node.await) fail(node, "for await is not allowed");
	if (node.type === "AwaitExpression" && !isAwaitedDirectWorkflowCall(node.argument))
		fail(node, "await is only allowed on a direct workflow call");
	if (node.type !== "Identifier" || node.name !== "workflow" || node === allowedParam) return;
	if (inForbiddenContext(ancestors)) fail(node, "workflow is not allowed inside a nested scope");
	if (isNonReference(node, ancestors[ancestors.length - 2])) return;
	if (!isWorkflowCalleeObject(node, ancestors)) fail(node, "workflow must be called directly as workflow.<member>(...)");
}

function validateLambda(lambda: Ast, allowedParam: Ast): void {
	walk.fullAncestor<any>(lambda as any, (node: Ast, _state: unknown, ancestors: Ast[]) =>
		checkNode(node, ancestors, lambda, allowedParam),
	);
}

// A checkpoint is the engine's only safe exit point, so the host needs to know whether one
// exists: a workflow without one cannot be soft-stopped and is reported as unbounded.
function declaresCheckpoint(lambda: Ast): boolean {
	let found = false;
	walk.simple<any>(lambda as any, {
		CallExpression(node: Ast) {
			if (isDirectWorkflowCall(node) && workflowMemberName(node.callee) === "checkpoint") found = true;
		},
	});
	return found;
}

function patternIdentifiers(node: Ast | null | undefined): Ast[] {
	if (!node) return [];
	if (node.type === "Identifier") return [node];
	if (node.type === "ObjectPattern")
		return node.properties.flatMap((p: Ast) => (p.type === "RestElement" ? patternIdentifiers(p.argument) : patternIdentifiers(p.value)));
	if (node.type === "ArrayPattern") return node.elements.flatMap((el: Ast | null) => patternIdentifiers(el));
	if (node.type === "AssignmentPattern") return patternIdentifiers(node.left);
	if (node.type === "RestElement") return patternIdentifiers(node.argument);
	return [];
}

function bindingIdentifiers(node: Ast): Ast[] {
	if (node.type === "VariableDeclarator") return patternIdentifiers(node.id);
	if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression")
		return [...(node.id ? [node.id] : []), ...node.params.flatMap(patternIdentifiers)];
	if (node.type === "ArrowFunctionExpression") return node.params.flatMap(patternIdentifiers);
	if (node.type === "ClassDeclaration" || node.type === "ClassExpression") return node.id ? [node.id] : [];
	if (node.type === "CatchClause") return patternIdentifiers(node.param);
	return [];
}

// The sandbox puts `workflow` on the global object, so `globalThis.workflow.run(...)` reaches the
// same handles without the direct-call contract. The raw global object is rejected.
const GLOBAL_OBJECTS = new Set(["globalThis", "global"]);

// `eval` and `Function` compile new code at runtime, so a `workflow.*` call inside that
// code would skip every static check above. Same bypass family as the global objects.
const DYNAMIC_CODE = new Set(["eval", "Function"]);

// `Reflect.get(target, key)` reads any member by a runtime string, so it reaches `constructor`
// without a banned member name. Same bypass family as the dynamic-code identifiers.
const REFLECTION_OBJECTS = new Set(["Reflect"]);

// Property names whose read reaches code generation past the static checks. `constructor`
// reaches `Function` directly; the own-property-descriptor APIs read a member value by a
// runtime string the same way.
const BANNED_PROPERTY_READS = new Set(["constructor", "__proto__", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]);

/** Statically resolve a member/property key to its string form, or null when it cannot be
 * proven at compile time. A non-computed Literal is the object-pattern string-key form
 * (`{ "constructor": F }`), which reads the same property as the dot form. Non-computed
 * private names (`#x`) still yield null and are caller-judged. */
function staticMemberKey(property: Ast, computed: boolean): string | null {
	if (!computed && property.type === "Identifier") return property.name;
	if (property.type === "Literal") {
		const value = property.value;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
			return String(value);
		return null;
	}
	// A template with no expressions is a constant string; anything else is runtime-dependent.
	if (computed && property.type === "TemplateLiteral" && property.expressions.length === 0)
		return property.quasis[0].value.cooked ?? property.quasis[0].value.raw;
	return null;
}

function validateGlobalObject(program: Ast): void {
	walk.fullAncestor<any>(program as any, (node: Ast, _state: unknown, ancestors: Ast[]) => {
		if (node.type === "MemberExpression") {
			const name = staticMemberKey(node.property, node.computed);
			// An unresolved computed key can hide `constructor`; reject instead of ignoring it.
			if (node.computed && name === null)
				fail(node, "computed member keys must be a literal or constant template string");
			if (name !== null && BANNED_PROPERTY_READS.has(name))
				fail(node, `${name} member access is not allowed; it can reach code generation past the compile checks`);
		}
		// WHY: dynamic import loads code at runtime past every static check above,
		// the same bypass as eval/Function — reject it with the same loud failure.
		if (node.type === "ImportExpression") fail(node, "dynamic import is not allowed; it can hide a workflow call from the compile checks");
		// `this` at script top level IS the global object, so it is the same bypass as globalThis.
		if (node.type === "ThisExpression") fail(node, "this is not allowed; call workflow.<member>(...) directly");
		if (node.type !== "Identifier") return;
		if (GLOBAL_OBJECTS.has(node.name)) {
			if (isNonReference(node, ancestors[ancestors.length - 2])) return;
			fail(node, `${node.name} is not allowed; call workflow.<member>(...) directly`);
		}
		if (DYNAMIC_CODE.has(node.name)) {
			if (isNonReference(node, ancestors[ancestors.length - 2])) return;
			fail(node, `${node.name} is not allowed; it can hide a workflow call from the compile checks`);
		}
		if (REFLECTION_OBJECTS.has(node.name)) {
			if (isNonReference(node, ancestors[ancestors.length - 2])) return;
			fail(node, `${node.name} is not allowed; it can read a prototype member by name past the compile checks`);
		}
	});
}

/** Destructuring reads a property by name without a MemberExpression, so the same
 * prototype/reflection names must be rejected in every ObjectPattern key. */
function validateDestructuringKeys(program: Ast): void {
	walk.fullAncestor<any>(program as any, (node: Ast) => {
		if (node.type !== "ObjectPattern") return;
		for (const property of node.properties) {
			if (property.type === "RestElement") continue;
			const name = staticMemberKey(property.key, property.computed);
			if (property.computed && name === null)
				fail(property, "computed destructuring keys must be a literal or constant template string");
			if (name !== null && BANNED_PROPERTY_READS.has(name))
				fail(property.key, `${name} destructuring is not allowed; it can reach code generation past the compile checks`);
		}
	});
}

// The workflow lambda's `workflow` param is the only legal binding named `workflow` (docs/workflows.md, File and entry point).
function validateBindings(program: Ast, allowedParam: Ast): void {
	walk.fullAncestor<any>(program as any, (node: Ast) => {
		for (const id of bindingIdentifiers(node)) {
			if (id.name === "workflow" && id !== allowedParam) fail(id, "illegal workflow binding");
		}
	});
}

function isAwaitedCall(node: Ast, ancestors: Ast[]): boolean {
	const parent = ancestors[ancestors.length - 2];
	if (parent?.type === "AwaitExpression" && parent.argument === node) return true;
	const grand = ancestors[ancestors.length - 3];
	return (
		parent?.type === "ChainExpression" &&
		parent.expression === node &&
		grand?.type === "AwaitExpression" &&
		grand.argument === parent
	);
}

function insertAwaits(source: string, lambda: Ast): string {
	const s = new MagicString(source);
	let wrapped = 0;
	walk.fullAncestor<any>(lambda as any, (node: Ast, _state: unknown, ancestors: Ast[]) => {
		const isWorkflowCall = isDirectWorkflowCall(node) || (node?.type === "ChainExpression" && isDirectWorkflowCall(node.expression));
		if (!isWorkflowCall || isAwaitedCall(node, ancestors)) return;
		// `ancestors` includes the current node — acorn-walk pushes it before its
		// callback and pops after — so `current` is the node itself, not its parent.
		// Skip the ChainExpression wrapper: its inner direct workflow call is visited
		// and wrapped on its own visit, so wrapping the wrapper too would nest
		// `(await (await workflow?.run()))`. Awaited calls are already skipped above.
		const current = ancestors[ancestors.length - 1];
		if (current?.type === "ChainExpression" && isDirectWorkflowCall(current.expression)) return;
		s.appendLeft(node.start, "(await ");
		s.appendRight(node.end, ")");
		wrapped += 1;
	});
	if (wrapped > 0 && !lambda.async) s.appendLeft(lambda.start, "async ");
	return s.toString();
}

/** One compiled workflow: the sandbox script plus the host-relevant contract facts. */
export interface CompiledWorkflow {
	/** Await-annotated script body for the sandbox. */
	code: string;
	/** True when the workflow declares a `workflow.checkpoint(...)` safe exit point.
	 * False marks the run unbounded: no soft target can stop it, so none is offered. */
	hasCheckpoint: boolean;
}

/** Compile one workflow file into an await-annotated script body. Throws {@link WorkflowCompileError}. */
export function compileWorkflow(source: string): CompiledWorkflow {
	const program = parseProgram(source);
	const statement = findWorkflowStatement(program);
	const lambda = extractLambda(statement);
	validateBindings(program, lambda.params[0]);
	validateGlobalObject(program);
	validateDestructuringKeys(program);
	validateLambda(lambda, lambda.params[0]);
	const hasCheckpoint = declaresCheckpoint(lambda);
	const compiled = insertAwaits(source, lambda);
	// WHY: the injected `async` must yield valid JS. Without this, a sloppy identifier
	// such as `await` silently becomes a reserved word and the output fails to parse.
	parseProgram(compiled);
	return { code: compiled, hasCheckpoint };
}
