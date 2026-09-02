import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	__setModelGroupsFsForTests,
	createGroup,
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
	assert.equal(Object.keys(loadModelGroups(access(cwd)).configs.project.groups).length, 0);
	createGroup("project", access(cwd), "review", { models: [] }, registry());
	assert.deepEqual(read("project", cwd).groups.review.models, []);
	assert.throws(() => createGroup("project", access(cwd), "review", { models: [] }, registry()), /already exists/);

	createGroup("project", access(cwd), "inherit-roundtrip", { models: [{ provider: "anthropic", modelId: "claude" }] }, registry());
	const inheritLoaded = loadModelGroups(access(cwd)).configs.project.groups["inherit-roundtrip"].models[0];
	assert.equal(inheritLoaded.thinkingLevel, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(inheritLoaded, "thinkingLevel"), false);
	const inheritPersisted = read("project", cwd).groups["inherit-roundtrip"].models[0];
	assert.equal(inheritPersisted.thinkingLevel, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(inheritPersisted, "thinkingLevel"), false);

	updateGroup("project", access(cwd), "review", { models: [{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" }] }, registry());
	renameGroup("project", access(cwd), "review", "reviewers");
	assert.equal(read("project", cwd).groups.review, undefined);
	assert.equal(read("project", cwd).groups.reviewers.models[0].thinkingLevel, "high");

	createGroup("project", access(cwd), "collision", { models: [] }, registry());
	assert.throws(() => renameGroup("project", access(cwd), "reviewers", "collision"), /already exists/);
	createGroup("global", access(cwd), "reviewers", { models: [{ provider: "openai", modelId: "gpt-5" }, { provider: "missing", modelId: "nope" }] }, registry());
	const loaded = loadModelGroups(access(cwd));
	const resolved = validateModelGroups(loaded, registry());
	const globalReviewers = resolved.find((g) => g.name === "reviewers" && g.scope === "global");
	assert.equal(globalReviewers?.validation.shadowedByProject, true);
	assert.deepEqual(globalReviewers?.validation.unavailableRefs, [{ provider: "missing", modelId: "nope" }]);
	assert.equal(globalReviewers?.validation.degraded, true);

	createGroup("global", access(cwd), "move-collision", { models: [] }, registry());
	createGroup("project", access(cwd), "move-collision", { models: [] }, registry());
	assert.throws(() => moveGroup(access(cwd), "move-collision", "project"), /already exists in project scope/);
	assert.ok(read("global", cwd).groups["move-collision"]);
	assert.ok(read("project", cwd).groups["move-collision"]);

	const deleted = deleteGroup("global", access(cwd), "reviewers");
	assert.equal(deleted.otherScopeHasOverride, true);
	moveGroup(access(cwd), "reviewers", "global");
	assert.ok(read("global", cwd).groups.reviewers);
	assert.equal(read("project", cwd).groups.reviewers, undefined);
}));

test("model groups load recovery handles malformed, schema-invalid, unsupported version, and backup failure", () => withTemp(({ cwd }) => {
	fs.mkdirSync(path.dirname(modelGroupsPath("global", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("global", cwd), "{not json", "utf8");
	let loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.issues[0].kind, "corrupt-json");
	assert.ok(fs.existsSync(`${modelGroupsPath("global", cwd)}.bak`));

	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 2, groups: { bad: { models: [{ provider: 1 }] } } }), "utf8");
	loaded = loadModelGroups(access(cwd));
	const schemaIssue = loaded.issues.find((i) => i.scope === "project")!;
	assert.equal(schemaIssue.kind, "schema-invalid");
	assert.equal(schemaIssue.scope, "project");
	assert.equal(schemaIssue.sourcePath, modelGroupsPath("project", cwd));
	assert.equal(schemaIssue.backupPath, `${modelGroupsPath("project", cwd)}.bak`);
	assert.match(schemaIssue.message, /provider/);
	assert.ok(fs.existsSync(schemaIssue.backupPath!));
	assert.equal(Object.keys(loaded.configs.project.groups).length, 0);

	fs.writeFileSync(modelGroupsPath("project", cwd), JSON.stringify({ version: 99, groups: {} }), "utf8");
	loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.issues.find((i) => i.scope === "project")?.kind, "unsupported-version");
	assert.equal(loaded.issues.find((i) => i.scope === "project")?.version, 99);

	fs.writeFileSync(modelGroupsPath("project", cwd), "{bad", "utf8");
	__setModelGroupsFsForTests({ copyFileSync: () => { throw new Error("denied"); } });
	loaded = loadModelGroups(access(cwd));
	const issue = loaded.issues.find((i) => i.scope === "project")!;
	assert.equal(issue.backupFailed, true);
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), "{bad");
	assert.throws(() => createGroup("project", access(cwd), "must-not-overwrite", { models: [] }, registry()), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "load-recovery");
		return true;
	});
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), "{bad");
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
			assert.match(path.basename(generatedTempPath), /^model-groups\.json\.\d+\.\d+\.tmp$/);
			assert.ok(fs.readFileSync(generatedTempPath, "utf8").includes('"drop"'));
			throw renameCause;
		},
	});
	assert.throws(() => saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "rename");
		assert.equal(error.sourcePath, sourcePath);
		assert.equal(error.targetPath, generatedTempPath);
		assert.equal(error.cause, renameCause);
		return true;
	});

	assert.ok(generatedTempPath);
	assert.deepEqual(fs.readFileSync(sourcePath), committedBytes);
	assert.equal(fs.existsSync(generatedTempPath), false);
	assert.deepEqual(fs.readdirSync(path.dirname(sourcePath)).filter((name) => /^model-groups\.json\.\d+\.\d+\.tmp$/.test(name)), []);
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
			assert.ok(fs.existsSync(generatedTempPath));
			throw renameCause;
		},
		unlinkSync: (target) => {
			assert.equal(String(target), generatedTempPath);
			throw cleanupCause;
		},
	});
	assert.throws(() => saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "rename");
		assert.equal(error.sourcePath, sourcePath);
		assert.equal(error.targetPath, generatedTempPath);
		assert.equal(error.cause, renameCause);
		assert.match(error.message, /cleanup denied/);
		return true;
	});

	assert.ok(generatedTempPath);
	assert.deepEqual(fs.readFileSync(sourcePath), committedBytes);
	assert.equal(fs.existsSync(generatedTempPath), true);
}));

