import { expect, test, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	__setModelGroupsFsForTests,
	createGroup,
	createModelGroupsAccess,
	deleteGroup,
	loadModelGroups,
	modelGroupsPath,
	moveGroup,
	renameGroup,
	saveModelGroups,
	summarizeBootValidation,
	updateGroup,
	validateModelGroups,
} from "../../model-groups/store.js";
import {
	ModelGroupsPersistenceError,
	type ModelGroupDef,
	type ModelGroupScope,
	type ModelGroupsAccess,
	type ResolvedModelGroup,
} from "../../model-groups/types.js";
import { createConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { testMinContext } from "./model-groups-constraints-fixture.js";
import { recordOf, withTempAgentDir } from "./helpers.js";
import { testProvider, withTemp } from "./model-groups-helpers.js";
import { createModelRegistry } from "../support/model-registry.js";
import { assertPresent } from "../assertions.js";

function access(cwd: string, policy: ModelGroupsAccess["policy"] = "global-project"): ModelGroupsAccess {
	return { cwd, policy };
}

// The persisted file as tests read it back; keys the store does not know stay `unknown`.
interface PersistedModel {
	provider: string;
	modelId: string;
	[key: string]: unknown;
}
interface PersistedGroup {
	models: PersistedModel[];
	constraints?: Record<string, unknown>;
	[key: string]: unknown;
}
interface PersistedConfig {
	groups: Record<string, PersistedGroup>;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedGroup(value: unknown): value is PersistedGroup {
	if (!isRecord(value)) {
		return false;
	}
	const models: unknown = value.models;
	return (
		Array.isArray(models) &&
		models.every((entry: unknown) => isRecord(entry) && typeof entry.provider === "string" && typeof entry.modelId === "string") &&
		(value.constraints === undefined || isRecord(value.constraints))
	);
}

function assertPersistedConfig(value: unknown, file: string): asserts value is PersistedConfig {
	if (!isRecord(value) || !isRecord(value.groups) || !Object.values(value.groups).every(isPersistedGroup)) {
		throw new Error(`${file} does not hold a model groups config.`);
	}
}

function readFile(file: string): PersistedConfig {
	const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	assertPersistedConfig(parsed, file);
	return parsed;
}

function read(scope: ModelGroupScope, cwd: string): PersistedConfig {
	return readFile(modelGroupsPath(scope, cwd));
}

// Every model is authenticated. `gpt-ctx` has a 100-token context window, so it supports injected testMinContext overrides up to 100; the other models have a context window of 0.
function storeRegistry(): Promise<ModelRegistry> {
	return createModelRegistry({
		orange: testProvider(
			[
				{ id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } },
				{ id: "gpt-ctx", contextWindow: 100 },
			],
			{ auth: true },
		),
		alpha: testProvider([{ id: "claude" }], { auth: true }),
	});
}

function writeProjectFile(cwd: string, content: string): string {
	const projectPath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	fs.writeFileSync(projectPath, content, "utf8");
	return projectPath;
}

test("model groups store creates a group and rejects a duplicate name", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		expect(Object.keys(loadModelGroups(access(cwd)).configs.project.groups)).toHaveLength(0);
		createGroup("project", access(cwd), "review", { models: [] }, registry);
		expect(read("project", cwd).groups.review.models).toStrictEqual([]);
		expect(() => {
			createGroup("project", access(cwd), "review", { models: [] }, registry);
		}).toThrow("Model group 'review' already exists in project scope");
	}));

test("model groups store round-trips an inherited thinking level", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("project", access(cwd), "inherit-roundtrip", { models: [{ provider: "alpha", modelId: "claude" }] }, registry);
		const inheritLoaded = loadModelGroups(access(cwd)).configs.project.groups["inherit-roundtrip"].models[0];
		expect(inheritLoaded.thinkingLevel).toBeUndefined();
		expect(Object.getOwnPropertyNames(inheritLoaded)).not.toContain("thinkingLevel");
		const inheritPersisted = read("project", cwd).groups["inherit-roundtrip"].models[0];
		expect(inheritPersisted.thinkingLevel).toBeUndefined();
		expect(Object.getOwnPropertyNames(inheritPersisted)).not.toContain("thinkingLevel");
	}));

test("model groups store validates groups against the registry", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("project", access(cwd), "reviewers", { models: [] }, registry);
		createGroup(
			"global",
			access(cwd),
			"reviewers",
			{
				models: [
					{ provider: "orange", modelId: "gpt-5" },
					{ provider: "missing", modelId: "nope" },
				],
			},
			registry,
		);
		const resolved = validateModelGroups(loadModelGroups(access(cwd)), registry);
		const globalReviewers = resolved.find((g) => g.name === "reviewers" && g.scope === "global");
		expect(globalReviewers?.validation.shadowedByProject).toBe(true);
		expect(globalReviewers?.validation.unavailableRefs).toStrictEqual([{ provider: "missing", modelId: "nope" }]);
		expect(globalReviewers?.validation.degraded).toBe(true);
	}));

test("model groups store renames a group and rejects a name collision", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("project", access(cwd), "review", { models: [{ provider: "orange", modelId: "gpt-5", thinkingLevel: "high" }] }, registry);
		renameGroup("project", access(cwd), "review", "reviewers");
		expect(read("project", cwd).groups.review).toBeUndefined();
		expect(read("project", cwd).groups.reviewers.models[0].thinkingLevel).toBe("high");

		createGroup("project", access(cwd), "collision", { models: [] }, registry);
		expect(() => {
			renameGroup("project", access(cwd), "reviewers", "collision");
		}).toThrow("Model group 'collision' already exists in project scope");
	}));

test("model groups store updates a group", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("project", access(cwd), "review", { models: [] }, registry);
		updateGroup("project", access(cwd), "review", { models: [{ provider: "orange", modelId: "gpt-5", thinkingLevel: "high" }] }, registry);
		expect(read("project", cwd).groups.review.models).toStrictEqual([{ provider: "orange", modelId: "gpt-5", thinkingLevel: "high" }]);
	}));

