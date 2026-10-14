import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { parseNpmViewValue, writeCompatArtifacts } = await import(new URL("../../scripts/compat-fixture.mjs", import.meta.url).href);
const { packEntry } = await import(new URL("../../scripts/test-package-host.mjs", import.meta.url).href);

function withTempDir(prefix: string, run: (temp: string) => void): void {
	const temp = mkdtempSync(join(tmpdir(), prefix));
	try {
		run(temp);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

test("writeCompatArtifacts does nothing when artifacts are disabled", () => {
	withTempDir("compat-artifact-disabled-", (temp) => {
		const artifactDir = join(temp, "artifacts");
		writeCompatArtifacts(undefined, join(temp, "source"), { piVersion: "1.2.3", typeboxVersion: "4.5.6" });
		assert.equal(existsSync(artifactDir), false);
	});
});

test("writeCompatArtifacts writes reproducible successful compatibility artifacts", () => {
	withTempDir("compat-artifact-success-", (temp) => {
		const sourceDir = join(temp, "source");
		const artifactDir = join(temp, "artifacts");
		const packageLock = '{"lockfileVersion":3}\n';
		mkdirSync(sourceDir);
		writeFileSync(join(sourceDir, "package-lock.json"), packageLock);

		writeCompatArtifacts(artifactDir, sourceDir, { piVersion: "1.2.3", typeboxVersion: "4.5.6" });

		assert.equal(readFileSync(join(artifactDir, "package-lock.json"), "utf8"), packageLock);
		assert.equal(readFileSync(join(artifactDir, "versions.txt"), "utf8"), `pi=1.2.3\ntypebox=4.5.6\nnode=${process.version}\n`);
	});
});

test("writeCompatArtifacts rejects a successful artifact without its package lock", () => {
	withTempDir("compat-artifact-missing-lock-", (temp) => {
		const sourceDir = join(temp, "source");
		mkdirSync(sourceDir);
		assert.throws(
			() => writeCompatArtifacts(join(temp, "artifacts"), sourceDir, { piVersion: "1.2.3", typeboxVersion: "4.5.6" }),
			/Expected compatibility package lock/,
		);
	});
});

test("parseNpmViewValue unwraps one-element arrays and treats empty output as undeclared", () => {
	assert.equal(parseNpmViewValue('"1.2.0"'), "1.2.0");
	assert.equal(parseNpmViewValue('["1.2.0"]'), "1.2.0");
	assert.equal(parseNpmViewValue(""), undefined);
	assert.equal(parseNpmViewValue("  \n"), undefined);
	assert.deepEqual(parseNpmViewValue("[]"), []);
	assert.throws(() => parseNpmViewValue("{not json"), SyntaxError);
});

test("packEntry accepts exactly one pack entry and rejects every other shape", () => {
	const entry = { filename: "pi-schematic-1.0.0.tgz" };
	assert.equal(packEntry([entry]), entry);
	assert.equal(packEntry({ "pi-schematic": entry }), entry);
	assert.throws(() => packEntry([entry, entry]), /Unexpected npm pack --json output/);
	assert.throws(() => packEntry({ a: entry, b: entry }), /Unexpected npm pack --json output/);
	assert.throws(() => packEntry([{ filename: "" }]), /Unexpected npm pack --json output/);
	assert.throws(() => packEntry([{ name: "no-filename" }]), /Unexpected npm pack --json output/);
	assert.throws(() => packEntry("x"), /Unexpected npm pack --json output/);
});
