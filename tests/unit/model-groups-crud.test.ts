import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { ModelGroupsPersistenceError, type ModelGroupScope, type ModelGroupsAccess } from "../../model-groups/types.js";
import { createConstraintRegistry } from "../../model-groups/constraints/registry.js";
import { testMinContext } from "./model-groups-constraints-fixture.js";
import { withTempAgentDir } from "./helpers.js";
import { withTemp } from "./model-groups-helpers.js";

function access(cwd: string, policy: ModelGroupsAccess["policy"] = "global-project"): ModelGroupsAccess { return { cwd, policy }; }

function read(scope: ModelGroupScope, cwd: string): any {
	return JSON.parse(fs.readFileSync(modelGroupsPath(scope, cwd), "utf8"));
}

function registry(available = new Set(["openai:gpt-5", "anthropic:claude"])): any {
	const models = [
		{ provider: "openai", id: "gpt-5", input: ["text", "image"], reasoning: true, thinkingLevelMap: { xhigh: "x" } },
		{ provider: "anthropic", id: "claude", input: ["text"], reasoning: false },
	];
	return {
		getAll: () => models,
		getAvailable: () => models.filter((m) => available.has(`${m.provider}:${m.id}`)),
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: any) => available.has(`${model.provider}:${model.id}`),
	};
}

test("model groups store creates, round-trips, validates, renames, updates, deletes, and moves", () => withTemp(({ cwd }) => {
	expect(Object.keys(loadModelGroups(access(cwd)).configs.project.groups)).toHaveLength(0);
	createGroup("project", access(cwd), "review", { models: [] }, registry());
	expect(read("project", cwd).groups.review.models).toStrictEqual([]);
	expect(() => createGroup("project", access(cwd), "review", { models: [] }, registry())).toThrow(/already exists/);

	createGroup("project", access(cwd), "inherit-roundtrip", { models: [{ provider: "anthropic", modelId: "claude" }] }, registry());
	const inheritLoaded = loadModelGroups(access(cwd)).configs.project.groups["inherit-roundtrip"].models[0];
	expect(inheritLoaded.thinkingLevel).toBeUndefined();
	expect(Object.getOwnPropertyNames(inheritLoaded)).not.toContain("thinkingLevel");
	const inheritPersisted = read("project", cwd).groups["inherit-roundtrip"].models[0];
	expect(inheritPersisted.thinkingLevel).toBeUndefined();
	expect(Object.getOwnPropertyNames(inheritPersisted)).not.toContain("thinkingLevel");

	updateGroup("project", access(cwd), "review", { models: [{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" }] }, registry());
	renameGroup("project", access(cwd), "review", "reviewers");
	expect(read("project", cwd).groups.review).toBeUndefined();
	expect(read("project", cwd).groups.reviewers.models[0].thinkingLevel).toBe("high");

	createGroup("project", access(cwd), "collision", { models: [] }, registry());
	expect(() => renameGroup("project", access(cwd), "reviewers", "collision")).toThrow(/already exists/);
	createGroup("global", access(cwd), "reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "missing", modelId: "nope" }] }, registry());
	const loaded = loadModelGroups(access(cwd));
	const resolved = validateModelGroups(loaded, registry());
	const globalReviewers = resolved.find((g) => g.name === "reviewers" && g.scope === "global");
	expect(globalReviewers?.validation.shadowedByProject).toBe(true);
	expect(globalReviewers?.validation.unavailableRefs).toStrictEqual([{ provider: "missing", modelId: "nope" }]);
	expect(globalReviewers?.validation.degraded).toBe(true);

	createGroup("global", access(cwd), "move-collision", { models: [] }, registry());
	createGroup("project", access(cwd), "move-collision", { models: [] }, registry());
	expect(() => moveGroup(access(cwd), "move-collision", "project")).toThrow(/already exists in project scope/);
	expect(read("global", cwd).groups["move-collision"]).toBeTruthy();
	expect(read("project", cwd).groups["move-collision"]).toBeTruthy();

	const deleted = deleteGroup("global", access(cwd), "reviewers");
	expect(deleted.otherScopeHasOverride).toBe(true);
	moveGroup(access(cwd), "reviewers", "global");
	expect(read("global", cwd).groups.reviewers).toBeTruthy();
	expect(read("project", cwd).groups.reviewers).toBeUndefined();
}));

test("model groups load recovery handles malformed, schema-invalid, unsupported version, and backup failure", () => withTemp(({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{not json", "utf8");
	let loaded = loadModelGroups(access(cwd));
	expect(loaded.issues[0].kind).toBe("corrupt-json");
	expect(`${modelGroupsPath("global", cwd)}.bak`).toSatisfy(fs.existsSync);

	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { bad: { models: [{ provider: 1 }] } } }), "utf8");
	loaded = loadModelGroups(access(cwd));
	const schemaIssue = loaded.issues.find((i) => i.scope === "project")!;
	expect(schemaIssue.kind).toBe("schema-invalid");
	expect(schemaIssue.scope).toBe("project");
	expect(schemaIssue.sourcePath).toBe(modelGroupsPath("project", cwd));
	expect(schemaIssue.backupPath).toBe(`${modelGroupsPath("project", cwd)}.bak`);
	expect(schemaIssue.message).toMatch(/provider/);
	expect(schemaIssue.backupPath!).toSatisfy(fs.existsSync);
	expect(Object.keys(loaded.configs.project.groups)).toHaveLength(0);

	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	loaded = loadModelGroups(access(cwd));
	expect(loaded.issues.find((i) => i.scope === "project")?.kind).toBe("unsupported-version");
	expect(loaded.issues.find((i) => i.scope === "project")?.version).toBe(99);

	fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
	__setModelGroupsFsForTests({ copyFileSync: () => { throw new Error("denied"); } });
	loaded = loadModelGroups(access(cwd));
	const issue = loaded.issues.find((i) => i.scope === "project")!;
	expect(issue.backupFailed).toBe(true);
	expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe("{bad");
	expect(() => createGroup("project", access(cwd), "must-not-overwrite", { models: [] }, registry())).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.operation).toBe("save");
		expect(error.phase).toBe("load-recovery");
		return true;
	}));
	expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe("{bad");
}));

