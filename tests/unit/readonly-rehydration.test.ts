import { expect, test } from "vitest";
import { getReadonlyFromBranch } from "../../readonly-rehydration.js";

function makePI(readonlyFlag = false) {
	return { getFlag: () => readonlyFlag };
}

test("getReadonlyFromBranch returns false for empty branch with no CLI flag", () => {
	expect(getReadonlyFromBranch([], makePI(false))).toBe(false);
});

test("getReadonlyFromBranch returns true for empty branch with CLI flag", () => {
	expect(getReadonlyFromBranch([], makePI(true))).toBe(true);
});

test("getReadonlyFromBranch uses a persisted readonly entry when present", () => {
	expect(getReadonlyFromBranch([
			{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		], makePI(false))).toBe(true);
	expect(getReadonlyFromBranch([
			{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
		], makePI(true))).toBe(false);
});

test("getReadonlyFromBranch picks the latest entry (true wins)", () => {
	const branch = [
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
	];
	expect(getReadonlyFromBranch(branch, makePI(false))).toBe(true);
});

test("getReadonlyFromBranch picks the latest entry (false wins)", () => {
	const branch = [
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
	];
	expect(getReadonlyFromBranch(branch, makePI(false))).toBe(false);
});

test("getReadonlyFromBranch skips entries with wrong customType", () => {
	const branch = [
		{ type: "custom", customType: "other-extension", data: { enabled: true } },
	];
	expect(getReadonlyFromBranch(branch, makePI(false))).toBe(false);
});

test("getReadonlyFromBranch falls back to the CLI flag when no valid readonly entry exists", () => {
	expect(getReadonlyFromBranch([null, "string", 42], makePI(true))).toBe(true);
	expect(getReadonlyFromBranch([
			{ type: "custom", customType: "pi-schematic-readonly", data: null },
		], makePI(false))).toBe(false);
});
