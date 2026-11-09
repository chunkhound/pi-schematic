/**
 * Central test harness for the pi-schematic extension.
 *
 * Every non-E2E test that touches module-level singletons creates a harness
 * with `createTestHarness()` and tears it down from a cleanup returned by
 * `beforeEach` or from an `onTestFinished` callback.  One call installs a
 * fresh singleton container, its own write lock and context included, and
 * captures console output, so no test needs its own patches.  It throws,
 * changing nothing, while a write is pending on the installed write lock.
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
 *   const h = useTestHarness(); // registers h.teardown() in onTestFinished
 *   // test body: use h.warnings
 *
 * With a cleanup returned from beforeEach, which Vitest registers only when
 * the hook returned, so a harness that refused to start is not torn down:
 *
 *   describe("spawn", () => {
 *     let h: TestHarness;
 *     beforeEach(() => {
 *       h = createTestHarness();
 *       return () => { h.teardown(); };
 *     });
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	__setSingletons,
	createWriteLock,
	getSingletons,
	type RuntimeSingletons,
} from "../runtime-singletons.js";
import { onTestFinished } from "vitest";
import { SpawnFrameScheduler } from "../spawn/renderer.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TestHarness {
	/** Captured console.debug/log/warn/error calls. */
	warnings: { level: string; args: unknown[] }[];
	/**
	 * Restore the console, then the singletons that were current at
	 * createTestHarness() whether or not a write is pending, then clear the
	 * harness scheduler.  Throws, after all three, when the harness write lock
	 * had pending writes at the start of the call; the pending write is left as
	 * it is.  Call it from a cleanup returned by beforeEach or from an
	 * onTestFinished callback.
	 */
	teardown: () => void;
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create a fresh test harness.  Every test that needs isolation calls this.
 *
 * IMPORTANT: Do not call createTestHarness() twice without an intervening
 * teardown(). The second call captures the first's state, and teardown of the
 * second restores stale singletons. Tear each harness down from a cleanup
 * returned by beforeEach (or from afterEach) or from an onTestFinished
 * callback to guarantee a single active harness per test.
 */
export function createTestHarness(): TestHarness {
	const previousSingletons = getSingletons();
	const pendingAtStart = previousSingletons.writeLock.pending;
	if (pendingAtStart > 0) {
		throw new Error(
			`createTestHarness: ${pendingAtStart} write(s) still pending on the installed write lock; a previous test or caller did not finish its writes.`,
		);
	}

	const singletons: RuntimeSingletons = {
		writeLock: createWriteLock(),
		writeContext: new AsyncLocalStorage<true>(),
		frameScheduler: new SpawnFrameScheduler(),
	};
	const warnings: { level: string; args: unknown[] }[] = [];
	const originalDebug = console.debug;
	const originalLog = console.log;
	const originalWarn = console.warn;
	const originalError = console.error;

	// Install the fresh container in one call; no write is pending (checked
	// above), so the harness always runs on its own lock and context.
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
/**
 * Creates a harness for the current test and tears it down from
 * `onTestFinished`, which is registered only after `createTestHarness()`
 * returned, so a harness that refused to start is not torn down.
 */
export function useTestHarness(): TestHarness {
	const h = createTestHarness();
	onTestFinished(() => {
		h.teardown();
	});
	return h;
}