test("model groups store deletes a group and reports the other scope's override", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("project", access(cwd), "reviewers", { models: [] }, registry);
		createGroup("global", access(cwd), "reviewers", { models: [] }, registry);
		expect(deleteGroup("global", access(cwd), "reviewers")).toStrictEqual({ otherScopeHasOverride: true });
		expect(read("global", cwd).groups.reviewers).toBeUndefined();
		expect(read("project", cwd).groups).toHaveProperty(["reviewers"]);
	}));

test("model groups store moves a group and rejects a target-scope collision", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("global", access(cwd), "move-collision", { models: [] }, registry);
		createGroup("project", access(cwd), "move-collision", { models: [] }, registry);
		expect(() => {
			moveGroup(access(cwd), "move-collision", "project");
		}).toThrow("Model group 'move-collision' already exists in project scope");
		expect(read("global", cwd).groups).toHaveProperty(["move-collision"]);
		expect(read("project", cwd).groups).toHaveProperty(["move-collision"]);

		createGroup("project", access(cwd), "reviewers", { models: [] }, registry);
		moveGroup(access(cwd), "reviewers", "global");
		expect(read("global", cwd).groups).toHaveProperty(["reviewers"]);
		expect(read("project", cwd).groups.reviewers).toBeUndefined();
	}));

test.each([
	{
		operation: "update",
		act: (a: ModelGroupsAccess, registry: ModelRegistry) => {
			updateGroup("project", a, "ghost", { models: [] }, registry);
		},
	},
	{
		operation: "rename",
		act: (a: ModelGroupsAccess) => {
			renameGroup("project", a, "ghost", "spirit");
		},
	},
	{
		operation: "delete",
		act: (a: ModelGroupsAccess) => {
			deleteGroup("project", a, "ghost");
		},
	},
	{
		operation: "move",
		act: (a: ModelGroupsAccess) => {
			moveGroup(a, "ghost", "global");
		},
	},
])("store operations on a missing group throw and write nothing: $operation", ({ act }) =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const writeFileSync = vi.fn(fs.writeFileSync);
		__setModelGroupsFsForTests({ writeFileSync });
		expect(() => {
			act(access(cwd), registry);
		}).toThrow("Model group 'ghost' does not exist in project scope");
		expect(writeFileSync).not.toHaveBeenCalled();
	}),
);

test("renaming a group to its own canonical name writes nothing", () =>
	withTemp(async ({ cwd }) => {
		createGroup("project", access(cwd), "review", { models: [] }, await storeRegistry());
		const writeFileSync = vi.fn(fs.writeFileSync);
		__setModelGroupsFsForTests({ writeFileSync });
		renameGroup("project", access(cwd), "review", " review ");
		expect(writeFileSync).not.toHaveBeenCalled();
	}));

test.each([
	{
		operation: "create",
		act: (a: ModelGroupsAccess, registry: ModelRegistry) => {
			createGroup("project", a, "   ", { models: [] }, registry);
		},
	},
	{
		operation: "rename",
		act: (a: ModelGroupsAccess) => {
			renameGroup("project", a, "review", "   ");
		},
	},
])("store rejects a blank group name: $operation", ({ act }) =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup("project", access(cwd), "review", { models: [] }, registry);
		expect(() => {
			act(access(cwd), registry);
		}).toThrow("Model group name is required");
	}),
);

test("global-only access refuses a project-scope rename before reading the project file", () =>
	withTemp(({ cwd }) => {
		const projectPath = writeProjectFile(cwd, "{not json");
		expect(() => {
			renameGroup("project", access(cwd, "global-only"), "review", "reviewers");
		}).toThrow("Project Model Groups are unavailable in global-only mode");
		expect(`${projectPath}.bak`).not.toSatisfy(fs.existsSync);
	}));

test("deleting a group without an override in the other scope reports none", () =>
	withTemp(async ({ cwd }) => {
		createGroup("project", access(cwd), "solo", { models: [] }, await storeRegistry());
		expect(deleteGroup("project", access(cwd), "solo")).toStrictEqual({ otherScopeHasOverride: false });
	}));

test("a group with every reference unavailable is not degraded", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		createGroup(
			"project",
			access(cwd),
			"gone",
			{
				models: [
					{ provider: "missing", modelId: "nope" },
					{ provider: "missing", modelId: "gone" },
				],
			},
			registry,
		);
		const [gone] = validateModelGroups(loadModelGroups(access(cwd)), registry);
		assertPresent(gone, "the gone group resolves");
		expect(gone.validation.unavailableRefs).toHaveLength(2);
		expect(gone.validation.degraded).toBe(false);
	}));

test("an unsupported-version file is reported without a backup", () =>
	withTemp(({ cwd }) => {
		const projectPath = writeProjectFile(cwd, JSON.stringify({ version: 99, groups: {} }));
		const [issue] = loadModelGroups(access(cwd)).issues;
		assertPresent(issue, "the project config reports a load issue");
		expect(issue.kind).toBe("unsupported-version");
		expect(`${projectPath}.bak`).not.toSatisfy(fs.existsSync);
	}));

test("saving over a corrupt existing file writes the new config", () =>
	withTemp(({ cwd }) => {
		writeProjectFile(cwd, "{not json");
		saveModelGroups("project", access(cwd), { version: 2, groups: { fresh: { models: [] } } });
		expect(read("project", cwd)).toStrictEqual({ version: 2, groups: { fresh: { models: [] } } });
	}));

test("model groups load recovery handles malformed, schema-invalid, unsupported version, and backup failure", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
		fs.writeFileSync(modelGroupsPath("global", cwd), "{not json", "utf8");
		let loaded = loadModelGroups(access(cwd));
		expect(loaded.issues[0].kind).toBe("corrupt-json");
		expect(`${modelGroupsPath("global", cwd)}.bak`).toSatisfy(fs.existsSync);

		fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
		fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { bad: { models: [{ provider: 1 }] } } }), "utf8");
		loaded = loadModelGroups(access(cwd));
		const schemaIssue = loaded.issues.find((i) => i.scope === "project");
		assertPresent(schemaIssue, "the project config reports a load issue");
		expect(schemaIssue.kind).toBe("schema-invalid");
		expect(schemaIssue.scope).toBe("project");
		expect(schemaIssue.sourcePath).toBe(modelGroupsPath("project", cwd));
		expect(schemaIssue.backupPath).toBe(`${modelGroupsPath("project", cwd)}.bak`);
		expect(schemaIssue.message).toMatch(/provider/);
		expect(schemaIssue.backupPath).toSatisfy(fs.existsSync);
		expect(Object.keys(loaded.configs.project.groups)).toHaveLength(0);

		fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
		loaded = loadModelGroups(access(cwd));
		expect(loaded.issues.find((i) => i.scope === "project")?.kind).toBe("unsupported-version");
		expect(loaded.issues.find((i) => i.scope === "project")?.version).toBe(99);

		fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
		__setModelGroupsFsForTests({
			copyFileSync: () => {
				throw new Error("denied");
			},
		});
		loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((i) => i.scope === "project");
		assertPresent(issue, "the project config reports a load issue");
		expect(issue.backupFailed).toBe(true);
		expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe("{bad");
		expect(() => {
			createGroup("project", access(cwd), "must-not-overwrite", { models: [] }, registry);
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.operation).toBe("save");
				expect(error.phase).toBe("load-recovery");
				return true;
			}),
		);
		expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe("{bad");
	}));