test("model groups rename failure removes the generated temp file and preserves committed bytes", () => withTemp(({ cwd }) => {
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
	expect(() => saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } })).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.operation).toBe("save");
		expect(error.phase).toBe("rename");
		expect(error.sourcePath).toBe(sourcePath);
		expect(error.targetPath).toBe(generatedTempPath);
		expect(error.cause).toBe(renameCause);
		return true;
	}));

	expect(generatedTempPath).not.toBe("");
	expect(fs.readFileSync(sourcePath)).toStrictEqual(committedBytes);
	expect(generatedTempPath).not.toSatisfy(fs.existsSync);
	expect(fs.readdirSync(path.dirname(sourcePath)).filter((name) => /^model-groups\.json\.\d+\.\d+\.tmp$/.test(name))).toStrictEqual([]);
}));

test("model groups rename cleanup failure remains supplemental to the original typed error", () => withTemp(({ cwd }) => {
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
	expect(() => saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } })).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.operation).toBe("save");
		expect(error.phase).toBe("rename");
		expect(error.sourcePath).toBe(sourcePath);
		expect(error.targetPath).toBe(generatedTempPath);
		expect(error.cause).toBe(renameCause);
		expect(error.message).toMatch(/cleanup denied/);
		return true;
	}));

	expect(generatedTempPath).not.toBe("");
	expect(fs.readFileSync(sourcePath)).toStrictEqual(committedBytes);
	expect(generatedTempPath).toSatisfy(fs.existsSync);
}));

test("model groups persistence failures throw typed errors and preserve committed state", () => withTemp(({ cwd }) => {
	saveModelGroups("project", access(cwd), { version: 2, groups: { keep: { models: [] } } });
	__setModelGroupsFsForTests({ writeFileSync: () => { throw new Error("temp denied"); } });
	expect(() => updateGroup("project", access(cwd), "keep", { models: [{ provider: "openai", modelId: "gpt-5" }] }, registry())).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.operation).toBe("save");
		expect(error.phase).toBe("temp-write");
		expect(error.scope).toBe("project");
		expect(error.sourcePath).toBe(modelGroupsPath("project", cwd));
		expect(error.targetPath ?? "").toMatch(/model-groups\.json\..+\.tmp$/);
		return true;
	}));
	__setModelGroupsFsForTests(null);
	expect(read("project", cwd).groups.keep).toBeTruthy();
	expect(read("project", cwd).groups.keep.models).toHaveLength(0);

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("rename denied"); } });
	expect(() => saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } })).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.phase).toBe("rename");
		return true;
	}));
	__setModelGroupsFsForTests(null);
	expect(read("project", cwd).groups.keep).toBeTruthy();
	expect(read("project", cwd).groups.drop).toBeUndefined();

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("delete denied"); } });
	expect(() => deleteGroup("project", access(cwd), "keep")).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.operation).toBe("delete");
		return true;
	}));
	__setModelGroupsFsForTests(null);

	createGroup("global", access(cwd), "move-target-fails", { models: [] }, registry());
	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("target denied"); } });
	expect(() => moveGroup(access(cwd), "move-target-fails", "project")).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.operation).toBe("move");
		expect(error.partialMove).toBeUndefined();
		return true;
	}));
	__setModelGroupsFsForTests(null);

	createGroup("global", access(cwd), "move-me", { models: [] }, registry());
	let writes = 0;
	__setModelGroupsFsForTests({ renameSync: (from, to) => { writes++; if (writes === 2) throw new Error("source denied"); fs.renameSync(from, to); } });
	expect(() => moveGroup(access(cwd), "move-me", "project")).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.partialMove).toBe("target-written-source-retained");
		expect(error.phase).toBe("source-remove");
		return true;
	}));
}));

