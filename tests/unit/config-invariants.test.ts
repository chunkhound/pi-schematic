/**
 * Invariant tests for the audit-ci security audit configuration.
 *
 * Validates the audit policy, that any allowlist entries have unexpired expiry
 * dates, and that CI preserves the audit → unit → e2e order.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertPresent } from "../assertions.js";
import { CHILD_TIMEOUT_MS } from "./spawn-node.js";

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
const EXPECTED_PI_VERSION = "0.99.2";
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
// Transitive brace-expansion, minimatch, and undici advisories in the pinned test host
// @earendil-works/pi-coding-agent@0.99.2 (devDependency). Remove them when a
// pinned host ships patched versions; the expiry forces periodic re-review.
const EXPECTED_ALLOWLIST_KEYS = new Set<string>([
	"GHSA-6j4f-fj2g-mc7p",
	"GHSA-qhr7-859c-m2p7",
	"GHSA-q2hr-2g5m-vwhr",
	"GHSA-xjj6-f33q-929c",
	"GHSA-4qv8-2p9j-2685",
	"GHSA-f72v-6w45-q472",
	"GHSA-2m5v-pch6-74hx",
	"GHSA-4w7w-5xrc-9h26",
	"GHSA-qrxm-fqhp-jwvm",
	"GHSA-9fm3-97px-rjf6",
	"GHSA-55wc-3pg8-jfw6",
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
	expect(index, `missing workflow step: ${step}`).not.toBe(-1);
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
		expect(key, "allowlist entry must define exactly one scoped advisory path").toBeTruthy();
		expect(value, `missing metadata for allowlist entry: ${key}`).toBeTruthy();
		return [key, value];
	});
}

function parseIsoDate(value: string): number {
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	expect(Number.isNaN(timestamp), `invalid ISO date: ${value}`).not.toBe(true);
	return timestamp;
}

function minimumNodeVersion(value: string): string {
	const match = value.match(/^>=(?<version>\d+\.\d+\.\d+)$/);
	const version = match?.groups?.version;
	assertPresent(version, `unsupported engines.node format: ${value}`);
	return version;
}

function runAuditCi(): void {
	const command = "npx audit-ci --config audit-ci.jsonc";
	const result = spawnSync(command, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		shell: true,
		timeout: CHILD_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const diagnostics = [
		`command: ${command}`,
		`error.stack: ${result.error?.stack ?? "none"}`,
		`status: ${String(result.status)}`,
		`signal: ${String(result.signal)}`,
		`stdout:\n${result.stdout}`,
		`stderr:\n${result.stderr}`,
	].join("\n");

	const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	expect(timedOut, `${command} did not finish within ${CHILD_TIMEOUT_MS} ms and was killed\n${diagnostics}`).toBe(false);
	expect(result.error, diagnostics).toBe(undefined);
	expect(result.signal, diagnostics).toBe(null);
	expect(result.status, diagnostics).toBe(0);
}

test("pinned Pi compatibility metadata and source boundaries stay exact", () => {
	const packageJson = parsePackageJson();
	const lock = JSON.parse(readText(LOCK_PATH)) as { packages: Record<string, { version?: string }> };
	expect(packageJson.engines.node).toBe(">=22.19.0");
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		expect(packageJson.peerDependencies[name], `${name} peer must require ${EXPECTED_PI_PEER}`).toBe(EXPECTED_PI_PEER);
	}
	expect(packageJson.peerDependencies.typebox, `typebox peer must require ${EXPECTED_TYPEBOX_PEER}`).toBe(EXPECTED_TYPEBOX_PEER);
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		expect(packageJson.devDependencies[name]).toBe(EXPECTED_PI_VERSION);
		expect(lock.packages[`node_modules/${name}`]?.version).toBe(EXPECTED_PI_VERSION);
	}
	expect(packageJson.devDependencies.typebox).toBe(EXPECTED_TYPEBOX_VERSION);
	expect(lock.packages["node_modules/typebox"]?.version).toBe(EXPECTED_TYPEBOX_VERSION);

	const spawnSource = readText(SPAWN_SOURCE_PATH);
	expect(spawnSource).not.toMatch(/\bAuthStorage\b|\bModelRegistry\b/);
	expect(spawnSource).not.toMatch(/\bauthStorage\s*:/);
	expect(spawnSource).not.toMatch(/sessionFactory\(\{[\s\S]*?\bmodelRegistry\s*:/);
	expect(spawnSource).toMatch(/modelRegistry:\s*ctx\.modelRegistry/);
	expect(spawnSource).toMatch(/model:\s*childModel/);
	expect(spawnSource).toMatch(/session\.dispose\(\)/);
	const rendererSource = readText(RENDERER_SOURCE_PATH);
	expect(rendererSource).not.toMatch(/console\.(?:debug|warn|error|log)\s*\(/);
	expect(rendererSource).not.toMatch(/process\.(?:stdout|stderr)\.write\s*\(/);
});

test("audit-ci config enforces the reviewed allowlist policy", () => {
	const config = parseAuditConfig();
	expect(config.$schema).toBe(AUDIT_SCHEMA);
	expect(config.moderate).toBe(true);

	const entries = allowlistEntries(config);
	expect(new Set(entries.map(([key]) => key))).toStrictEqual(EXPECTED_ALLOWLIST_KEYS);
	const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
	for (const [key, value] of entries) {
		expect(key).toMatch(/^GHSA-[a-z0-9-]+(?:\|[^|>]+(?:>[^|>]+)*)?$/);
		expect(value.active).toBe(true);
		expect(value.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(parseIsoDate(value.expiry) >= today, `expired allowlist entry: ${key}`).toBe(true);
		expect(value.notes.trim()).not.toBe("");
	}
});

test("workflow keeps the expected matrix and audit/test order", () => {
	const workflow = readText(WORKFLOW_PATH);
	const packageJson = parsePackageJson();
	expect(workflow).toMatch(/fail-fast:\s+false/);
	expect(parseMatrixEntries(workflow)).toStrictEqual(EXPECTED_MATRIX);
	expect(stepIndex(workflow, "Security audit") < stepIndex(workflow, "Unit tests")).toBe(true);
	expect(stepIndex(workflow, "Unit tests") < stepIndex(workflow, "E2E tests")).toBe(true);
	expect(workflow).toMatch(/run: npx audit-ci --config audit-ci\.jsonc/);
	expect(EXPECTED_MATRIX.has(`ubuntu-latest@${minimumNodeVersion(packageJson.engines.node)}`)).toBe(true);
});


test("Windows current-Pi step runs after packed-host failure but not on cancellation", () => {
	const workflow = readText(WORKFLOW_PATH);
	const block = stepBlock(workflow, "Synchronized current Pi compatibility on Windows");
	expect(block).toMatch(/if:\s*matrix\.os == 'windows-latest' && !cancelled\(\)/);
});

test("audit-ci config matches the CI audit command", () => {
	runAuditCi();
});
