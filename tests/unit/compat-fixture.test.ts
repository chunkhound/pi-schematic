import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { packEntry, parseNpmViewValue, resolveLatestPi, writeCompatArtifacts } = await import(new URL("../../scripts/compat-fixture.mjs", import.meta.url).href);

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

const parseAccepted: Array<[string, string, unknown]> = [
	["a bare JSON string", '"1.2.0"', "1.2.0"],
	["a one-element array, unwrapped", '["1.2.0"]', "1.2.0"],
	["empty output, as undeclared", "", undefined],
	["whitespace-only output, as undeclared", "  \n", undefined],
	["an empty array, left as is", "[]", []],
];

for (const [shape, stdout, expected] of parseAccepted) {
	test(`parseNpmViewValue accepts ${shape}`, () => {
		assert.deepEqual(parseNpmViewValue(stdout), expected);
	});
}

test("parseNpmViewValue rejects non-JSON output, naming the command and keeping the parse error as cause", () => {
	const stdout = "{not json";
	assert.throws(
		() => parseNpmViewValue(stdout),
		(error: Error) => {
			assert.match(error.message, /npm view --json/);
			assert.ok(error.message.includes(JSON.stringify(stdout)));
			assert.ok(error.cause instanceof SyntaxError);
			return true;
		},
	);
});

const packEntryFixture = { filename: "pi-schematic-1.0.0.tgz" };

const packEntryAccepted: Array<[string, unknown]> = [
	["a one-element array", [packEntryFixture]],
	["an object keyed by package name", { "pi-schematic": packEntryFixture }],
];

for (const [shape, packJson] of packEntryAccepted) {
	test(`packEntry accepts ${shape}`, () => {
		assert.equal(packEntry(packJson), packEntryFixture);
	});
}

const packEntryRejected: Array<[string, unknown]> = [
	["a two-element array", [packEntryFixture, packEntryFixture]],
	["an object with two keys", { a: packEntryFixture, b: packEntryFixture }],
	["an entry with an empty filename", [{ filename: "" }]],
	["an entry without a filename", [{ name: "no-filename" }]],
	["a string", "x"],
];

for (const [shape, packJson] of packEntryRejected) {
	test(`packEntry rejects ${shape}`, () => {
		assert.throws(() => packEntry(packJson), /Unexpected npm pack --json output/);
	});
}

// resolveLatestPi reaches npm through the npm_execpath seam: a stub npm-cli.js answers each lookup.
async function withStubNpm(
	versionStdout: string,
	typeboxStdout: string,
	run: (temp: string, calls: () => string[][]) => Promise<void>,
): Promise<void> {
	const temp = mkdtempSync(join(tmpdir(), "compat-resolve-latest-pi-"));
	const callLog = join(temp, "calls.jsonl");
	const stub = join(temp, "npm-cli.js");
	writeFileSync(stub, `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + "\\n");
if (args.includes("version")) process.stdout.write(${JSON.stringify(versionStdout)});
else if (args.includes("dependencies.typebox")) process.stdout.write(${JSON.stringify(typeboxStdout)});
else process.exit(1);
`);
	const previous = process.env.npm_execpath;
	process.env.npm_execpath = stub;
	try {
		await run(temp, () => readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)));
	} finally {
		if (previous === undefined) delete process.env.npm_execpath;
		else process.env.npm_execpath = previous;
		rmSync(temp, { recursive: true, force: true });
	}
}

test("resolveLatestPi rejects when npm prints no latest version, without a TypeBox lookup", async () => {
	await withStubNpm("", "", async (temp, calls) => {
		await assert.rejects(resolveLatestPi(temp), /did not declare a usable version/);
		assert.equal(calls().length, 1);
	});
});

test("resolveLatestPi rejects when the resolved Pi version declares no TypeBox dependency", async () => {
	await withStubNpm('["1.2.0"]', "", async (temp, calls) => {
		await assert.rejects(resolveLatestPi(temp), /Pi coding-agent 1\.2\.0 did not declare a usable TypeBox version/);
		assert.deepEqual(calls().map((args) => args[1]), [
			"@earendil-works/pi-coding-agent@latest",
			"@earendil-works/pi-coding-agent@1.2.0",
		]);
	});
});

test("resolveLatestPi resolves the Pi version and the TypeBox version it requires", async () => {
	await withStubNpm('["1.2.0"]', '["1.3.27"]', async (temp) => {
		assert.deepEqual(await resolveLatestPi(temp), { piVersion: "1.2.0", typeboxVersion: "1.3.27" });
	});
});
