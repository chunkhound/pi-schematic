/**
 * Invariant tests for reviewed declarations that CI and the repository must agree
 * on: the audit-ci allowlist policy, the pinned Pi and typebox versions with
 * lockfile parity, the single Node floor, the repository-wide LF rule, the
 * documented floors, and the CI matrix and step order.
 *
 * Each fact has one source. A second claim fails the suite.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseDocument } from "yaml";
import { REPO_ROOT, REPO_ROOT_URL } from "../paths.js";

type AuditRecord = {
	active: boolean;
	expiry: string;
	notes: string;
};

type AuditConfig = {
	$schema: string;
	moderate: boolean;
	allowlist: Array<Record<string, AuditRecord>>;
};

type PackageJson = {
	version: string;
	engines: { node: string };
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};

const AUDIT_SCHEMA = "https://github.com/IBM/audit-ci/raw/main/docs/schema.json";
const AUDIT_CONFIG_PATH = new URL("audit-ci.jsonc", REPO_ROOT_URL);
const PACKAGE_JSON_PATH = new URL("package.json", REPO_ROOT_URL);
const WORKFLOW_PATH = new URL(".github/workflows/test.yml", REPO_ROOT_URL);
const LOCK_PATH = new URL("package-lock.json", REPO_ROOT_URL);
const README_PATH = new URL("README.md", REPO_ROOT_URL);
const CONTRIBUTING_PATH = new URL("CONTRIBUTING.md", REPO_ROOT_URL);
const GITATTRIBUTES_PATH = new URL(".gitattributes", REPO_ROOT_URL);
// Pinned versions verified against package.json + lockfile.
// Update when Pi devDependencies are bumped.
const PINNED_PI_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;
const EXPECTED_PI_VERSION = "1.0.4";
const EXPECTED_TYPEBOX_VERSION = "1.3.27";
// Floor for CI, engines, and the matrix. Bump only with the workflow and README.
const EXPECTED_NODE_FLOOR = "22.19.0";
// Approved peer floors — must track the pinned devDependency versions above.
const EXPECTED_PI_PEER = `>=${EXPECTED_PI_VERSION}`;
const EXPECTED_TYPEBOX_PEER = `>=${EXPECTED_TYPEBOX_VERSION}`;
const EXPECTED_MATRIX = new Set([
	`ubuntu-latest@${EXPECTED_NODE_FLOOR}`,
	"ubuntu-latest@24",
	"macos-latest@24",
	"windows-latest@24",
]);
// Transitive undici advisories in the pinned test host
// @earendil-works/pi-coding-agent@1.0.4 (devDependency). Remove an entry when a
// pinned host ships a patched version; the expiry forces periodic re-review.
const EXPECTED_ALLOWLIST_KEYS = new Set<string>([
	"GHSA-xjj6-f33q-929c",
	"GHSA-4qv8-2p9j-2685",
	"GHSA-f72v-6w45-q472",
	"GHSA-2m5v-pch6-74hx",
	"GHSA-4w7w-5xrc-9h26",
	"GHSA-55wc-3pg8-jfw6",
	"GHSA-9fm3-97px-rjf6",
	"GHSA-qrxm-fqhp-jwvm",
	"GHSA-g3hv-75wg-m249",
]);

function readText(url: URL): string {
	return readFileSync(url, "utf8");
}

function parseAuditConfig(): AuditConfig {
	const lines = readText(AUDIT_CONFIG_PATH)
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"));
	return JSON.parse(lines.join("\n")) as AuditConfig;
}

function parsePackageJson(): PackageJson {
	return JSON.parse(readText(PACKAGE_JSON_PATH)) as PackageJson;
}

function parseMatrixEntries(workflow: string): Set<string> {
	const entries = workflow.matchAll(/- os: ([^\n]+)\n\s+node-version: "([^"]+)"/g);
	return new Set(Array.from(entries, ([, os, node]) => `${os.trim()}@${node}`));
}

function stepIndex(workflow: string, step: string): number {
	const index = workflow.indexOf(`- name: ${step}`);
	assert.notEqual(index, -1, `missing workflow step: ${step}`);
	return index;
}

function stepBlock(workflow: string, step: string): string {
	const start = stepIndex(workflow, step);
	const afterName = workflow.indexOf("\n", start) + 1;
	const nextStep = workflow.indexOf("\n      - name:", afterName);
	const end = nextStep === -1 ? workflow.length : nextStep;
	return workflow.slice(afterName, end);
}

function allowlistEntries(config: AuditConfig): Array<[string, AuditRecord]> {
	return config.allowlist.map((entry) => {
		const [key, value] = Object.entries(entry)[0] ?? [];
		assert.ok(key, "allowlist entry must define exactly one scoped advisory path");
		assert.ok(value, `missing metadata for allowlist entry: ${key}`);
		return [key, value];
	});
}

function minimumNodeVersion(value: string): string {
	const match = value.match(/^>=(?<version>\d+\.\d+\.\d+)$/);
	assert.ok(match?.groups?.version, `unsupported engines.node format: ${value}`);
	return match.groups.version;
}

// WHY: the AST walker reads keys; this line regex only fixes the root env line contract.
const ROOT_NODE_FLOOR = /^\s*NODE_FLOOR: "(?<floor>\d+\.\d+\.\d+)"$/;
// WHY: `==` compares, it does not assign; both readers below must share that rule.
const FLOOR_ASSIGN = String.raw`NODE_FLOOR\s*=(?!=)`;
const NODE_FLOOR_ASSIGN = new RegExp(String.raw`\b${FLOOR_ASSIGN}`);
// WHY: an aliased floor exported to an output file is still a second source; only executed text counts.
const OUTPUT_ASSIGNMENT = /(?<key>[A-Za-z_][\w-]*)\s*=\s*["']?(?<value>v?\d+(?:\.\d+)*)["']?/g;
// WHY: only an output key naming the floor itself is a second source; metadata keys such as
// node_count or release_version stay inert even when their value looks like a version.
const FLOOR_ALIAS = /^(?:node[_-]?)?floor(?:[_-]?version)?$/i;
// WHY: prose keys may print a floor literal; only text outside matching quotes is an
// executed assignment. The scan tracks the active quote kind, so an apostrophe inside a
// double-quoted diagnostic cannot reopen it; shell and expression readers share it.
const scanOutsideQuotes = (line: string, onChar: (char: string, index: number) => boolean | void): void => {
	let quote = "";
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quote !== "" && char === "\\") index += 1;
		else if (quote === "" && (char === '"' || char === "'")) quote = char;
		else if (char === quote) quote = "";
		else if (quote === "" && onChar(char, index)) return;
	}
};
// WHY: the AST walker reconstructs only canonical `run: <body>` lines, so one spelling
// covers every YAML key form. A quoted `#` in the body stays content, not a comment.
const RUN_KEY = /^(?:-\s*)?run\s*:/;
const OUTPUT_FILE_TARGET = /\$\{?(?:env:)?GITHUB_(?:ENV|OUTPUT)\}?(?!\w)/;
// WHY: only an unquoted redirect operator followed by the env/output file executes a
// write; a quoted mention in a diagnostic or a step name is inert.
const REDIRECT_TARGET = new RegExp(String.raw`^>>?\s*["']?${OUTPUT_FILE_TARGET.source}`);
const outputRedirect = (line: string): boolean => {
	let found = false;
	scanOutsideQuotes(line, (char, index) => (found ||= char === ">" && REDIRECT_TARGET.test(line.slice(index))));
	return found;
};
// WHY: inside an env.NODE_FLOOR operand every integer is a floor claim, bare or v-prefixed,
// quoted or dotted; counters such as `github.run_number > 1` live in sibling operands, which
// nodeFloorOperands drops, so this pattern must never run on a full line. A digit run inside
// an identifier (`vars.NODE_24`) references a value; only a literal token starts a floor claim.
const FLOOR_OPERAND_LITERAL = /(?<!\w)(?:\d+\.\d+|["']?v?\d+["']?)/;
// WHY: PowerShell prints diagnostics through cmdlets, and Windows runs these steps in PowerShell.
const PRINT_COMMANDS = new Set(["echo", "printf", "write-host", "write-output"]);
const NODE_VERSION_KEY = /(?:^|[{,]\s*)["']?node-version["']?\s*:\s*(?:\$\{\{\s*)?["']?(?<operator>[~^]|[<>]=?)?\s*v?(?<version>\d+(?:\.\d+)*)/g;
// WHY: an expression value may choose between alternatives; a guard counter such as
// `github.run_number > 24` owns its number and must not be read as a version.
const NODE_VERSION_EXPRESSION_START = /\bnode-version\s*:\s*\$\{\{/g;
// WHY: a quoted `}` such as format('{0}', ...) is content, so the body ends only at the
// first `}}` outside quotes; a `[^}]*` capture would truncate there and hide a stale pin.
const expressionBody = (line: string, start: number): string | undefined => {
	let end = -1;
	scanOutsideQuotes(line.slice(start), (char, index) => {
		if (char !== "}" || line[start + index + 1] !== "}") return false;
		end = start + index;
		return true;
	});
	return end === -1 ? undefined : line.slice(start, end);
};
const expressionBodies = (line: string): string[] =>
	Array.from(line.matchAll(NODE_VERSION_EXPRESSION_START), (match) => expressionBody(line, (match.index ?? 0) + match[0].length))
		.filter((body): body is string => body !== undefined);
// WHY: Actions evaluates `${{ }}` before the shell, so a prose run scalar can still pin the
// floor through an expression. Mask each span with a control-char token (illegal in YAML, so
// it cannot collide with command text) so separators inside the expression fake no segment.
const EXPRESSION_START = /\$\{\{/g;
const EXPRESSION_PLACEHOLDER = /\u0000(\d+)\u0000/g;
const maskExpressionSpans = (line: string): { masked: string; bodies: string[] } => {
	const parts: string[] = [];
	const bodies: string[] = [];
	let cursor = 0;
	for (const match of line.matchAll(EXPRESSION_START)) {
		const start = match.index ?? 0;
		const body = expressionBody(line, start + match[0].length);
		if (body === undefined) continue;
		parts.push(line.slice(cursor, start), `\u0000${bodies.length}\u0000`);
		bodies.push(body);
		cursor = start + match[0].length + body.length + 2;
	}
	parts.push(line.slice(cursor));
	return { masked: parts.join(""), bodies };
};
const GUARD_COMPARISON = /[\w.]+\s*(?:>=|<=|==|!=|>|<)\s*["']?v?\d/;
const isGuardOperand = (operand: string): boolean => !operand.includes("node-version") && GUARD_COMPARISON.test(operand);
// WHY: separators inside quotes are content, and dropped empties stop a run of `&&` from
// faking a segment; expressions and shell commands share this one splitter.
const splitOutsideQuotes = (text: string, separators: string): string[] => {
	const parts: string[] = [];
	let start = 0;
	scanOutsideQuotes(text, (char, index) => {
		if (!separators.includes(char)) return;
		parts.push(text.slice(start, index));
		start = index + 1;
	});
	parts.push(text.slice(start));
	return parts.filter((part) => part.trim() !== "");
};
const NODE_VERSION_COMPARISON = /\bnode-version\s*(?:>=|<=|==|!=|>|<)\s*["']?(?<operator>[~^]|[<>]=?)?\s*v?(?<version>\d+(?:\.\d+)*)/g;
// WHY: a stale literal may sit on either side of the operator; both orders compare node-version.
const NODE_VERSION_REVERSED_COMPARISON = /["']?v?(?<version>\d+(?:\.\d+)*)["']?\s*(?:>=|<=|==|!=|>|<)\s*[\w.]*?node-version/g;
// WHY: a version argument is quoted and follows node-version in the same call, as in
// startsWith(matrix.node-version, '22.18.0'); a bare number elsewhere is unrelated.
const NODE_VERSION_ARGUMENT = /\bnode-version\b[^(),]*,\s*["']v?(?<version>\d+(?:\.\d+)*)["']/g;
// WHY: bracket access reads the same value, so one spelling keeps both comparison orders valid.
const BRACKET_NODE_VERSION = /\[\s*["']node-version["']\s*\]/g;
const normalizeNodeVersionAccess = (line: string): string => line.replace(BRACKET_NODE_VERSION, ".node-version");
// WHY: bracket access reads the same env value, so normalizing it keeps every dot-form
// operand and condition check valid for both spellings.
const BRACKET_NODE_FLOOR = /\[\s*["']NODE_FLOOR["']\s*\]/g;
const normalizeFloorAccess = (line: string): string => line.replace(BRACKET_NODE_FLOOR, ".NODE_FLOOR");
// WHY: aliases such as `lts/hydrogen` pin Node 18 with no digits, so silence fails open;
// runtime expressions and context references resolve elsewhere, and `''` tests only presence.
const NODE_VERSION_VALUE = /\bnode-version\b(?!-)['"]?\s*(?::|==|!=|>=|<=|>|<)\s*(?<value>[^\s,)\]}]+)/g;
const RESOLVED_VALUE = /^(?:$|\$\{\{|[<>=!~^]*v?\d)/;
const VALUE_SOURCE = /^(?:env|matrix|steps|needs|inputs|vars|secrets|github)\b/;
// WHY: a call such as format('{0}', '24') computes a version, so it is not an unresolved alias;
// its quoted arguments stay visible to the literal checks below.
const EXPRESSION_CALL = /^[\w.]+\s*\(/;
const unresolvedNodeVersionClaim = (line: string): boolean =>
	Array.from(line.matchAll(NODE_VERSION_VALUE), (match) => (match.groups?.value ?? "").replace(/^["']|["']$/g, ""))
		.some((value) => !RESOLVED_VALUE.test(value) && !VALUE_SOURCE.test(value) && !EXPRESSION_CALL.test(value));

// WHY: NODE_VERSION_ARGUMENT misses a list passed before node-version; brackets hold its literals.
const QUOTED_VERSION = /["']v?(?<version>\d+(?:\.\d+)*)["']/g;
const NODE_VERSION_LIST = /\[[^\]]*\]/g;
// WHY: a computed operand may hold the floor as a quoted call argument; above-floor values stay allowed.
const NODE_VERSION_CALL = /\bnode-version\s*(?:==|!=|>=|<=|>|<)\s*[\w.]+\s*\((?<args>[^)]*)\)/g;
const PROSE_KEYS = /^(?:-\s*)?(?:run|name|description)\s*:/;

function workflowNodeFloor(workflow: string): string {
	const floor = workflow.split("\n").find((line) => ROOT_NODE_FLOOR.test(line))?.match(ROOT_NODE_FLOOR)?.groups?.floor;
	assert.ok(floor, "workflow env must define NODE_FLOOR");
	return floor;
}

// WHY: only the root env.NODE_FLOOR and matrix entries may pin the floor. Any other
// NODE_FLOOR key is a second source, whatever its value shape, because the step conditions
// read env.NODE_FLOOR. Step pins are claims when they are below the floor, share its major,
// or pin a full version. The YAML parser supplies keys, decoded scalars, and alias
// resolution; the shell and expression scanners below judge each run/if scalar.
type ScalarClaim = { kind: "floor" } | { kind: "run" | "if" | "node-version"; value: string };

// WHY: a matrix include entry is the only allowed node-version path; a broader match would
// hide a step-level pin under a matrix-shaped key.
const isMatrixNodeVersion = (path: string[]): boolean =>
	path.length === 7 &&
	path[0] === "jobs" &&
	path[2] === "strategy" &&
	path[3] === "matrix" &&
	path[4] === "include" &&
	/^\d+$/.test(path[5]) &&
	path[6] === "node-version";
// WHY: the root env line is the one floor source; any other path is a second source.
const isRootFloor = (path: string[]): boolean => path.length === 2 && path[0] === "env" && path[1] === "NODE_FLOOR";

// WHY: toJS resolves anchors and aliases, so an alias of the floor block is a claim at its
// own path; stringify non-string scalars so an unquoted `node-version: 24` still reads "24".
function collectScalarClaims(node: unknown, path: string[], claims: ScalarClaim[]): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) => collectScalarClaims(item, [...path, String(index)], claims));
		return;
	}
	if (node === null || typeof node !== "object") return;
	for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
		const childPath = [...path, key];
		if (key === "NODE_FLOOR" && !isRootFloor(childPath)) claims.push({ kind: "floor" });
		else if (key === "node-version" && !isMatrixNodeVersion(childPath)) claims.push({ kind: "node-version", value: String(child) });
		else if (key === "run" || key === "if") claims.push({ kind: key, value: String(child) });
		collectScalarClaims(child, childPath, claims);
	}
}

function scalarClaims(workflow: string): ScalarClaim[] {
	const document = parseDocument(workflow);
	assert.deepEqual(document.errors.map((error) => error.message), [], "workflow must parse as YAML");
	const claims: ScalarClaim[] = [];
	collectScalarClaims(document.toJS(), [], claims);
	return claims;
}

// WHY: a literal run body keeps one command per line. A trailing backslash continues the
// command and a `} >> target` redirects the whole brace group above; a standalone redirect
// line is its own no-op command, so it must not inherit the diagnostic above.
const BRACE_REDIRECT_LINE = new RegExp(String.raw`^}\s*>>?\s*["']?${OUTPUT_FILE_TARGET.source}`);
const BRACE_OPEN = /^\s*\{\s*$/;
// WHY: every command in a redirected group writes the target, so the group folds into one line.
const foldBraceGroup = (lines: string[], redirect: string): void => {
	let from = lines.length - 1;
	while (from >= 0 && !BRACE_OPEN.test(lines[from])) from -= 1;
	if (from < 0) from = lines.length - 1;
	if (from >= 0) lines.splice(from, lines.length - from, `${lines.slice(from).join(" ")} ${redirect}`);
};
const joinRunBody = (body: string[]): string[] => {
	const lines: string[] = [];
	for (const line of body) {
		const previous = lines.at(-1)?.trimEnd();
		if (previous?.endsWith("\\")) lines[lines.length - 1] = `${previous.replace(/\\$/, "")} ${line.trim()}`;
		else if (BRACE_REDIRECT_LINE.test(line.trim())) foldBraceGroup(lines, line.trim());
		else lines.push(line);
	}
	return lines;
};

// WHY: one claim may produce several violations, because one scalar can hold several literals.
function claimViolations(claim: ScalarClaim, floor: string): string[] {
	if (claim.kind === "floor") return ["NODE_FLOOR: second source"];
	if (claim.kind === "run") {
		return joinRunBody(claim.value.split("\n"))
			.filter((line) => claimsFloor(`run: ${line}`, floor))
			.map((line) => `run: ${line}`);
	}
	const value = claim.kind === "if" ? claim.value.replace(/\s*\n\s*/g, " ").trim() : claim.value;
	const line = `${claim.kind}: ${value}`;
	return claimsFloor(line, floor) ? [line] : [];
}

