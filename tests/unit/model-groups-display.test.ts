import { expect, test } from "vitest";
import { decodeDisplayLabel, escapeDisplayLabel } from "../../model-groups/display.js";

// Every C0 control, DEL, every C1 control and the two Unicode line separators, then three ordinary inputs. A controlled
// code point titles its row as U+XXXX, since the character itself does not print.
test.for<{ label: string; raw: string; encoded: string }>([
	{ label: "U+0000", raw: "\u0000", encoded: "\\x00" },
	{ label: "U+0001", raw: "\u0001", encoded: "\\x01" },
	{ label: "U+0002", raw: "\u0002", encoded: "\\x02" },
	{ label: "U+0003", raw: "\u0003", encoded: "\\x03" },
	{ label: "U+0004", raw: "\u0004", encoded: "\\x04" },
	{ label: "U+0005", raw: "\u0005", encoded: "\\x05" },
	{ label: "U+0006", raw: "\u0006", encoded: "\\x06" },
	{ label: "U+0007", raw: "\u0007", encoded: "\\x07" },
	{ label: "U+0008", raw: "\u0008", encoded: "\\x08" },
	{ label: "U+0009", raw: "\u0009", encoded: "\\t" },
	{ label: "U+000A", raw: "\u000A", encoded: "\\n" },
	{ label: "U+000B", raw: "\u000B", encoded: "\\x0B" },
	{ label: "U+000C", raw: "\u000C", encoded: "\\x0C" },
	{ label: "U+000D", raw: "\u000D", encoded: "\\r" },
	{ label: "U+000E", raw: "\u000E", encoded: "\\x0E" },
	{ label: "U+000F", raw: "\u000F", encoded: "\\x0F" },
	{ label: "U+0010", raw: "\u0010", encoded: "\\x10" },
	{ label: "U+0011", raw: "\u0011", encoded: "\\x11" },
	{ label: "U+0012", raw: "\u0012", encoded: "\\x12" },
	{ label: "U+0013", raw: "\u0013", encoded: "\\x13" },
	{ label: "U+0014", raw: "\u0014", encoded: "\\x14" },
	{ label: "U+0015", raw: "\u0015", encoded: "\\x15" },
	{ label: "U+0016", raw: "\u0016", encoded: "\\x16" },
	{ label: "U+0017", raw: "\u0017", encoded: "\\x17" },
	{ label: "U+0018", raw: "\u0018", encoded: "\\x18" },
	{ label: "U+0019", raw: "\u0019", encoded: "\\x19" },
	{ label: "U+001A", raw: "\u001A", encoded: "\\x1A" },
	{ label: "U+001B", raw: "\u001B", encoded: "\\x1B" },
	{ label: "U+001C", raw: "\u001C", encoded: "\\x1C" },
	{ label: "U+001D", raw: "\u001D", encoded: "\\x1D" },
	{ label: "U+001E", raw: "\u001E", encoded: "\\x1E" },
	{ label: "U+001F", raw: "\u001F", encoded: "\\x1F" },
	{ label: "U+007F", raw: "\u007F", encoded: "\\x7F" },
	{ label: "U+0080", raw: "\u0080", encoded: "\\x80" },
	{ label: "U+0081", raw: "\u0081", encoded: "\\x81" },
	{ label: "U+0082", raw: "\u0082", encoded: "\\x82" },
	{ label: "U+0083", raw: "\u0083", encoded: "\\x83" },
	{ label: "U+0084", raw: "\u0084", encoded: "\\x84" },
	{ label: "U+0085", raw: "\u0085", encoded: "\\x85" },
	{ label: "U+0086", raw: "\u0086", encoded: "\\x86" },
	{ label: "U+0087", raw: "\u0087", encoded: "\\x87" },
	{ label: "U+0088", raw: "\u0088", encoded: "\\x88" },
	{ label: "U+0089", raw: "\u0089", encoded: "\\x89" },
	{ label: "U+008A", raw: "\u008A", encoded: "\\x8A" },
	{ label: "U+008B", raw: "\u008B", encoded: "\\x8B" },
	{ label: "U+008C", raw: "\u008C", encoded: "\\x8C" },
	{ label: "U+008D", raw: "\u008D", encoded: "\\x8D" },
	{ label: "U+008E", raw: "\u008E", encoded: "\\x8E" },
	{ label: "U+008F", raw: "\u008F", encoded: "\\x8F" },
	{ label: "U+0090", raw: "\u0090", encoded: "\\x90" },
	{ label: "U+0091", raw: "\u0091", encoded: "\\x91" },
	{ label: "U+0092", raw: "\u0092", encoded: "\\x92" },
	{ label: "U+0093", raw: "\u0093", encoded: "\\x93" },
	{ label: "U+0094", raw: "\u0094", encoded: "\\x94" },
	{ label: "U+0095", raw: "\u0095", encoded: "\\x95" },
	{ label: "U+0096", raw: "\u0096", encoded: "\\x96" },
	{ label: "U+0097", raw: "\u0097", encoded: "\\x97" },
	{ label: "U+0098", raw: "\u0098", encoded: "\\x98" },
	{ label: "U+0099", raw: "\u0099", encoded: "\\x99" },
	{ label: "U+009A", raw: "\u009A", encoded: "\\x9A" },
	{ label: "U+009B", raw: "\u009B", encoded: "\\x9B" },
	{ label: "U+009C", raw: "\u009C", encoded: "\\x9C" },
	{ label: "U+009D", raw: "\u009D", encoded: "\\x9D" },
	{ label: "U+009E", raw: "\u009E", encoded: "\\x9E" },
	{ label: "U+009F", raw: "\u009F", encoded: "\\x9F" },
	{ label: "U+2028", raw: "\u2028", encoded: "\\u2028" },
	{ label: "U+2029", raw: "\u2029", encoded: "\\u2029" },
	{ label: '"ordinary λ"', raw: "ordinary λ", encoded: "ordinary λ" },
	{ label: '"\\\\"', raw: "\\", encoded: "\\\\" },
	{
		label: '"\\u001b]8;;https://example.test\\u0007link\\u001b]8;;\\u0007"',
		raw: "\u001B]8;;https://example.test\u0007link\u001B]8;;\u0007",
		encoded: "\\x1B]8;;https://example.test\\x07link\\x1B]8;;\\x07",
	},
])("model-groups display codec reversibly escapes every controlled code point: $label", ({ raw, encoded }) => {
	expect(escapeDisplayLabel(raw)).toBe(encoded);
	expect(decodeDisplayLabel(encoded)).toStrictEqual({ ok: true, value: raw });
});

test("model-groups display codec writes the canonical escape for each controlled code point", () => {
	expect(escapeDisplayLabel("\n\r\t\u0007\u001b\u007f\u0080\u009f\u2028\u2029\\")).toBe("\\n\\r\\t\\x07\\x1B\\x7F\\x80\\x9F\\u2028\\u2029\\\\");
});

test.each(["\\q", "\\x", "\\x0", "\\x0g", "\\x1b", "\\x20", "\\u2027", "\\u202A", "trailing\\", "\\x09", "\\x0A", "\\x0D"])(
	"model-groups display decoder rejects non-canonical, unknown, malformed, and incomplete escapes: %s",
	(encoded) => {
		expect(decodeDisplayLabel(encoded).ok).toBe(false);
	},
);