test("model groups strictly partitions schema and legacy version domains", () => withTemp(({ cwd }) => {
	const projectPath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	const invalid: Array<[string, unknown, RegExp]> = [
		["root", [], /root/], ["version type", { version: "1", groups: {} }, /version/],
		["negative", { version: -1, groups: {} }, /version/], ["fraction low", { version: 0.5, groups: {} }, /version/],
		["fraction high", { version: 1.5, groups: {} }, /version/], ["groups", { version: 2, groups: [] }, /groups/],
		["group", { version: 2, groups: { bad: 1 } }, /group/],
		["provider missing", { version: 2, groups: { bad: { models: [{ modelId: "m" }] } } }, /provider/],
		["provider type", { version: 2, groups: { bad: { models: [{ provider: 1, modelId: "m" }] } } }, /provider/],
		["model missing", { version: 2, groups: { bad: { models: [{ provider: "p" }] } } }, /modelId/],
		["model type", { version: 2, groups: { bad: { models: [{ provider: "p", modelId: 1 }] } } }, /modelId/],
		["models", { version: 2, groups: { bad: { models: 1 } } }, /models/],
		["thinking", { version: 2, groups: { bad: { models: [{ provider: "p", modelId: "m", thinkingLevel: "turbo" }] } } }, /thinkingLevel/],
	];
	for (const [label, raw, message] of invalid) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((candidate) => candidate.scope === "project")!;
		expect(issue.kind, label).toBe("schema-invalid");
		expect(issue.message, label).toMatch(message);
		expect(`${projectPath}.bak`, label).toSatisfy(fs.existsSync);
		expect(Object.keys(loaded.configs.project.groups).length, label).toBe(0);
	}
	for (const raw of [{ groups: { legacy: { models: [] } } }, { version: 0, groups: { legacy: { models: [] } } }]) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		expect(loaded.issues).toHaveLength(0);
		expect(loaded.configs.project.version).toBe(2);
		updateGroup("project", access(cwd), "legacy", { models: [] }, registry());
		expect(read("project", cwd).version).toBe(2);
	}
}));

test("legacy constraints recover as schema-invalid instead of crashing load", () => withTemp(({ cwd }) => {
	const projectPath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	for (const raw of [{ groups: { legacy: { models: [], constraints: {} } } }, { version: 0, groups: { legacy: { models: [], constraints: {} } } }, { version: 1, groups: { legacy: { models: [], constraints: {} } } }]) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((candidate) => candidate.scope === "project")!;
		expect(issue.kind).toBe("schema-invalid");
		expect(issue.message).toMatch(/constraints/);
		expect(`${projectPath}.bak`).toSatisfy(fs.existsSync);
		expect(Object.keys(loaded.configs.project.groups)).toHaveLength(0);
	}
}));

test("store-level validation derives empty-common and stale-override flags and counts them", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: {
		empty: { models: [] },
		unresolved: { models: [{ provider: "openai", modelId: "gone" }, { provider: "openai", modelId: "gpt-5" }] },
		stale: { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["text", "image"] } },
	} }), "utf8");
	const resolved = validateModelGroups(loadModelGroups(a), registry());
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

test("low-level save permits shape-valid overrides while CRUD rejects union-cap-invalid overrides", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	// The low-level persistence boundary only validates v2 shape. It deliberately
	// persists this image override even though claude's union has text only.
	saveModelGroups("project", a, { version: 2, groups: { persistenceOnly: { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["image"] } } } });
	expect(read("project", cwd).groups.persistenceOnly.constraints.modalities).toStrictEqual(["image"]);
	// CRUD owns the union-cap invariant and must reject the same invalid shape
	// before any write.
	// claude supports only text, so an override of image must be rejected by the CRUD gate.
	let writes = 0;
	__setModelGroupsFsForTests({ writeFileSync: (_p?: unknown, _d?: unknown, ..._r: unknown[]) => { writes++; fs.writeFileSync(_p as any, _d as any, ...(_r as any)); } });
	expect(() => createGroup("project", a, "claude-only", { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["image"] } }, registry())).toThrow(/unsupported modalities: image/);
	expect(writes).toBe(0);
	__setModelGroupsFsForTests(null);

	createGroup("project", a, "rich", { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { modalities: ["text", "image"] } }, registry());
	const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
	let writes2 = 0;
	__setModelGroupsFsForTests({ writeFileSync: (_p: unknown, _d: unknown, _r: unknown) => { writes2++; fs.writeFileSync(_p as any, _d as any, _r as any); } });
	// Combined member change: replacing gpt-5 (text+image+reasoning) with claude (text only)
	// makes the retained override's image unsupported → the gate must reject before any write.
	expect(() => updateGroup("project", a, "rich", { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["text", "image"] } }, registry())).toThrow(/unsupported modalities: image/);
	expect(writes2, "rejected update must not write").toBe(0);
	expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe(before);
	__setModelGroupsFsForTests(null);
}));

