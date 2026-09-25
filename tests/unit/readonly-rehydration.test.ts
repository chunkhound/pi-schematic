import test from "node:test";
import assert from "node:assert/strict";
import { getReadonlyFromBranch } from "../../readonly-rehydration.js";

function makePI(readonlyFlag = false) {
	return { getFlag: () => readonlyFlag };
}

test("getReadonlyFromBranch returns false for empty branch with no CLI flag", () => {
	assert.equal(getReadonlyFromBranch([], makePI(false)), false);
});

test("getReadonlyFromBranch returns true for empty branch with CLI flag", () => {
	assert.equal(getReadonlyFromBranch([], makePI(true)), true);
});

test("getReadonlyFromBranch uses a persisted readonly entry when present", () => {
	assert.equal(
		getReadonlyFromBranch([
			{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		], makePI(false)),
		true,
	);
	assert.equal(
		getReadonlyFromBranch([
			{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
		], makePI(true)),
		false,
	);
});

test("getReadonlyFromBranch picks the latest entry (true wins)", () => {
	const branch = [
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
	];
	assert.equal(getReadonlyFromBranch(branch, makePI(false)), true);
});

test("getReadonlyFromBranch picks the latest entry (false wins)", () => {
	const branch = [
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: true } },
		{ type: "custom", customType: "pi-schematic-readonly", data: { enabled: false } },
	];
	assert.equal(getReadonlyFromBranch(branch, makePI(false)), false);
});

test("getReadonlyFromBranch skips entries with wrong customType", () => {
	const branch = [
		{ type: "custom", customType: "other-extension", data: { enabled: true } },
	];
	assert.equal(getReadonlyFromBranch(branch, makePI(false)), false);
});

test("getReadonlyFromBranch falls back to the CLI flag when no valid readonly entry exists", () => {
	assert.equal(getReadonlyFromBranch([null, "string", 42], makePI(true)), true);
	assert.equal(
		getReadonlyFromBranch([
			{ type: "custom", customType: "pi-schematic-readonly", data: null },
		], makePI(false)),
		false,
	);
});
