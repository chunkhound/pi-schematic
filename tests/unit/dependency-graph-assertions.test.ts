import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { REPO_ROOT_URL } from "../paths.js";

const { assertSynchronizedPackageVersions } = await import(
	new URL("scripts/dependency-graph-assertions.mjs", REPO_ROOT_URL).href,
);

const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

test("latest compatibility lane guards every installed Pi package", () => {
	const source = readFileSync(new URL("scripts/test-compat-current.mjs", REPO_ROOT_URL), "utf8");
	expect(source).toMatch(/["']@earendil-works\/pi-agent-core["']/i);
});

function dependency(version: string, dependencies = {}): object {
	return { version, dependencies };
}

function graph(piVersion = "0.99.0", typeboxVersion = "2.0.0"): object {
	return {
		name: "synthetic-install",
		version: "1.0.0",
		dependencies: {
			"@earendil-works/pi-ai": dependency(piVersion, { typebox: dependency(typeboxVersion) }),
			"@earendil-works/pi-coding-agent": dependency(piVersion, {
				"@earendil-works/pi-agent-core": dependency(piVersion),
				"@earendil-works/pi-ai": dependency(piVersion, { typebox: dependency(typeboxVersion) }),
				"@earendil-works/pi-tui": dependency(piVersion),
			}),
			"@earendil-works/pi-tui": dependency(piVersion),
			typebox: dependency(typeboxVersion),
		},
	};
}

test("latest assertions accept recursively synchronized Pi and TypeBox versions", () => {
	const current = graph();
	expect(assertSynchronizedPackageVersions(current, PI_PACKAGES)).toBe("0.99.0");
	expect(assertSynchronizedPackageVersions(current, ["typebox"])).toBe("2.0.0");
});

test("latest assertions reject mixed nested Pi and TypeBox versions", () => {
	const mixedCore = graph() as any;
	mixedCore.dependencies["@earendil-works/pi-coding-agent"].dependencies["@earendil-works/pi-agent-core"].version = "0.98.0";
	expect(() => assertSynchronizedPackageVersions(mixedCore, PI_PACKAGES)).toThrow(/synchronized.*0\.98\.0.*0\.99\.0/i);

	const mixedTypebox = graph() as any;
	mixedTypebox.dependencies["@earendil-works/pi-ai"].dependencies.typebox.version = "1.9.0";
	expect(() => assertSynchronizedPackageVersions(mixedTypebox, ["typebox"])).toThrow(/synchronized.*1\.9\.0.*2\.0\.0/i);
});