test("injected descriptors get persisted validation and CRUD cap enforcement through the registry", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	const injected = createConstraintRegistry([testMinContext]);
	// A model with a concrete contextWindow so the injected descriptor can evaluate it.
	const ctxModel = { provider: "openai", id: "gpt-ctx", input: ["text"], reasoning: false, contextWindow: 100 };
	const reg = registry();
	const modelRegistry: any = { ...reg, find: (provider: string, id: string) => id === "gpt-ctx" ? ctxModel : reg.find(provider, id) };
	// Valid override: normalized through CRUD and persisted.
	createGroup("project", a, "deep", { models: [{ provider: "openai", modelId: "gpt-ctx" }], constraints: { testMinContext: 5 } }, modelRegistry, injected);
	expect(read("project", cwd).groups.deep.constraints).toStrictEqual({ testMinContext: 5 });
	// Load with the same registry decodes/validates the persisted value.
	const loaded = loadModelGroups(a, injected);
	expect(loaded.issues).toHaveLength(0);
	expect(loaded.configs.project.groups.deep.constraints?.testMinContext).toBe(5);
	// Boot validation with the same registry carries the injected descriptor's evaluation.
	const resolved = validateModelGroups(loaded, modelRegistry, injected);
	expect(resolved[0].evaluations?.map((evaluation) => evaluation.key), "injected evaluation must be present in boot validation").toContain("testMinContext");
	// Unknown keys stay opaque even under an injected registry.
	updateGroup("project", a, "deep", { models: [{ provider: "openai", modelId: "gpt-ctx" }], constraints: { testMinContext: 5, futureKey: { nested: true } } }, modelRegistry, injected);
	expect(read("project", cwd).groups.deep.constraints).toStrictEqual({ testMinContext: 5, futureKey: { nested: true } });
}));

test("injected persisted values are validated on save and malformed values trigger schema-invalid load recovery", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	const injected = createConstraintRegistry([testMinContext]);
	const sourcePath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	// Save-side rejection: an invalid injected value cannot be persisted.
	expect(() => saveModelGroups("project", a, { version: 2, groups: { g: { models: [], constraints: { testMinContext: -3 } } } }, injected)).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
		expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
		expect(error.message).toMatch(/testMinContext must be a positive safe integer/);
		return true;
	}));
	// Load-side recovery: a hand-edited malformed value is schema-invalid and backed up.
	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { g: { models: [], constraints: { testMinContext: "nope" } } } }), "utf8");
	const loaded = loadModelGroups(a, injected);
	expect(loaded.issues).toHaveLength(1);
	expect(loaded.issues[0].kind).toBe("schema-invalid");
	expect(loaded.issues[0].message).toMatch(/testMinContext must be a positive safe integer/);
	expect(`${sourcePath}.bak`, "malformed injected value must back up like any schema-invalid config").toSatisfy(fs.existsSync);
}));

test("CRUD rejects unsupported injected overrides before any write", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	const injected = createConstraintRegistry([testMinContext]);
	const ctxModel = { provider: "openai", id: "gpt-ctx", input: ["text"], reasoning: false, contextWindow: 100 };
	const reg = registry();
	const modelRegistry: any = { ...reg, find: (provider: string, id: string) => id === "gpt-ctx" ? ctxModel : reg.find(provider, id) };
	let writes = 0;
	__setModelGroupsFsForTests({ writeFileSync: (_p?: unknown, _d?: unknown, ..._r: unknown[]) => { writes++; fs.writeFileSync(_p as any, _d as any, ...(_r as any)); } });
	try {
		expect(() => createGroup("project", a, "deep", { models: [{ provider: "openai", modelId: "gpt-ctx" }], constraints: { testMinContext: 200 } }, modelRegistry, injected)).toThrow(/testMinContext override 200 exceeds/);
		expect(writes, "rejected injected override must not write").toBe(0);
	} finally {
		__setModelGroupsFsForTests(null);
	}
}));

test("opaque constraint values are deep-cloned on load — no aliasing between store and merged views", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	// An opaque (unknown to the registry) nested constraint value passes through
	// persistence untouched; the store and merged views must not share it by reference.
	const nested = { min: 5, tags: ["a", "b"] };
	saveModelGroups("project", a, { version: 2, groups: { deep: { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { testMinContext: nested } } } });
	const loaded = loadModelGroups(a);
	const merged = loaded.merged.find((g) => g.name === "deep")!;
	(merged.constraints!.testMinContext as { min: number }).min = 99;
	expect((loaded.configs.project.groups.deep.constraints!.testMinContext as { min: number }).min, "mutating the merged view must not alias the store copy").toBe(5);
	expect(merged.constraints!.testMinContext, "nested constraint values must be distinct objects").not.toBe((loaded.configs.project.groups.deep.constraints!.testMinContext as unknown));
}));

