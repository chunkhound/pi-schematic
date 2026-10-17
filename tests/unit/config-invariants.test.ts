/**
 * Invariant tests for the audit-ci security audit configuration.
 *
 * Validates the audit policy, that any allowlist entries have unexpired expiry
 * dates, and that CI preserves the audit → unit → e2e order.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWorkflowAutocompleteProvider } from "../../workflow/autocomplete.js";
import { CANCEL_CONFIRM_MS } from "../../workflow/command.js";
import { MAX_DEFERRED_EFFECTS, MAX_EFFECTS } from "../../workflow/host.js";
import { HANDOFF_COMPACTION_TIMEOUT_MS } from "../../workflow/rebind.js";
import { HARD_DEADLINE_FACTOR, MAX_TIMEOUT_MS } from "../../workflow/sandbox.js";
import { TIME_PRESET_MS, TIME_PRESETS } from "../../workflow/limits-dialog.js";
import { MAX_EFFECT_ROWS, MAX_MODELS_COLLAPSED } from "../../workflow/summary-renderer.js";
import { STRUCTURED_OUTPUT_TOOL } from "../../workflow/output.js";
import { RESERVED_REASONS } from "../../workflow/types.js";

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
	engines: { node: string };
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};

const AUDIT_SCHEMA = "https://github.com/IBM/audit-ci/raw/main/docs/schema.json";
const REPO_ROOT_URL = new URL("../../", import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);
const AUDIT_CONFIG_PATH = new URL("audit-ci.jsonc", REPO_ROOT_URL);
const PACKAGE_JSON_PATH = new URL("package.json", REPO_ROOT_URL);
const WORKFLOW_PATH = new URL(".github/workflows/test.yml", REPO_ROOT_URL);
const LOCK_PATH = new URL("package-lock.json", REPO_ROOT_URL);
const SPAWN_SOURCE_PATH = new URL("spawn/index.ts", REPO_ROOT_URL);
const RENDERER_SOURCE_PATH = new URL("spawn/renderer.ts", REPO_ROOT_URL);
const WORKFLOWS_DOC_PATH = new URL("docs/workflows.md", REPO_ROOT_URL);
const WORKFLOW_ENGINE_DOC_PATH = new URL("docs/workflow-engine.md", REPO_ROOT_URL);
// Pinned versions verified against package.json + lockfile.
// Update when Pi devDependencies are bumped.
const EXPECTED_PI_VERSION = "1.0.4";
const EXPECTED_TYPEBOX_VERSION = "1.3.27";
// Approved peer floors — must track the pinned devDependency versions above.
const EXPECTED_PI_PEER = `>=${EXPECTED_PI_VERSION}`;
const EXPECTED_TYPEBOX_PEER = `>=${EXPECTED_TYPEBOX_VERSION}`;
const EXPECTED_MATRIX = new Set([
	"ubuntu-latest@22.19.0",
	"ubuntu-latest@24",
	"macos-latest@24",
	"windows-latest@24",
]);
// Transitive brace-expansion advisories in the pinned test host
// @earendil-works/pi-coding-agent@1.0.4 (devDependency). Remove them when a
// pinned host ships a patched brace-expansion; the expiry forces periodic re-review.
const EXPECTED_ALLOWLIST_KEYS = new Set<string>([
	"GHSA-6j4f-fj2g-mc7p",
	"GHSA-qhr7-859c-m2p7",
	"GHSA-q2hr-2g5m-vwhr",
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

function parseIsoDate(value: string): number {
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	assert.notEqual(Number.isNaN(timestamp), true, `invalid ISO date: ${value}`);
	return timestamp;
}

function minimumNodeVersion(value: string): string {
	const match = value.match(/^>=(?<version>\d+\.\d+\.\d+)$/);
	assert.ok(match?.groups?.version, `unsupported engines.node format: ${value}`);
	return match.groups.version;
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

test("pinned Pi compatibility metadata and source boundaries stay exact", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as { packages: Record<string, { version?: string }> };
	assert.equal(packageJson.engines.node, ">=22.19.0");
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(packageJson.peerDependencies[name], EXPECTED_PI_PEER, `${name} peer must require ${EXPECTED_PI_PEER}`);
	}
	assert.equal(packageJson.peerDependencies.typebox, EXPECTED_TYPEBOX_PEER, `typebox peer must require ${EXPECTED_TYPEBOX_PEER}`);
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(packageJson.devDependencies[name], EXPECTED_PI_VERSION);
		assert.equal(lock.packages[`node_modules/${name}`]?.version, EXPECTED_PI_VERSION);
	}
	assert.equal(packageJson.devDependencies.typebox, EXPECTED_TYPEBOX_VERSION);
	assert.equal(lock.packages["node_modules/typebox"]?.version, EXPECTED_TYPEBOX_VERSION);

	const spawnSource = readText(SPAWN_SOURCE_PATH);
	assert.doesNotMatch(spawnSource, /\bAuthStorage\b|\bModelRegistry\b/);
	assert.doesNotMatch(spawnSource, /\bauthStorage\s*:/);
	assert.doesNotMatch(spawnSource, /sessionFactory\(\{[\s\S]*?\bmodelRegistry\s*:/);
	assert.match(spawnSource, /modelRegistry:\s*ctx\.modelRegistry/);
	assert.match(spawnSource, /model:\s*childModel/);
	assert.match(spawnSource, /session\.dispose\(\)/);
	const rendererSource = readText(RENDERER_SOURCE_PATH);
	assert.doesNotMatch(rendererSource, /console\.(?:debug|warn|error|log)\s*\(/);
	assert.doesNotMatch(rendererSource, /process\.(?:stdout|stderr)\.write\s*\(/);
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
		assert.ok(parseIsoDate(value.expiry) >= today, `expired allowlist entry: ${key}`);
		assert.notEqual(value.notes.trim(), "");
	}
});

test("workflow keeps the expected matrix and audit/test order", () => {
	const workflow = readText(WORKFLOW_PATH);
	const packageJson = parsePackageJson();
	assert.match(workflow, /fail-fast:\s+false/);
	assert.deepEqual(parseMatrixEntries(workflow), EXPECTED_MATRIX);
	assert.ok(stepIndex(workflow, "Type check") < stepIndex(workflow, "Security audit"));
	assert.ok(stepIndex(workflow, "Security audit") < stepIndex(workflow, "Coverage"));
	assert.ok(stepIndex(workflow, "Coverage") < stepIndex(workflow, "E2E tests"));
	assert.match(workflow, /run: npx audit-ci --config audit-ci\.jsonc/);
	assert.ok(EXPECTED_MATRIX.has(`ubuntu-latest@${minimumNodeVersion(packageJson.engines.node)}`));
});


// Constants: code owns every value. The engine doc names each constant and its owner file.
// Author-visible rule values are stated once in docs/workflows.md; pinned below to the code.
const CONTRACT_CONSTANT_ROWS: Array<[name: string, owner: string]> = [
	["CANCEL_CONFIRM_MS", "workflow/command.ts"],
	["HANDOFF_COMPACTION_TIMEOUT_MS", "workflow/rebind.ts"],
	["MAX_DEFERRED_EFFECTS", "workflow/host.ts"],
	["HARD_DEADLINE_FACTOR", "workflow/sandbox.ts"],
];
const INTERNAL_CONSTANT_ROWS: Array<[name: string, owner: string]> = [
	["MEMORY_LIMIT_BYTES", "workflow/command.ts"],
	["WORKFLOW_PROGRESS_TICK_MS", "workflow/command.ts"],
	["MAX_EFFECTS", "workflow/host.ts"],
	["MAX_TIMEOUT_MS", "workflow/sandbox.ts"],
	["STRUCTURED_OUTPUT_TOOL", "workflow/output.ts"],
	["MAX_EFFECT_ROWS", "workflow/summary-renderer.ts"],
	["MAX_MODELS_COLLAPSED", "workflow/summary-renderer.ts"],
	["MAX_ENTRY_OUTPUT_LINES", "workflow/activity.ts"],
	["MAX_ENTRY_OUTPUT_CHARS", "workflow/activity.ts"],
	["MAX_SUGGESTIONS", "workflow/autocomplete.ts"],
];

test("workflow engine constants stay pinned to the code and the docs name them", () => {
	// Exported knobs: the imported value must equal the reviewed pin.
	const exported: Array<[name: string, actual: unknown, expected: unknown]> = [
		["CANCEL_CONFIRM_MS", CANCEL_CONFIRM_MS, 500],
		["HANDOFF_COMPACTION_TIMEOUT_MS", HANDOFF_COMPACTION_TIMEOUT_MS, 15 * 60 * 1000],
		["MAX_DEFERRED_EFFECTS", MAX_DEFERRED_EFFECTS, 16],
		["MAX_EFFECTS", MAX_EFFECTS, 100],
		["MAX_TIMEOUT_MS", MAX_TIMEOUT_MS, 2147483647],
		["HARD_DEADLINE_FACTOR", HARD_DEADLINE_FACTOR, 2],
		["STRUCTURED_OUTPUT_TOOL", STRUCTURED_OUTPUT_TOOL, "workflow_output"],
		["MAX_EFFECT_ROWS", MAX_EFFECT_ROWS, 10],
		["MAX_MODELS_COLLAPSED", MAX_MODELS_COLLAPSED, 8],
	];
	for (const [name, actual, expected] of exported) {
		assert.equal(actual, expected, `${name} changed — update docs/workflows.md (rule owner) if the author-visible value moved`);
	}
	// Host-reserved abort reasons: exact tokens, in order.
	assert.deepEqual([...RESERVED_REASONS], ["cost-limit", "time-limit", "cancelled", "error"]);
	// Engine doc: every constant row names its owner file, which must exist. No value column.
	const engineDoc = readText(WORKFLOW_ENGINE_DOC_PATH);
	for (const [name, owner] of [...CONTRACT_CONSTANT_ROWS, ...INTERNAL_CONSTANT_ROWS]) {
		assert.match(engineDoc, new RegExp(`\\| \`${name}\` \\| \`${owner}\` \\|`), `engine-doc table lost the ${name} row`);
		assert.equal(existsSync(new URL(owner, REPO_ROOT_URL)), true, `${name} owner ${owner} is missing`);
	}
	assert.doesNotMatch(engineDoc, /^\| `[A-Z_]+` \|.*\d/m, "engine-doc constant rows must not restate values");
	// The constants section splits contract-visible knobs from internal knobs.
	const contractHeading = engineDoc.indexOf("Contract-visible knobs");
	const internalHeading = engineDoc.indexOf("Internal knobs");
	assert.ok(contractHeading >= 0 && internalHeading > contractHeading, "engine-doc constants must split contract-visible from internal");
	for (const [name] of CONTRACT_CONSTANT_ROWS) {
		assert.ok(engineDoc.indexOf(`\`${name}\``, contractHeading) < internalHeading, `${name} must sit in the contract-visible table`);
	}
	// workflows.md (rule owner) prose pins, each matching the code value above.
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	assert.match(workflowsDoc, /MAX_DEFERRED_EFFECTS = 16/);
	assert.match(workflowsDoc, /within 500 ms \(`CANCEL_CONFIRM_MS`\) confirms/);
	assert.match(workflowsDoc, /\*\*twice\*\* the soft time target/);
	// The handoff deadline is per wait, not one shared budget (workflow/rebind.ts).
	assert.match(workflowsDoc, /each handoff wait carries its own full 15-minute deadline/i);
	assert.doesNotMatch(workflowsDoc, /one absolute 15-minute deadline/i);
	// The dialog duration presets are stated once in the docs; pin the prose to the code so a
	// preset change forces a docs edit (TIME_PRESET_MS keys are the labels with a duration).
	const timePresetSentence = workflowsDoc.match(/the time presets are ([^;]+);/i);
	assert.ok(timePresetSentence, "docs/workflows.md lost the time-preset sentence");
	const documentedPresets = [...timePresetSentence[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	assert.deepEqual(documentedPresets, Object.keys(TIME_PRESET_MS));
	assert.ok(documentedPresets.every((label) => TIME_PRESETS.includes(label)), "every documented time preset must be a real UI preset");
});

test("the /workflow completion list is capped at the engine suggestion limit", async () => {
	const entries = Array.from({ length: 25 }, (_, index) => ({ name: `flow-${index}`, path: `/w/flow-${index}.js`, source: "global" as const, label: "global" }));
	const current = { getSuggestions: async () => null, applyCompletion: () => "", shouldTriggerFileCompletion: () => false };
	const provide = createWorkflowAutocompleteProvider(async () => entries)(current as any);
	const options = { signal: new AbortController().signal };
	const suggestions = (await provide.getSuggestions(["/workflow flow"], 0, "/workflow flow".length, options)) as { items: unknown[] };
	assert.equal(suggestions.items.length, 20);
});

test("workflow docs keep one owner per shared rule", () => {
	const workflowsDoc = readText(WORKFLOWS_DOC_PATH);
	const engineDoc = readText(WORKFLOW_ENGINE_DOC_PATH);
	// Rejection rules: workflows.md owns them; workflow-engine.md only points.
	assert.match(workflowsDoc, /Full rejection list \(compiler contract\)/);
	assert.match(engineDoc, /The rules live in \[workflows\.md\]/);
	assert.doesNotMatch(engineDoc, /\| Rejection \| Rule \|/);
	// Checkpoint optionality: the unbounded rule (incl. workflow.exit being terminal, not a checkpoint) lives only in Constraints.
	assert.match(workflowsDoc, /Checkpoints are optional\. Without `workflow\.checkpoint\(\.\.\.\)`, the workflow is unbounded/);
	assert.match(workflowsDoc, /`workflow\.exit` is terminal and is not a checkpoint/);
	// Example: workflows.md links the runnable script; it embeds no copy and no model id.
	assert.match(workflowsDoc, /examples\/workflows\/review\.js/);
	assert.doesNotMatch(workflowsDoc, /jev-latest|"typesafe"/);
	// Value restatements: the engine doc names MAX_EFFECTS / MAX_EFFECT_ROWS, never their values.
	assert.doesNotMatch(workflowsDoc, /MAX_EFFECTS = |MAX_EFFECT_ROWS = /);
	assert.match(workflowsDoc, /`MAX_EFFECTS`[^\n]*workflow-engine\.md/);
	assert.match(workflowsDoc, /`MAX_EFFECT_ROWS`[^\n]*workflow-engine\.md/);
	// workflow-limits: the engine-doc surfaces table lists it; the e2e run pins the entry.
	assert.match(engineDoc, /\| `workflow-limits` entry \| `workflow\/limits-dialog\.ts` \|/);
});

test("Windows current-Pi step runs after packed-host failure but not on cancellation", () => {
	const workflow = readText(WORKFLOW_PATH);
	const block = stepBlock(workflow, "Synchronized current Pi compatibility on Windows");
	assert.match(block, /if:\s*matrix\.os == 'windows-latest' && !cancelled\(\)/);
});

test("audit-ci config matches the CI audit command", () => {
	runAuditCi();
});
