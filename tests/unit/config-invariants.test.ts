/**
 * Invariant tests for the audit-ci security audit configuration.
 *
 * Validates the audit policy, that any allowlist entries have unexpired expiry
 * dates, and that CI preserves the audit → unit → e2e order.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
const REPO_ROOT_URL = new URL("../../", import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);
const AUDIT_CONFIG_PATH = new URL("audit-ci.jsonc", REPO_ROOT_URL);
const PACKAGE_JSON_PATH = new URL("package.json", REPO_ROOT_URL);
const WORKFLOW_PATH = new URL(".github/workflows/test.yml", REPO_ROOT_URL);
const LOCK_PATH = new URL("package-lock.json", REPO_ROOT_URL);
const SPAWN_SOURCE_PATH = new URL("spawn/index.ts", REPO_ROOT_URL);
const RENDERER_SOURCE_PATH = new URL("spawn/renderer.ts", REPO_ROOT_URL);
const README_PATH = new URL("README.md", REPO_ROOT_URL);
// Pinned versions verified against package.json + lockfile.
// Update when Pi devDependencies are bumped.
const EXPECTED_PI_VERSION = "1.0.4";
const EXPECTED_TYPEBOX_VERSION = "1.3.27";
// Floor for CI, engines, and the matrix. Bump only with the workflow and README.
const EXPECTED_NODE_FLOOR = "22.19.0";
// Approved peer floors — must track the pinned devDependency versions above.
const EXPECTED_PI_PEER = `>=${EXPECTED_PI_VERSION}`;
const EXPECTED_TYPEBOX_PEER = `>=${EXPECTED_TYPEBOX_VERSION}`;
const EXPECTED_MATRIX = new Set([
	"ubuntu-latest@22.19.0",
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

const SEMVER = /\d+\.\d+\.\d+/;
const NODE_FLOOR = /^\s*NODE_FLOOR: "(?<floor>\d+\.\d+\.\d+)"$/;

function workflowNodeFloor(workflow: string): string {
	const floor = workflow.split("\n").find((line) => NODE_FLOOR.test(line))?.match(NODE_FLOOR)?.groups?.floor;
	assert.ok(floor, "workflow env must define NODE_FLOOR");
	return floor;
}

// WHY: only the root env.NODE_FLOOR and matrix entries may pin the floor. Step-level
// pins, same-major literals, and stale full versions re-introduce a second source of
// truth, while a nested NODE_FLOOR override silently diverges the conditions. Comment
// text is stripped before matching, so prose may name the floor without being a source.
function floorLiteralViolations(workflow: string, floor: string): string[] {
	const lines = workflow.split("\n");
	const exempt = matrixLineIndices(lines);
	exempt.add(lines.findIndex((line) => NODE_FLOOR.test(line)));
	return lines.map((line) => line.split("#")[0].trim()).filter((line, index) => !exempt.has(index) && claimsFloor(line, floor));
}

// A same-major node-version literal is a floor claim; a full version is stale at any major.
function claimsFloor(line: string, floor: string): boolean {
	const pinned = line.match(/^["']?node-version["']?: ["']?v?(?<version>\d+(?:\.\d+)*)/)?.groups?.version;
	return pinned === undefined
		? SEMVER.test(line) && /node-version|NODE_FLOOR/.test(line)
		: pinned.split(".").length === 3 || pinned.split(".")[0] === floor.split(".")[0];
}

// Indices of the matrix block, which ends at the next line of the matrix key's indent or less.
function matrixLineIndices(lines: string[]): Set<number> {
	const start = lines.findIndex((line) => /^\s*matrix:\s*$/.test(line));
	assert.notEqual(start, -1, "workflow must define a matrix");
	const indent = indentOf(lines[start]);
	const indices = new Set<number>();
	for (let index = start + 1; index < lines.length; index += 1) {
		if (lines[index].trim() !== "" && indentOf(lines[index]) <= indent) break;
		indices.add(index);
	}
	return indices;
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
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
	const step = "      - uses: actions/setup-node@v4\n        with:\n";
	assert.equal(injected(`${step}          node-version: "${floor}"\n`).length, 1, "step-level floor pin");
	assert.equal(injected(`${step}          node-version: "22"\n`).length, 1, "step-level major pin");
	assert.equal(injected(`${step}          "node-version": "22"\n`).length, 1, "quoted key major pin");
	assert.equal(injected(`${step}          node-version: "20.19.0"\n`).length, 1, "stale full version");
	assert.equal(injected("      - name: Stale floor\n        if: matrix.node-version == '22.18.0'\n").length, 1, "stale floor literal");
	assert.equal(floorLiteralViolations(workflow.replace("  test:\n", `  test:\n    env:\n      NODE_FLOOR: "22.18.0"\n`), floor).length, 1, "job-level NODE_FLOOR override");
});

test("docs name the current Node and Pi floors", () => {
	const readme = readText(README_PATH);
	assert.deepEqual(new Set(readme.match(/Node\.js [\d.]+/g)), new Set([`Node.js ${EXPECTED_NODE_FLOOR}`]), "README must name only the Node floor");
	assert.match(readme, new RegExp(`Pi ${EXPECTED_PI_VERSION.replaceAll(".", "\\.")}`), "README must name the Pi floor");
	assert.doesNotMatch(readme, /0\.99\.2/, "README still names the retired Pi floor");
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