function floorLiteralViolations(workflow: string, floor: string): string[] {
	return scalarClaims(workflow).flatMap((claim) => claimViolations(claim, floor));
}

// WHY: a printer still runs its `$(...)`/backtick body, so command-position text inside it
// executes. An escaped or single-quoted substitution prints instead, so mask those spans
// first; an apostrophe inside a double-quoted string is content, not a quote region.
const EXECUTABLE_SUBSTITUTION = /(?<!\\)`([^`]*)`|(?<!\\)\$\(([^()]*)\)/g;
const maskSingleQuotes = (command: string): string => {
	let masked = "", quote = "";
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (char === "\\" && quote !== "'") { masked += command.slice(index, index + 2); index += 1; continue; }
		if (char === quote) quote = "";
		else if (quote === "" && (char === "'" || char === '"')) quote = char;
		masked += quote === "'" ? " " : char;
	}
	return masked;
};
const substitutionAssignment = (command: string): boolean =>
	Array.from(maskSingleQuotes(command).matchAll(EXECUTABLE_SUBSTITUTION), ([, backtick, paren]) => backtick ?? paren ?? "")
		.some((body) => shellSegments(body).some(segmentAssignsFloor));

// WHY: `echo "a; b"` is one printer call; splitting on a quoted separator would fake a
// second command and turn a printed diagnostic into an executed write. A separator run
// yields empty segments, which the splitter drops so no phantom command appears.
const shellSegments = (command: string): string[] => splitOutsideQuotes(command, ";|&");
const isPrinter = (segment: string): boolean => PRINT_COMMANDS.has((segment.trim().split(/\s+/)[0] ?? "").toLowerCase());
const carriesRedirect = (segment: string): boolean => outputRedirect(segment);
// WHY: a printer only executes its substitution body or an env/output write; every other
// segment runs a real command, whatever the shell quotes around it (bash -c "...").
const executedSegments = (line: string): string[] =>
	RUN_KEY.test(line)
		? shellSegments(line.replace(RUN_KEY, "")).filter((segment) => !isPrinter(segment) || carriesRedirect(segment) || substitutionAssignment(segment))
		: [];

// WHY: Actions still evaluates `${{ }}` in a prose run scalar, but a printer argument only
// prints, so only spans in a non-printer segment are live.
const liveExpressionBodies = (line: string): string[] => {
	const { masked, bodies } = maskExpressionSpans(line.replace(RUN_KEY, ""));
	return shellSegments(masked).filter((segment) => !isPrinter(segment))
		.flatMap((segment) => Array.from(segment.matchAll(EXPRESSION_PLACEHOLDER), (match) => bodies[Number(match[1])]))
		.filter((body): body is string => body !== undefined);
};
const liveExpressionClaims = (line: string, floor: string): boolean =>
	liveExpressionBodies(line).some((body) => {
		const operands = splitOutsideQuotes(normalizeFloorAccess(normalizeNodeVersionAccess(body)), ";|&");
		const floorOperand = operands.some((operand) => /\benv\.NODE_FLOOR\b/.test(operand) && FLOOR_OPERAND_LITERAL.test(operand));
		const literals = operands.filter((operand) => !isGuardOperand(operand))
			.flatMap((operand) => Array.from(operand.matchAll(QUOTED_VERSION), (match) => match.groups?.version ?? ""));
		return floorOperand || literals.some((version) => isFloorClaim(version, floor));
	});
const ASSIGNMENT_PREFIXES = new Set(["env", "export", "declare", "readonly", "local", "typeset", "sudo", "time", "nohup", "exec", "command", "builtin"]);
const ASSIGNMENT_WORD = /^(?:\$env:)?NODE_FLOOR\s*=(?!=)/;
// WHY: an assignment pins the floor only at command position; a command argument such as
// `node -e 'NODE_FLOOR=22'` or `npm test -- --grep NODE_FLOOR=22` merely carries the text.
// Walk generic NAME=value words, options, and wrapper prefixes to the command word.
const GENERIC_ASSIGNMENT = /^(?:\$env:)?[A-Za-z_]\w*=(?!=)/;
const leadingAssignment = (segment: string): boolean => {
	let rest = segment.trim();
	for (;;) {
		if (ASSIGNMENT_WORD.test(rest)) return true;
		const word = rest.match(/^\S+/)?.[0];
		if (word === undefined) return false;
		const consumes = GENERIC_ASSIGNMENT.test(word) || word.startsWith("-") || ASSIGNMENT_PREFIXES.has(word.toLowerCase());
		if (!consumes) return false;
		rest = rest.slice(word.length).trimStart();
	}
};
// WHY: `bash -c`, `bash -lc`, and `eval "..."` execute their body, so it recurses through
// the same segment checks; a body that only prints stays inert. Combined and separate
// options containing `c` both execute, so leading options are consumed first.
const SHELL_BODY = /^(?:(?:sh|bash|zsh|ksh|dash)(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c[A-Za-z]*|eval)\s+(?<rest>.+)$/;
const unquoteFirst = (text: string): string => {
	const trimmed = text.trim();
	const single = trimmed.match(/^'(?<body>[^']*)'/);
	if (single?.groups?.body !== undefined) return single.groups.body;
	const double = trimmed.match(/^"(?<body>(?:[^"\\]|\\.)*)"/);
	return double?.groups?.body?.replace(/\\(["\\])/g, "$1") ?? trimmed;
};
const shellBodyAssignsFloor = (segment: string): boolean => {
	const body = segment.trim().match(SHELL_BODY)?.groups?.rest;
	return body !== undefined && shellSegments(unquoteFirst(body)).some(segmentAssignsFloor);
};
// WHY: a printer with a redirect exports what it writes, so the whole segment counts; a real
// command pins the floor only through command-position text, an explicit shell body, or an
// executed substitution.
const segmentAssignsFloor = (segment: string): boolean => {
	if (isPrinter(segment)) return carriesRedirect(segment) ? NODE_FLOOR_ASSIGN.test(segment) : substitutionAssignment(segment);
	return leadingAssignment(segment) || shellBodyAssignsFloor(segment) || substitutionAssignment(segment);
};
const isAssignment = (line: string, prose: boolean): boolean =>
	NODE_FLOOR_ASSIGN.test(line) && (!prose || executedSegments(line).some(segmentAssignsFloor));
// WHY: a redirect exports the assignments its own command writes, so only segments that
// carry the redirect are scanned; isFloorClaim keeps above-floor majors allowed.
const outputFloorClaim = (line: string, floor: string): boolean =>
	RUN_KEY.test(line) && shellSegments(line.replace(RUN_KEY, "")).some((segment) =>
		carriesRedirect(segment) && Array.from(segment.matchAll(OUTPUT_ASSIGNMENT), (match) => [match.groups?.key ?? "", match.groups?.value ?? ""]).some(([key, value]) => FLOOR_ALIAS.test(key) && isFloorClaim(value.replace(/^v/, ""), floor)));

// WHY: only operands that name env.NODE_FLOOR compare it to a floor; their literals are
// claims, while a sibling operand's literal belongs to another expression (an OS label).
// Node-version literals in any operand are checked separately by versionLiterals.
const operands = (line: string): string[] => line.split(/\s*(?:&&|\|\|)\s*/);
const nodeFloorOperands = (line: string): string[] => operands(line).filter((operand) => /\benv\.NODE_FLOOR\b/.test(operand));
// WHY: list literals in a node-version operand claim; sibling OS labels and counters stay inert.
const nodeVersionListLiterals = (line: string): string[] =>
	operands(line).filter((operand) => /\bnode-version\b/.test(operand)).flatMap((operand) =>
		Array.from(operand.matchAll(NODE_VERSION_LIST), ([list]) => Array.from(list.matchAll(QUOTED_VERSION), (match) => match.groups?.version ?? "")),
	).flat();

// WHY: one line can name several versions; one stale literal is enough to break a step
// after a floor bump, so every literal from every matching operand counts.
type VersionLiteral = { operator?: string; version: string };
const versionLiterals = (line: string, patterns: RegExp[]): VersionLiteral[] =>
	patterns.flatMap((pattern) => Array.from(line.matchAll(pattern), (match) => ({ operator: match.groups?.operator, version: match.groups?.version ?? "" })));
// WHY: every quoted alternative in a node-version expression is a claim; a guard operand
// compares a counter, not the version, so its number stays inert.
const nodeVersionExpressionLiterals = (line: string): VersionLiteral[] =>
	expressionBodies(line)
		.flatMap((body) => splitOutsideQuotes(body, ";|&"))
		.filter((operand) => !isGuardOperand(operand))
		.flatMap((operand) => Array.from(operand.matchAll(QUOTED_VERSION), (match) => ({ version: match.groups?.version ?? "" })));

function claimsFloor(line: string, floor: string): boolean {
	const prose = PROSE_KEYS.test(line);
	// WHY: prose verdicts stay on the raw line; normalizing only feeds the non-prose checks.
	const normalized = normalizeNodeVersionAccess(normalizeFloorAccess(line));
	if (isAssignment(line, prose)) return true;
	// WHY: a version-shaped literal in any env.NODE_FLOOR operand is a second floor source,
	// whatever the operator.
	if (!prose && nodeFloorOperands(normalized).some((operand) => FLOOR_OPERAND_LITERAL.test(operand))) return true;
	if (outputFloorClaim(line, floor)) return true;
	// WHY: prose prints key-shaped text, so a prose key never maps (see the prose-scalar block);
	// Actions still evaluates a `${{ }}` in a run scalar before the shell runs it.
	if (prose) return RUN_KEY.test(line) && liveExpressionClaims(line, floor);
	const patterns = [NODE_VERSION_KEY, NODE_VERSION_COMPARISON, NODE_VERSION_REVERSED_COMPARISON, NODE_VERSION_ARGUMENT];
	const literals = versionLiterals(normalized, patterns).concat(nodeVersionExpressionLiterals(normalized), nodeVersionListLiterals(normalized).map((version) => ({ version })));
	const callLiterals = Array.from(normalized.matchAll(NODE_VERSION_CALL), (match) => match.groups?.args ?? "")
		.flatMap((args) => Array.from(args.matchAll(QUOTED_VERSION), (match) => ({ version: match.groups?.version ?? "" })));
	literals.push(...callLiterals);
	if (literals.some(({ operator, version }) => rangeClaims(operator, version, floor))) return true;
	return unresolvedNodeVersionClaim(normalized);
}

// WHY: an upper bound admits below-floor versions, so `<`/`<=` always claim; a lower bound
// claims only below the floor or in the floor major; an exact pin keeps the full-version rule.
function rangeClaims(operator: string | undefined, version: string, floor: string): boolean {
	if (operator === undefined) return isFloorClaim(version, floor);
	if (operator.startsWith("<")) return true;
	return belowFloor(version, floor) || isSameMajor(version, floor);
}

function isFloorClaim(version: string, floor: string): boolean {
	return isFullVersion(version) || isSameMajor(version, floor) || belowFloor(version, floor);
}

function isFullVersion(version: string): boolean {
	return version.split(".").length === 3;
}

function isSameMajor(version: string, floor: string): boolean {
	return version.split(".")[0] === floor.split(".")[0];
}

function belowFloor(version: string, floor: string): boolean {
	const current = version.split(".").map(Number);
	const minimum = floor.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const delta = (current[index] ?? 0) - (minimum[index] ?? 0);
		if (delta !== 0) return delta < 0;
	}
	return false;
}

function runAuditCi(): void {
	const command = "npx audit-ci --config audit-ci.jsonc";
	const result = spawnSync(command, { cwd: REPO_ROOT, encoding: "utf8", shell: true });
	const diagnostics = [
		`command: ${command}`,
		`error.stack: ${result.error?.stack ?? "none"}`,
		`status: ${String(result.status)}`,
		`signal: ${String(result.signal)}`,
		`stdout:\n${result.stdout}`,
		`stderr:\n${result.stderr}`,
	].join("\n");

	assert.equal(result.error, undefined, diagnostics);
	assert.equal(result.signal, null, diagnostics);
	assert.equal(result.status, 0, diagnostics);
}

test("pinned Pi compatibility metadata stays exact", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as { packages: Record<string, { version?: string }> };
	assert.equal(packageJson.engines.node, `>=${EXPECTED_NODE_FLOOR}`);
	for (const name of PINNED_PI_PACKAGES) {
		assert.equal(packageJson.peerDependencies[name], EXPECTED_PI_PEER, `${name} peer must require ${EXPECTED_PI_PEER}`);
	}
	assert.equal(packageJson.peerDependencies.typebox, EXPECTED_TYPEBOX_PEER, `typebox peer must require ${EXPECTED_TYPEBOX_PEER}`);
	for (const name of PINNED_PI_PACKAGES) {
		assert.equal(packageJson.devDependencies[name], EXPECTED_PI_VERSION);
		assert.equal(lock.packages[`node_modules/${name}`]?.version, EXPECTED_PI_VERSION);
	}
	assert.equal(packageJson.devDependencies.typebox, EXPECTED_TYPEBOX_VERSION);
	assert.equal(lock.packages["node_modules/typebox"]?.version, EXPECTED_TYPEBOX_VERSION);
});

test("package and lockfile versions agree", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as {
		version?: string;
		packages: Record<string, { version?: string }>;
	};
	assert.equal(lock.version, packageJson.version, "package-lock.json version must match package.json");
	assert.equal(
		lock.packages[""]?.version,
		packageJson.version,
		"package-lock.json root package version must match package.json",
	);
});

test("the Node floor has one source across CI, engines, and the matrix", () => {
	const packageJson = parsePackageJson();
	const workflow = readText(WORKFLOW_PATH);
	const floor = workflowNodeFloor(workflow);
	assert.equal(floor, EXPECTED_NODE_FLOOR, "workflow env NODE_FLOOR must equal the reviewed floor");
	assert.equal(packageJson.engines.node, `>=${floor}`, "engines.node must equal the workflow NODE_FLOOR");
	assert.ok(EXPECTED_MATRIX.has(`ubuntu-latest@${floor}`), "the matrix must run the Node floor on ubuntu-latest");
	assert.deepEqual(
		floorLiteralViolations(workflow, floor),
		[],
		"only env.NODE_FLOOR and the matrix entry may name the floor",
	);
});

test("the Node floor guard rejects any extra floor literal", () => {
	const workflow = readText(WORKFLOW_PATH);
	const floor = workflowNodeFloor(workflow);
	assert.deepEqual(floorLiteralViolations(workflow, floor), [], "the real workflow must stay clean");
	const anchor = "      - run: npm ci\n";
	assert.ok(workflow.includes(anchor), "workflow must keep the npm ci step");
	const injected = (snippet: string): string[] => floorLiteralViolations(workflow.replace(anchor, anchor + snippet), floor);
	const injectedOverride = (value: string): string[] => floorLiteralViolations(workflow.replace("  test:\n", `  test:\n    env:\n      NODE_FLOOR: "${value}"\n`), floor);
	const step = "      - uses: actions/setup-node@v4\n        with:\n";
	assert.equal(injected(`${step}          node-version: "${floor}"\n`).length, 1, "step-level floor pin");
	assert.equal(injected(`${step}          node-version: "22"\n`).length, 1, "step-level major pin");
	assert.equal(injected(`${step}          "node-version": "22"\n`).length, 1, "quoted key major pin");
	assert.equal(injected(`${step}          node-version: "20.19.0"\n`).length, 1, "stale full version");
	assert.equal(injected(`${step}          node-version: "21"\n`).length, 1, "below-floor major pin");
	assert.equal(injected(`${step}          node-version: "24"\n`).length, 0, "above-floor major pin stays allowed");
	assert.equal(injected(`${step}          node-version: "v21"\n`).length, 1, "v-prefixed below-floor major pin");
	assert.equal(injected(`${step}          node-version: "v22"\n`).length, 1, "v-prefixed same-major pin");
	assert.deepEqual(["~21.0.0", "^21.0.0", ">=21.0.0", "~22.0.0", "<23.0.0", "<=24.0.0"].map((range) => injected(`${step}          node-version: "${range}"\n`).length), [1, 1, 1, 1, 1, 1], "below-floor and same-major ranges claim");
	assert.deepEqual([">24.0.0", ">=24.0.0", "~24.0.0", "^24.0.0"].map((range) => injected(`${step}          node-version: "${range}"\n`).length), [0, 0, 0, 0], "above-floor ranges stay allowed");
	assert.equal(injected("      - name: Range comparison\n        if: matrix.node-version == '~21.0.0'\n").length, 1, "range comparison-operator pin");
	assert.equal(injected("      - name: Prose floor\n        run: echo NODE_FLOOR 22.18.0\n").length, 0, "prose is not a claim");
	assert.equal(injected("      - name: Prose key\n        run: 'echo \"NODE_FLOOR: 22.19.0\"'\n").length, 0, "prose key with colon is not a claim");
	assert.deepEqual(["node-version >= 22.19.0", "if: node-version >= 22.18.0", "${{ node-version >= 22.18.0 }}"].map((text) => injected(`      - name: Prose condition\n        run: 'echo "${text}"'\n`).length), [0, 0, 0], "prose comparisons are not claims");
	assert.equal(injected("      - name: Live expression\n        run: \${{ matrix.node-version == '22.19.0' && 'npm test' || 'echo skip' }}\n").length, 1, "a stale floor in a live command-selection expression is a claim");
	assert.deepEqual(["      - name: Live above floor\n        run: \${{ matrix.node-version == '24' && 'npm test' || 'echo skip' }}\n", "      - name: Printed live expression\n        run: echo \"\${{ matrix.node-version == '22.19.0' }}\"\n"].map((snippet) => injected(snippet).length), [0, 0], "above-floor and printed live expressions stay inert");
	assert.equal(injected("      - name: Live expression after printer\n        run: echo start && \${{ matrix.node-version == '22.19.0' && 'npm test' }}\n").length, 1, "a live expression after a printer still claims");
	assert.equal(injected("      - name: Live floor operand\n        run: \${{ env.NODE_FLOOR != 22 && 'npm test' }}\n").length, 1, "a bare floor operand in a live expression claims");
	assert.equal(injected("      - name: Range floor\n        if: matrix.node-version >= 'v22'\n").length, 1, "v-prefixed comparison-operator floor pin");
	assert.equal(injected("      - name: Bracket below floor\n        if: matrix['node-version'] == '21'\n").length, 1, "bracket-key below-floor pin");
	assert.equal(injected("      - name: Bracket floor\n        if: matrix['node-version'] == '22.19.0'\n").length, 1, "bracket-key floor pin");
	assert.equal(injected("      - name: Bracket above floor\n        if: matrix['node-version'] == '24'\n").length, 0, "bracket-key above-floor pin stays allowed");
	assert.equal(injected("      - name: Reversed bracket floor\n        if: \${{ '21' == matrix['node-version'] }}\n").length, 1, "reversed bracket-key floor pin");
	assert.equal(injected(`${step}          node-version: "lts/hydrogen"\n`).length, 1, "digit-free alias pin is a claim");
	assert.equal(injected(`${step}          node-version: latest\n`).length, 1, "digit-free alias latest is a claim");
	assert.equal(injected(`${step}          node-version: \${{ matrix.node-version }}\n`).length, 0, "matrix expression value stays allowed");
	assert.equal(injected("      - name: Prose assign\n        run: echo \"NODE_FLOOR=22.19.0\"\n").length, 0, "quoted prose floor literal is not a claim");
	assert.equal(injected("      - name: Prose shell literal\n        run: echo 'NODE_FLOOR=22.18.0'\n").length, 0, "single-quoted prose floor literal is not a claim");
	assert.equal(injected("      - name: Prose diagnostic\n        run: echo \"Current NODE_FLOOR=22\"\n").length, 0, "quoted diagnostic assignment is not a claim");
	assert.equal(injected("      - name: Prose printf\n        run: printf '%s' 'Current NODE_FLOOR=22'\n").length, 0, "quoted printf diagnostic is not a claim");
	assert.equal(injected("      - name: Prose apostrophe\n        run: echo \"it's NODE_FLOOR=22\"\n").length, 0, "apostrophe inside a diagnostic does not reopen the scan");
	assert.equal(injected("      - name: Verify NODE_FLOOR=22.19.0 applies\n        run: npm ci\n").length, 0, "an inert step name is not a claim");
	assert.equal(injected("      - name: Prose description\n        description: pins NODE_FLOOR=22.19.0 for devs\n        run: npm ci\n").length, 0, "an inert description is not a claim");
	assert.equal(injected("      - name: Unquoted echo\n        run: echo Current NODE_FLOOR=22.19.0\n").length, 0, "an unquoted printer argument is not a claim");
	assert.equal(injected("      - name: Unquoted printf\n        run: printf %s NODE_FLOOR=22\n").length, 0, "an unquoted printf argument is not a claim");
	assert.equal(injected("      - name: Explicit key\n        env:\n          ? NODE_FLOOR\n          : \"22.18.0\"\n").length, 1, "explicit-key NODE_FLOOR mapping is a second source");
	assert.equal(injected("      - name: Quoted explicit key\n        env:\n          ? \"NODE_FLOOR\"\n          : '22.18.0'\n").length, 1, "quoted explicit-key NODE_FLOOR mapping is a second source");
	assert.equal(injected("      - name: Prose explicit key\n        run: echo \"? NODE_FLOOR\"\n").length, 0, "explicit-key token in prose is not a claim");
	assert.deepEqual([injected("      - name: Anchored key\n        env:\n          &nf NODE_FLOOR: \"22.18.0\"\n"), injected(`${step}          !!str node-version: "22.18.0"\n`), injected(`${step}          node-version: &pin "22.18.0"\n`), injected("      - name: Flow anchored key\n        env: { &nf NODE_FLOOR: '22.18.0' }\n")].map((violations) => violations.length), [1, 1, 1, 1], "anchored and tagged keys are claims");
	assert.equal(injected(`${step}          !!str node-version: "24"\n`).length, 0, "tagged above-floor pin stays inert");
	assert.equal(injected("      - name: Stale floor\n        if: matrix.node-version == '22.18.0'\n").length, 1, "stale floor literal");
	assert.equal(injected("      - name: Reversed stale floor\n        if: \${{ '22.18.0' == matrix.node-version }}\n").length, 1, "reversed stale floor literal");
	assert.equal(injected("      - name: Reversed above floor\n        if: \${{ '24' == matrix.node-version }}\n").length, 0, "reversed above-floor literal stays allowed");
	assert.equal(injected("      - name: Prose reversed comparison\n        run: echo \"'22.18.0' == matrix.node-version\"\n").length, 0, "prose reversed comparison stays inert");
	assert.equal(injected("      - name: Range floor\n        if: matrix.node-version >= '22.19.0'\n").length, 1, "comparison-operator floor pin");
	assert.equal(injected("      - name: Flow floor\n        env: { NODE_FLOOR: '22.19.0' }\n").length, 1, "flow-style NODE_FLOOR override");
	assert.equal(injected(`      - uses: actions/setup-node@v4\n        with: { node-version: "${floor}" }\n`).length, 1, "flow-style step floor pin");
	const danglingFlow = (block: string, key: string, value: string): string =>
		`      - name: Dangling flow\n        ${block}: {\n          ${key}:\n          "${value}"\n        }\n`;
	assert.equal(injected(danglingFlow("env", "NODE_FLOOR", floor)).length, 1, "multi-line flow NODE_FLOOR override");
	assert.equal(injected(danglingFlow("with", "node-version", floor)).length, 1, "multi-line flow step floor pin");
	assert.equal(injected(danglingFlow("with", "node-version", "24")).length, 0, "multi-line flow above-floor pin stays allowed");
	assert.equal(injected("      - name: Folded node-version prose\n        run: >\n          node-version: 22.18.0\n").length, 0, "folded prose whose body starts with node-version is not a claim");
	assert.equal(injected("      - name: Folded floor\n        if: >-\n          matrix.node-version == '22.18.0'\n").length, 1, "folded step condition floor pin");
	assert.equal(injected("      - name: Env write\n        run: echo \"NODE_FLOOR=22.18.0\" >> $GITHUB_ENV\n").length, 1, "NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Env braced write\n        run: echo \"NODE_FLOOR=22.18.0\" >> \"${GITHUB_ENV}\"\n").length, 1, "braced NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Env PowerShell write\n        run: echo \"NODE_FLOOR=22.18.0\" >> $env:GITHUB_ENV\n").length, 1, "PowerShell NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: PowerShell diagnostic\n        run: Write-Host \"NODE_FLOOR=22\"\n").length, 0, "a Write-Host diagnostic is not a claim");
	assert.equal(injected("      - name: PowerShell output\n        run: Write-Output \"NODE_FLOOR=22\"\n").length, 0, "a Write-Output diagnostic is not a claim");
	assert.equal(injected("      - name: Env PowerShell braced write\n        run: echo \"NODE_FLOOR=22.18.0\" >> \"${env:GITHUB_ENV}\"\n").length, 1, "braced PowerShell NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Quoted output write\n        run: 'echo \"floor=22\" >> \"$GITHUB_OUTPUT\"'\n").length, 1, "YAML-quoted floor output write is a second source");
	assert.equal(injected("      - name: Quoted env write\n        run: 'echo \"NODE_FLOOR=22\" >> \"$GITHUB_ENV\"'\n").length, 1, "YAML-quoted NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Quoted diagnostic\n        run: 'echo \"Current NODE_FLOOR=22\"'\n").length, 0, "YAML-quoted diagnostic stays inert");
	assert.equal(injected("      - name: Double-quoted output write\n        run: \"echo \\\"floor=22\\\" >> $GITHUB_OUTPUT\"\n").length, 1, "double-quoted YAML run with escaped quotes writes the floor");
	assert.deepEqual([["floor=22.18.0", "$GITHUB_OUTPUT"], ["floor=22.18.0", '"${GITHUB_OUTPUT}"'], ["floor=22.18.0", "$env:GITHUB_OUTPUT"], ["floor=22", "$GITHUB_OUTPUT"], ["NODE_FLOOR=22", "$GITHUB_ENV"], ["node_floor_version=22", "$GITHUB_OUTPUT"]].map(([pair, target]) => injected(`      - name: Output write\n        run: echo "${pair}" >> ${target}\n`).length), [1, 1, 1, 1, 1, 1], "aliased GITHUB_OUTPUT floor write is a second source");
	assert.deepEqual(["$GITHUB_ENV_BACKUP", "$GITHUB_OUTPUT_EXTRA"].map((target) => injected(`      - name: Longer target\n        run: echo "NODE_FLOOR=22" > ${target}\n`).length), [0, 0], "a longer variable name is not the env/output target");
	assert.deepEqual(["count=3", "os=ubuntu-latest", "node_count=21", "release_version=2.4.0", "version=22", "floor_count=21", "count=3.14"].map((pair) => injected(`      - name: Output control\n        run: echo "${pair}" >> $GITHUB_OUTPUT\n`).length), [0, 0, 0, 0, 0, 0, 0], "non-floor-key output is not a floor claim");
	assert.equal(injected("      - name: Output prose\n        run: echo \"floor=22.18.0\"\n").length, 0, "printed alias without a redirect is inert");
	assert.equal(injected("      - name: Output prose\n        run: echo \"floor=22.18.0\"\n").length, 0, "printed alias without a redirect is inert");
	assert.equal(injected("      - name: Publish floor=22.18.0 to $GITHUB_OUTPUT\n        run: npm ci\n").length, 0, "a step name mentioning the target is inert");
	assert.equal(injected("      - name: Described\n        description: sets $GITHUB_OUTPUT floor=22.18.0 for devs\n        run: npm ci\n").length, 0, "a description mentioning the target is inert");
	assert.equal(injected("      - name: Printed target\n        run: echo \"floor=22.18.0 expected in $GITHUB_OUTPUT\"\n").length, 0, "a printed diagnostic naming the target is inert");
	assert.equal(injected("      - name: Printed env target\n        run: echo \"NODE_FLOOR=22.18.0 is printed; $GITHUB_ENV untouched\"\n").length, 0, "a quoted separator does not fake an executed write");
	assert.equal(injected("      - name: Print then true\n        run: echo \"NODE_FLOOR=22\"; true\n").length, 0, "a printer beside another command is not an executed assignment");
	assert.equal(injected("      - name: Print then done\n        run: echo \"NODE_FLOOR=22\" && echo done\n").length, 0, "a separator run creates no phantom command segment");
	assert.equal(injected("      - name: Spaced run key\n        run : echo \"NODE_FLOOR=22.19.0\"\n").length, 0, "a spaced run key is prose");
	assert.equal(injected("      - \"name\": Diagnostic NODE_FLOOR=22\n        run: true\n").length, 0, "a double-quoted step name is prose");
	assert.equal(injected("      - 'name': Diagnostic NODE_FLOOR=22\n        run: true\n").length, 0, "a single-quoted step name is prose");
	assert.equal(injected("      - \"run\": echo \"NODE_FLOOR=22\"\n").length, 0, "a quoted run printer is prose");
	assert.equal(injected("      - \"run\": NODE_FLOOR=22.18.0 npm test\n").length, 1, "a quoted run assignment is a second source");
	assert.deepEqual(["      - \"run\": \"echo NODE_FLOOR=22\"\n", "      - \"run\": |\n          echo \"NODE_FLOOR=22\"\n", "      - run : |\n          echo \"NODE_FLOOR=22\"\n", "      - run : echo \"NODE_FLOOR=22\"\n"].map((snippet) => injected(snippet).length), [0, 0, 0, 0], "quoted and spaced run keys stay prose");
	assert.deepEqual(["      - \"run\": NODE_FLOOR=22.18.0 npm test\n", "      - run : NODE_FLOOR=22.18.0 npm test\n"].map((snippet) => injected(snippet).length), [1, 1], "quoted and spaced run assignments stay claims");
	assert.equal(injected("      - \"name\": Diagnostic NODE_FLOOR=22\n        env:\n          NODE_FLOOR: \"22.18.0\"\n").length, 1, "an env override under a quoted name stays a claim");
	assert.equal(injected("      - name: Next-line env write\n        run: |\n          echo \"NODE_FLOOR=22.18.0\"\n          >> $GITHUB_ENV\n").length, 0, "a standalone redirect line does not execute the echo above");
	assert.equal(injected("      - name: Continuation env write\n        run: |\n          echo \"NODE_FLOOR=22.18.0\" \\\n          >> \"$GITHUB_ENV\"\n").length, 1, "backslash-continued NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Brace env write\n        run: |\n          {\n          echo \"NODE_FLOOR=22.18.0\"\n          } >> $GITHUB_ENV\n").length, 1, "brace-group NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Brace group env write\n        run: |\n          {\n          echo \"NODE_FLOOR=22.19.0\"\n          echo done\n          } >> $GITHUB_ENV\n").length, 1, "a redirected brace group writes every command");
	assert.equal(injected("      - name: Next-line output write\n        run: |\n          echo \"floor=22.18.0\"\n          >> $GITHUB_OUTPUT\n").length, 0, "a standalone redirect line leaves the diagnostic output inert");
	assert.equal(injected("      - name: Split prose\n        run: |\n          echo \"NODE_FLOOR=22.18.0\"\n          echo \"see $GITHUB_ENV\"\n").length, 0, "split prose mentioning the target is inert");
	assert.equal(injected("      - name: Quoted shell\n        run: bash -c \"NODE_FLOOR=22.18.0 npm test\"\n").length, 1, "quoted shell execution is a second source");
	assert.equal(injected("      - name: Executed substitution\n        run: echo \"$(NODE_FLOOR=22.18.0 printenv NODE_FLOOR)\"\n").length, 1, "an assignment inside an executed substitution is a second source");
	assert.deepEqual(["      - name: Printed substitution\n        run: echo \"$(printf NODE_FLOOR=22)\"\n", "      - name: Echo substitution\n        run: echo \"$(echo NODE_FLOOR=22)\"\n"].map((snippet) => injected(snippet).length), [0, 0], "a printer argument inside a substitution stays printed");
	assert.equal(injected("      - name: Prefixed substitution\n        run: echo \"$(CI=true NODE_FLOOR=22 npm test)\"\n").length, 1, "an environment prefix at the substitution's command position is a second source");
	assert.equal(injected("      - name: Quoted substitution\n        run: echo '$(NODE_FLOOR=22.18.0 printenv NODE_FLOOR)'\n").length, 0, "a single-quoted substitution stays inert");
	assert.equal(injected("      - name: Substitution beside prose\n        run: echo \"NODE_FLOOR=22.18.0 $(date)\"\n").length, 0, "an assignment outside the substitution stays printed");
	assert.equal(injected("      - name: Apostrophe substitution\n        run: echo \"it's $(NODE_FLOOR=22.18.0 printenv NODE_FLOOR)\"\n").length, 1, "an apostrophe inside a diagnostic does not mask a live substitution");
	assert.equal(injected("      - name: Shell prefix\n        run: NODE_FLOOR=22.18.0 npm test\n").length, 1, "shell-prefix NODE_FLOOR is a second source");
	assert.deepEqual(["      - name: Command argument\n        run: node -e 'process.stdout.write(\"NODE_FLOOR=22\")'\n", "      - name: Filter argument\n        run: npm test -- --grep NODE_FLOOR=22\n"].map((snippet) => injected(snippet).length), [0, 0], "assignment-shaped arguments are not claims");
	assert.equal(injected("      - name: Env prefix\n        run: env NODE_FLOOR=22 npm test\n").length, 1, "env-prefix NODE_FLOOR is a second source");
	assert.deepEqual(["      - name: Generic env prefix\n        run: CI=true NODE_FLOOR=22.18.0 npm test\n", "      - name: Generic env prefix above\n        run: CI=true NODE_FLOOR=24 npm test\n"].map((snippet) => injected(snippet).length), [1, 1], "a generic environment prefix cannot hide a NODE_FLOOR assignment");
	assert.equal(injected("      - name: Generic env prefix only\n        run: CI=true npm test\n").length, 0, "a generic environment prefix alone is not a claim");
	assert.equal(injected("      - name: Shell body\n        run: sh -c 'NODE_FLOOR=22.18.0 npm test'\n").length, 1, "a shell -c assignment is a second source");
	assert.deepEqual(["      - name: Combined shell options\n        run: bash -lc \"NODE_FLOOR=22.18.0 npm test\"\n", "      - name: Separate shell options\n        run: bash -l -c 'NODE_FLOOR=22.18.0 npm test'\n"].map((snippet) => injected(snippet).length), [1, 1], "combined and separate shell options execute their body");
	assert.equal(injected("      - name: Printed combined body\n        run: bash -lc \"echo NODE_FLOOR=22\"\n").length, 0, "a printed combined-option body stays inert");
	assert.equal(injected("      - name: Prefixed shell body\n        run: bash -lc \"CI=true NODE_FLOOR=22 npm test\"\n").length, 1, "an environment prefix inside a shell body is a second source");
	assert.equal(injected("      - name: Printed shell body\n        run: bash -c \"echo NODE_FLOOR=22\"\n").length, 0, "a printed shell body stays inert");
	assert.equal(injected("      - name: Env read\n        if: matrix.node-version == env.NODE_FLOOR\n").length, 0, "reference to env.NODE_FLOOR is not a claim");
	assert.equal(injected("      - name: Env floor-first read\n        if: env.NODE_FLOOR == matrix.node-version\n").length, 0, "floor-first reference to env.NODE_FLOOR is not a claim");
	assert.equal(injected("      - name: Env floor-first literal\n        if: env.NODE_FLOOR == '22.18.0'\n").length, 1, "literal beside env.NODE_FLOOR stays a second source");
	assert.equal(injected("      - name: Env compare\n        if: env.NODE_FLOOR != '22.18.0'\n").length, 1, "literal beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Env expression\n        if: \${{ env.NODE_FLOOR != '22.18.0' }}\n").length, 1, "expression literal beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Env contains\n        if: contains(env.NODE_FLOOR, '22.18.0')\n").length, 1, "function literal beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Bracket floor access\n        if: env['NODE_FLOOR'] == '22.18.0'\n").length, 1, "bracket env floor access is a second source");
	assert.equal(injected("      - name: Bracket floor compare\n        if: env[\"NODE_FLOOR\"] != '22.18.0'\n").length, 1, "double-quoted bracket env floor compare is a second source");
	assert.equal(injected("      - name: Bracket floor read\n        if: env['NODE_FLOOR'] == matrix.node-version\n").length, 0, "bracket env floor reference is not a claim");
	assert.equal(injected("      - name: Prose bracket floor\n        run: echo \"env['NODE_FLOOR'] == '22.18.0'\"\n").length, 0, "prose bracket env floor text stays inert");
	assert.equal(injected("      - name: Env quoted major\n        if: env.NODE_FLOOR != '24'\n").length, 1, "quoted major beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Env bare major\n        if: env.NODE_FLOOR != 24\n").length, 1, "bare major beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Env bare v-prefixed major\n        if: env.NODE_FLOOR != v24\n").length, 1, "bare v-prefixed major beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Env reference with digits\n        if: env.NODE_FLOOR != vars.NODE_24\n").length, 0, "digits inside an identifier are not a floor literal");
	assert.equal(injected("      - name: Env bare full version\n        if: env.NODE_FLOOR != 24.0.1\n").length, 1, "bare full version beside env.NODE_FLOOR is a second source");
	assert.equal(injected("      - name: Env bare major and counter\n        if: env.NODE_FLOOR != 24 && github.run_number > 1\n").length, 1, "bare major beside env.NODE_FLOOR is a claim even with a counter sibling");
	assert.equal(injected("      - name: Env empty compare counter\n        if: env.NODE_FLOOR != '' && github.run_number > 1\n").length, 0, "counter sibling of an empty compare is not a floor literal");
	assert.equal(injected("      - name: Env run counter\n        if: matrix.node-version == env.NODE_FLOOR && github.run_number > 1\n").length, 0, "run counter beside env.NODE_FLOOR is not a floor literal");
	assert.equal(injected("      - name: Env sibling label\n        if: matrix.node-version == env.NODE_FLOOR && matrix.os == 'ubuntu-24.04'\n").length, 0, "literal in a sibling operand is not beside env.NODE_FLOOR");
	assert.equal(injected("      - name: Block prose\n        run: |\n          echo \"NODE_FLOOR=22.19.0\"\n").length, 0, "block-scalar prose is not a claim");
	assert.equal(injected("      - name: Commented block header\n        run: | # diagnostic\n          echo \"NODE_FLOOR=22\"\n").length, 0, "a commented block header still marks its body as prose");
	assert.equal(injected("      - name: Commented folded header\n        run: > # diagnostic\n          echo \"NODE_FLOOR=22.18.0\"\n          >> \"$GITHUB_ENV\"\n").length, 1, "a commented folded header keeps its env write");
	assert.equal(injected("      - name: Indented block prose\n        run: |2\n          echo \"NODE_FLOOR=22\"\n").length, 0, "an explicit indentation indicator still marks the body as prose");
	assert.equal(injected("      - name: Indented chomped block prose\n        run: |2-\n          echo \"NODE_FLOOR=22\"\n").length, 0, "an indentation-then-chomping header still marks the body as prose");
	assert.equal(injected("      - name: Chomped indented block prose\n        run: |-2\n          echo \"NODE_FLOOR=22\"\n").length, 0, "a chomping-then-indentation header still marks the body as prose");
	assert.equal(injected("      - name: Indented folded env write\n        run: >2\n          echo \"NODE_FLOOR=22.18.0\"\n          >> \"$GITHUB_ENV\"\n").length, 1, "an indented folded header keeps its env write");
	assert.equal(injected("      - name: Indented block output write\n        run: |2\n          echo \"floor=22.18.0\" >> $GITHUB_OUTPUT\n").length, 1, "an indented literal run body writes the floor");
	assert.equal(injected("      - name: |2\n          Diagnostic NODE_FLOOR=22\n        run: true\n").length, 0, "an indented block step name is prose");
	assert.equal(injected("      - name: Folded prose\n        run: >\n          echo \"node-version 22.19.0\"\n").length, 0, "folded prose body is not a claim");
	assert.equal(injected("      - name: Folded env write\n        run: >\n          echo \"NODE_FLOOR=22.18.0\"\n          >> \"$GITHUB_ENV\"\n").length, 1, "folded NODE_FLOOR env write is a second source");
	assert.equal(injected("      - name: Folded quoted hash\n        run: >\n          echo \"step #2\" ;\n          NODE_FLOOR=22.18.0 npm test\n").length, 1, "quoted hash in a folded run body does not hide a NODE_FLOOR assignment");
	assert.equal(injected("      - name: Block description\n        description: |\n          node-version 22.19.0\n").length, 0, "description block body is not a claim");
	assert.equal(injected("      - name: Block assign\n        run: |\n          NODE_FLOOR=22.18.0 npm test\n").length, 1, "block-scalar NODE_FLOOR is a second source");
	assert.equal(injected("      - run: |\n          echo hello\n        env:\n          NODE_FLOOR: \"22.18.0\"\n").length, 1, "sibling env key after a run block stays a claim");
	assert.equal(injected("      - name: |\n          echo hello\n        env:\n          NODE_FLOOR: \"22.18.0\"\n").length, 1, "sibling env key after a name block stays a claim");
	assert.equal(injected("      - run: |\n          echo hello\n        with:\n          node-version: \"22.18.0\"\n").length, 1, "sibling with key after a run block stays a claim");
	assert.equal(injected("      - run: >\n          echo hello\n        env:\n          NODE_FLOOR: \"22.18.0\"\n").length, 1, "sibling env key after a folded run block stays a claim");
	assert.equal(injected("      - run: >\n          echo hello\n        with:\n          node-version: \"22.18.0\"\n").length, 1, "sibling with key after a folded run block stays a claim");
	assert.equal(injected("      - name: Env compare and stale\n        if: matrix.node-version == env.NODE_FLOOR && matrix.node-version == '22.18.0'\n").length, 1, "stale literal in a sibling operand is a claim");
	assert.equal(injected("      - name: Stale alternative\n        if: matrix.node-version == '24' || matrix.node-version == '22.18.0'\n").length, 1, "stale literal in any alternative is a claim");
	assert.equal(injected("      - name: Empty compare counter\n        if: matrix.node-version != '' && github.run_number > 1\n").length, 0, "run counter is not a Node version");
	assert.equal(injected("      - name: Empty compare label\n        if: matrix.node-version != '' && matrix.os == 'ubuntu-20.04'\n").length, 0, "OS label is not a Node version");
	assert.equal(injected(`${step}          node-version: \${{ '22.18.0' }}\n`).length, 1, "expression-valued floor pin");
	assert.equal(injected(`${step}          node-version: \${{ '24' }}\n`).length, 0, "above-floor expression stays allowed");
	assert.equal(injected(`${step}          node-version: \${{ matrix.node-version || '22.18.0' }}\n`).length, 1, "expression fallback floor pin");
	assert.equal(injected(`${step}          node-version: \${{ matrix.node-version || '24' }}\n`).length, 0, "above-floor expression fallback stays allowed");
	assert.equal(injected(`${step}          node-version: \${{ format('{0}', '${floor}') }}\n`).length, 1, "quoted brace in a computed floor expression is a claim");
	assert.equal(injected(`${step}          node-version: \${{ format('{0}', '24') }}\n`).length, 0, "quoted brace in a computed above-floor expression stays allowed");
	assert.equal(injected(`${step}          node-version: \${{ format('{0}', '22.18.0') || '24' }}\n`).length, 1, "quoted brace in a computed fallback floor is a claim");
	assert.equal(injected(`${step}          node-version: \${{ github.run_number > 24 && '22.18.0' || '24' }}\n`).length, 1, "guard counter does not hide a stale alternative");
	assert.equal(injected(`${step}          node-version: \${{ github.run_number > 1 && matrix.node-version || '24' }}\n`).length, 0, "guard counter is not a Node version");
	assert.equal(injected(`${step}          "node-version": \${{ matrix.node-version || '22.18.0' }}\n`).length, 1, "quoted key expression fallback floor pin");
	assert.equal(injected("      - name: Function floor\n        if: startsWith(matrix.node-version, '22.18.0')\n").length, 1, "function-call condition floor pin");
	assert.equal(injected("      - name: Computed above floor\n        if: matrix.node-version == format('{0}', '24')\n").length, 0, "a computed above-floor expression stays allowed");
	assert.equal(injected("      - name: Computed floor\n        if: matrix.node-version == format('{0}', '22.18.0')\n").length, 1, "a floor literal inside a computed expression is a claim");
	assert.deepEqual(['["22.18.0","24"]', '["22"]', '["24"]'].map((list) => injected(`      - name: List literal\n        if: contains(fromJson('${list}'), matrix.node-version)\n`).length), [1, 1, 0], "list-argument floor literal claims, above-floor stays allowed");
	assert.equal(injected("      - name: List label\n        if: contains(fromJson('[\"ubuntu-24.04\"]'), matrix.node-version)\n").length, 0, "OS label list is not a Node version");
	assert.equal(injected("      - name: Prose list\n        run: echo \"contains(fromJson('[\"22.18.0\"]'), matrix.node-version)\"\n").length, 0, "prose list is inert");
	assert.equal(injected("      - name: Sibling list\n        if: matrix.node-version == '24' && contains(fromJson('[\"22.18.0\"]'), matrix.os)\n").length, 0, "list in a sibling operand is inert");
	assert.equal(injected("      - name: Split floor\n        if: >-\n\n          matrix.node-version == '22.18.0'\n").length, 1, "blank-interrupted folded condition floor pin");
	const matrixOverride = (snippet: string): string[] => floorLiteralViolations(workflow.replace('            node-version: "24"    # latest on Windows', `            node-version: "24"    # latest on Windows\n${snippet}`), floor);
	assert.equal(matrixOverride('            env:\n              NODE_FLOOR: "22.18.0"\n').length, 1, "matrix-region NODE_FLOOR key is a second source");
	const anchoredWorkflow = workflow.replace("env:\n  NODE_FLOOR: \"22.19.0\"\n", `env: &floors\n  NODE_FLOOR: "${floor}"\n`);
	const injectedAnchored = (snippet: string): string[] => floorLiteralViolations(anchoredWorkflow.replace(anchor, anchor + snippet), floor);
	assert.equal(injectedAnchored("      - name: Aliased floors\n        env: *floors\n").length, 1, "alias of a floor-bearing block is a second source");
	assert.equal(injected("      - name: Plain anchor\n        env: &plain\n          CI: \"true\"\n      - name: Aliased plain\n        env: *plain\n").length, 0, "alias of a block without the floor stays inert");
	assert.equal(injectedOverride("22.18.0").length, 1, "job-level NODE_FLOOR override");
	assert.equal(injectedOverride("24").length, 1, "short job-level NODE_FLOOR override");
	assert.equal(injectedOverride("24.0").length, 1, "two-part job-level NODE_FLOOR override");
	assert.equal(injected("      - name: Deep env key\n        env:\n          NODE_FLOOR: \"22.18.0\"\n").length, 1, "deeply indented NODE_FLOOR key is a second source");
});