test("model groups persistence failures throw typed errors and preserve committed state", () => withTemp(({ cwd }) => {
	saveModelGroups("project", access(cwd), { version: 2, groups: { keep: { models: [] } } });
	__setModelGroupsFsForTests({ writeFileSync: () => { throw new Error("temp denied"); } });
	assert.throws(() => updateGroup("project", access(cwd), "keep", { models: [{ provider: "openai", modelId: "gpt-5" }] }, registry()), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "save");
		assert.equal(error.phase, "temp-write");
		assert.equal(error.scope, "project");
		assert.equal(error.sourcePath, modelGroupsPath("project", cwd));
		assert.match(error.targetPath ?? "", /model-groups\.json\..+\.tmp$/);
		return true;
	});
	__setModelGroupsFsForTests(null);
	assert.ok(read("project", cwd).groups.keep);
	assert.equal(read("project", cwd).groups.keep.models.length, 0);

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("rename denied"); } });
	assert.throws(() => saveModelGroups("project", access(cwd), { version: 2, groups: { drop: { models: [] } } }), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.phase, "rename");
		return true;
	});
	__setModelGroupsFsForTests(null);
	assert.ok(read("project", cwd).groups.keep);
	assert.equal(read("project", cwd).groups.drop, undefined);

	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("delete denied"); } });
	assert.throws(() => deleteGroup("project", access(cwd), "keep"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "delete");
		return true;
	});
	__setModelGroupsFsForTests(null);

	createGroup("global", access(cwd), "move-target-fails", { models: [] }, registry());
	__setModelGroupsFsForTests({ renameSync: () => { throw new Error("target denied"); } });
	assert.throws(() => moveGroup(access(cwd), "move-target-fails", "project"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.operation, "move");
		assert.equal(error.partialMove, undefined);
		return true;
	});
	__setModelGroupsFsForTests(null);

	createGroup("global", access(cwd), "move-me", { models: [] }, registry());
	let writes = 0;
	__setModelGroupsFsForTests({ renameSync: (from, to) => { writes++; if (writes === 2) throw new Error("source denied"); fs.renameSync(from, to); } });
	assert.throws(() => moveGroup(access(cwd), "move-me", "project"), (error) => {
		assert.ok(error instanceof ModelGroupsPersistenceError);
		assert.equal(error.partialMove, "target-written-source-retained");
		assert.equal(error.phase, "source-remove");
		return true;
	});
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
		assert.equal(issue.kind, "schema-invalid", label);
		assert.match(issue.message, message, label);
		assert.ok(fs.existsSync(`${projectPath}.bak`), label);
		assert.equal(Object.keys(loaded.configs.project.groups).length, 0, label);
	}
	for (const raw of [{ groups: { legacy: { models: [] } } }, { version: 0, groups: { legacy: { models: [] } } }]) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		assert.equal(loaded.issues.length, 0);
		assert.equal(loaded.configs.project.version, 2);
		updateGroup("project", access(cwd), "legacy", { models: [] }, registry());
		assert.equal(read("project", cwd).version, 2);
	}
}));

