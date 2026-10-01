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
const EXPECTED_ALLOWLIST_KEYS = new Set<string>([
	// Transitive advisories inside the pinned test host
	// @earendil-works/pi-coding-agent@0.84.1 (devDependency; this extension ships no
	// runtime dependencies). Patched in the host's newer releases; remove these
	// entries when the pinned host is bumped. Expiry forces periodic re-review.
	"GHSA-2jfj-6hjv-fm6j",
	"GHSA-3wwx-pv8p-q78v",
	"GHSA-3xpg-4rpp-hhhm",
	"GHSA-6j4f-fj2g-mc7p",
	"GHSA-pmjh-fq2x-6v4x",
	"GHSA-q2hr-2g5m-vwhr",
	"GHSA-qhr7-859c-m2p7",
	"GHSA-rfgv-xxqx-mfg5",
	"GHSA-rx4f-c7p8-82vq",
	"GHSA-w293-vg96-wgc3",
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
