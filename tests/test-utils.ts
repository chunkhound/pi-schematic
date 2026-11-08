/**
 * Central test harness for the pi-schematic extension.
 *
 * Every non-E2E test that touches module-level singletons creates a harness
 * with `createTestHarness()` and tears it down from `afterEach` or an
 * `onTestFinished` callback.  One call installs a fresh singleton container
 * (keeping the previous write lock and context while a write is pending on
 * them) and captures console output — no per-test patches.
 *
 * `teardown()` restores the console, then the container that was current at
 * `createTestHarness()` (even while a write is pending), then clears the
 * harness scheduler, and finally throws when a write was still pending on
 * the harness write lock.  It never releases or resets that write.  Calling it
 * from a hook adds that error to the test's errors next to any assertion
 * failure instead of replacing it.
 *
 * Usage:
 *
 *   const h = createTestHarness();
 *   onTestFinished(() => { h.teardown(); });
 *   // test body — use h.warnings
 *
 * With beforeEach/afterEach:
 *
 *   describe("spawn", () => {
 *     let h: TestHarness;
 *     beforeEach(() => { h = createTestHarness(); });
 *     afterEach(() => { h.teardown(); });
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	__setSingletons,
	createWriteLock,
	getSingletons,
	type RuntimeSingletons,
} from "../runtime-singletons.js";
import { SpawnFrameScheduler } from "../spawn/renderer.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TestHarness {
	/** Captured console.debug/log/warn/error calls. */
	warnings: Array<{ level: string; args: unknown[] }>;
	/**
	 * Restore the console, then the singletons that were current at
	 * createTestHarness() whether or not a write is pending, then clear the
	 * harness scheduler.  Throws, after all three, when the harness write lock
	 * had pending writes at the start of the call; the pending write is left as
	 * it is.  Call it from afterEach or an onTestFinished callback.
	 */
	teardown: () => void;
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create a fresh test harness.  Every test that needs isolation calls this.
 *
 * IMPORTANT: Do not call createTestHarness() twice without an intervening
 * teardown(). The second call captures the first's state, and teardown of the
 * second restores stale singletons. Use beforeEach/afterEach to guarantee a
 * single active harness per test.
 */
export function createTestHarness(): TestHarness {
	const previousSingletons = getSingletons();

	const singletons: RuntimeSingletons = {
		writeLock: createWriteLock(),
		writeContext: new AsyncLocalStorage<true>(),
		frameScheduler: new SpawnFrameScheduler(),
	};
	const warnings: Array<{ level: string; args: unknown[] }> = [];
	const originalDebug = console.debug;
	const originalLog = console.log;
	const originalWarn = console.warn;
	const originalError = console.error;

	// Atomic swap: replace the production singleton container (write lock,
	// context, frame scheduler) in one call.
	__setSingletons(singletons);

	// Capture every forbidden TUI-corrupting console level for assertions.
	console.debug = (...args: unknown[]) => {
		warnings.push({ level: "debug", args });
	};
	console.log = (...args: unknown[]) => {
		warnings.push({ level: "log", args });
	};
	console.warn = (...args: unknown[]) => {
		warnings.push({ level: "warn", args });
	};
	console.error = (...args: unknown[]) => {
		warnings.push({ level: "error", args });
	};

	return {
		warnings,
		teardown: () => {
			const pendingWrites = singletons.writeLock.pending;
			console.debug = originalDebug;
			console.log = originalLog;
			console.warn = originalWarn;
			console.error = originalError;
			// A write still running keeps the lock and context it captured; forcing
			// the swap only stops the harness lock from leaking into the next test.
			__setSingletons(previousSingletons, { forceWriteLock: true });
			// Clear the harness scheduler to release any dirty components before
			// disposal.
			singletons.frameScheduler.clear();
			if (pendingWrites > 0) {
				throw new Error(
					`createTestHarness teardown: ${pendingWrites} write(s) still pending on the harness write lock; the test ended before its writes finished.`,
				);
			}
		},
	};
}