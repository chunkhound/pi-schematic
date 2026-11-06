import { expect, test } from "vitest";
import { decodeDisplayLabel, escapeDisplayLabel } from "../../model-groups/display.js";

const dangerous = [
	...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)),
	String.fromCharCode(0x7f),
	...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i)),
	"\u2028",
	"\u2029",
];

test("model-groups display codec reversibly escapes every controlled code point", () => {
	for (const raw of ["ordinary λ", "\\", ...dangerous, "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007"]) {
		const encoded = escapeDisplayLabel(raw);
		expect(decodeDisplayLabel(encoded)).toStrictEqual({ ok: true, value: raw });
		for (const codePoint of encoded) {
			const code = codePoint.codePointAt(0)!;
			expect(code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029, JSON.stringify({ raw, encoded })).toBe(false);
		}
	}
	expect(escapeDisplayLabel("\n\r\t\u0007\u001b\u007f\u0080\u009f\u2028\u2029\\")).toBe("\\n\\r\\t\\x07\\x1B\\x7F\\x80\\x9F\\u2028\\u2029\\\\");
});

test("model-groups display decoder rejects non-canonical, unknown, malformed, and incomplete escapes", () => {
	for (const encoded of ["\\q", "\\x", "\\x0", "\\x0g", "\\x1b", "\\x20", "\\u2027", "\\u202A", "trailing\\"]) {
		expect(decodeDisplayLabel(encoded).ok, encoded).toBe(false);
	}
});