test("v2 config load rejects non-array, duplicate, and out-of-vocabulary modality constraints", () => withTemp(({ cwd }) => {
	const projectPath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	const cases: Array<[string, unknown, RegExp]> = [
		["non-array", { version: 2, groups: { g: { models: [], constraints: { modalities: { text: true } } } } }, /modalities/],
		["duplicate", { version: 2, groups: { g: { models: [], constraints: { modalities: ["text", "text"] } } } }, /unique/],
		["out-of-language", { version: 2, groups: { g: { models: [], constraints: { modalities: ["audio"] } } } }, /vocabulary/],
	];
	for (const [label, raw, message] of cases) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((candidate) => candidate.scope === "project")!;
		expect(issue.kind, label).toBe("schema-invalid");
		expect(issue.message, label).toMatch(message);
		expect(`${projectPath}.bak`, label).toSatisfy(fs.existsSync);
	}
}));

test("v1 migration is in-memory until the first successful mutation writes v2 without an invented override", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const v1Bytes = JSON.stringify({ version: 1, groups: { legacy: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }, null, 2) + "\n";
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, v1Bytes, "utf8");

	const loaded = loadModelGroups(access(cwd));
	expect(loaded.configs.project.version).toBe(2);
	expect(loaded.configs.project.groups.legacy.constraints).toBeUndefined();
	expect(fs.readFileSync(sourcePath, "utf8")).toBe(v1Bytes);

	updateGroup("project", access(cwd), "legacy", { models: [{ provider: "anthropic", modelId: "claude" }] }, registry());
	const persisted = read("project", cwd);
	expect(persisted.version).toBe(2);
	expect(Object.getOwnPropertyNames(persisted.groups.legacy)).not.toContain("modalityOverride");
}));

test("legacy modalityOverride is opaque and not interpreted", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const v1Bytes = JSON.stringify({ version: 1, groups: { legacy: { models: [{ provider: "openai", modelId: "gpt-5" }], modalityOverride: ["image"] } } }, null, 2) + "\n";
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, v1Bytes, "utf8");
	const loaded = loadModelGroups(access(cwd));
	expect(loaded.configs.project.groups.legacy.constraints).toBeUndefined();
	expect(Object.getOwnPropertyNames(loaded.configs.project.groups.legacy)).toContain("modalityOverride");
	expect(fs.readFileSync(sourcePath, "utf8")).toBe(v1Bytes);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	expect(Object.getOwnPropertyNames(read("project", cwd).groups.legacy)).not.toContain("modalityOverride");
}));

test("malformed legacy modalityOverride loads opaquely and is dropped on a v2 write", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const v1Bytes = JSON.stringify({ version: 1, groups: { legacy: { models: [], modalityOverride: "not-an-array" } } }, null, 2) + "\n";
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, v1Bytes, "utf8");
	const loaded = loadModelGroups(access(cwd));
	expect(loaded.issues).toHaveLength(0);
	expect((loaded.configs.project.groups.legacy as any).modalityOverride).toBe("not-an-array");
	expect(fs.readFileSync(sourcePath, "utf8")).toBe(v1Bytes);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	expect(Object.getOwnPropertyNames(read("project", cwd).groups.legacy)).not.toContain("modalityOverride");
}));

test("v2 constraint envelope preserves explicit empty and opaque slots canonically", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	const fixtures: Array<[string, any, string[] | undefined]> = [
		["generic", { constraints: { modalities: ["reasoning", "text"] } }, ["text", "reasoning"]],
		["empty", { constraints: { modalities: [] } }, []],
		["automatic", {}, undefined],
	];
	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: Object.fromEntries(fixtures.map(([name, envelope]) => [name, { models: [{ provider: "openai", modelId: "gpt-5" }], ...envelope }])) }), "utf8");
	const loaded = loadModelGroups(access(cwd));
	expect(loaded.issues).toHaveLength(0);
	for (const [name, _envelope, expected] of fixtures) expect(loaded.configs.project.groups[name].constraints?.modalities, name).toStrictEqual(expected);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	const persisted = read("project", cwd);
	for (const [name, _envelope, expected] of fixtures) {
		const group = persisted.groups[name];
		if (expected === undefined) {
			expect(Object.getOwnPropertyNames(group), name).not.toContain("constraints");
		} else {
			expect(group.constraints.modalities, name).toStrictEqual(expected);
		}
	}

	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { opaque: { models: [{ provider: "openai", modelId: "gpt-5", modelSentinel: true }], groupSentinel: true, constraints: { modalities: ["image"], cost: { future: true } } } } }), "utf8");
	const opaque = loadModelGroups(access(cwd));
	updateGroup("project", access(cwd), "opaque", { ...opaque.configs.project.groups.opaque, models: [{ provider: "openai", modelId: "gpt-5", modelSentinel: true, thinkingLevel: "high" } as any] }, registry());
	const opaquePersisted = read("project", cwd).groups.opaque;
	expect(opaquePersisted.constraints).toStrictEqual({ modalities: ["image"], cost: { future: true } });
	expect(opaquePersisted.groupSentinel).toBe(true);
	expect(opaquePersisted.models[0].modelSentinel).toBe(true);
}));

