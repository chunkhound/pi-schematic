import assert from "node:assert/strict";
import test from "node:test";

const { needsE2eConcurrency } = await import(
	new URL("../../scripts/e2e-concurrency.mjs", import.meta.url).href
);

test("e2e concurrency cap matches every e2e pattern shape", () => {
	assert.equal(needsE2eConcurrency(["tests/e2e/basic.test.ts"]), true);
	assert.equal(needsE2eConcurrency(["tests/unit/basic.test.ts"]), false);
	assert.equal(needsE2eConcurrency(["tests\\e2e\\basic.test.ts"]), true);
	assert.equal(needsE2eConcurrency(["tests/e2e"]), true);
	assert.equal(needsE2eConcurrency(["tests/unit/a.test.ts", "tests/e2e/basic.test.ts"]), true);
	assert.equal(needsE2eConcurrency(["tests/e2e-extra/basic.test.ts"]), false);
});