test("model groups rename failure removes the generated temp file and preserves committed bytes", () =>
	withTemp(({ cwd }) => {
		const sourcePath = modelGroupsPath("project", cwd);
		saveModelGroups("project", access(cwd), { version: 2, groups: { keep: { models: [] } } });
		const committedBytes = fs.readFileSync(sourcePath);
		const renameCause = new Error("rename denied");
		let generatedTempPath = "";

		__setModelGroupsFsForTests({
			renameSync: (from) => {
				generatedTempPath = String(from);
				expect(path.basename(generatedTempPath)).toMatch(/^model-groups\.json\.\d+\.\d+\.tmp$/);
				expect(fs.readFileSync(generatedTempPath, "utf8")).toContain('"drop"');
				throw renameCause;
			},
		});
		expect(() => {
			saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } });
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.operation).toBe("save");
				expect(error.phase).toBe("rename");
				expect(error.sourcePath).toBe(sourcePath);
				expect(error.targetPath).toBe(generatedTempPath);
				expect(error.cause).toBe(renameCause);
				return true;
			}),
		);

		expect(generatedTempPath).not.toBe("");
		expect(fs.readFileSync(sourcePath)).toStrictEqual(committedBytes);
		expect(generatedTempPath).not.toSatisfy(fs.existsSync);
		expect(fs.readdirSync(path.dirname(sourcePath)).filter((name) => /^model-groups\.json\.\d+\.\d+\.tmp$/.test(name))).toStrictEqual([]);
	}));

test("model groups rename cleanup failure remains supplemental to the original typed error", () =>
	withTemp(({ cwd }) => {
		const sourcePath = modelGroupsPath("project", cwd);
		saveModelGroups("project", access(cwd), { version: 2, groups: { keep: { models: [] } } });
		const committedBytes = fs.readFileSync(sourcePath);
		const renameCause = new Error("rename denied");
		const cleanupCause = new Error("cleanup denied");
		let generatedTempPath = "";

		__setModelGroupsFsForTests({
			renameSync: (from) => {
				generatedTempPath = String(from);
				expect(generatedTempPath).toSatisfy(fs.existsSync);
				throw renameCause;
			},
			unlinkSync: (target) => {
				expect(String(target)).toBe(generatedTempPath);
				throw cleanupCause;
			},
		});
		expect(() => {
			saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } });
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.operation).toBe("save");
				expect(error.phase).toBe("rename");
				expect(error.sourcePath).toBe(sourcePath);
				expect(error.targetPath).toBe(generatedTempPath);
				expect(error.cause).toBe(renameCause);
				expect(error.message).toMatch(/cleanup denied/);
				return true;
			}),
		);

		expect(generatedTempPath).not.toBe("");
		expect(fs.readFileSync(sourcePath)).toStrictEqual(committedBytes);
		expect(generatedTempPath).toSatisfy(fs.existsSync);
	}));

test("model groups save temp-write failure throws a typed save error and preserves committed state", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		saveModelGroups("project", access(cwd), { version: 2, groups: { keep: { models: [] } } });
		__setModelGroupsFsForTests({
			writeFileSync: () => {
				throw new Error("temp denied");
			},
		});
		expect(() => {
			updateGroup("project", access(cwd), "keep", { models: [{ provider: "orange", modelId: "gpt-5" }] }, registry);
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.operation).toBe("save");
				expect(error.phase).toBe("temp-write");
				expect(error.scope).toBe("project");
				expect(error.sourcePath).toBe(modelGroupsPath("project", cwd));
				expect(error.targetPath ?? "").toMatch(/model-groups\.json\..+\.tmp$/);
				return true;
			}),
		);
		__setModelGroupsFsForTests(null);
		expect(read("project", cwd).groups).toHaveProperty(["keep"]);
		expect(read("project", cwd).groups.keep.models).toHaveLength(0);
	}));

test("model groups delete persistence failure throws a typed delete error and preserves committed state", () =>
	withTemp(({ cwd }) => {
		saveModelGroups("project", access(cwd), { version: 2, groups: { keep: { models: [] } } });
		__setModelGroupsFsForTests({
			renameSync: () => {
				throw new Error("delete denied");
			},
		});
		expect(() => deleteGroup("project", access(cwd), "keep")).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.operation).toBe("delete");
				return true;
			}),
		);
		__setModelGroupsFsForTests(null);
		expect(read("project", cwd).groups).toHaveProperty(["keep"]);
	}));

test("model groups move persistence failure throws a typed move error and preserves committed state", () =>
	withTemp(async ({ cwd }) => {
		createGroup("global", access(cwd), "move-target-fails", { models: [] }, await storeRegistry());
		__setModelGroupsFsForTests({
			renameSync: () => {
				throw new Error("target denied");
			},
		});
		expect(() => {
			moveGroup(access(cwd), "move-target-fails", "project");
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.operation).toBe("move");
				expect(error.partialMove).toBeUndefined();
				return true;
			}),
		);
		__setModelGroupsFsForTests(null);
		expect(loadModelGroups(access(cwd)).merged.map((g) => [g.name, g.scope])).toStrictEqual([["move-target-fails", "global"]]);
	}));

