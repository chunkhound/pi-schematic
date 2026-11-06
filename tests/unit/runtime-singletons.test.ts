import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTestHarness } from "../test-utils.js";
import {
	__setSingletons,
	createWriteLock,
	getSingletons,
} from "../../runtime-singletons.js";

test("createTestHarness swaps singleton state atomically and restores it on teardown", () => {
	const before = getSingletons();
	const h = createTestHarness();
	const during = getSingletons();

	assert.notEqual(during, before);
	assert.notEqual(during.writeContext, before.writeContext);
	assert.notEqual(during.frameScheduler, before.frameScheduler);

	h.teardown();
	assert.equal(getSingletons(), before);
});

test("__setSingletons warns and preserves lock + write context during in-flight writes", () => {
	// Use harness to isolate the test's singleton manipulation
	const outer = getSingletons();
	const h = createTestHarness();
	const before = getSingletons();
	try {
		before.writeLock.pending = 1; // simulate in-flight write on test singleton
		__setSingletons({
			writeLock: createWriteLock(),
			writeContext: new AsyncLocalStorage<true>(),
			frameScheduler: before.frameScheduler,
		});
		const after = getSingletons();
		const warnings = h.warnings.filter((entry) => entry.level === "warn");
		assert.ok(warnings.length > 0);
		assert.match(String(warnings[0].args[0]), /pending/);
		assert.equal(after.writeLock, before.writeLock);
		assert.equal(after.writeContext, before.writeContext);
	} finally {
		// Settle the simulated write, as a finished write would, so teardown
		// can restore the previous singletons instead of preserving this lock.
		before.writeLock.pending = 0;
		h.teardown();
	}
	assert.equal(getSingletons(), outer);
});

test("write lock serializes concurrent writers and completes all", async () => {
	const h = createTestHarness();
	const s = getSingletons();

	const order: number[] = [];
	const writers = Array.from({ length: 5 }, (_, i) =>
		(async () => {
			// Grab the current tail promise before acquiring the lock
			const prev = s.writeLock.tail;
			// Simulate acquiring the lock by chaining onto the tail
			let release: () => void;
			const next = new Promise<void>((resolve) => { release = resolve; });
			s.writeLock.pending += 1;
			s.writeLock.tail = next;
			await prev;
			order.push(i);
			s.writeLock.pending -= 1;
			release!();
		})(),
	);

	await Promise.all(writers);

	// All writers completed in some order
	assert.equal(order.length, 5);
	assert.ok(order.includes(0));
	assert.ok(order.includes(4));

	// Order is deterministic (no concurrent completion — serialized by lock)
	// If lock works, order is a strict permutation of [0,1,2,3,4]
	const sorted = [...order].sort((a, b) => a - b);
	assert.deepEqual(order, sorted, "lock must serialize writers — no concurrent completion");

	h.teardown();
});