test("v2 drops stale modalityOverride rather than reinterpreting it", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { stale: { models: [], modalityOverride: ["image"] } } }), "utf8");
	const loaded = loadModelGroups(access(cwd));
	expect(loaded.issues).toHaveLength(0);
	expect(loaded.configs.project.groups.stale.constraints).toBeUndefined();
	saveModelGroups("project", access(cwd), loaded.configs.project);
	expect(Object.getOwnPropertyNames(read("project", cwd).groups.stale)).not.toContain("modalityOverride");
}));

test("v2 normalization preserves opaque root group and model keys through load save and update", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const raw = {
		version: 2,
		rootSentinel: { keep: true },
		groups: {
			review: {
				groupSentinel: "keep",
				models: [{ provider: "openai", modelId: "gpt-5", modelSentinel: "keep" }],
			},
		},
	};
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, JSON.stringify(raw), "utf8");

	const loaded = loadModelGroups(access(cwd));
	saveModelGroups("project", access(cwd), loaded.configs.project);
	updateGroup("project", access(cwd), "review", { ...loaded.configs.project.groups.review, models: loaded.configs.project.groups.review.models.map((model) => ({ ...model, thinkingLevel: "high" })) }, registry());

	const persisted = read("project", cwd);
	expect(persisted.rootSentinel).toStrictEqual({ keep: true });
	expect(persisted.groups.review.groupSentinel).toBe("keep");
	expect(persisted.groups.review.models[0].modelSentinel).toBe("keep");
	expect(persisted.groups.review.models[0].thinkingLevel).toBe("high");
}));

test("store normalization strips runtime-derived group keys while preserving opaque keys", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	createGroup("project", a, "review", { models: [{ provider: "openai", modelId: "gpt-5" }] }, registry());
	updateGroup("project", a, "review", {
		models: [{ provider: "openai", modelId: "gpt-5" }],
		constraints: { modalities: ["text", "image"] },
		opaqueSentinel: { keep: true },
		name: "review", scope: "project", sourcePath: "/runtime/model-groups.json",
		modalities: { common: ["text"], supported: ["text", "image", "reasoning"], effective: ["text", "image"] },
		validation: { unavailableRefs: [], shadowedByProject: false, degraded: false, emptyCommonModalities: false, unsupportedOverrideModalities: [] },
	} as any, registry());
	const persisted = read("project", cwd).groups.review;
	expect(Object.keys(persisted).sort()).toStrictEqual(["constraints", "models", "opaqueSentinel"]);
	expect(persisted.constraints.modalities).toStrictEqual(["text", "image"]);
	expect(persisted.opaqueSentinel).toStrictEqual({ keep: true });
	for (const key of ["name", "scope", "sourcePath", "modalities", "validation"]) expect(Object.getOwnPropertyNames(persisted)).not.toContain(key);
}));

test("version-3 mutations refuse before temp write including loadScopeConfig-backed CRUD", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, JSON.stringify({ version: 3, groups: {} }), "utf8");
	let writes = 0;
	__setModelGroupsFsForTests({ writeFileSync: () => { writes++; throw new Error("must not write"); } });
	for (const mutate of [
		() => saveModelGroups("project", access(cwd), { version: 2, groups: {} }),
		() => createGroup("project", access(cwd), "blocked", { models: [] }, registry()),
	]) {
		expect(mutate).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
			expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
			expect(error.phase).toBe("config-validation");
			return true;
		}));
	}
	expect(writes).toBe(0);
	expect(fs.readFileSync(sourcePath, "utf8")).toBe(JSON.stringify({ version: 3, groups: {} }));
}));

test("modality overrides survive CRUD rename and move lifecycle in both scopes", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	createGroup("project", a, "review", { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { modalities: ["image"] } }, registry());
	updateGroup("project", a, "review", { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { modalities: ["text", "image"] } }, registry());
	renameGroup("project", a, "review", "reviewers");
	moveGroup(a, "reviewers", "global");
	saveModelGroups("global", a, loadModelGroups(a).configs.global);
	expect(read("global", cwd).groups.reviewers.constraints.modalities).toStrictEqual(["text", "image"]);

	renameGroup("global", a, "reviewers", "global-reviewers");
	moveGroup(a, "global-reviewers", "project");
	expect(read("global", cwd).groups["global-reviewers"]).toBeUndefined();
	expect(read("project", cwd).groups["global-reviewers"].constraints.modalities).toStrictEqual(["text", "image"]);
}));

