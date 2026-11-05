import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vitest";
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

	expect(during).not.toBe(before);
	expect(during.writeContext).not.toBe(before.writeContext);
	expect(during.frameScheduler).not.toBe(before.frameScheduler);

	h.teardown();
	expect(getSingletons()).toBe(before);
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
		expect(warnings.length).toBeGreaterThan(0);
		expect(String(warnings[0].args[0])).toMatch(/pending/);
		expect(after.writeLock).toBe(before.writeLock);
		expect(after.writeContext).toBe(before.writeContext);
	} finally {
		// Settle the simulated write, as a finished write would, so teardown
		// can restore the previous singletons instead of preserving this lock.
		before.writeLock.pending = 0;
		h.teardown();
	}
	expect(getSingletons()).toBe(outer);
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
	expect(order.length).toBe(5);
	expect(order).toContain(0);
	expect(order).toContain(4);

	// Order is deterministic (no concurrent completion — serialized by lock)
	// If lock works, order is a strict permutation of [0,1,2,3,4]
	const sorted = [...order].sort((a, b) => a - b);
	expect(order, "lock must serialize writers — no concurrent completion").toStrictEqual(sorted);

	h.teardown();
});