test("legacy constraints recover as schema-invalid instead of crashing load", () => withTemp(({ cwd }) => {
	const projectPath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(projectPath), { recursive: true });
	for (const raw of [{ groups: { legacy: { models: [], constraints: {} } } }, { version: 0, groups: { legacy: { models: [], constraints: {} } } }, { version: 1, groups: { legacy: { models: [], constraints: {} } } }]) {
		fs.writeFileSync(projectPath, JSON.stringify(raw), "utf8");
		const loaded = loadModelGroups(access(cwd));
		const issue = loaded.issues.find((candidate) => candidate.scope === "project")!;
		assert.equal(issue.kind, "schema-invalid");
		assert.match(issue.message, /constraints/);
		assert.ok(fs.existsSync(`${projectPath}.bak`));
		assert.equal(Object.keys(loaded.configs.project.groups).length, 0);
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
	assert.equal(empty?.validation.emptyCommonModalities, true, "empty group has no common modalities");
	const unresolved = resolved.find((g) => g.name === "unresolved");
	assert.equal(unresolved?.validation.emptyCommonModalities, true, "unresolved member fails closed");
	const stale = resolved.find((g) => g.name === "stale");
	assert.deepEqual(stale?.validation.unsupportedOverrideModalities, ["image"]);
	const summary = summarizeBootValidation(resolved);
	assert.equal(summary.emptyModalityCount, 2);
	assert.equal(summary.staleModalityOverrideCount, 1);
}));

test("low-level save permits shape-valid overrides while CRUD rejects union-cap-invalid overrides", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	// The low-level persistence boundary only validates v2 shape. It deliberately
	// persists this image override even though claude's union has text only.
	saveModelGroups("project", a, { version: 2, groups: { persistenceOnly: { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["image"] } } } });
	assert.deepEqual(read("project", cwd).groups.persistenceOnly.constraints.modalities, ["image"]);
	// CRUD owns the union-cap invariant and must reject the same invalid shape
	// before any write.
	// claude supports only text, so an override of image must be rejected by the CRUD gate.
	let writes = 0;
	__setModelGroupsFsForTests({ writeFileSync: (_p?: unknown, _d?: unknown, ..._r: unknown[]) => { writes++; fs.writeFileSync(_p as any, _d as any, ...(_r as any)); } });
	assert.throws(() => createGroup("project", a, "claude-only", { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["image"] } }, registry()), /unsupported modalities: image/);
	assert.equal(writes, 0);
	__setModelGroupsFsForTests(null);

	createGroup("project", a, "rich", { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { modalities: ["text", "image"] } }, registry());
	const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
	let writes2 = 0;
	__setModelGroupsFsForTests({ writeFileSync: (_p: unknown, _d: unknown, _r: unknown) => { writes2++; fs.writeFileSync(_p as any, _d as any, _r as any); } });
	// Combined member change: replacing gpt-5 (text+image+reasoning) with claude (text only)
	// makes the retained override's image unsupported → the gate must reject before any write.
	assert.throws(() => updateGroup("project", a, "rich", { models: [{ provider: "anthropic", modelId: "claude" }], constraints: { modalities: ["text", "image"] } }, registry()), /unsupported modalities: image/);
	assert.equal(writes2, 0, "rejected update must not write");
	assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), before);
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
	assert.deepEqual(read("project", cwd).groups.deep.constraints, { testMinContext: 5 });
	// Load with the same registry decodes/validates the persisted value.
	const loaded = loadModelGroups(a, injected);
	assert.equal(loaded.issues.length, 0);
	assert.equal(loaded.configs.project.groups.deep.constraints?.testMinContext, 5);
	// Boot validation with the same registry carries the injected descriptor's evaluation.
	const resolved = validateModelGroups(loaded, modelRegistry, injected);
	assert.ok(resolved[0].evaluations?.some((evaluation) => evaluation.key === "testMinContext"), "injected evaluation must be present in boot validation");
	// Unknown keys stay opaque even under an injected registry.
	updateGroup("project", a, "deep", { models: [{ provider: "openai", modelId: "gpt-ctx" }], constraints: { testMinContext: 5, futureKey: { nested: true } } }, modelRegistry, injected);
	assert.deepEqual(read("project", cwd).groups.deep.constraints, { testMinContext: 5, futureKey: { nested: true } });
}));

