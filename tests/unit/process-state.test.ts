/**
 * Registry invariant: module state that must survive a jiti double-load lives
 * under a `Symbol.for` key on globalThis (process-state.ts), so every fresh
 * lookup — including one made by a second module copy — returns the SAME object.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import { registeredState } from "../../process-state.js";
import { childUsageByCall } from "../../spawn/index.js";

test("registeredState: two fresh lookups of one key share one value", () => {
	const first = registeredState("test.process-state.shared", () => ({ n: 0 }));
	const second = registeredState("test.process-state.shared", () => ({ n: 0 }));
	assert.equal(first, second, "same key must resolve to one stored object");
	first.n = 1;
	assert.equal(second.n, 1, "a write through one lookup is visible at the other");

	const other = registeredState("test.process-state.other", () => ({ n: 0 }));
	assert.notEqual(first, other, "distinct keys must not share storage");
});

test("child usage: a map written by one lookup is read at another", () => {
	const writer = childUsageByCall();
	const reader = childUsageByCall();
	assert.equal(writer, reader, "one process-wide map for every module copy");

	const record = {
		usage: {
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} as Usage,
		model: "mock-model",
		thinking: "medium" as const,
		route: { status: "inherited" as const },
	};
	writer.set("call-registry", record);
	assert.equal(reader.get("call-registry"), record, "write by one lookup visible at another");
	reader.delete("call-registry");
	assert.equal(writer.has("call-registry"), false, "consumed entries are visible everywhere");
});