test("model groups move source-remove failure throws a typed move error and preserves committed state", () =>
	withTemp(async ({ cwd }) => {
		createGroup("global", access(cwd), "move-me", { models: [] }, await storeRegistry());
		let writes = 0;
		__setModelGroupsFsForTests({
			renameSync: (from, to) => {
				writes++;
				if (writes === 2) {
					throw new Error("source denied");
				}
				fs.renameSync(from, to);
			},
		});
		expect(() => {
			moveGroup(access(cwd), "move-me", "project");
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.partialMove).toBe("target-written-source-retained");
				expect(error.phase).toBe("source-remove");
				return true;
			}),
		);
		__setModelGroupsFsForTests(null);
		expect(loadModelGroups(access(cwd)).merged.map((g) => [g.name, g.scope])).toStrictEqual([
			["move-me", "global"],
			["move-me", "project"],
		]);
	}));

test.each<[string, unknown, string | RegExp]>([
	["root", [], /root/],
	["empty object", {}, "version must be 2"],
	["missing version", { groups: {} }, "version must be 2"],
	["version 1 without groups", { version: 1 }, "version must be 2"],
	["version 0", { version: 0, groups: {} }, "version must be 2"],
	["version 1", { version: 1, groups: {} }, "version must be 2"],
	["version type", { version: "1", groups: {} }, "version must be 2"],
	["negative", { version: -1, groups: {} }, "version must be 2"],
	["fraction low", { version: 0.5, groups: {} }, "version must be 2"],
	["fraction high", { version: 1.5, groups: {} }, "version must be 2"],
	["groups", { version: 2, groups: [] }, /groups/],
	["group", { version: 2, groups: { bad: 1 } }, /group/],
	["provider missing", { version: 2, groups: { bad: { models: [{ modelId: "m" }] } } }, /provider/],
	["provider type", { version: 2, groups: { bad: { models: [{ provider: 1, modelId: "m" }] } } }, /provider/],
	["model missing", { version: 2, groups: { bad: { models: [{ provider: "p" }] } } }, /modelId/],
	["model type", { version: 2, groups: { bad: { models: [{ provider: "p", modelId: 1 }] } } }, /modelId/],
	["models", { version: 2, groups: { bad: { models: 1 } } }, /models/],
	["thinking", { version: 2, groups: { bad: { models: [{ provider: "p", modelId: "m", thinkingLevel: "turbo" }] } } }, /thinkingLevel/],
])("model groups load reports invalid configs as schema-invalid: %s", (_label, raw, message) =>
	withTemp(({ cwd }) => {
		const projectPath = writeProjectFile(cwd, JSON.stringify(raw));
		const loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((candidate) => candidate.scope === "project");
		assertPresent(issue, "the project config reports a load issue");
		expect(issue.kind).toBe("schema-invalid");
		expect(issue.message).toMatch(message);
		expect(`${projectPath}.bak`).toSatisfy(fs.existsSync);
		expect(Object.keys(loaded.configs.project.groups)).toHaveLength(0);
	}),
);

test("store-level validation derives empty-common and stale-override flags and counts them", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const a = access(cwd);
		fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
		fs.writeFileSync(
			modelGroupsPath("project", cwd),
			JSON.stringify({
				version: 2,
				groups: {
					empty: { models: [] },
					unresolved: {
						models: [
							{ provider: "orange", modelId: "gone" },
							{ provider: "orange", modelId: "gpt-5" },
						],
					},
					stale: { models: [{ provider: "alpha", modelId: "claude" }], constraints: { modalities: ["text", "image"] } },
				},
			}),
			"utf8",
		);
		const resolved = validateModelGroups(loadModelGroups(a), registry);
		// claude supports text only, so image is a stale unsupported override entry.
		const empty = resolved.find((g) => g.name === "empty");
		expect(empty?.validation.emptyCommonModalities, "empty group has no common modalities").toBe(true);
		const unresolved = resolved.find((g) => g.name === "unresolved");
		expect(unresolved?.validation.emptyCommonModalities, "unresolved member fails closed").toBe(true);
		const stale = resolved.find((g) => g.name === "stale");
		expect(stale?.validation.unsupportedOverrideModalities).toStrictEqual(["image"]);
		const summary = summarizeBootValidation(resolved);
		expect(summary.emptyModalityCount).toBe(2);
		expect(summary.staleModalityOverrideCount).toBe(1);
	}));

test("low-level save permits shape-valid overrides while CRUD rejects union-cap-invalid overrides", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const a = access(cwd);
		// The low-level persistence boundary only validates v2 shape. It deliberately
		// persists this image override even though claude's union has text only.
		saveModelGroups("project", a, {
			version: 2,
			groups: { persistenceOnly: { models: [{ provider: "alpha", modelId: "claude" }], constraints: { modalities: ["image"] } } },
		});
		expect(read("project", cwd).groups.persistenceOnly.constraints?.modalities).toStrictEqual(["image"]);
		// CRUD owns the union-cap invariant and must reject the same invalid shape
		// before any write.
		// claude supports only text, so an override of image must be rejected by the CRUD gate.
		const writeFileSync = vi.fn(fs.writeFileSync);
		__setModelGroupsFsForTests({ writeFileSync });
		expect(() => {
			createGroup("project", a, "claude-only", { models: [{ provider: "alpha", modelId: "claude" }], constraints: { modalities: ["image"] } }, registry);
		}).toThrow(/unsupported modalities: image/);
		expect(writeFileSync).not.toHaveBeenCalled();
		__setModelGroupsFsForTests(null);

		createGroup("project", a, "rich", { models: [{ provider: "orange", modelId: "gpt-5" }], constraints: { modalities: ["text", "image"] } }, registry);
		const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
		const writeFileSync2 = vi.fn(fs.writeFileSync);
		__setModelGroupsFsForTests({ writeFileSync: writeFileSync2 });
		// Combined member change: replacing gpt-5 (text+image+reasoning) with claude (text only)
		// makes the retained override's image unsupported → the gate must reject before any write.
		expect(() => {
			updateGroup("project", a, "rich", { models: [{ provider: "alpha", modelId: "claude" }], constraints: { modalities: ["text", "image"] } }, registry);
		}).toThrow(/unsupported modalities: image/);
		expect(writeFileSync2, "rejected update must not write").not.toHaveBeenCalled();
		expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe(before);
		__setModelGroupsFsForTests(null);
	}));