test("injected persisted values are validated on save and malformed values trigger schema-invalid load recovery", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	const injected = createConstraintRegistry([testMinContext]);
	const sourcePath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	// Save-side rejection: an invalid injected value cannot be persisted.
	assert.throws(() => saveModelGroups("project", a, { version: 2, groups: { g: { models: [], constraints: { testMinContext: -3 } } } }, injected), (error: unknown) => error instanceof ModelGroupsPersistenceError && /testMinContext must be a positive safe integer/.test(error.message));
	// Load-side recovery: a hand-edited malformed value is schema-invalid and backed up.
	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { g: { models: [], constraints: { testMinContext: "nope" } } } }), "utf8");
	const loaded = loadModelGroups(a, injected);
	assert.equal(loaded.issues.length, 1);
	assert.equal(loaded.issues[0].kind, "schema-invalid");
	assert.match(loaded.issues[0].message, /testMinContext must be a positive safe integer/);
	assert.ok(fs.existsSync(`${sourcePath}.bak`), "malformed injected value must back up like any schema-invalid config");
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
		assert.throws(() => createGroup("project", a, "deep", { models: [{ provider: "openai", modelId: "gpt-ctx" }], constraints: { testMinContext: 200 } }, modelRegistry, injected), /testMinContext override 200 exceeds/);
		assert.equal(writes, 0, "rejected injected override must not write");
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
	assert.equal((loaded.configs.project.groups.deep.constraints!.testMinContext as { min: number }).min, 5, "mutating the merged view must not alias the store copy");
	assert.notEqual(merged.constraints!.testMinContext, (loaded.configs.project.groups.deep.constraints!.testMinContext as unknown), "nested constraint values must be distinct objects");
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
		assert.equal(issue.kind, "schema-invalid", label);
		assert.match(issue.message, message, label);
		assert.ok(fs.existsSync(`${projectPath}.bak`), label);
	}
}));

test("v1 migration is in-memory until the first successful mutation writes v2 without an invented override", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const v1Bytes = JSON.stringify({ version: 1, groups: { legacy: { models: [{ provider: "openai", modelId: "gpt-5" }] } } }, null, 2) + "\n";
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, v1Bytes, "utf8");

	const loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.configs.project.version, 2);
	assert.equal(loaded.configs.project.groups.legacy.constraints, undefined);
	assert.equal(fs.readFileSync(sourcePath, "utf8"), v1Bytes);

	updateGroup("project", access(cwd), "legacy", { models: [{ provider: "anthropic", modelId: "claude" }] }, registry());
	const persisted = read("project", cwd);
	assert.equal(persisted.version, 2);
	assert.equal(Object.hasOwn(persisted.groups.legacy, "modalityOverride"), false);
}));

test("legacy modalityOverride is opaque and not interpreted", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const v1Bytes = JSON.stringify({ version: 1, groups: { legacy: { models: [{ provider: "openai", modelId: "gpt-5" }], modalityOverride: ["image"] } } }, null, 2) + "\n";
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, v1Bytes, "utf8");
	const loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.configs.project.groups.legacy.constraints, undefined);
	assert.equal(Object.hasOwn(loaded.configs.project.groups.legacy, "modalityOverride"), true);
	assert.equal(fs.readFileSync(sourcePath, "utf8"), v1Bytes);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	assert.equal(Object.hasOwn(read("project", cwd).groups.legacy, "modalityOverride"), false);
}));