test("model groups use branded paths, global-only access, canonical own keys, and native max", () => withTemp(({ cwd }) => {
	expect(modelGroupsPath("project", cwd, "branded-pi")).toBe(path.join(cwd, "branded-pi", "pi-schematic", "model-groups.json"));
	const raw = '{"version":1,"groups":{" __proto__ ":{"models":[{"provider":"p","modelId":"proto","thinkingLevel":"max"}]},"constructor":{"models":[]},"toString":{"models":[]}}}';
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), raw, "utf8");
	let loaded = loadModelGroups(access(cwd));
	for (const name of ["__proto__", "constructor", "toString"]) expect(Object.getOwnPropertyNames(loaded.configs.project.groups)).toContain(name);
	expect(loaded.configs.project.groups.__proto__.models[0].thinkingLevel).toBe("max");
	saveModelGroups("project", access(cwd), loaded.configs.project);
	const persisted = read("project", cwd);
	expect(Object.keys(persisted.groups).sort()).toStrictEqual(["__proto__", "constructor", "toString"].sort());
	expect(Object.getPrototypeOf(loaded.configs.project.groups)).toBeNull();

	for (const name of ["__proto__", "constructor", "toString"]) {
		deleteGroup("project", access(cwd), name);
		createGroup("global", access(cwd), ` ${name} `, { models: [] }, registry());
		updateGroup("global", access(cwd), name, { models: [{ provider: "p", modelId: name }] }, registry());
		moveGroup(access(cwd), name, "project");
		expect(Object.getOwnPropertyNames(read("project", cwd).groups)).toContain(name);
		deleteGroup("project", access(cwd), name);
	}

	const projectProbes: string[] = [];
	__setModelGroupsFsForTests({ existsSync: (candidate) => {
		if (String(candidate).startsWith(cwd)) { projectProbes.push(String(candidate)); throw new Error("project probed"); }
		return fs.existsSync(candidate);
	} });
	const untrusted = loadModelGroups(access(cwd, "global-only"));
	expect(projectProbes).toStrictEqual([]);
	expect(untrusted.merged.filter((group) => group.scope !== "global")).toStrictEqual([]);
	expect(() => createGroup("project", access(cwd, "global-only"), "forbidden", { models: [] }, registry())).toThrow(/global-only/);
	expect(projectProbes).toStrictEqual([]);
}));

test("model groups direct save canonicalizes unique keys and rejects empty/colliding keys before write", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	saveModelGroups("project", a, { version: 2, groups: { committed: { models: [] } } });
	const unique: Record<string, any> = Object.create(null);
	Object.defineProperty(unique, " unique ", { value: { models: [] }, enumerable: true });
	saveModelGroups("project", a, { version: 2, groups: unique });
	expect(Object.keys(read("project", cwd).groups)).toStrictEqual(["unique"]);
	for (const keys of [["   "], ["same", " same "]]) {
		const groups: Record<string, any> = Object.create(null);
		for (const key of keys) Object.defineProperty(groups, key, { value: { models: [] }, enumerable: true });
		const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
		let writes = 0;
		__setModelGroupsFsForTests({ writeFileSync: (..._args: any[]) => { writes++; throw new Error("must not write"); } });
		expect(() => saveModelGroups("project", a, { version: 2, groups })).toThrow(expect.toSatisfy((error: ModelGroupsPersistenceError) => {
			expect(error).toBeInstanceOf(ModelGroupsPersistenceError);
			expect(error.operation).toBe("save");
			expect(error.phase).toBe("config-validation");
			return true;
		}));
		expect(writes).toBe(0);
		expect(fs.readFileSync(modelGroupsPath("project", cwd), "utf8")).toBe(before);
		__setModelGroupsFsForTests(null);
	}
}));

test("global model groups file lives under PI_CODING_AGENT_DIR when it is set", () => withTemp(({ cwd, home }) => withTempAgentDir(async (agentDir) => {
	const expectedPath = path.join(agentDir, "pi-schematic", "model-groups.json");
	expect(modelGroupsPath("global", cwd)).toBe(expectedPath);

	createGroup("global", access(cwd), "relocated", { models: [] }, registry());

	expect(JSON.parse(fs.readFileSync(expectedPath, "utf8")).groups.relocated.models).toStrictEqual([]);
	expect(path.join(home, ".pi")).not.toSatisfy(fs.existsSync);
})));

test("global model groups file defaults to the home agent dir when PI_CODING_AGENT_DIR is unset", () => withTemp(({ cwd, home }) => {
	expect(modelGroupsPath("global", cwd)).toBe(path.join(home, ".pi", "agent", "pi-schematic", "model-groups.json"));
}));

