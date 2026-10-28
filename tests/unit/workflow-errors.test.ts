import { expect, test } from "vitest";
import { messageOf, safeAppendEntry } from "../../workflow/errors.js";

test("messageOf returns Error.message for Error instances", () => {
	const error = new Error("boom");
	expect(messageOf(error)).toBe("boom");
});

test("messageOf stringifies non-Error values", () => {
	expect(messageOf("string")).toBe("string");
	expect(messageOf(42)).toBe("42");
	expect(messageOf(null)).toBe("null");
});

test("safeAppendEntry returns true on success", () => {
	const entries: { type: string; data?: unknown }[] = [];
	const pi = {
		appendEntry: (type: string, data?: unknown) => {
			entries.push({ type, data });
			return true;
		},
	} as any;
	expect(safeAppendEntry(pi, "test", { a: 1 })).toBe(true);
	expect(entries).toStrictEqual([{ type: "test", data: { a: 1 } }]);
});

test("safeAppendEntry returns false when append throws", () => {
	const pi = {
		appendEntry: () => {
			throw new Error("append failed");
		},
	} as any;
	expect(safeAppendEntry(pi, "test")).toBe(false);
});