test("injected descriptors get persisted validation and CRUD cap enforcement through the registry", () =>
	withTemp(async ({ cwd }) => {
		const a = access(cwd);
		const injected = createConstraintRegistry([testMinContext]);
		// gpt-ctx has a 100-token contextWindow, so the testMinContext override 5 is supported.
		const modelRegistry = await storeRegistry();
		// Valid override: normalized through CRUD and persisted.
		createGroup("project", a, "deep", { models: [{ provider: "orange", modelId: "gpt-ctx" }], constraints: { testMinContext: 5 } }, modelRegistry, injected);
		expect(read("project", cwd).groups.deep.constraints).toStrictEqual({ testMinContext: 5 });
		// Load with the same registry decodes/validates the persisted value.
		const loaded = loadModelGroups(a, injected);
		expect(loaded.issues).toHaveLength(0);
		expect(loaded.configs.project.groups.deep.constraints?.testMinContext).toBe(5);
		// Boot validation with the same registry carries the injected descriptor's evaluation.
		const resolved = validateModelGroups(loaded, modelRegistry, injected);
		expect(
			resolved[0].evaluations.map((evaluation) => evaluation.key),
			"injected evaluation must be present in boot validation",
		).toContain("testMinContext");
		// Unknown keys stay opaque even under an injected registry.
		updateGroup(
			"project",
			a,
			"deep",
			{ models: [{ provider: "orange", modelId: "gpt-ctx" }], constraints: { testMinContext: 5, futureKey: { nested: true } } },
			modelRegistry,
			injected,
		);
		expect(read("project", cwd).groups.deep.constraints).toStrictEqual({ testMinContext: 5, futureKey: { nested: true } });
	}));

test("injected persisted values are validated on save and malformed values trigger schema-invalid load recovery", () =>
	withTemp(({ cwd }) => {
		const a = access(cwd);
		const injected = createConstraintRegistry([testMinContext]);
		const sourcePath = modelGroupsPath("project", cwd);
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		// Save-side rejection: an invalid injected value cannot be persisted.
		expect(() => {
			saveModelGroups("project", a, { version: 2, groups: { g: { models: [], constraints: { testMinContext: -3 } } } }, injected);
		}).toThrow(
			expect.toSatisfy((error: ModelGroupsPersistenceError) => {
				expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
				expect(error.message).toMatch(/testMinContext must be a positive safe integer/);
				return true;
			}),
		);
		// Load-side recovery: a hand-edited malformed value is schema-invalid and backed up.
		fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { g: { models: [], constraints: { testMinContext: "nope" } } } }), "utf8");
		const loaded = loadModelGroups(a, injected);
		expect(loaded.issues).toHaveLength(1);
		expect(loaded.issues[0].kind).toBe("schema-invalid");
		expect(loaded.issues[0].message).toMatch(/testMinContext must be a positive safe integer/);
		expect(`${sourcePath}.bak`, "malformed injected value must back up like any schema-invalid config").toSatisfy(fs.existsSync);
	}));

test("CRUD rejects unsupported injected overrides before any write", () =>
	withTemp(async ({ cwd }) => {
		const a = access(cwd);
		const injected = createConstraintRegistry([testMinContext]);
		const modelRegistry = await storeRegistry();
		const writeFileSync = vi.fn(fs.writeFileSync);
		__setModelGroupsFsForTests({ writeFileSync });
		try {
			expect(() => {
				createGroup(
					"project",
					a,
					"deep",
					{ models: [{ provider: "orange", modelId: "gpt-ctx" }], constraints: { testMinContext: 200 } },
					modelRegistry,
					injected,
				);
			}).toThrow(/testMinContext override 200 exceeds/);
			expect(writeFileSync, "rejected injected override must not write").not.toHaveBeenCalled();
		} finally {
			__setModelGroupsFsForTests(null);
		}
	}));

test("opaque constraint values are deep-cloned on load — no aliasing between store and merged views", () =>
	withTemp(({ cwd }) => {
		const a = access(cwd);
		// An opaque (unknown to the registry) nested constraint value passes through
		// persistence untouched; the store and merged views must not share it by reference.
		const nested = { min: 5, tags: ["a", "b"] };
		saveModelGroups("project", a, {
			version: 2,
			groups: { deep: { models: [{ provider: "orange", modelId: "gpt-5" }], constraints: { testMinContext: nested } } },
		});
		const loaded = loadModelGroups(a);
		const merged = loaded.merged.find((g) => g.name === "deep");
		assertPresent(merged, "the merged view holds the deep group");
		const mergedConstraints = merged.constraints;
		const storedConstraints = loaded.configs.project.groups.deep.constraints;
		assertPresent(mergedConstraints, "the merged group keeps its constraints");
		assertPresent(storedConstraints, "the stored group keeps its constraints");
		recordOf(mergedConstraints.testMinContext, "the merged constraint value").min = 99;
		expect(recordOf(storedConstraints.testMinContext, "the stored constraint value").min, "mutating the merged view must not alias the store copy").toBe(5);
		expect(mergedConstraints.testMinContext, "nested constraint values must be distinct objects").not.toBe(storedConstraints.testMinContext);
	}));

test.each<[string, unknown, RegExp]>([
	["non-array", { version: 2, groups: { g: { models: [], constraints: { modalities: { text: true } } } } }, /modalities/],
	["duplicate", { version: 2, groups: { g: { models: [], constraints: { modalities: ["text", "text"] } } } }, /unique/],
	["out-of-language", { version: 2, groups: { g: { models: [], constraints: { modalities: ["audio"] } } } }, /vocabulary/],
])("v2 config load rejects non-array, duplicate, and out-of-vocabulary modality constraints: %s", (_label, raw, message) =>
	withTemp(({ cwd }) => {
		const projectPath = writeProjectFile(cwd, JSON.stringify(raw));
		const issue = loadModelGroups(access(cwd)).issues.find((candidate) => candidate.scope === "project");
		assertPresent(issue, "the project config reports a load issue");
		expect(issue.kind).toBe("schema-invalid");
		expect(issue.message).toMatch(message);
		expect(`${projectPath}.bak`).toSatisfy(fs.existsSync);
	}),
);