test("malformed legacy modalityOverride loads opaquely and is dropped on a v2 write", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	const v1Bytes = JSON.stringify({ version: 1, groups: { legacy: { models: [], modalityOverride: "not-an-array" } } }, null, 2) + "\n";
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, v1Bytes, "utf8");
	const loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.issues.length, 0);
	assert.equal((loaded.configs.project.groups.legacy as any).modalityOverride, "not-an-array");
	assert.equal(fs.readFileSync(sourcePath, "utf8"), v1Bytes);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	assert.equal(Object.hasOwn(read("project", cwd).groups.legacy, "modalityOverride"), false);
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
	assert.equal(loaded.issues.length, 0);
	for (const [name, _envelope, expected] of fixtures) assert.deepEqual(loaded.configs.project.groups[name].constraints?.modalities, expected, name);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	const persisted = read("project", cwd);
	for (const [name, _envelope, expected] of fixtures) {
		const group = persisted.groups[name];
		if (expected === undefined) {
			assert.equal(Object.hasOwn(group, "constraints"), false, name);
		} else {
			assert.deepEqual(group.constraints.modalities, expected, name);
		}
	}

	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { opaque: { models: [{ provider: "openai", modelId: "gpt-5", modelSentinel: true }], groupSentinel: true, constraints: { modalities: ["image"], cost: { future: true } } } } }), "utf8");
	const opaque = loadModelGroups(access(cwd));
	updateGroup("project", access(cwd), "opaque", { ...opaque.configs.project.groups.opaque, models: [{ provider: "openai", modelId: "gpt-5", modelSentinel: true, thinkingLevel: "high" } as any] }, registry());
	const opaquePersisted = read("project", cwd).groups.opaque;
	assert.deepEqual(opaquePersisted.constraints, { modalities: ["image"], cost: { future: true } });
	assert.equal(opaquePersisted.groupSentinel, true);
	assert.equal(opaquePersisted.models[0].modelSentinel, true);
}));

test("v2 drops stale modalityOverride rather than reinterpreting it", () => withTemp(({ cwd }) => {
	const sourcePath = modelGroupsPath("project", cwd);
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(sourcePath, JSON.stringify({ version: 2, groups: { stale: { models: [], modalityOverride: ["image"] } } }), "utf8");
	const loaded = loadModelGroups(access(cwd));
	assert.equal(loaded.issues.length, 0);
	assert.equal(loaded.configs.project.groups.stale.constraints, undefined);
	saveModelGroups("project", access(cwd), loaded.configs.project);
	assert.equal(Object.hasOwn(read("project", cwd).groups.stale, "modalityOverride"), false);
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
	assert.deepEqual(persisted.rootSentinel, { keep: true });
	assert.equal(persisted.groups.review.groupSentinel, "keep");
	assert.equal(persisted.groups.review.models[0].modelSentinel, "keep");
	assert.equal(persisted.groups.review.models[0].thinkingLevel, "high");
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
	assert.deepEqual(Object.keys(persisted).sort(), ["constraints", "models", "opaqueSentinel"]);
	assert.deepEqual(persisted.constraints.modalities, ["text", "image"]);
	assert.deepEqual(persisted.opaqueSentinel, { keep: true });
	for (const key of ["name", "scope", "sourcePath", "modalities", "validation"]) assert.equal(Object.hasOwn(persisted, key), false);
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
		assert.throws(mutate, (error) => {
			assert.ok(error instanceof ModelGroupsPersistenceError);
			assert.equal(error.phase, "config-validation");
			return true;
		});
	}
	assert.equal(writes, 0);
	assert.equal(fs.readFileSync(sourcePath, "utf8"), JSON.stringify({ version: 3, groups: {} }));
}));

test("modality overrides survive CRUD rename and move lifecycle in both scopes", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	createGroup("project", a, "review", { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { modalities: ["image"] } }, registry());
	updateGroup("project", a, "review", { models: [{ provider: "openai", modelId: "gpt-5" }], constraints: { modalities: ["text", "image"] } }, registry());
	renameGroup("project", a, "review", "reviewers");
	moveGroup(a, "reviewers", "global");
	saveModelGroups("global", a, loadModelGroups(a).configs.global);
	assert.deepEqual(read("global", cwd).groups.reviewers.constraints.modalities, ["text", "image"]);

	renameGroup("global", a, "reviewers", "global-reviewers");
	moveGroup(a, "global-reviewers", "project");
	assert.equal(read("global", cwd).groups["global-reviewers"], undefined);
	assert.deepEqual(read("project", cwd).groups["global-reviewers"].constraints.modalities, ["text", "image"]);
}));