// WHY: one global `* text=auto eol=lf` rule plus the EOL report keep every tracked
// text file LF, whatever core.autocrlf says.
const EOL_MARKERS = new Set(["i/crlf", "i/mixed", "w/crlf", "w/mixed"]);
function eolViolations(report: string): string[] { return report.split("\n").filter((line) => line.split(/\s+/).some((field) => EOL_MARKERS.has(field))); }

test("repository text has one LF line-ending contract", () => {
	const rules = readText(GITATTRIBUTES_PATH).split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
	assert.deepEqual(rules, ["* text=auto eol=lf"], "all text must check out with LF; see .gitattributes");
	const result = spawnSync("git", ["ls-files", "--eol"], { cwd: REPO_ROOT, encoding: "utf8" });
	assert.equal(result.status, 0, `git ls-files --eol failed: ${result.stderr}`);
	const line = (index: string, worktree: string): string => `i/${index}    w/${worktree}    attr/text=auto eol=lf \tREADME.md`;
	for (const [index, worktree] of [["crlf", "lf"], ["mixed", "lf"], ["lf", "crlf"], ["lf", "mixed"]]) assert.equal(eolViolations(line(index, worktree)).length, 1, `must reject i/${index} w/${worktree}`);
	assert.deepEqual(eolViolations(line("lf", "lf")), [], "clean LF report must pass");
	assert.deepEqual(eolViolations("i/none    w/none    -text\tlogo.gif"), [], "non-text files must not be flagged");
	assert.match(result.stdout, /i\/lf\s+w\/lf/, "git ls-files --eol must report i/lf and w/lf");
	assert.deepEqual(eolViolations(result.stdout), [], "tracked text must be LF; stale Windows checkout recovery: git checkout -- .");
});

