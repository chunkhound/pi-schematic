import assert from "node:assert/strict";
import test from "node:test";
import { messageOf, safeAppendEntry } from "../../workflow/errors.js";

test("messageOf returns Error.message for Error instances", () => {
	const error = new Error("boom");
	assert.equal(messageOf(error), "boom");
});

test("messageOf stringifies non-Error values", () => {
	assert.equal(messageOf("string"), "string");
	assert.equal(messageOf(42), "42");
	assert.equal(messageOf(null), "null");
});

test("safeAppendEntry returns true on success", () => {
	const entries: Array<{ type: string; data?: unknown }> = [];
	const pi = {
		appendEntry: (type: string, data?: unknown) => {
			entries.push({ type, data });
			return true;
		},
	} as any;
	assert.equal(safeAppendEntry(pi, "test", { a: 1 }), true);
	assert.deepEqual(entries, [{ type: "test", data: { a: 1 } }]);
});

test("safeAppendEntry returns false when append throws", () => {
	const pi = {
		appendEntry: () => { throw new Error("append failed"); },
	} as any;
	assert.equal(safeAppendEntry(pi, "test"), false);
});