test("global model groups path follows a PI_CODING_AGENT_DIR change between resolutions", () => withTemp(async ({ cwd }) => {
	await withTempAgentDir(async (firstAgentDir) => {
		expect(modelGroupsPath("global", cwd)).toBe(path.join(firstAgentDir, "pi-schematic", "model-groups.json"));
	});
	await withTempAgentDir(async (secondAgentDir) => {
		expect(modelGroupsPath("global", cwd)).toBe(path.join(secondAgentDir, "pi-schematic", "model-groups.json"));
	});
}));

function pointAgentDirAtProjectConfig(cwd: string): string {
	const agentDir = path.join(cwd, ".pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return path.join(agentDir, "pi-schematic", "model-groups.json");
}

test("a project config dir that is the agent dir loads its groups once, as global", () => withTemp(({ cwd }) => {
	const sharedPath = pointAgentDirAtProjectConfig(cwd);
	fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
	fs.writeFileSync(sharedPath, JSON.stringify({ version: 2, groups: { shared: { models: [] } } }));

	const loaded = loadModelGroups(access(cwd, "global-project"));

	expect(loaded.merged.map((g) => [g.name, g.scope])).toStrictEqual([["shared", "global"]]);
}));

test("a project config dir that is the agent dir refuses project-scope writes", () => withTemp(({ cwd }) => {
	const sharedPath = pointAgentDirAtProjectConfig(cwd);

	expect(() => createGroup("project", access(cwd, "global-project"), "local", { models: [] }, registry())).toThrow(/unavailable in global-only mode/);
	expect(sharedPath).not.toSatisfy(fs.existsSync);
}));

test("a trusted session whose project config dir is the agent dir gets global-only access", () => withTemp(({ cwd }) => {
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
	if (!fs.existsSync(upperCased)) return false;
	process.env.PI_CODING_AGENT_DIR = upperCased;
	return true;
}

function writeSharedGroup(cwd: string): void {
	const sharedPath = path.join(cwd, ".pi", "pi-schematic", "model-groups.json");
	fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
	fs.writeFileSync(sharedPath, JSON.stringify({ version: 2, groups: { shared: { models: [] } } }));
}

test("distinct config dirs on a filesystem reporting inode 0 keep both scopes", () => withTemp(({ cwd, home }) => {
	const agentDir = path.join(home, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	saveModelGroups("global", access(cwd), { version: 2, groups: { fromGlobal: { models: [] } } });
	saveModelGroups("project", access(cwd), { version: 2, groups: { fromProject: { models: [] } } });
	__setModelGroupsFsForTests({ statSync: (() => ({ dev: 1n, ino: 0n })) as any });

	const trusted = createModelGroupsAccess(cwd, true);

	expect(trusted.policy).toBe("global-project");
	expect(loadModelGroups(trusted).merged.map((g) => [g.name, g.scope])).toStrictEqual([["fromGlobal", "global"], ["fromProject", "project"]]);
}));

test("an agent dir symlinked to the project config dir loads its groups once, as global", () => withTemp(({ cwd }) => {
	pointAgentDirAtProjectConfigThroughSymlink(cwd);
	writeSharedGroup(cwd);

	const loaded = loadModelGroups(access(cwd, "global-project"));

	expect(loaded.merged.map((g) => [g.name, g.scope])).toStrictEqual([["shared", "global"]]);
}));

test("an agent dir symlinked to the project config dir refuses project-scope writes", () => withTemp(({ cwd }) => {
	pointAgentDirAtProjectConfigThroughSymlink(cwd);

	expect(() => createGroup("project", access(cwd, "global-project"), "local", { models: [] }, registry())).toThrow(/unavailable in global-only mode/);
	expect(path.join(cwd, ".pi", "pi-schematic", "model-groups.json")).not.toSatisfy(fs.existsSync);
}));

test("an agent dir naming the project config dir in another case loads its groups once, as global", ({ skip }) => withTemp(({ cwd }) => {
	if (!pointAgentDirAtProjectConfigInOtherCase(cwd)) {
		skip("the temp filesystem is case-sensitive, so the two spellings are different directories");
	}
	writeSharedGroup(cwd);

	const loaded = loadModelGroups(access(cwd, "global-project"));

	expect(loaded.merged.map((g) => [g.name, g.scope])).toStrictEqual([["shared", "global"]]);
}));

test("an agent dir naming the project config dir in another case refuses project-scope writes", ({ skip }) => withTemp(({ cwd }) => {
	if (!pointAgentDirAtProjectConfigInOtherCase(cwd)) {
		skip("the temp filesystem is case-sensitive, so the two spellings are different directories");
	}

	expect(() => createGroup("project", access(cwd, "global-project"), "local", { models: [] }, registry())).toThrow(/unavailable in global-only mode/);
	expect(path.join(cwd, ".pi", "pi-schematic", "model-groups.json")).not.toSatisfy(fs.existsSync);
}));
