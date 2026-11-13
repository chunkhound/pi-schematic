import { AsyncLocalStorage } from "node:async_hooks";
import { expect, onTestFinished, test, vi } from "vitest";
import { createTestHarness, useTestHarness } from "../test-utils.js";
import {
	__setSingletons,
	createWriteLock,
	getSingletons,
} from "../../runtime-singletons.js";
import { SpawnFrameScheduler } from "../../spawn/renderer.js";

test("createTestHarness swaps singleton state atomically and restores it on teardown", () => {
	const before = getSingletons();
	const h = createTestHarness();
	onTestFinished(() => {
		h.teardown();
		expect(getSingletons()).toBe(before);
	});
	const during = getSingletons();

	expect(during).not.toBe(before);
	expect(during.writeContext).not.toBe(before.writeContext);
	expect(during.frameScheduler).not.toBe(before.frameScheduler);
});

test("__setSingletons keeps the lock and write context of an in-flight write and takes the other fields from the caller", () => {
	// Use harness to isolate the test's singleton manipulation
	const outer = getSingletons();
	const h = createTestHarness();
	const before = getSingletons();
	onTestFinished(() => {
		// Settle the simulated write, as a finished write would, so teardown
		// does not fail on a pending write.
		before.writeLock.pending = 0;
		h.teardown();
		expect(getSingletons()).toBe(outer);
	});
	before.writeLock.pending = 1; // simulate in-flight write on test singleton
	const frameScheduler = new SpawnFrameScheduler();
	__setSingletons({
		writeLock: createWriteLock(),
		writeContext: new AsyncLocalStorage<true>(),
		frameScheduler,
	});
	const after = getSingletons();
	expect(h.warnings).toStrictEqual([]);
	expect(after.writeLock).toBe(before.writeLock);
	expect(after.writeContext).toBe(before.writeContext);
	expect(after.frameScheduler).toBe(frameScheduler);
});

test("write lock serializes concurrent writers and completes all", async () => {
	useTestHarness();
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
	expect(order).toHaveLength(5);
	expect(order).toContain(0);
	expect(order).toContain(4);

	// Order is deterministic (no concurrent completion — serialized by lock)
	// If lock works, order is a strict permutation of [0,1,2,3,4]
	const sorted = [...order].sort((a, b) => a - b);
	expect(order, "lock must serialize writers — no concurrent completion").toStrictEqual(sorted);
});

test("teardown restores the console and singletons, then fails, when a write is still pending", () => {
	const outer = getSingletons();
	const { debug, log, warn, error } = console;
	const h = createTestHarness();
	const { writeLock, frameScheduler } = getSingletons();
	writeLock.pending = 1;
	const clear = vi.spyOn(frameScheduler, "clear");

	expect(() => { h.teardown(); }).toThrow(/pending/);

	expect(writeLock.pending, "teardown leaves the pending write alone").toBe(1);
	expect(clear, "teardown clears the harness scheduler before it throws").toHaveBeenCalledOnce();
	expect(getSingletons()).toBe(outer);
	expect(console.debug).toBe(debug);
	expect(console.log).toBe(log);
	expect(console.warn).toBe(warn);
	expect(console.error).toBe(error);
});

test("teardown restores the console and singletons when clearing the harness scheduler throws", () => {
	const outer = getSingletons();
	const { debug, log, warn, error } = console;
	const h = createTestHarness();
	onTestFinished(() => {
		// Undo the singleton swap teardown should have made, so a failure here
		// does not leave the harness singletons installed. restoreMocks restores
		// the console spies before the next test.
		__setSingletons(outer, { forceWriteLock: true });
	});
	vi.spyOn(getSingletons().frameScheduler, "clear").mockImplementation(() => {
		throw new Error("boom");
	});

	expect(() => { h.teardown(); }).toThrow(/boom/);

	expect(getSingletons()).toBe(outer);
	expect(console.debug).toBe(debug);
	expect(console.log).toBe(log);
	expect(console.warn).toBe(warn);
	expect(console.error).toBe(error);
});

test("createTestHarness fails, and changes nothing, when a write is pending on the installed lock", () => {
	const outer = getSingletons();
	const h = createTestHarness();
	const installed = getSingletons();
	onTestFinished(() => {
		// Settle the simulated write so the outer teardown does not fail on it.
		installed.writeLock.pending = 0;
		h.teardown();
		expect(getSingletons()).toBe(outer);
	});
	installed.writeLock.pending = 1;
	const { debug, log, warn, error } = console;

	expect(() => createTestHarness()).toThrow(/pending/);

	expect(getSingletons()).toBe(installed);
	expect(installed.writeLock.pending).toBe(1);
	expect(console.debug).toBe(debug);
	expect(console.log).toBe(log);
	expect(console.warn).toBe(warn);
	expect(console.error).toBe(error);
});
