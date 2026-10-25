// Narrowing assertions for Vitest tests. Each helper makes exactly one counted `expect(...)` with
// the most specific matcher for its check, and its `asserts` signature narrows the argument for
// the code after the call, so a test needs no second, uncounted assertion just to satisfy the type
// checker.

import { expect } from "vitest";

/** Asserts `value` is neither `null` nor `undefined`. */
export function assertPresent<T>(value: T, message?: string): asserts value is NonNullable<T> {
	expect(value, message).not.toBeNullable();
}
