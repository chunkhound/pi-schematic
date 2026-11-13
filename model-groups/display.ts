export type DisplayDecodeResult = { ok: true; value: string } | { ok: false; message: string };

function hex(value: number): string {
	return value.toString(16).toUpperCase().padStart(2, "0");
}

export function escapeDisplayLabel(raw: string): string {
	let encoded = "";
	for (const char of raw) {
		const code = char.codePointAt(0)!;
		if (char === "\\") {encoded += "\\\\";}
		else if (char === "\n") {encoded += "\\n";}
		else if (char === "\r") {encoded += "\\r";}
		else if (char === "\t") {encoded += "\\t";}
		else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {encoded += `\\x${hex(code)}`;}
		else if (code === 0x2028 || code === 0x2029) {encoded += `\\u${code.toString(16).toUpperCase()}`;}
		else {encoded += char;}
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
		const escape = encoded[++index];
		if (escape === undefined) {return { ok: false, message: "Incomplete display escape" };}
		if (escape === "\\") {value += "\\";}
		else if (escape === "n") {value += "\n";}
		else if (escape === "r") {value += "\r";}
		else if (escape === "t") {value += "\t";}
		else if (escape === "x") {
			const digits = encoded.slice(index + 1, index + 3);
			if (!/^[0-9A-F]{2}$/.test(digits)) {return { ok: false, message: "Invalid or non-canonical \\xHH display escape" };}
			const code = Number.parseInt(digits, 16);
			if (!(code < 0x20 || (code >= 0x7f && code <= 0x9f)) || code === 0x09 || code === 0x0a || code === 0x0d) {
				return { ok: false, message: "Display escape does not encode a canonical control" };
			}
			value += String.fromCharCode(code);
			index += 2;
		} else if (escape === "u") {
			const digits = encoded.slice(index + 1, index + 5);
			if (digits !== "2028" && digits !== "2029") {return { ok: false, message: "Invalid canonical Unicode display escape" };}
			value += String.fromCharCode(Number.parseInt(digits, 16));
			index += 4;
		} else {return { ok: false, message: `Unknown display escape \\${escape}` };}
	}
	return { ok: true, value };
}
