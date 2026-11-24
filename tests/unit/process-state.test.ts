/**
 * Registry invariant: module state that must survive a jiti double-load lives
 * under a `Symbol.for` key on globalThis (process-state.ts), so every fresh
 * lookup — including one made by a second module copy — returns the SAME object.
 */
import { expect, test } from "vitest";
import { registeredState } from "../../process-state.js";

test("registeredState: two fresh lookups of one key share one value", () => {
	const first = registeredState("test.process-state.shared", () => ({ n: 0 }));
	const second = registeredState("test.process-state.shared", () => ({ n: 0 }));
	expect(first, "same key must resolve to one stored object").toBe(second);
	first.n = 1;
	expect(second.n, "a write through one lookup is visible at the other").toBe(1);

	const other = registeredState("test.process-state.other", () => ({ n: 0 }));
	expect(first, "distinct keys must not share storage").not.toBe(other);
});
