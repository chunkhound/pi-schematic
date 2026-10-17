/**
 * Pure shell parsing utilities: tokenization, segment splitting,
 * command substitution extraction, and parenthesis matching.
 *
 * No domain dependencies — only types and low-level parsing.
 */

export type ShellPart = { text: string; operator: string; unsupported?: boolean };
export type ShellScan = { current: string; quote: string; escaped: boolean; nesting: number };

export function consumeShellCharacter(scan: ShellScan, ch: string, prefix: string = scan.current): boolean {
	if (scan.escaped) { scan.escaped = false; return true; }
	if (ch === "\\" && scan.quote !== "'") { scan.escaped = true; return true; }
	if (scan.quote) { if (ch === scan.quote) scan.quote = ""; return true; }
	if (ch === "'" || ch === '"') { scan.quote = ch; return true; }
	// Braces are reserved words only at command boundaries, not ordinary echo arguments.
	const boundary = /(?:^|[;|&\n])\s*$/.test(prefix);
	if (ch === "(" || (ch === "{" && boundary)) scan.nesting++;
	if ((ch === ")" || (ch === "}" && boundary)) && scan.nesting > 0) scan.nesting--;
	return scan.nesting !== 0;
}

function shellOperator(cmd: string, i: number, current: string): string {
	const ch = cmd[i], next = cmd[i + 1], prev = current.at(-1);
	if ((ch === "|" && prev === ">") || (ch === "&" && (prev === ">" || prev === "<" || next === ">"))) return "";
	if (ch === "|" && next === "&") return "|&";
	if ((ch === "&" || ch === "|") && next === ch) return ch + ch;
	return ";|&\n".includes(ch) ? ch : "";
}

export function splitUnquotedShellSegments(cmd: string): ShellPart[] {
	const segments: ShellPart[] = [];
	const scan: ShellScan = { current: "", quote: "", escaped: false, nesting: 0 };
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (!scan.quote && !scan.escaped && ch === "#" && (!scan.current || /\s/.test(scan.current.at(-1)!))) {
			while (i < cmd.length && cmd[i] !== "\n") i++;
			if (i === cmd.length) break;
		}
		const operator = consumeShellCharacter(scan, cmd[i]) ? "" : shellOperator(cmd, i, scan.current);
		if (!operator) { scan.current += cmd[i]; continue; }
		segments.push({ text: scan.current, operator });
		scan.current = "";
		i += operator.length - 1;
	}
	segments.push({ text: scan.current, operator: "", unsupported: scan.nesting !== 0 });
	return segments;
}

/** Index of the `)` matching the `(` at `start`, honoring quotes and escapes. */
export function matchingParenIndex(text: string, start: number): number {
	let depth = 0, quote = "", escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (escaped) { escaped = false; continue; }
		if (quote === "'") { if (ch === "'") quote = ""; continue; }
		if (quote === '"') { if (ch === "\\") { escaped = true; continue; } if (ch === '"') quote = ""; continue; }
		if (ch === "\\") { escaped = true; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return -1;
}

/** Index just past the `))` closing a `$((` expansion, or -1 when unterminated. */
export function findArithmeticEnd(line: string, start: number): number {
	let depth = 2;
	for (let i = start; i < line.length; i++) {
		if (line[i] === "(") depth++;
		else if (line[i] === ")" && --depth === 0) return i + 1;
	}
	return -1;
}

function regexCommandBodies(line: string, pattern: RegExp): string[] {
	return [...line.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean);
}

// `<(…)` bodies: the fd content an outer command reads. One pattern so the
// heredoc-output check and the substitution extractor agree on the boundary.
const PROCESS_SUBSTITUTION_PATTERN = /<\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/** Bodies of process substitutions `<(…)`. Unlike `$(…)`, the body is a stream, not a value. */
export function extractProcessSubstitutions(line: string): string[] {
	return regexCommandBodies(line, PROCESS_SUBSTITUTION_PATTERN);
}

/** Index just past the quote that closes the one at `start` (or line end if unterminated). */
function quotedEnd(line: string, start: number): number {
	if (start >= line.length) return start;
	const q = line[start];
	if (q !== "'" && q !== '"') return start;
	for (let i = start + 1; i < line.length; i++) {
		if (line[i] === '\\' && i + 1 < line.length) { i++; continue; }
		if (line[i] === q) return i + 1;
	}
	return line.length;
}

function dollarCommandEnd(line: string, start: number): number {
	let depth = 1;
	for (let i = start; i < line.length; i++) {
		if (line[i] === "'" || line[i] === '"') { i = quotedEnd(line, i) - 1; continue; }
		if (line[i] === '\\' && i + 1 < line.length) { i++; continue; }
		if (line[i] === "(") depth++;
		if (line[i] === ")" && --depth === 0) return i;
	}
	return line.length;
}

export function extractCommandSubstitutions(line: string): string[] {
	const commands = regexCommandBodies(line, /`([^`]*)`/g);
	commands.push(...extractProcessSubstitutions(line));
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		// Heredoc text is not shell-quoted; only backslash suppresses expansion.
		if (ch === "\\") { i++; continue; }
		// `$()` is active outside single quotes, including inside double quotes.
		if (line.slice(i, i + 2) !== "$(") continue;
		if (line[i + 2] === "(") {
			const end = findArithmeticEnd(line, i + 3);
			if (end !== -1) { commands.push(...extractCommandSubstitutions(line.slice(i + 3, end - 2))); i = end - 1; continue; }
		}
		const end = dollarCommandEnd(line, i + 2);
		const body = line.slice(i + 2, end).trim();
		if (body) commands.push(body);
		i = end;
	}
	return commands;
}