test("docs name the current Node and Pi floors", () => {
	const readme = readText(README_PATH);
	assert.deepEqual(new Set(readme.match(/Node\.js [\d.]+/g)), new Set([`Node.js ${EXPECTED_NODE_FLOOR}`]), "README must name only the Node floor");
	assert.ok(readme.includes(`Pi ${EXPECTED_PI_VERSION}`), "README must name the Pi floor");
	assert.doesNotMatch(readme, /0\.99\.2/, "README still names the retired Pi floor");
	const contributing = readText(CONTRIBUTING_PATH);
	assert.deepEqual(
		new Set(contributing.match(/[\d.]+ \(minimum\)/g)),
		new Set([`${EXPECTED_NODE_FLOOR} (minimum)`]),
		"CONTRIBUTING must name only the Node floor",
	);
});

test("audit-ci config enforces the reviewed allowlist policy", () => {
	const config = parseAuditConfig();
	assert.equal(config.$schema, AUDIT_SCHEMA);
	assert.equal(config.moderate, true);

	const entries = allowlistEntries(config);
	assert.deepEqual(new Set(entries.map(([key]) => key)), EXPECTED_ALLOWLIST_KEYS);
	const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
	for (const [key, value] of entries) {
		assert.match(key, /^GHSA-[a-z0-9-]+(?:\|[^|>]+(?:>[^|>]+)*)?$/);
		assert.equal(value.active, true);
		assert.match(value.expiry, /^\d{4}-\d{2}-\d{2}$/);
		assert.ok(Date.parse(`${value.expiry}T00:00:00Z`) >= today, `expired allowlist entry: ${key}`);
		assert.notEqual(value.notes.trim(), "");
	}
});

