import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--base" && i + 1 < argv.length && base === undefined) {
			base = argv[++i];
		} else if (argv[i] === "--events" && i + 1 < argv.length && events === undefined) {
			events = argv[++i];
		} else {
			throw new UsageError(`unexpected argument ${JSON.stringify(argv[i])}`);
		}
	}
	if (base === undefined || base === "") {
		throw new UsageError("--base <ref> is required");
	}
	if (events === undefined || events === "") {
		throw new UsageError("--events <file> is required");
	}
	const model = process.env.CONVENTIONS_CHECK_MODEL;
	if (model === undefined || model === "") {
		throw new UsageError("the CONVENTIONS_CHECK_MODEL environment variable (provider/model) is required");
	}
	return { base, events: resolve(events), model };
}

function escapeData(value) {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value) {
	return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
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
	process.stdout.write(`::notice::${escapeData(`${base} has no ${CONVENTIONS_PATH}; checking against the working tree's copy`)}\n`);
	return readFileSync(local, "utf8");
}

function isStringOrNull(value) {
	return value === null || typeof value === "string";
}

function validateVerdict(verdict, conventions) {
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
	const headings = new Set(Array.from(conventions.matchAll(/^## (.+)\r?$/gm), (match) => match[1]));
	if (headings.size === 0) {
		return "conventions has no H2 headings";
	}
	const reported = new Set();
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
		if (!headings.has(result.convention)) {
			return `${where}.convention names no heading: ${JSON.stringify(result.convention)}`;
		}
		reported.add(result.convention);
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
	for (const heading of headings) {
		if (!reported.has(heading)) {
			return `no result for convention ${JSON.stringify(heading)}`;
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

function printTurns(turns) {
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
		process.stdout.write("::group::pi turns\n");
	}
	untrusted(process.stdout, lines.join("\n"));
	if (process.env.GITHUB_ACTIONS !== undefined) {
		process.stdout.write("::endgroup::\n");
	}
}

function prompt(diffPath, conventionsPath) {
	return [
		`Review the pull request diff in ${diffPath} against the conventions in ${conventionsPath}; both files are attached above.`,
		"Check every sentence of every convention.",
		"The working directory is the pull request head; read its files with the tools when the diff alone does not settle a sentence.",
		"A sentence is a violation only when the pull request's changes make it false. A sentence the changes do not touch is not_applicable; one they touch and keep true is pass.",
		"Return one result per (convention, sentence) pair: the convention's heading, the sentence verbatim, and as evidence the file path relative to the repository root, the line number in the pull request head and a verbatim quote of that line. Use null for evidence that does not exist.",
		"Call json_output exactly once with all results.",
	].join("\n");
}

function check(root, workDir, { base, events, model }) {
	const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
	if (resolved.status !== 0) {
		throw new Error(`the base ref ${JSON.stringify(base)} does not resolve to a commit`);
	}
	const baseSha = resolved.stdout.trim();

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
		return 0;
	}

	const conventionsPath = join(workDir, "conventions.md");
	const conventions = readConventions(root, baseSha, base);
	writeFileSync(conventionsPath, conventions);
	const verdictPath = join(workDir, "verdict.json");
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
				prompt(diffPath, conventionsPath),
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
	printTurns(turns);
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
	const invalid = validateVerdict(verdict, conventions);
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

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(
				`check-conventions: ${error.message}\nUsage: CONVENTIONS_CHECK_MODEL=<provider/model> node scripts/check-conventions.mjs --base <ref> --events <file>\n`,
			);
			return 2;
		}
		throw error;
	}
	const root = repoRootFromScript(import.meta.url);
	const workDir = mkdtempSync(join(tmpdir(), "check-conventions-"));
	try {
		return check(root, workDir, options);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

process.exitCode = main();
