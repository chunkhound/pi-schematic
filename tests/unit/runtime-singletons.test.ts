import { AsyncLocalStorage } from "node:async_hooks";
import { expect, onTestFinished, test } from "vitest";
import { createTestHarness } from "../test-utils.js";
import { __setSingletons, createWriteLock, getSingletons } from "../../runtime-singletons.js";
import { SpawnFrameScheduler } from "../../spawn/renderer.js";

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
