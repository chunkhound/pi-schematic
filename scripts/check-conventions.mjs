import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- this script runs in CI on the current LTS, where matchesGlob is stable; below Node.js 22.20 it is experimental.
import { join, matchesGlob, resolve } from "node:path";
import { repoRootFromScript } from "./compat-process.mjs";

// The extensions are pinned here; the workflow keys its extension cache on this file's hash.
const EXTENSIONS = ["npm:@nqbao/pi-json-schema@0.1.1", "npm:@aantenore/pi-budget@0.1.0", "npm:@router-for-me/pi-cliproxyapi-provider@1.4.24"];
const MAX_TURNS = 30;
const CONVENTIONS_DIR = "docs/conventions";
const SKILL_NAME = "checking-convention";
const SKILL_PATH = `.agents/skills/${SKILL_NAME}/SKILL.md`;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERDICTS = ["pass", "violation", "not_applicable"];
const RESULT_KEYS = ["convention", "sentence", "verdict", "file", "line", "quote"];
const OUTPUT_TAIL = 8192;
const SUMMARY_WIDTH = 120;
const BUDGET_NOTICE = "[pi-budget] Budget: reached turns limit (";
// The other stop reasons pi-ai defines (pending, length, error, aborted, deferred) end a run that did not complete.
const COMPLETED_STOP_REASONS = ["stop", "toolUse"];
const USAGE = [
	"Usage: node scripts/check-conventions.mjs --list --base <ref>",
	"       CONVENTIONS_CHECK_MODEL=<provider/model> node scripts/check-conventions.mjs --base <ref> --convention <slug> --events <file>",
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
		throw new UsageError("--convention needs a slug");
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

// stderr keeps the --list output on stdout a single JSON value; the runner reads workflow commands from both streams.
function notice(message) {
	process.stderr.write(`::notice::${escapeData(message)}\n`);
}

// Returns [{ file, text }] for each convention file, in file-name order. The conventions come from the base revision,
// so a pull request cannot change the conventions it is checked against.
function readConventionFiles(root, baseSha, base) {
	const listed = gitChecked(root, ["ls-tree", "-z", "--name-only", baseSha, "--", `${CONVENTIONS_DIR}/`])
		.split("\0")
		.filter((file) => file.endsWith(".md") && file !== `${CONVENTIONS_DIR}/README.md`)
		.sort();
	if (listed.length > 0) {
		return listed.map((file) => ({ file, text: gitChecked(root, ["show", `${baseSha}:${file}`]) }));
	}
	// The pull request that adds the conventions has no base copy to check against.
	const local = join(root, CONVENTIONS_DIR);
	const files = existsSync(local)
		? readdirSync(local)
				.filter((name) => name.endsWith(".md") && name !== "README.md")
				.sort()
		: [];
	if (files.length === 0) {
		throw new Error(`neither ${base} nor the working tree has convention files in ${CONVENTIONS_DIR}/`);
	}
	notice(`${base} has no convention files in ${CONVENTIONS_DIR}/; checking against the working tree's copies`);
	return files.map((name) => ({ file: `${CONVENTIONS_DIR}/${name}`, text: readFileSync(join(local, name), "utf8") }));
}

// The review instructions come from the base revision too, so a pull request cannot change its own reviewer's instructions.
function readSkill(root, baseSha, base) {
	const listed = gitChecked(root, ["ls-tree", "--name-only", baseSha, "--", SKILL_PATH]).trim();
	if (listed === SKILL_PATH) {
		return gitChecked(root, ["show", `${baseSha}:${SKILL_PATH}`]);
	}
	const local = join(root, SKILL_PATH);
	if (!existsSync(local)) {
		throw new Error(`neither ${base} nor the working tree has ${SKILL_PATH}`);
	}
	notice(`${base} has no ${SKILL_PATH}; reviewing with the working tree's copy`);
	return readFileSync(local, "utf8");
}

// A convention file is frontmatter holding only a `paths` list of double-quoted globs, then an H1 that names the convention.
function parseConvention({ file, text }) {
	const slug = file.slice(CONVENTIONS_DIR.length + 1, -".md".length);
	if (!SLUG.test(slug)) {
		throw new Error(`${file}: the file name must be a slug of lowercase letters, digits and single hyphens`);
	}
	const lines = text.split(/\r?\n/);
	if (lines[0] !== "---") {
		throw new Error(`${file}: the first line must be "---", the start of the frontmatter`);
	}
	if (lines[1] !== "paths:") {
		throw new Error(`${file}: line 2 must be "paths:", the only frontmatter key`);
	}
	const include = [];
	const exclude = [];
	let index = 2;
	for (; index < lines.length && lines[index] !== "---"; index++) {
		const item = /^ {2}- (".*")$/.exec(lines[index]);
		if (item === null) {
			throw new Error(`${file}: line ${String(index + 1)} must be a paths item of the form '  - "<glob>"'`);
		}
		let glob;
		try {
			glob = JSON.parse(item[1]);
		} catch (error) {
			throw new Error(`${file}: line ${String(index + 1)} is not a valid JSON string: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		}
		const pattern = glob.startsWith("!") ? glob.slice(1) : glob;
		if (pattern === "") {
			throw new Error(`${file}: line ${String(index + 1)} has an empty glob`);
		}
		if (pattern.startsWith("/") || pattern.split("/").some((segment) => segment === ".." || segment === ".")) {
			throw new Error(`${file}: line ${String(index + 1)} has the glob ${JSON.stringify(glob)}, which must be relative and contain no "." or ".." segment`);
		}
		(glob.startsWith("!") ? exclude : include).push(pattern);
	}
	if (index === lines.length) {
		throw new Error(`${file}: the frontmatter has no closing "---"`);
	}
	if (include.length === 0) {
		throw new Error(`${file}: paths has no including glob`);
	}
	const heading = lines.slice(index + 1).find((line) => line.trim() !== "");
	const name = heading === undefined ? null : /^# (.*\S)\s*$/.exec(heading)?.[1];
	if (name === undefined || name === null) {
		throw new Error(`${file}: the first non-empty line after the frontmatter must be an H1 "# <name>"`);
	}
	return { file, slug, name, include, exclude, text };
}

function parseConventions(files) {
	const conventions = files.map(parseConvention);
	const names = new Set();
	for (const { file, name } of conventions) {
		if (names.has(name)) {
			throw new Error(`${file}: another convention file is also named ${JSON.stringify(name)}`);
		}
		names.add(name);
	}
	return conventions;
}

// The same range as the diff pi reviews. Without rename detection, a renamed file appears under both its names.
function changedFiles(root, baseSha) {
	return gitChecked(root, ["diff", "--name-only", "--no-renames", "-z", `${baseSha}...HEAD`])
		.split("\0")
		.filter((file) => file !== "");
}

function matchingFiles(convention, changed) {
	return changed.filter((file) => convention.include.some((glob) => matchesGlob(file, glob)) && !convention.exclude.some((glob) => matchesGlob(file, glob)));
}

// A convention is selected when at least one changed file matches its paths.
function selectConventions(conventions, changed) {
	const selected = [];
	for (const convention of conventions) {
		if (matchingFiles(convention, changed).length > 0) {
			selected.push(convention);
		} else {
			notice(`Skipping convention ${JSON.stringify(convention.name)}: no changed file matches its paths`);
		}
	}
	return selected;
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

// pi expands a skill command only at the start of the message, and passes the text after the command's name on as its input.
// The space after the name is required: pi takes the name up to the first space.
function prompt(conventionPath, name, diffPath, files) {
	return [
		`/skill:${SKILL_NAME} `,
		`Convention file: ${conventionPath}`,
		`Convention name: ${JSON.stringify(name)}`,
		`Diff file: ${diffPath}`,
		"Changed files matching the convention's paths (each name is a JSON string):",
		...files.map((name) => JSON.stringify(name)),
		`Turn limit: ${String(MAX_TURNS)}`,
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

function review(root, workDir, diffPath, skill, convention, files, events, model) {
	process.stdout.write(`Reviewing convention ${JSON.stringify(convention.name)}.\n`);
	const runDir = join(workDir, convention.slug);
	mkdirSync(runDir);
	const conventionPath = join(runDir, `${convention.slug}.md`);
	writeFileSync(conventionPath, convention.text);
	// pi loads a skill directory that holds a SKILL.md; the frontmatter's name is the one the skill command uses.
	const skillDir = join(runDir, SKILL_NAME);
	mkdirSync(skillDir);
	writeFileSync(join(skillDir, "SKILL.md"), skill);
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
				// An explicit --skill path still loads under --no-skills.
				"--no-skills",
				"--skill",
				skillDir,
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
				prompt(conventionPath, convention.name, diffPath, files),
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
	printTurns(turns, convention.name);
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
	const invalid = validateVerdict(verdict, convention.name);
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
	const conventions = parseConventions(readConventionFiles(root, baseSha, base));
	// A named convention is reviewed whether or not the changed files select it.
	const named = mode === "convention" ? conventions.find(({ slug }) => slug === convention) : undefined;
	if (mode === "convention" && named === undefined) {
		throw new UsageError(`${CONVENTIONS_DIR}/ has no convention with the slug ${JSON.stringify(convention)}`);
	}
	const skill = readSkill(root, baseSha, base);
	const diffPath = writeDiff(root, workDir, baseSha, base);
	if (diffPath === undefined) {
		return 0;
	}
	const changed = changedFiles(root, baseSha);
	if (named !== undefined) {
		return review(root, workDir, diffPath, skill, named, matchingFiles(named, changed), events, model);
	}

	const selected = selectConventions(conventions, changed);
	if (selected.length === 0) {
		process.stdout.write("No changed file matches the paths of any convention; nothing to check.\n");
		return 0;
	}
	mkdirSync(events, { recursive: true });
	const failed = [];
	for (const selection of selected) {
		if (review(root, workDir, diffPath, skill, selection, matchingFiles(selection, changed), join(events, `${selection.slug}.jsonl`), model) !== 0) {
			failed.push(selection.name);
		}
	}
	if (failed.length > 0) {
		process.stderr.write(
			`${String(failed.length)} of ${String(selected.length)} conventions failed: ${failed.map((name) => JSON.stringify(name)).join(", ")}\n`,
		);
		return 1;
	}
	process.stdout.write(`All ${String(selected.length)} conventions passed.\n`);
	return 0;
}

function main() {
	try {
		const options = parseArgs(process.argv.slice(2));
		const root = repoRootFromScript(import.meta.url);
		if (options.mode === "list") {
			const baseSha = resolveBase(root, options.base);
			const conventions = parseConventions(readConventionFiles(root, baseSha, options.base));
			const selected = selectConventions(conventions, changedFiles(root, baseSha));
			process.stdout.write(`${JSON.stringify(selected.map(({ name, slug }) => ({ name, slug })))}\n`);
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
