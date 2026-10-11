/**
 * Every example workflow MUST satisfy the author contract in docs/workflows.md.
 * The engine compiler is that contract's single source of truth, so this guard
 * runs it over each file. The expected set is pinned: adding or removing an
 * example fails here until this list and examples/workflows/README.md agree.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { compileWorkflow } from "../../workflow/compile.js";

const EXAMPLES_DIR_URL = new URL("../../examples/workflows/", import.meta.url);

// Pinned so a stray file cannot enter the examples without a matching review.
const EXPECTED = ["gate-then-loop.js", "handoff.js", "new-session.js", "review.js", "smoke.js"];

test("examples/workflows holds exactly the expected scripts", () => {
	const actual = readdirSync(EXAMPLES_DIR_URL)
		.filter((name) => name.endsWith(".js"))
		.sort();
	assert.deepEqual(actual, [...EXPECTED]);
});

for (const name of EXPECTED) {
	test(`${name} satisfies the author contract`, () => {
		const source = readFileSync(new URL(name, EXAMPLES_DIR_URL), "utf8");
		assert.doesNotThrow(() => compileWorkflow(source));
	});
}
