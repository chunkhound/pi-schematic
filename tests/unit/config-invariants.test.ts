/**
 * Invariant tests for the audit-ci security audit configuration.
 *
 * Validates the audit policy, that any allowlist entries have unexpired expiry
 * dates, and that CI preserves the audit → unit → e2e order.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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
	engines: { node: string };
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	scripts: Record<string, string>;
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
// Pinned versions verified against package.json + lockfile.
// Update when Pi devDependencies are bumped.
const EXPECTED_PI_VERSION = "0.84.1";
const EXPECTED_TYPEBOX_VERSION = "1.3.7";
// Approved peer floors — must track the pinned devDependency versions above.
const EXPECTED_PI_PEER = `>=${EXPECTED_PI_VERSION}`;
const EXPECTED_TYPEBOX_PEER = `>=${EXPECTED_TYPEBOX_VERSION}`;
const EXPECTED_MATRIX = new Set([
	"ubuntu-latest@22.19.0",
	"ubuntu-latest@24",
	"macos-latest@24",
	"windows-latest@24",
]);
const EXPECTED_ALLOWLIST_KEYS = new Set<string>();

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

test("audit-ci config enforces the empty allowlist policy", () => {
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
	assert.ok(stepIndex(workflow, "Security audit") < stepIndex(workflow, "Unit tests"));
	assert.ok(stepIndex(workflow, "Unit tests") < stepIndex(workflow, "E2E tests"));
	assert.match(workflow, /run: npx audit-ci --config audit-ci\.jsonc/);
	assert.ok(EXPECTED_MATRIX.has(`ubuntu-latest@${minimumNodeVersion(packageJson.engines.node)}`));
});


// The REQUIRE_* env vars are the switches that make the enforcement suites fail loudly
// instead of silently skipping on a runner that lost the capability they assert, so a
// deleted env line must fail here before CI can go green with skipped enforcement.
test("workflow keeps the enforcement gate env vars on their lanes", () => {
	const workflow = readText(WORKFLOW_PATH);
	assert.match(
		stepBlock(workflow, "Unit tests"),
		/\n?\s*env:\n\s*REQUIRE_OUTSIDE_TEMP_WRITES: "1"/,
		"the unit-test lane must keep REQUIRE_OUTSIDE_TEMP_WRITES so outside-temp regressions fail loudly instead of skipping",
	);
	const laneStart = workflow.indexOf("  sandbox-enforcement:");
	assert.notEqual(laneStart, -1, "missing sandbox-enforcement lane");
	const laneEnd = workflow.indexOf("\n  current-pi:", laneStart);
	const lane = workflow.slice(laneStart, laneEnd === -1 ? workflow.length : laneEnd);
	assert.match(
		lane,
		/\n?\s*env:\n\s*REQUIRE_OS_SANDBOX: "1"/,
		"the sandbox-enforcement lane must keep REQUIRE_OS_SANDBOX so kernel enforcement is exercised, never skipped",
	);
	assert.match(
		lane,
		/run-node-test\.mjs tests\/unit\/os-sandbox\.test\.ts/,
		"the sandbox-enforcement lane must actually run the OS-sandbox suite, or its gate guards nothing",
	);
});

test("Windows current-Pi step runs after packed-host failure but not on cancellation", () => {
	const workflow = readText(WORKFLOW_PATH);
	const block = stepBlock(workflow, "Synchronized current Pi compatibility on Windows");
	assert.match(block, /if:\s*matrix\.os == 'windows-latest' && !cancelled\(\)/);
});

// The live audit is network-dependent and its verdict changes with every upstream advisory,
// so it never runs inside `npm test`: CI runs it as its own "Security audit" step. This guard
// keeps that step honest offline — it must audit exactly the config these tests parse, from the
// repo root where package-lock.json lives.
test("CI audit step audits the same config these tests validate", () => {
	const block = stepBlock(readText(WORKFLOW_PATH), "Security audit");
	assert.match(block, /(?:^|\s)npx audit-ci\b/, "the Security audit step must invoke audit-ci");
	const configs = [...block.matchAll(/--config\s+(\S+)/g)].map((match) => match[1]!);
	assert.deepEqual(
		configs,
		[path.relative(REPO_ROOT, fileURLToPath(AUDIT_CONFIG_PATH))],
		"CI must audit the config validated by these tests — keep the workflow command and AUDIT_CONFIG_PATH in sync",
	);
	assert.doesNotMatch(block, /working-directory:/, "audit-ci finds package-lock.json at the repo root");
	assert.ok(parseAuditConfig().moderate, "the config CI loads must still parse and enforce moderate advisories");
});

// The test:coverage script is the only thing standing between a silent coverage regression
// and a green CI lane, so these thresholds must be present and on the real Node flags
// (--test-coverage-lines / --test-coverage-branches — Node rejects the "enforce-*" spelling).
// The workflow must actually execute the script on Linux, otherwise the contract is dead:
// Windows skips POSIX differential cases and would under-count the threshold.
test("test:coverage thresholds run in CI on Linux", () => {
	const coverageScript = parsePackageJson().scripts["test:coverage"];
	assert.ok(coverageScript, "test:coverage script must exist");
	assert.match(
		coverageScript,
		/--test-coverage-lines=90/,
		"test:coverage must enforce a 90% line threshold on the readonly modules",
	);
	assert.match(
		coverageScript,
		/--test-coverage-branches=85/,
		"test:coverage must enforce an 85% branch threshold on the readonly modules",
	);
	assert.match(
		coverageScript,
		/--test-coverage-include='readonly-\*\.ts'/,
		"test:coverage must cover the readonly modules, including readonly-shell-utils.ts (critical classification path)",
	);
	// os-sandbox.ts needs a kernel sandbox the coverage lane does not provision; the
	// sandbox-enforcement lane owns that enforcement, so counting it here only lets
	// the gate stay green while the suite skips.
	assert.doesNotMatch(
		coverageScript,
		/--test-coverage-include='os-sandbox\.ts'/,
		"test:coverage must not count os-sandbox.ts — its kernel enforcement runs in the sandbox-enforcement lane",
	);
	const coverageStep = stepBlock(readText(WORKFLOW_PATH), "Readonly coverage");
	assert.match(coverageStep, /(?:^|\s)npm run test:coverage\b/, "CI must execute npm run test:coverage");
	assert.match(
		coverageStep,
		/if:\s*runner\.os == 'Linux'/,
		"coverage runs on Linux only — Windows skips POSIX cases and would under-count",
	);
	// Without this flag the POSIX differential suites can silently skip and the gate
	// stays green with no real coverage.
	assert.match(
		coverageStep,
		/REQUIRE_OUTSIDE_TEMP_WRITES:\s*["']1["']/,
		"the Readonly coverage step must set REQUIRE_OUTSIDE_TEMP_WRITES=1 so POSIX suites cannot skip",
	);
});
