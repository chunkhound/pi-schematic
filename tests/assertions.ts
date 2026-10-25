// Narrowing assertions for Vitest tests. Each helper makes exactly one counted `expect(...)` with
// the most specific matcher for its check, and its `asserts` signature narrows the argument for
// the code after the call, so a test needs no second, uncounted assertion just to satisfy the type
// checker.

import { expect } from "vitest";

/** Asserts `value` is not `undefined`; `null` passes. */
export function assertDefined<T>(value: T, message?: string): asserts value is Exclude<T, undefined> {
	expect(value, message).not.toBeUndefined();
}

/** Asserts `value` is neither `null` nor `undefined`. */
export function assertPresent<T>(value: T, message?: string): asserts value is NonNullable<T> {
	expect(value, message).not.toBeNullable();
}

/**
 * Asserts `actual` is `expected` (`Object.is`) and narrows `actual` to that literal. Passed a
 * discriminant such as `entry.type`, it also narrows `entry` to the union members with that
 * discriminant, as an `entry.type === "..."` check would.
 */
export function assertEqual<T, const V extends T>(actual: T, expected: V, message?: string): asserts actual is V {
	expect(actual, message).toBe(expected);
}

/** Asserts `value` is an instance of `ctor`. */
export function assertInstanceOf<C extends abstract new (...args: never[]) => unknown>(
	value: unknown,
	ctor: C,
	message?: string,
): asserts value is InstanceType<C> {
	expect(value, message).toBeInstanceOf(ctor);
}
