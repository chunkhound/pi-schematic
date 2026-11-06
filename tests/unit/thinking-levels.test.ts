import { expect, test } from "vitest";
import { isThinkingLevel } from "../../thinking-levels.js";

test("isThinkingLevel rejects values outside the thinking-level list", () => {
	for (const value of ["ultra", "MAX", "", undefined, 3]) {
		expect(isThinkingLevel(value), String(value)).toBe(false);
	}
});
