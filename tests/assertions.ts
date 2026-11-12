// Assertion helpers for Vitest tests. Each helper makes exactly one counted `expect(...)` with the
// most specific matcher for its check. The `assert...` helpers also narrow their argument for the
// code after the call through an `asserts` signature, so a test needs no second, uncounted
// assertion just to satisfy the type checker.

import { expect } from "vitest";

/** Asserts `value` is neither `null` nor `undefined`. */
export function assertPresent<T>(value: T, message?: string): asserts value is NonNullable<T> {
	expect(value, message).not.toBeNullable();
}

// The failure message carries the full string, so a mismatch shows what was compared against.
function withActual(actual: string, message: string | undefined): string {
	return message === undefined ? actual : `${message}\n${actual}`;
}

/** Asserts `actual` starts with `prefix`; a failure prints the full `actual`. */
export function expectPrefix(actual: string, prefix: string, message?: string): void {
	expect(actual.slice(0, prefix.length), withActual(actual, message)).toBe(prefix);
}

/** Asserts `actual` ends with `suffix`; a failure prints the full `actual`. */
export function expectSuffix(actual: string, suffix: string, message?: string): void {
	// The start index comes from `actual.length`: `actual.slice(-0)` is the whole string, which would
	// make an empty suffix compare the whole string.
	expect(actual.slice(actual.length - suffix.length), withActual(actual, message)).toBe(suffix);
}