test.each<[string, { constraints?: { modalities: string[] } }, string[] | undefined, boolean]>([
	["generic", { constraints: { modalities: ["reasoning", "text"] } }, ["text", "reasoning"], true],
	["empty", { constraints: { modalities: [] } }, [], true],
	["automatic", {}, undefined, false],
])("v2 constraint envelope preserves explicit empty and opaque slots canonically: %s", (name, envelope, expected, persistsConstraints) =>
	withTemp(({ cwd }) => {
		writeProjectFile(cwd, JSON.stringify({ version: 2, groups: { [name]: { models: [{ provider: "orange", modelId: "gpt-5" }], ...envelope } } }));
		const loaded = loadModelGroups(access(cwd));
		expect(loaded.issues).toHaveLength(0);
		expect(loaded.configs.project.groups[name].constraints?.modalities).toStrictEqual(expected);
		saveModelGroups("project", access(cwd), loaded.configs.project);
		const persisted = read("project", cwd).groups[name];
		expect(persisted.constraints?.modalities).toStrictEqual(expected);
		expect(Object.hasOwn(persisted, "constraints")).toBe(persistsConstraints);
	}),
);

test("v2 normalization preserves opaque root group and model keys through load save and update", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const sourcePath = modelGroupsPath("project", cwd);
		const raw = {
			version: 2,
			rootSentinel: { keep: true },
			groups: {
				review: {
					groupSentinel: "keep",
					models: [{ provider: "orange", modelId: "gpt-5", modelSentinel: "keep" }],
				},
			},
		};
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		fs.writeFileSync(sourcePath, JSON.stringify(raw), "utf8");

		const loaded = loadModelGroups(access(cwd));
		saveModelGroups("project", access(cwd), loaded.configs.project);
		updateGroup(
			"project",
			access(cwd),
			"review",
			{ ...loaded.configs.project.groups.review, models: loaded.configs.project.groups.review.models.map((model) => ({ ...model, thinkingLevel: "high" })) },
			registry,
		);

		const persisted = read("project", cwd);
		expect(persisted.rootSentinel).toStrictEqual({ keep: true });
		expect(persisted.groups.review.groupSentinel).toBe("keep");
		expect(persisted.groups.review.models[0].modelSentinel).toBe("keep");
		expect(persisted.groups.review.models[0].thinkingLevel).toBe("high");
	}));

test("a modalityOverride key in a version-2 file is kept as an opaque key and not read as an override", () =>
	withTemp(async ({ cwd }) => {
		writeProjectFile(
			cwd,
			JSON.stringify({ version: 2, groups: { review: { models: [{ provider: "orange", modelId: "gpt-5" }], modalityOverride: ["text"] } } }),
		);
		const loaded = loadModelGroups(access(cwd));
		const [review] = validateModelGroups(loaded, await storeRegistry());
		assertPresent(review, "the review group resolves");
		expect(review.modalities.effective).toStrictEqual(["text", "image", "reasoning"]);
		saveModelGroups("project", access(cwd), loaded.configs.project);
		expect(read("project", cwd).groups.review.modalityOverride).toStrictEqual(["text"]);
	}));

test("store normalization strips runtime-derived group keys while preserving opaque keys", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const a = access(cwd);
		createGroup("project", a, "review", { models: [{ provider: "orange", modelId: "gpt-5" }] }, registry);
		const runtimeView: ResolvedModelGroup & { opaqueSentinel: { keep: boolean } } = {
			models: [{ provider: "orange", modelId: "gpt-5" }],
			constraints: { modalities: ["text", "image"] },
			opaqueSentinel: { keep: true },
			name: "review",
			scope: "project",
			sourcePath: "/runtime/model-groups.json",
			modalities: { common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text", "image"] },
			validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] },
			evaluations: [],
		};
		updateGroup("project", a, "review", runtimeView, registry);
		const persisted = read("project", cwd).groups.review;
		expect(Object.keys(persisted).sort()).toStrictEqual(["constraints", "models", "opaqueSentinel"]);
		expect(persisted.constraints?.modalities).toStrictEqual(["text", "image"]);
		expect(persisted.opaqueSentinel).toStrictEqual({ keep: true });
		for (const key of ["name", "scope", "sourcePath", "modalities", "validation", "evaluations"]) {
			expect(Object.getOwnPropertyNames(persisted)).not.toContain(key);
		}
	}));

test("version-3 mutations refuse before temp write including loadScopeConfig-backed CRUD", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const sourcePath = modelGroupsPath("project", cwd);
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
		fs.writeFileSync(sourcePath, JSON.stringify({ version: 3, groups: {} }), "utf8");
		const writeFileSync = vi.fn(() => {
			throw new Error("must not write");
		});
		__setModelGroupsFsForTests({ writeFileSync });
		for (const mutate of [
			() => {
				saveModelGroups("project", access(cwd), { version: 2, groups: {} });
			},
			() => {
				createGroup("project", access(cwd), "blocked", { models: [] }, registry);
			},
		]) {
			expect(mutate).toThrow(
				expect.toSatisfy((error: ModelGroupsPersistenceError) => {
					expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
					expect(error.phase).toBe("config-validation");
					return true;
				}),
			);
		}
		expect(writeFileSync).not.toHaveBeenCalled();
		expect(fs.readFileSync(sourcePath, "utf8")).toBe(JSON.stringify({ version: 3, groups: {} }));
	}));

test("modality overrides survive CRUD rename and move lifecycle in both scopes", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const a = access(cwd);
		createGroup("project", a, "review", { models: [{ provider: "orange", modelId: "gpt-5" }], constraints: { modalities: ["image"] } }, registry);
		updateGroup("project", a, "review", { models: [{ provider: "orange", modelId: "gpt-5" }], constraints: { modalities: ["text", "image"] } }, registry);
		renameGroup("project", a, "review", "reviewers");
		moveGroup(a, "reviewers", "global");
		saveModelGroups("global", a, loadModelGroups(a).configs.global);
		expect(read("global", cwd).groups.reviewers.constraints?.modalities).toStrictEqual(["text", "image"]);

		renameGroup("global", a, "reviewers", "global-reviewers");
		moveGroup(a, "global-reviewers", "project");
		expect(read("global", cwd).groups["global-reviewers"]).toBeUndefined();
		expect(read("project", cwd).groups["global-reviewers"].constraints?.modalities).toStrictEqual(["text", "image"]);
	}));

