export type DisplayDecodeResult = { ok: true; value: string } | { ok: false; message: string };

/** C0/C1 control bytes; every codec and sanitizer shares this single test. */
export function isControlCodePoint(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Unicode format controls that spoof or hide text: bidi overrides/embeddings/isolates
 * and zero-width characters. They are invisible or reorder neighbors, so any surface
 * that prints external diagnostic text must escape or drop them.
 */
const BIDI_OR_ZERO_WIDTH = new Set([
	0x200b,
	0x200c,
	0x200d, // zero-width space / non-joiner / joiner
	0x202a,
	0x202b,
	0x202c,
	0x202d,
	0x202e, // bidi embedding / override / pop
	0x2066,
	0x2067,
	0x2068,
	0x2069, // bidi isolate
	0xfeff, // zero-width no-break space / BOM
]);

export function isBidiOrZeroWidth(code: number): boolean {
	return BIDI_OR_ZERO_WIDTH.has(code);
}

/** Drop C0/C1 and bidi/zero-width characters; the single stripper for diagnostic text and spend keys. */
export function stripUnsafeDisplayChars(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0);
		if (code !== undefined && !isControlCodePoint(code) && !isBidiOrZeroWidth(code)) {
			out += ch;
		}
	}
	return out;
}

function hex(value: number): string {
	return value.toString(16).toUpperCase().padStart(2, "0");
}

export function escapeDisplayLabel(raw: string): string {
	let encoded = "";
	for (const char of raw) {
		const code = char.codePointAt(0);
		if (code === undefined) {
			throw new Error("String iteration yielded an empty character.");
		}
		if (char === "\\") {
			encoded += "\\\\";
		} else if (char === "\n") {
			encoded += "\\n";
		} else if (char === "\r") {
			encoded += "\\r";
		} else if (char === "\t") {
			encoded += "\\t";
		} else if (isControlCodePoint(code)) {
			encoded += `\\x${hex(code)}`;
		} else if (code === 0x2028 || code === 0x2029 || isBidiOrZeroWidth(code)) {
			encoded += `\\u${code.toString(16).toUpperCase()}`;
		} else {
			encoded += char;
		}
	}
	return encoded;
}

export function decodeDisplayLabel(encoded: string): DisplayDecodeResult {
	let value = "";
	for (let index = 0; index < encoded.length; index++) {
		const char = encoded[index];
		if (char !== "\\") {
			value += char;
			continue;
		}
		const escape = encoded.at(++index);
		if (escape === undefined) {
			return { ok: false, message: "Incomplete display escape" };
		}
		if (escape === "\\") {
			value += "\\";
		} else if (escape === "n") {
			value += "\n";
		} else if (escape === "r") {
			value += "\r";
		} else if (escape === "t") {
			value += "\t";
		} else if (escape === "x") {
			const digits = encoded.slice(index + 1, index + 3);
			if (!/^[0-9A-F]{2}$/.test(digits)) {
				return { ok: false, message: "Invalid or non-canonical \\xHH display escape" };
			}
			const code = Number.parseInt(digits, 16);
			if (!(code < 0x20 || (code >= 0x7f && code <= 0x9f)) || code === 0x09 || code === 0x0a || code === 0x0d) {
				return { ok: false, message: "Display escape does not encode a canonical control" };
			}
			value += String.fromCharCode(code);
			index += 2;
		} else if (escape === "u") {
			const digits = encoded.slice(index + 1, index + 5);
			const code = Number.parseInt(digits, 16);
			if (!(code === 0x2028 || code === 0x2029 || isBidiOrZeroWidth(code))) {
				return { ok: false, message: "Invalid canonical Unicode display escape" };
			}
			value += String.fromCharCode(code);
			index += 4;
		} else {
			return { ok: false, message: `Unknown display escape \\${escape}` };
		}
	}
	return { ok: true, value };
}
