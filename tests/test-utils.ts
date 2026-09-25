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
	isNoopScheduler,
	type RuntimeSingletons,
} from "../runtime-singletons.js";
import { SpawnFrameScheduler } from "../spawn/renderer.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TestHarness {
	/** Captured console.debug/log/warn/error calls. */
	warnings: Array<{ level: string; args: unknown[] }>;
	/** Restore console, clear scheduler, reset write lock. */
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
 *
 * CRITICAL: ESM static imports resolve before any module body runs. This means
 * spawn/renderer.ts registers the production frame scheduler at import time.
 * The test harness replaces the frame scheduler with a fresh test scheduler.
 * This works correctly as long as test-utils.ts is imported before spawn/renderer.ts
 * in the module graph. Never use dynamic import() to load spawn/renderer.ts after
 * createTestHarness() — the production scheduler would overwrite the test one.
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

	// Check whether spawn/renderer.ts was already statically imported before
	// this harness call — if previousSingletons still holds the noop marker,
	// the production registration at the bottom of spawn/renderer.ts never ran.
	if (isNoopScheduler(previousSingletons.frameScheduler)) {
		console.warn(
			"[test-utils] spawn/renderer.ts was not statically imported before " +
				"createTestHarness() — the production frame scheduler was never " +
				"registered. Frame-batched rendering tests will use the noop scheduler.",
		);
	}

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
			// Restore singletons first so the harness scheduler is current.
			// Then clear it to release any dirty components before disposal.
			__setSingletons(previousSingletons);
			singletons.frameScheduler.clear();
			console.debug = originalDebug;
			console.log = originalLog;
			console.warn = originalWarn;
			console.error = originalError;
		},
	};
}