/**
 * Registry invariant: module state that must survive a jiti double-load lives
 * under a `Symbol.for` key on globalThis (process-state.ts), so every fresh
 * lookup — including one made by a second module copy — returns the SAME object.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registeredState } from "../../process-state.js";

test("registeredState: two fresh lookups of one key share one value", () => {
	const first = registeredState("test.process-state.shared", () => ({ n: 0 }));
	const second = registeredState("test.process-state.shared", () => ({ n: 0 }));
	assert.equal(first, second, "same key must resolve to one stored object");
	first.n = 1;
	assert.equal(second.n, 1, "a write through one lookup is visible at the other");

	const other = registeredState("test.process-state.other", () => ({ n: 0 }));
	assert.notEqual(first, other, "distinct keys must not share storage");
});
