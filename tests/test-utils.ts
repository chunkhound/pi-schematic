/**
 * Central test harness for the pi-schematic extension.
 *
 * Every non-E2E test that touches module-level singletons starts with
 * `const h = createTestHarness()` and ends with `h.teardown()`.  One call
 * replaces the singleton container atomically and captures console output —
 * no per-test patches.
 *
 * Usage:
 *
 *   const h = createTestHarness();
 *   // test body — use h.warnings
 *   h.teardown();
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
	/** Restore console and the previous singletons, then clear the harness scheduler. */
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
			__setSingletons(previousSingletons);
			// Clear the harness scheduler to release any dirty components before
			// disposal.
			singletons.frameScheduler.clear();
			console.debug = originalDebug;
			console.log = originalLog;
			console.warn = originalWarn;
			console.error = originalError;
		},
	};
}