test("workflow keeps the expected matrix and audit/test order", () => {
	const workflow = readText(WORKFLOW_PATH);
	const packageJson = parsePackageJson();
	assert.match(workflow, /fail-fast:\s+false/);
	assert.deepEqual(parseMatrixEntries(workflow), EXPECTED_MATRIX);
	assert.ok(stepIndex(workflow, "Type check") < stepIndex(workflow, "Security audit"));
	assert.ok(stepIndex(workflow, "Security audit") < stepIndex(workflow, "Unit tests"));
	assert.ok(stepIndex(workflow, "Unit tests") < stepIndex(workflow, "E2E tests"));
	assert.match(workflow, /run: npx audit-ci --config audit-ci\.jsonc/);
	assert.ok(EXPECTED_MATRIX.has(`ubuntu-latest@${minimumNodeVersion(packageJson.engines.node)}`));
});

test("Windows current-Pi step runs after packed-host failure but not on cancellation", () => {
	const workflow = readText(WORKFLOW_PATH);
	const block = stepBlock(workflow, "Synchronized current Pi compatibility on Windows");
	assert.match(block, /if:\s*matrix\.os == 'windows-latest' && !cancelled\(\)/);
});

test("audit-ci config matches the CI audit command", () => {
	runAuditCi();
});
