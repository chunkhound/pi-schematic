import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	LEADING_REDIRECTION_PATTERN,
	REDIRECT_TOKEN_PATTERN,
	matchRedirectToken,
	skipLeadingRedirections,
} from "../../readonly-shell-utils.js";

// Static guards for the readonly classifier's module graph. The classifier split into
// per-concern modules (readonly-bash.ts + readonly-bash-*.ts + readonly-shell-utils.ts);
// these assertions keep two drift risks visible: a shared primitive being re-copied into a
// second module, and a new import cycle being introduced (ESM cycles can surface as TDZ
// errors when a binding is read during module evaluation).
const REPO_ROOT = new URL("../../", import.meta.url);

// WHY glob instead of a hardcoded list: a new readonly-*.ts module must enter cycle
// detection automatically; a forgotten list entry would decay the guard to green.
// readonly-boundary.ts and readonly-rehydration.ts match the glob but import nothing in
// this graph, so they add edgeless nodes and cannot cause false cycle failures.
const MODULES: readonly string[] = globSync("readonly-*.ts", { cwd: fileURLToPath(REPO_ROOT) }).sort();

// The only tolerated cycle today: the dispatcher <-> commands/dirchange/heredoc helpers need
// each other to recurse into nested shell code. Keep this list exact: adding a module to a
// cycle must be a deliberate change, not an accident.
//
// Allowlist update process: a new cycle member fails this test with REVIEW REQUIRED.
// To update: (1) confirm the cycle is needed for nested-shell recursion (not a
// stray import), (2) get human review, (3) extend ALLOWED_CYCLIC_MODULES with the
// module name plus a comment naming the recursion, (4) keep this test failing
// until the list change lands — never silence it with a skip or a wider glob.
const ALLOWED_CYCLIC_MODULES = new Set([
	"readonly-bash.ts",
	"readonly-bash-commands.ts",
	"readonly-bash-dirchange.ts",
	"readonly-bash-heredoc.ts",
]);

function sourceOf(module: string): string {
	return readFileSync(new URL(module, REPO_ROOT), "utf8");
}

function importsOf(module: string): string[] {
	// WHY one pattern for every ESM shape: `export ... from`, single quotes, and
	// dynamic `import()` all name a dependency, so missing one would hide a real cycle.
	return [...sourceOf(module).matchAll(/(?:from\s+|import[\s(]+)["']\.\/([A-Za-z0-9_-]+)\.js["']/g)]
		.map((match) => `${match[1]}.ts`)
		.filter((target) => MODULES.includes(target));
}

function reachesSelf(start: string, graph: ReadonlyMap<string, string[]>): boolean {
	const seen = new Set<string>();
	const stack = [...graph.get(start)!];
	while (stack.length) {
		const node = stack.pop()!;
		if (node === start) return true;
		if (seen.has(node)) continue;
		seen.add(node);
		stack.push(...graph.get(node)!);
	}
	return false;
}

// WHY name scan, not regex-literal scan: identifiers survive reformats and a comment
// mentioning a literal no longer trips the guard; only a real redeclaration does.
function declaresHelper(source: string, name: string): boolean {
	return new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`).test(source);
}

function assertSingleOwner(name: string): void {
	const owners = MODULES.filter(
		(module) => module !== "readonly-shell-utils.ts" && declaresHelper(sourceOf(module), name),
	);
	assert.deepEqual(owners, [], `${name} must be imported from readonly-shell-utils.ts, never redeclared`);
}

test("readonly module graph keeps its cycles within the documented set", () => {
	// WHY tripwire, not a hardcoded list: an empty glob (bad cwd, engine change) must
	// fail loudly instead of vacuously passing cycle detection with zero nodes.
	assert.ok(MODULES.includes("readonly-shell-utils.ts"), `readonly glob found no modules: ${String(MODULES)}`);
	const graph = new Map(MODULES.map((module) => [module, importsOf(module)]));
	for (const module of MODULES) {
		if (reachesSelf(module, graph)) {
			assert.ok(
				ALLOWED_CYCLIC_MODULES.has(module),
				`REVIEW REQUIRED: new readonly import cycle member: ${module}. Human review needed: either break the cycle or deliberately extend ALLOWED_CYCLIC_MODULES per the process above`,
			);
		}
	}
});

test("leading-redirect parsing has a single source of truth", () => {
	assert.ok(LEADING_REDIRECTION_PATTERN instanceof RegExp, "pattern must be exported from readonly-shell-utils.ts");
	assert.match(skipLeadingRedirections.toString(), /LEADING_REDIRECTION_PATTERN/, "skipper must use the shared pattern, not a copy");
	assertSingleOwner("skipLeadingRedirections");
	for (const [tokens, expected] of [[["rm"], 0], [[">out", "rm"], 1], [[">", "out", "rm"], 2]] as const) {
		assert.equal(skipLeadingRedirections([...tokens], 0), expected, tokens.join(" "));
	}
});

test("write-redirect token parsing has a single source of truth", () => {
	assert.ok(REDIRECT_TOKEN_PATTERN instanceof RegExp, "pattern must be exported from readonly-shell-utils.ts");
	// A copied regex literal keeps the name but loses the shared constant; this catches that
	// exact drift, while assertSingleOwner catches a redeclaration.
	assert.match(matchRedirectToken.toString(), /REDIRECT_TOKEN_PATTERN/, "matcher must use the shared pattern, not a copy");
	assertSingleOwner("matchRedirectToken");
	// Independent operator expectations guard the pattern itself, not just the wiring.
	for (const [word, expected] of [[">", ">"], ["2>", "2>"], [">>", ">>"], ["&>", "&>"], ["<", "<"], ["rm", null], ["2", null]] as const) {
		assert.equal(matchRedirectToken(word)?.[0] ?? null, expected, word);
	}
});

test("redirect token stripping has a single source of truth", () => {
	assertSingleOwner("stripRedirectTokens");
});
