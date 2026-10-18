import test from "node:test";
import assert from "node:assert/strict";
import { isThinkingLevel } from "../../thinking-levels.js";

test("isThinkingLevel rejects values outside the thinking-level list", () => {
	for (const value of ["ultra", "MAX", "", undefined, 3]) {
		assert.equal(isThinkingLevel(value), false, String(value));
	}
});