test("model groups use branded paths", () =>
	withTemp(({ cwd }) => {
		expect(modelGroupsPath("project", cwd, "branded-pi")).toBe(path.join(cwd, "branded-pi", "pi-schematic", "model-groups.json"));
	}));

test("model groups global-only access refuses project scope", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const projectProbes: string[] = [];
		__setModelGroupsFsForTests({
			existsSync: (candidate) => {
				if (String(candidate).startsWith(cwd)) {
					projectProbes.push(String(candidate));
					throw new Error("project probed");
				}
				return fs.existsSync(candidate);
			},
		});
		const untrusted = loadModelGroups(access(cwd, "global-only"));
		expect(projectProbes).toStrictEqual([]);
		expect(untrusted.merged.filter((group) => group.scope !== "global")).toStrictEqual([]);
		expect(() => {
			createGroup("project", access(cwd, "global-only"), "forbidden", { models: [] }, registry);
		}).toThrow(/global-only/);
		expect(projectProbes).toStrictEqual([]);
	}));

test("model groups keep canonical own keys", () =>
	withTemp(({ cwd }) => {
		writeProjectFile(cwd, '{"version":2,"groups":{" __proto__ ":{"models":[]},"constructor":{"models":[]},"toString":{"models":[]}}}');
		const loaded = loadModelGroups(access(cwd));
		expect(Object.getOwnPropertyNames(loaded.configs.project.groups).sort()).toStrictEqual(["__proto__", "constructor", "toString"]);
		saveModelGroups("project", access(cwd), loaded.configs.project);
		expect(Object.keys(read("project", cwd).groups).sort()).toStrictEqual(["__proto__", "constructor", "toString"]);
	}));

test("model groups persist native max", () =>
	withTemp(({ cwd }) => {
		writeProjectFile(cwd, JSON.stringify({ version: 2, groups: { deep: { models: [{ provider: "p", modelId: "m", thinkingLevel: "max" }] } } }));
		const loaded = loadModelGroups(access(cwd));
		expect(loaded.configs.project.groups.deep.models[0].thinkingLevel).toBe("max");
		saveModelGroups("project", access(cwd), loaded.configs.project);
		expect(read("project", cwd).groups.deep.models[0].thinkingLevel).toBe("max");
	}));

test.for(["__proto__", "constructor"])("rename, move and delete of a group named %s leave exactly the expected own group keys", (name) =>
	withTemp(async ({ cwd }) => {
		const a = access(cwd);
		const registry = await storeRegistry();
		const groups = (scope: ModelGroupScope) => loadModelGroups(a).configs[scope].groups;
		const names = (scope: ModelGroupScope) => Object.getOwnPropertyNames(groups(scope)).sort();
		createGroup("project", a, "keep", { models: [{ provider: "orange", modelId: "gpt-5" }] }, registry);
		createGroup("project", a, name, { models: [{ provider: "alpha", modelId: "claude" }] }, registry);
		createGroup("global", a, "other", { models: [{ provider: "alpha", modelId: "claude" }] }, registry);
		createGroup("global", a, "drop", { models: [] }, registry);
		const keep = groups("project").keep;
		const other = groups("global").other;

		renameGroup("project", a, name, "renamed");
		const renamedAway = names("project");
		renameGroup("project", a, "renamed", name);
		const renamedBack = names("project");

		moveGroup(a, name, "global");
		const moved = { project: names("project"), global: names("global") };

		renameGroup("global", a, "drop", "dropped");
		const siblingRenamed = names("global");
		deleteGroup("global", a, "dropped");
		const siblingDeleted = names("global");

		deleteGroup("global", a, name);
		expect({
			renamedAway,
			renamedBack,
			moved,
			siblingRenamed,
			siblingDeleted,
			deleted: names("global"),
			keep: groups("project").keep,
			other: groups("global").other,
		}).toStrictEqual({
			renamedAway: ["keep", "renamed"],
			renamedBack: [name, "keep"].sort(),
			moved: { project: ["keep"], global: [name, "drop", "other"].sort() },
			siblingRenamed: [name, "dropped", "other"].sort(),
			siblingDeleted: [name, "other"].sort(),
			deleted: ["other"],
			keep,
			other,
		});
	}),
);

test("model groups direct save canonicalizes unique keys and rejects empty/colliding keys before write", () =>
	withTemp(({ cwd }) => {
		const a = access(cwd);
		saveModelGroups("project", a, { version: 2, groups: { committed: { models: [] } } });
		const unique: Record<string, ModelGroupDef> = {};
		Object.setPrototypeOf(unique, null);
		Object.defineProperty(unique, " unique ", { value: { models: [] }, enumerable: true });
		saveModelGroups("project", a, { version: 2, groups: unique });
		expect(Object.keys(read("project", cwd).groups)).toStrictEqual(["unique"]);
		for (const keys of [["   "], ["same", " same "]]) {
			const groups: Record<string, ModelGroupDef> = {};
			Object.setPrototypeOf(groups, null);
			for (const key of keys) {
				Object.defineProperty(groups, key, { value: { models: [] }, enumerable: true });
			}
			const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
			const writeFileSync = vi.fn(() => {
				throw new Error("must not write");
			});
			__setModelGroupsFsForTests({ writeFileSync });
			expect(() => {
				saveModelGroups("project", a, { version: 2, groups });
			}).toThrow(
				expect.toSatisfy((error: ModelGroupsPersistenceError) => {
					expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
					expect(error.operation).toBe("save");
					expect(error.phase).toBe("config-validation");
					return true;
				}),
			);
			expect(writeFileSync).not.toHaveBeenCalled();
			expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe(before);
			__setModelGroupsFsForTests(null);
		}
	}));

test("global model groups file lives under PI_CODING_AGENT_DIR when it is set", () =>
	withTemp(async ({ cwd, home }) => {
		const registry = await storeRegistry();
		await withTempAgentDir((agentDir) => {
			const expectedPath = path.join(agentDir, "pi-schematic", "model-groups.json");
			expect(modelGroupsPath("global", cwd)).toBe(expectedPath);

			createGroup("global", access(cwd), "relocated", { models: [] }, registry);

			expect(readFile(expectedPath).groups.relocated.models).toStrictEqual([]);
			expect(path.join(home, ".pi")).not.toSatisfy(fs.existsSync);
		});
	}));