test("model groups use branded paths, global-only access, canonical own keys, and native max", () => withTemp(({ cwd }) => {
	assert.equal(modelGroupsPath("project", cwd, "branded-pi"), path.join(cwd, "branded-pi", "pi-agenticoding", "model-groups.json"));
	const raw = '{"version":1,"groups":{" __proto__ ":{"models":[{"provider":"p","modelId":"proto","thinkingLevel":"max"}]},"constructor":{"models":[]},"toString":{"models":[]}}}';
	fs.mkdirSync(path.dirname(modelGroupsPath("project", cwd)), { recursive: true });
	fs.writeFileSync(modelGroupsPath("project", cwd), raw, "utf8");
	let loaded = loadModelGroups(access(cwd));
	for (const name of ["__proto__", "constructor", "toString"]) assert.ok(Object.hasOwn(loaded.configs.project.groups, name));
	assert.equal(loaded.configs.project.groups.__proto__.models[0].thinkingLevel, "max");
	saveModelGroups("project", access(cwd), loaded.configs.project);
	const persisted = read("project", cwd);
	assert.deepEqual(Object.keys(persisted.groups).sort(), ["__proto__", "constructor", "toString"].sort());
	assert.equal(Object.getPrototypeOf(loaded.configs.project.groups), null);

	for (const name of ["__proto__", "constructor", "toString"]) {
		deleteGroup("project", access(cwd), name);
		createGroup("global", access(cwd), ` ${name} `, { models: [] }, registry());
		updateGroup("global", access(cwd), name, { models: [{ provider: "p", modelId: name }] }, registry());
		moveGroup(access(cwd), name, "project");
		assert.ok(Object.hasOwn(read("project", cwd).groups, name));
		deleteGroup("project", access(cwd), name);
	}

	let projectProbe = false;
	__setModelGroupsFsForTests({ existsSync: (candidate) => {
		if (String(candidate).startsWith(cwd)) { projectProbe = true; throw new Error("project probed"); }
		return fs.existsSync(candidate);
	} });
	const untrusted = loadModelGroups(access(cwd, "global-only"));
	assert.equal(projectProbe, false);
	assert.equal(untrusted.merged.every((group) => group.scope === "global"), true);
	assert.throws(() => createGroup("project", access(cwd, "global-only"), "forbidden", { models: [] }, registry()), /global-only/);
	assert.equal(projectProbe, false);
}));

test("model groups direct save canonicalizes unique keys and rejects empty/colliding keys before write", () => withTemp(({ cwd }) => {
	const a = access(cwd);
	saveModelGroups("project", a, { version: 2, groups: { committed: { models: [] } } });
	const unique: Record<string, any> = Object.create(null);
	Object.defineProperty(unique, " unique ", { value: { models: [] }, enumerable: true });
	saveModelGroups("project", a, { version: 2, groups: unique });
	assert.deepEqual(Object.keys(read("project", cwd).groups), ["unique"]);
	for (const keys of [["   "], ["same", " same "]]) {
		const groups: Record<string, any> = Object.create(null);
		for (const key of keys) Object.defineProperty(groups, key, { value: { models: [] }, enumerable: true });
		const before = fs.readFileSync(modelGroupsPath("project", cwd), "utf8");
		let writes = 0;
		__setModelGroupsFsForTests({ writeFileSync: (..._args: any[]) => { writes++; throw new Error("must not write"); } });
		assert.throws(() => saveModelGroups("project", a, { version: 2, groups }), (error) => {
			assert.ok(error instanceof ModelGroupsPersistenceError);
			assert.equal(error.operation, "save");
			assert.equal(error.phase, "config-validation");
			return true;
		});
		assert.equal(writes, 0);
		assert.equal(fs.readFileSync(modelGroupsPath("project", cwd), "utf8"), before);
		__setModelGroupsFsForTests(null);
	}
}));
