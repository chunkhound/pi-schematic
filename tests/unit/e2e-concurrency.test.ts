import { expect, test } from "vitest";
import { REPO_ROOT_URL } from "../paths.js";

const { needsE2eConcurrency } = await import(new URL("scripts/e2e-concurrency.mjs", REPO_ROOT_URL).href);

test("e2e concurrency cap matches every e2e pattern shape", () => {
	expect(needsE2eConcurrency(["tests/e2e/basic.test.ts"])).toBe(true);
	expect(needsE2eConcurrency(["tests/unit/basic.test.ts"])).toBe(false);
	expect(needsE2eConcurrency(["tests\\e2e\\basic.test.ts"])).toBe(true);
	expect(needsE2eConcurrency(["tests/e2e"])).toBe(true);
	expect(needsE2eConcurrency(["tests/unit/a.test.ts", "tests/e2e/basic.test.ts"])).toBe(true);
	expect(needsE2eConcurrency(["tests/e2e-extra/basic.test.ts"])).toBe(false);
});