test("global model groups file defaults to the home agent dir when PI_CODING_AGENT_DIR is unset", () =>
	withTemp(({ cwd, home }) => {
		expect(modelGroupsPath("global", cwd)).toBe(path.join(home, ".pi", "agent", "pi-schematic", "model-groups.json"));
	}));

test("global model groups path follows a PI_CODING_AGENT_DIR change between resolutions", () =>
	withTemp(async ({ cwd }) => {
		await withTempAgentDir((firstAgentDir) => {
			expect(modelGroupsPath("global", cwd)).toBe(path.join(firstAgentDir, "pi-schematic", "model-groups.json"));
		});
		await withTempAgentDir((secondAgentDir) => {
			expect(modelGroupsPath("global", cwd)).toBe(path.join(secondAgentDir, "pi-schematic", "model-groups.json"));
		});
	}));

function pointAgentDirAtProjectConfig(cwd: string): string {
	const agentDir = path.join(cwd, ".pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return path.join(agentDir, "pi-schematic", "model-groups.json");
}

test("a project config dir that is the agent dir loads its groups once, as global", () =>
	withTemp(({ cwd }) => {
		const sharedPath = pointAgentDirAtProjectConfig(cwd);
		fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
		fs.writeFileSync(sharedPath, JSON.stringify({ version: 2, groups: { shared: { models: [] } } }));

		const loaded = loadModelGroups(access(cwd, "global-project"));

		expect(loaded.merged.map((g) => [g.name, g.scope])).toStrictEqual([["shared", "global"]]);
	}));

test("a project config dir that is the agent dir refuses project-scope writes", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		const sharedPath = pointAgentDirAtProjectConfig(cwd);

		expect(() => {
			createGroup("project", access(cwd, "global-project"), "local", { models: [] }, registry);
		}).toThrow(/unavailable in global-only mode/);
		expect(sharedPath).not.toSatisfy(fs.existsSync);
	}));

test("a trusted session whose project config dir is the agent dir gets global-only access", () =>
	withTemp(({ cwd }) => {
		pointAgentDirAtProjectConfig(cwd);

		expect(createModelGroupsAccess(cwd, true).policy).toBe("global-only");
	}));

function pointAgentDirAtProjectConfigThroughSymlink(cwd: string): void {
	const configDir = path.join(cwd, ".pi");
	const link = path.join(path.dirname(cwd), "agent-dir-link");
	fs.mkdirSync(configDir, { recursive: true });
	// A junction needs no privilege on Windows; other platforms ignore the type.
	fs.symlinkSync(configDir, link, "junction");
	process.env.PI_CODING_AGENT_DIR = link;
}

/** Points the agent dir at the project config dir spelled in another case; returns false on a case-sensitive filesystem. */
function pointAgentDirAtProjectConfigInOtherCase(cwd: string): boolean {
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const upperCased = path.join(cwd, ".PI");
	if (!fs.existsSync(upperCased)) {
		return false;
	}
	process.env.PI_CODING_AGENT_DIR = upperCased;
	return true;
}

function writeSharedGroup(cwd: string): void {
	const sharedPath = path.join(cwd, ".pi", "pi-schematic", "model-groups.json");
	fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
	fs.writeFileSync(sharedPath, JSON.stringify({ version: 2, groups: { shared: { models: [] } } }));
}

test("distinct config dirs on a filesystem reporting inode 0 keep both scopes", () =>
	withTemp(({ cwd, home }) => {
		const agentDir = path.join(home, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		saveModelGroups("global", access(cwd), { version: 2, groups: { fromGlobal: { models: [] } } });
		saveModelGroups("project", access(cwd), { version: 2, groups: { fromProject: { models: [] } } });
		__setModelGroupsFsForTests({ statSync: (() => ({ dev: 1n, ino: 0n })) as any });

		const trusted = createModelGroupsAccess(cwd, true);

		expect(trusted.policy).toBe("global-project");
		expect(loadModelGroups(trusted).merged.map((g) => [g.name, g.scope])).toStrictEqual([
			["fromGlobal", "global"],
			["fromProject", "project"],
		]);
	}));

test("an agent dir symlinked to the project config dir loads its groups once, as global", () =>
	withTemp(({ cwd }) => {
		pointAgentDirAtProjectConfigThroughSymlink(cwd);
		writeSharedGroup(cwd);

		const loaded = loadModelGroups(access(cwd, "global-project"));

		expect(loaded.merged.map((g) => [g.name, g.scope])).toStrictEqual([["shared", "global"]]);
	}));

test("an agent dir symlinked to the project config dir refuses project-scope writes", () =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		pointAgentDirAtProjectConfigThroughSymlink(cwd);

		expect(() => {
			createGroup("project", access(cwd, "global-project"), "local", { models: [] }, registry);
		}).toThrow(/unavailable in global-only mode/);
		expect(path.join(cwd, ".pi", "pi-schematic", "model-groups.json")).not.toSatisfy(fs.existsSync);
	}));

test("an agent dir naming the project config dir in another case loads its groups once, as global", ({ skip }) =>
	withTemp(({ cwd }) => {
		if (!pointAgentDirAtProjectConfigInOtherCase(cwd)) {
			skip("the temp filesystem is case-sensitive, so the two spellings are different directories");
		}
		writeSharedGroup(cwd);

		const loaded = loadModelGroups(access(cwd, "global-project"));

		expect(loaded.merged.map((g) => [g.name, g.scope])).toStrictEqual([["shared", "global"]]);
	}));

test("an agent dir naming the project config dir in another case refuses project-scope writes", ({ skip }) =>
	withTemp(async ({ cwd }) => {
		const registry = await storeRegistry();
		if (!pointAgentDirAtProjectConfigInOtherCase(cwd)) {
			skip("the temp filesystem is case-sensitive, so the two spellings are different directories");
		}

		expect(() => {
			createGroup("project", access(cwd, "global-project"), "local", { models: [] }, registry);
		}).toThrow(/unavailable in global-only mode/);
		expect(path.join(cwd, ".pi", "pi-schematic", "model-groups.json")).not.toSatisfy(fs.existsSync);
	}));
