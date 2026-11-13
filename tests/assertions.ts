// Assertion helpers for Vitest tests. Each helper makes exactly one counted `expect(...)` with the
// most specific matcher for its check. The `assert...` helpers also narrow their argument for the
// code after the call through an `asserts` signature, so a test needs no second, uncounted
// assertion just to satisfy the type checker.

import { expect } from "vitest";

/** Asserts `value` is neither `null` nor `undefined`. */
export function assertPresent<T>(value: T, message?: string): asserts value is NonNullable<T> {
	expect(value, message).not.toBeNullable();
}

/** Asserts `value` is a string. */
export function assertString(value: unknown, message?: string): asserts value is string {
	expect(value, message).toBeTypeOf("string");
}

/** Asserts `value` is an instance of `Class`. */
export function assertInstanceOf<T>(value: unknown, Class: abstract new (...args: never[]) => T, message?: string): asserts value is T {
	expect(value, message).toBeInstanceOf(Class);
}

// The failure message carries the full string, so a mismatch shows the string the compared part was cut from.
function withActual(actual: string, message: string | undefined): string {
	return message === undefined ? actual : `${message}\n${actual}`;
}

/** Asserts `actual` starts with `prefix`; a failure prints the full `actual`. */
export function expectPrefix(actual: string, prefix: string, message?: string): void {
	expect(actual.slice(0, prefix.length), withActual(actual, message)).toBe(prefix);
}

/** Asserts `actual` ends with `suffix`; a failure prints the full `actual`. */
export function expectSuffix(actual: string, suffix: string, message?: string): void {
	// The start index comes from `actual.length`, clamped at 0: `actual.slice(-0)` is the whole string,
	// which would make an empty suffix compare the whole string, and a negative start for a suffix longer
	// than `actual` wraps around and shows a cut-off tail.
	expect(actual.slice(Math.max(0, actual.length - suffix.length)), withActual(actual, message)).toBe(suffix);
}
