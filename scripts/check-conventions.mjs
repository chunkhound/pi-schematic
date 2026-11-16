import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRootFromScript } from "./compat-process.mjs";

// The extensions are pinned here; the workflow keys its extension cache on this file's hash.
const EXTENSIONS = ["npm:@nqbao/pi-json-schema@0.1.1", "npm:@aantenore/pi-budget@0.1.0", "npm:@router-for-me/pi-cliproxyapi-provider@1.4.24"];
const MAX_TURNS = 30;
const CONVENTIONS_PATH = "docs/conventions.md";
const VERDICTS = ["pass", "violation", "not_applicable"];
const RESULT_KEYS = ["convention", "sentence", "verdict", "file", "line", "quote"];
const OUTPUT_TAIL = 8192;
const SUMMARY_WIDTH = 120;
const BUDGET_NOTICE = "[pi-budget] Budget: reached turns limit (";
// The other stop reasons pi-ai defines (pending, length, error, aborted, deferred) end a run that did not complete.
const COMPLETED_STOP_REASONS = ["stop", "toolUse"];
const USAGE = [
	"Usage: node scripts/check-conventions.mjs --list --base <ref>",
	"       CONVENTIONS_CHECK_MODEL=<provider/model> node scripts/check-conventions.mjs --base <ref> --convention <heading> --events <file>",
	"       CONVENTIONS_CHECK_MODEL=<provider/model> node scripts/check-conventions.mjs --base <ref> --events <directory>",
].join("\n");
const commandToken = randomBytes(16).toString("hex");

function untrusted(stream, text) {
	if (process.env.GITHUB_ACTIONS !== undefined) {
		stream.write(`::stop-commands::${commandToken}\n${text}\n::${commandToken}::\n`);
	} else {
		stream.write(`${text}\n`);
	}
}

class UsageError extends Error {}

function git(root, args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) {
		throw result.error;
	}
	return result;
}

function gitChecked(root, args) {
	const result = git(root, args);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed with status ${String(result.status)}: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

function parseArgs(argv) {
	let base;
	let events;
	let convention;
	let list = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--base" && i + 1 < argv.length && base === undefined) {
			base = argv[++i];
		} else if (argv[i] === "--events" && i + 1 < argv.length && events === undefined) {
			events = argv[++i];
		} else if (argv[i] === "--convention" && i + 1 < argv.length && convention === undefined) {
			convention = argv[++i];
		} else if (argv[i] === "--list" && !list) {
			list = true;
		} else {
			throw new UsageError(`unexpected argument ${JSON.stringify(argv[i])}`);
		}
	}
	if (base === undefined || base === "") {
		throw new UsageError("--base <ref> is required");
	}
	if (list) {
		if (convention !== undefined || events !== undefined) {
			throw new UsageError("--list takes only --base");
		}
		return { mode: "list", base };
	}
	if (convention === "") {
		throw new UsageError("--convention needs a heading");
	}
	if (events === undefined || events === "") {
		throw new UsageError("--events is required: a file with --convention, a directory without it");
	}
	const model = process.env.CONVENTIONS_CHECK_MODEL;
	if (model === undefined || model === "") {
		throw new UsageError("the CONVENTIONS_CHECK_MODEL environment variable (provider/model) is required");
	}
	return { mode: convention === undefined ? "all" : "convention", base, convention, events: resolve(events), model };
}

function escapeData(value) {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value) {
	return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function resolveBase(root, base) {
	const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
	if (resolved.status !== 0) {
		throw new Error(`the base ref ${JSON.stringify(base)} does not resolve to a commit`);
	}
	return resolved.stdout.trim();
}

function readConventions(root, baseSha, base) {
	const listed = gitChecked(root, ["ls-tree", "--name-only", baseSha, "--", CONVENTIONS_PATH]).trim();
	if (listed === CONVENTIONS_PATH) {
		return gitChecked(root, ["show", `${baseSha}:${CONVENTIONS_PATH}`]);
	}
	// The pull request that adds the conventions file has no base copy to check against.
	const local = join(root, CONVENTIONS_PATH);
	if (!existsSync(local)) {
		throw new Error(`neither ${base} nor the working tree has ${CONVENTIONS_PATH}`);
	}
	// stderr keeps the --list output on stdout a single JSON value; the runner reads workflow commands from both streams.
	process.stderr.write(`::notice::${escapeData(`${base} has no ${CONVENTIONS_PATH}; checking against the working tree's copy`)}\n`);
	return readFileSync(local, "utf8");
}

function slugify(heading) {
	return heading
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

// A convention's section runs from its H2 heading to the next H2 heading or the end of the file.
// A `## ` line inside a fenced code block is example text, not a heading.
function parseConventions(conventions) {
	const matches = [];
	let fence = null;
	for (const line of conventions.matchAll(/^.*$/gm)) {
		// A fence closes on a run of the same character at least as long as the one that opened it.
		const marker = /^(`{3,}|~{3,})/.exec(line[0])?.[1];
		if (marker !== undefined && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
			fence = fence === null ? marker : null;
			continue;
		}
		const heading = fence === null ? /^## (.+?)\r?$/.exec(line[0]) : null;
		if (heading !== null) {
			matches.push({ index: line.index, name: heading[1] });
		}
	}
	if (fence !== null) {
		throw new Error(`${CONVENTIONS_PATH} has an unclosed ${fence} code fence`);
	}
	if (matches.length === 0) {
		throw new Error(`${CONVENTIONS_PATH} has no H2 headings`);
	}
	const sections = matches.map((match, index) => ({
		name: match.name,
		slug: slugify(match.name),
		text: conventions.slice(match.index, matches[index + 1]?.index ?? conventions.length),
	}));
	const names = new Set();
	const slugs = new Set();
	for (const { name, slug } of sections) {
		if (names.has(name)) {
			throw new Error(`${CONVENTIONS_PATH} has two conventions headed ${JSON.stringify(name)}`);
		}
		if (slug === "") {
			throw new Error(`the heading ${JSON.stringify(name)} has no letters or digits to name it by`);
		}
		if (slugs.has(slug)) {
			throw new Error(`${CONVENTIONS_PATH} has two headings with the slug ${JSON.stringify(slug)}`);
		}
		names.add(name);
		slugs.add(slug);
	}
	return sections;
}

function isStringOrNull(value) {
	return value === null || typeof value === "string";
}

function validateVerdict(verdict, heading) {
	if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
		return "the verdict is not an object";
	}
	const keys = Object.keys(verdict);
	if (keys.length !== 1 || keys[0] !== "results") {
		return `the verdict has keys ${JSON.stringify(keys)}, expected only "results"`;
	}
	if (!Array.isArray(verdict.results)) {
		return "results is not an array";
	}
	if (verdict.results.length === 0) {
		return "results is empty";
	}
	for (const [index, result] of verdict.results.entries()) {
		const where = `results[${String(index)}]`;
		if (typeof result !== "object" || result === null || Array.isArray(result)) {
			return `${where} is not an object`;
		}
		const resultKeys = Object.keys(result).sort();
		if (JSON.stringify(resultKeys) !== JSON.stringify([...RESULT_KEYS].sort())) {
			return `${where} has keys ${JSON.stringify(resultKeys)}, expected ${JSON.stringify(RESULT_KEYS)}`;
		}
		if (typeof result.convention !== "string" || typeof result.sentence !== "string") {
			return `${where}.convention and .sentence must be strings`;
		}
		if (result.convention !== heading) {
			return `${where}.convention is ${JSON.stringify(result.convention)}, expected ${JSON.stringify(heading)}`;
		}
		if (!VERDICTS.includes(result.verdict)) {
			return `${where}.verdict is ${JSON.stringify(result.verdict)}, expected one of ${VERDICTS.join(", ")}`;
		}
		if (!isStringOrNull(result.file) || !isStringOrNull(result.quote)) {
			return `${where}.file and .quote must be strings or null`;
		}
		if (result.line !== null && !(Number.isInteger(result.line) && result.line >= 1)) {
			return `${where}.line must be an integer of at least 1 or null`;
		}
	}
	return null;
}

function reportViolation(result) {
	const site = result.file === null ? "" : result.line === null ? `${result.file}: ` : `${result.file}:${String(result.line)}: `;
	const quote = result.quote === null ? "" : ` — ${result.quote}`;
	const line = `${site}[${result.convention}] ${result.sentence}${quote}`;
	untrusted(process.stdout, process.env.GITHUB_ACTIONS === undefined ? line.replace(/[\r\n]/g, " ") : line);
	if (process.env.GITHUB_ACTIONS !== undefined) {
		const properties = [];
		if (result.file !== null) {
			properties.push(`file=${escapeProperty(result.file)}`);
			if (result.line !== null) {
				properties.push(`line=${String(result.line)}`);
			}
		}
		properties.push(`title=${escapeProperty(result.convention)}`);
		process.stdout.write(`::error ${properties.join(",")}::${escapeData(`${result.sentence}${quote}`)}\n`);
	}
}

function truncate(text) {
	return text.length > SUMMARY_WIDTH ? `${text.slice(0, SUMMARY_WIDTH - 1)}…` : text;
}

function mainArgument(args) {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	return [args.command, args.pattern, args.path].find((value) => typeof value === "string");
}

// Each turn holds the tool calls and token usage of its assistant messages, read from pi's JSON event stream.
// lastMessage is the final assistant message, whose stop reason pi does not report in JSON mode.
function readTurns(eventsPath) {
	const turns = [];
	let lastMessage;
	for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof event !== "object" || event === null) {
			continue;
		}
		if (event.type === "turn_start") {
			turns.push({ toolCalls: [], input: 0, output: 0, cacheRead: 0 });
			continue;
		}
		const turn = turns.at(-1);
		if (event.type !== "message_end" || event.message?.role !== "assistant" || turn === undefined) {
			continue;
		}
		lastMessage = event.message;
		turn.input += event.message.usage.input;
		turn.output += event.message.usage.output;
		turn.cacheRead += event.message.usage.cacheRead;
		for (const content of event.message.content) {
			if (content.type === "toolCall") {
				const argument = mainArgument(content.arguments);
				turn.toolCalls.push(argument === undefined ? content.name : `${content.name} ${JSON.stringify(argument)}`);
			}
		}
	}
	return { turns, lastMessage };
}

function printTurns(turns, heading) {
	const lines = [];
	for (const [index, turn] of turns.entries()) {
		lines.push(`turn ${String(index + 1)}`);
		for (const toolCall of turn.toolCalls) {
			lines.push(`  ${truncate(toolCall)}`);
		}
		lines.push(`  tokens: ${String(turn.input)} in, ${String(turn.output)} out`);
	}
	const sum = (key) => turns.reduce((total, turn) => total + turn[key], 0);
	lines.push(
		`${String(turns.length)} turns, ${String(sum("input"))} input tokens, ${String(sum("output"))} output tokens, ${String(sum("cacheRead"))} cache read`,
	);
	// Workflow commands are ignored inside a stop-commands window, so the group lines go outside it.
	if (process.env.GITHUB_ACTIONS !== undefined) {
		process.stdout.write(`::group::${escapeData(`pi turns: ${heading}`)}\n`);
	}
	untrusted(process.stdout, lines.join("\n"));
	if (process.env.GITHUB_ACTIONS !== undefined) {
		process.stdout.write("::endgroup::\n");
	}
}

function prompt(diffPath, conventionsPath, heading) {
	return [
		`Review the pull request diff in ${diffPath} against the convention ${JSON.stringify(heading)} in ${conventionsPath}; both files are attached above.`,
		"Check every sentence of the convention.",
		"The working directory is the pull request head; read its files with the tools when the diff alone does not settle a sentence.",
		"A sentence is a violation only when the pull request's changes make it false. A sentence the changes do not touch is not_applicable; one they touch and keep true is pass.",
		`Return one result per sentence: the convention's heading ${JSON.stringify(heading)}, the sentence verbatim, and as evidence the file path relative to the repository root, the line number in the pull request head and a verbatim quote of that line. Use null for evidence that does not exist.`,
		"Call json_output exactly once with all results.",
	].join("\n");
}

// Returns the diff file's path, or undefined when the pull request changes nothing.
function writeDiff(root, workDir, baseSha, base) {
	const diffPath = join(workDir, "pr.diff");
	// The diff goes to a file: a large diff exceeds both the spawn output buffer and Linux's 128 KiB limit on one argument.
	const diffFd = openSync(diffPath, "w");
	let diff;
	try {
		diff = spawnSync("git", ["diff", `${baseSha}...HEAD`], { cwd: root, stdio: ["ignore", diffFd, "pipe"], encoding: "utf8" });
	} finally {
		closeSync(diffFd);
	}
	if (diff.error) {
		throw diff.error;
	}
	if (diff.status !== 0) {
		throw new Error(`git diff ${base}...HEAD failed with status ${String(diff.status)}: ${diff.stderr.trim()}`);
	}
	if (statSync(diffPath).size === 0) {
		process.stdout.write(`No changes between ${base} and HEAD; nothing to check.\n`);
		return undefined;
	}
	return diffPath;
}

function review(root, workDir, diffPath, section, events, model) {
	process.stdout.write(`Reviewing convention ${JSON.stringify(section.name)}.\n`);
	const runDir = join(workDir, section.slug);
	mkdirSync(runDir);
	const conventionsPath = join(runDir, "conventions.md");
	writeFileSync(conventionsPath, section.text);
	const verdictPath = join(runDir, "verdict.json");
	const schema = readFileSync(join(root, "scripts", "conventions-verdict.schema.json"), "utf8");

	// The event stream goes straight to the events file, so the spawn output buffer does not bound its size.
	const eventsFd = openSync(events, "w");
	let pi;
	try {
		pi = spawnSync(
			join(root, "node_modules", ".bin", "pi"),
			[
				"-p",
				"--mode",
				"json",
				"--model",
				model,
				"--no-extensions",
				...EXTENSIONS.flatMap((extension) => ["-e", extension]),
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-approve",
				"--no-session",
				// --tools keeps MCP tools unless disabled, so the allowlist alone would not bound the agent.
				"--no-mcp",
				"--tools",
				"read,grep,find,ls,json_output",
				"--json-schema",
				JSON.stringify(JSON.parse(schema)),
				"--json-output",
				verdictPath,
				// The best-effort fallback fails with the CLIProxyAPI provider; without json_output there is no verdict.
				"--json-fallback",
				"none",
				"--budget-turns",
				String(MAX_TURNS),
				`@${conventionsPath}`,
				`@${diffPath}`,
				prompt(diffPath, conventionsPath, section.name),
			],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", eventsFd, "pipe"], maxBuffer: 64 * 1024 * 1024 },
		);
	} finally {
		closeSync(eventsFd);
	}
	if (pi.error) {
		throw pi.error;
	}
	const { turns, lastMessage } = readTurns(events);
	printTurns(turns, section.name);
	// A budget stop fails even when a verdict was written before it.
	if (pi.stderr.includes(BUDGET_NOTICE)) {
		untrusted(
			process.stderr,
			`The turn budget of ${String(MAX_TURNS)} was exhausted after ${String(turns.length)} turns. stderr tail:\n${pi.stderr.slice(-OUTPUT_TAIL)}`,
		);
		return 1;
	}
	if (lastMessage !== undefined && !COMPLETED_STOP_REASONS.includes(lastMessage.stopReason)) {
		const message = `pi's last response stopped with reason ${JSON.stringify(lastMessage.stopReason)}: ${lastMessage.errorMessage ?? "no error message"}`;
		untrusted(process.stderr, process.env.GITHUB_ACTIONS === undefined ? message.replace(/[\r\n]/g, " ") : message);
		return 1;
	}
	if (pi.status !== 0) {
		untrusted(process.stderr, `pi exited with status ${String(pi.status)}, signal ${String(pi.signal)}. stderr tail:\n${pi.stderr.slice(-OUTPUT_TAIL)}`);
		return 1;
	}
	if (!existsSync(verdictPath)) {
		untrusted(process.stderr, `pi wrote no verdict (json_output was never called). stderr tail:\n${pi.stderr.slice(-OUTPUT_TAIL)}`);
		return 1;
	}
	let verdict;
	try {
		verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
	} catch (error) {
		const message = `The verdict is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
		untrusted(process.stderr, process.env.GITHUB_ACTIONS === undefined ? message.replace(/[\r\n]/g, " ") : message);
		return 1;
	}
	const invalid = validateVerdict(verdict, section.name);
	if (invalid !== null) {
		const message = `The verdict does not match the schema: ${invalid}`;
		untrusted(process.stderr, process.env.GITHUB_ACTIONS === undefined ? message.replace(/[\r\n]/g, " ") : message);
		return 1;
	}

	const violations = verdict.results.filter((result) => result.verdict === "violation");
	for (const violation of violations) {
		reportViolation(violation);
	}
	process.stdout.write(`${String(verdict.results.length)} sentences checked, ${String(violations.length)} violations.\n`);
	return violations.length > 0 ? 1 : 0;
}

function check(root, workDir, { mode, base, convention, events, model }) {
	const baseSha = resolveBase(root, base);
	const sections = parseConventions(readConventions(root, baseSha, base));
	const selected = mode === "convention" ? sections.find((section) => section.name === convention) : undefined;
	if (mode === "convention" && selected === undefined) {
		throw new UsageError(`${CONVENTIONS_PATH} has no convention headed ${JSON.stringify(convention)}`);
	}
	const diffPath = writeDiff(root, workDir, baseSha, base);
	if (diffPath === undefined) {
		return 0;
	}
	if (selected !== undefined) {
		return review(root, workDir, diffPath, selected, events, model);
	}

	mkdirSync(events, { recursive: true });
	const failed = [];
	for (const section of sections) {
		if (review(root, workDir, diffPath, section, join(events, `${section.slug}.jsonl`), model) !== 0) {
			failed.push(section.name);
		}
	}
	if (failed.length > 0) {
		process.stderr.write(
			`${String(failed.length)} of ${String(sections.length)} conventions failed: ${failed.map((name) => JSON.stringify(name)).join(", ")}\n`,
		);
		return 1;
	}
	process.stdout.write(`All ${String(sections.length)} conventions passed.\n`);
	return 0;
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const root = repoRootFromScript(import.meta.url);
		if (options.mode === "list") {
			const sections = parseConventions(readConventions(root, resolveBase(root, options.base), options.base));
			process.stdout.write(`${JSON.stringify(sections.map(({ name, slug }) => ({ name, slug })))}\n`);
			return 0;
		}
		const workDir = mkdtempSync(join(tmpdir(), "check-conventions-"));
		try {
			return check(root, workDir, options);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`check-conventions: ${error.message}\n${USAGE}\n`);
			return 2;
		}
		throw error;
	}
}

process.exitCode = main();
