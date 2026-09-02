import { homedir } from "node:os";
import path from "node:path";
import * as fs from "node:fs";
import { CONFIG_DIR_NAME, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { modalitiesConstraint } from "./constraints/modalities.js";
import { evaluateConstraint, evaluateConstraints } from "./constraints/engine.js";
import { presentConstraintDiagnosticRecords } from "./constraints/presentation.js";
import { productionConstraintRegistry, type ConstraintRegistry } from "./constraints/registry.js";
import { resolveConstraintMembers } from "./constraints/resolution.js";
import { canonicalizeModelGroupName } from "./names.js";
import { ModelGroupsPersistenceError, type ModelGroupDef, type ModelGroupModalities, type ModelGroupModality, type ModelGroupModel, type ModelGroupScope, type ModelGroupsAccess, type ModelGroupsBootValidation, type ModelGroupsConfig, type ModelGroupsLoadedGroup, type ModelGroupsLoadIssue, type ModelGroupsLoadResult, type ResolvedModelGroup } from "./types.js";

const CURRENT_VERSION = 2;
const VALID_THINKING = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
type FsOps = Pick<typeof fs, "existsSync" | "mkdirSync" | "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync" | "unlinkSync">;
let fsOps: FsOps = fs;
export function __setModelGroupsFsForTests(next: Partial<FsOps> | null): void { fsOps = next ? { ...fs, ...next } : fs; }
export function modelGroupsPath(scope: ModelGroupScope, cwd: string, projectConfigDirName = CONFIG_DIR_NAME): string { return scope === "global" ? path.join(homedir(), ".pi", "agent", "pi-agenticoding", "model-groups.json") : path.join(cwd, projectConfigDirName, "pi-agenticoding", "model-groups.json"); }
function ownGroups(): Record<string, ModelGroupDef> { return Object.create(null) as Record<string, ModelGroupDef>; }
function cloneDef(def: ModelGroupDef): ModelGroupDef {
	// Deep-clone the constraint envelope: persisted constraint values are
	// JSON-serializable by contract, so structuredClone is safe and keeps
	// opaque/future constraint values (not just the known modalities array)
	// from aliasing between the store and caller-held views.
	const constraints = def.constraints === undefined ? undefined : structuredClone(def.constraints);
	return { ...def, models: def.models.map((model) => ({ ...model })), ...(constraints === undefined ? {} : { constraints }) };
}
function defineGroup(groups: Record<string, ModelGroupDef>, name: string, def: ModelGroupDef): void { Object.defineProperty(groups, name, { value: cloneDef(def), enumerable: true, writable: true, configurable: true }); }
function hasOwnGroup(groups: Record<string, ModelGroupDef>, name: string): boolean { return Object.hasOwn(groups, name); }
function emptyConfig(): ModelGroupsConfig { return { version: CURRENT_VERSION, groups: ownGroups() }; }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assertScopeAllowed(scope: ModelGroupScope, access: ModelGroupsAccess): void { if (scope === "project" && access.policy === "global-only") throw new Error("Project Model Groups are unavailable in global-only mode"); }
function persistenceError(details: ConstructorParameters<typeof ModelGroupsPersistenceError>[0]): ModelGroupsPersistenceError { return new ModelGroupsPersistenceError(details); }
function validateModelEntry(value: unknown, at: string): { ok: true; model: ModelGroupModel } | { ok: false; message: string } {
	if (!isPlainRecord(value)) return { ok: false, message: `${at} must be an object` };
	if (typeof value.provider !== "string" || !value.provider) return { ok: false, message: `${at}.provider must be a non-empty string` };
	if (typeof value.modelId !== "string" || !value.modelId) return { ok: false, message: `${at}.modelId must be a non-empty string` };
	if (value.thinkingLevel !== undefined && !VALID_THINKING.has(value.thinkingLevel as ModelThinkingLevel)) return { ok: false, message: `${at}.thinkingLevel is invalid` };
	const model = { ...value, provider: value.provider, modelId: value.modelId } as ModelGroupModel;
	if (value.thinkingLevel === undefined) delete (model as any).thinkingLevel;
	return { ok: true, model };
}
function normalizeOverrideEnvelope(rawDef: Record<string, unknown>, sourceVersion: number, rawName: string, registry: ConstraintRegistry): { ok: true; constraints?: Record<string, unknown> } | { ok: false; message: string } {
	if (sourceVersion < 2) {
		if (Object.hasOwn(rawDef, "constraints")) return { ok: false, message: `group ${rawName}.constraints is unsupported in legacy config` };
		return { ok: true };
	}
	if (rawDef.constraints !== undefined && !isPlainRecord(rawDef.constraints)) return { ok: false, message: `group ${rawName}.constraints must be an object` };
	const constraints = rawDef.constraints === undefined ? undefined : { ...rawDef.constraints as Record<string, unknown> };
	// Registry-iterated persisted-value normalization: every present known key is
	// decoded (shape/vocabulary validation) and re-encoded (canonical form) through
	// its descriptor's persistence codec. Keys the registry does not know stay
	// opaque — they are neither validated nor dropped.
	if (constraints) {
		for (const descriptor of registry.descriptors) {
			if (!Object.hasOwn(constraints, descriptor.key)) continue;
			const decoded = descriptor.persistence.override.decode(constraints[descriptor.key], `group ${rawName}.constraints.${descriptor.key}`);
			if (!decoded.ok) return decoded;
			constraints[descriptor.key] = descriptor.persistence.override.encode(decoded.value);
		}
	}
	return { ok: true, ...(constraints && Object.keys(constraints).length ? { constraints } : {}) };
}
function normalizeGroups(rawGroups: Record<string, unknown>, sourceVersion: number, registry: ConstraintRegistry): { ok: true; groups: Record<string, ModelGroupDef> } | { ok: false; message: string } {
	const groups = ownGroups();
	for (const rawName of Object.keys(rawGroups)) {
		const name = canonicalizeModelGroupName(rawName);
		if (!name) return { ok: false, message: "group name must not be empty after trimming" };
		if (hasOwnGroup(groups, name)) return { ok: false, message: `group keys collide after trimming at '${name}'` };

		const rawDef = rawGroups[rawName];
		if (!isPlainRecord(rawDef) || !Array.isArray(rawDef.models)) {
			return { ok: false, message: `group ${rawName}${isPlainRecord(rawDef) ? ".models must be an array" : " must be an object"}` };
		}

		const models: ModelGroupModel[] = [];
		for (let i = 0; i < rawDef.models.length; i++) {
			const result = validateModelEntry(rawDef.models[i], `group ${rawName}.models[${i}]`);
			if (!result.ok) return result;
			models.push(result.model);
		}
		const envelope = normalizeOverrideEnvelope(rawDef, sourceVersion, rawName, registry);
		if (!envelope.ok) return envelope;
		// Strip runtime-derived fields while retaining opaque config keys and the v2 envelope.
		const { name: _name, scope: _scope, sourcePath: _sourcePath, modalities: _modalities, validation: _validation, models: _rawModels, constraints: _constraints, modalityOverride: _modalityOverride, ...configDef } = rawDef;
		const { ok: _ok, ...normalizedEnvelope } = envelope;
		defineGroup(groups, name, {
			...configDef,
			models,
			...normalizedEnvelope,
			...(sourceVersion < 2 && Object.hasOwn(rawDef, "modalityOverride") ? { modalityOverride: rawDef.modalityOverride } : {}),
		});
	}
	return { ok: true, groups };
}
function validateConfig(raw: unknown, registry: ConstraintRegistry): { ok: true; config: ModelGroupsConfig } | { ok: false; message: string } {
	if (!isPlainRecord(raw) || !isPlainRecord(raw.groups)) return { ok: false, message: !isPlainRecord(raw) ? "config root must be an object" : "groups must be an object" };
	const sourceVersion = raw.version === undefined || raw.version === 0 ? 1 : raw.version;
	if (typeof sourceVersion !== "number" || !Number.isInteger(sourceVersion) || sourceVersion < 1) return { ok: false, message: "version must be a non-negative supported integer (only missing/0 normalize)" };
	if (sourceVersion > CURRENT_VERSION) return { ok: false, message: `unsupported version ${sourceVersion}` };
	const normalized = normalizeGroups(raw.groups, sourceVersion, registry); return normalized.ok ? { ok: true, config: { version: CURRENT_VERSION, groups: normalized.groups } } : normalized;
}
function backupAndIssue(scope: ModelGroupScope, sourcePath: string, kind: ModelGroupsLoadIssue["kind"], message: string, version?: number): ModelGroupsLoadIssue {
	const issue: ModelGroupsLoadIssue = { scope, sourcePath, kind, message, backupPath: `${sourcePath}.bak`, version };
	if (kind === "unsupported-version") return issue;
	try {
		fsOps.copyFileSync(sourcePath, issue.backupPath!);
	} catch (cause) {
		issue.backupFailed = true;
		issue.message = `${message}; backup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	return issue;
}
function loadScope(scope: ModelGroupScope, access: ModelGroupsAccess, registry: ConstraintRegistry): { config: ModelGroupsConfig; issue?: ModelGroupsLoadIssue } {
	assertScopeAllowed(scope, access);
	const sourcePath = modelGroupsPath(scope, access.cwd);
	if (!fsOps.existsSync(sourcePath)) return { config: emptyConfig() };

	let parsed: unknown;
	try {
		parsed = JSON.parse(String(fsOps.readFileSync(sourcePath, "utf8")));
	} catch (cause) {
		return {
			config: emptyConfig(),
			issue: backupAndIssue(scope, sourcePath, "corrupt-json", cause instanceof Error ? cause.message : String(cause)),
		};
	}
	if (isPlainRecord(parsed) && typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version > CURRENT_VERSION) {
		return {
			config: emptyConfig(),
			issue: backupAndIssue(scope, sourcePath, "unsupported-version", `unsupported version ${parsed.version}`, parsed.version),
		};
	}
	const validated = validateConfig(parsed, registry);
	return validated.ok
		? { config: validated.config }
		: { config: emptyConfig(), issue: backupAndIssue(scope, sourcePath, "schema-invalid", validated.message) };
}
function mergeLoaded(configs: Record<ModelGroupScope, ModelGroupsConfig>, access: ModelGroupsAccess): ModelGroupsLoadedGroup[] {
	const names = new Set([...Object.keys(configs.global.groups), ...Object.keys(configs.project.groups)]);
	const out: ModelGroupsLoadedGroup[] = [];
	for (const name of [...names].sort()) {
		if (hasOwnGroup(configs.global.groups, name)) {
			out.push({
				name,
				scope: "global",
				sourcePath: modelGroupsPath("global", access.cwd),
				...cloneDef(configs.global.groups[name]),
			});
		}
		if (access.policy === "global-project" && hasOwnGroup(configs.project.groups, name)) {
			out.push({
				name,
				scope: "project",
				sourcePath: modelGroupsPath("project", access.cwd),
				...cloneDef(configs.project.groups[name]),
			});
		}
	}
	return out;
}
export function loadModelGroups(access: ModelGroupsAccess, constraintRegistry: ConstraintRegistry = productionConstraintRegistry): ModelGroupsLoadResult {
	const global = loadScope("global", access, constraintRegistry);
	const project = access.policy === "global-project" ? loadScope("project", access, constraintRegistry) : { config: emptyConfig() };
	return {
		configs: { global: global.config, project: project.config },
		merged: mergeLoaded({ global: global.config, project: project.config }, access),
		issues: [global.issue, project.issue].filter((i): i is ModelGroupsLoadIssue => Boolean(i)),
	};
}
function normalizeSaveConfig(scope: ModelGroupScope, sourcePath: string, config: ModelGroupsConfig, registry: ConstraintRegistry): ModelGroupsConfig {
	const normalized = normalizeGroups(config.groups as any, 2, registry);
	if (!normalized.ok) {
		throw persistenceError({ operation: "save", scope, sourcePath, phase: "config-validation", message: normalized.message });
	}
	return { version: CURRENT_VERSION, groups: normalized.groups };
}
/** Low-level persistence: unlike createGroup/updateGroup, this does not enforce the modality union-cap invariant; cap enforcement is CRUD-only, so rename/delete/move are out of scope. */
export function saveModelGroups(scope: ModelGroupScope, access: ModelGroupsAccess, config: ModelGroupsConfig, constraintRegistry: ConstraintRegistry = productionConstraintRegistry): void {
	assertScopeAllowed(scope, access);
	const sourcePath = modelGroupsPath(scope, access.cwd);
	const normalized = normalizeSaveConfig(scope, sourcePath, config, constraintRegistry);
	let raw: Record<string, unknown> = {};
	if (fsOps.existsSync(sourcePath)) {
		try {
			const parsed = JSON.parse(String(fsOps.readFileSync(sourcePath, "utf8")));
			if (isPlainRecord(parsed)) {
				if (typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version > CURRENT_VERSION) {
					throw persistenceError({ operation: "save", scope, sourcePath, phase: "config-validation", message: `unsupported version ${parsed.version}` });
				}
				raw = parsed;
			}
		} catch (cause) {
			if (cause instanceof ModelGroupsPersistenceError) throw cause;
		}
	}

	const tempPath = `${sourcePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fsOps.mkdirSync(path.dirname(sourcePath), { recursive: true });
		fsOps.writeFileSync(tempPath, JSON.stringify({ ...raw, version: CURRENT_VERSION, groups: normalized.groups }, null, 2) + "\n", "utf8");
	} catch (cause) {
		throw persistenceError({
			operation: "save",
			scope,
			sourcePath,
			targetPath: tempPath,
			phase: "temp-write",
			message: `Failed to write temp model-groups file for ${scope}: ${cause instanceof Error ? cause.message : String(cause)}`,
			cause,
		});
	}
	try {
		fsOps.renameSync(tempPath, sourcePath);
	} catch (cause) {
		let detail = "";
		try {
			fsOps.unlinkSync(tempPath);
		} catch (cleanup) {
			detail = `; temp cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
		}
		throw persistenceError({
			operation: "save",
			scope,
			sourcePath,
			targetPath: tempPath,
			phase: "rename",
			message: `Failed to commit model-groups file for ${scope}: ${cause instanceof Error ? cause.message : String(cause)}${detail}`,
			cause,
		});
	}
}
function loadScopeConfig(scope: ModelGroupScope, access: ModelGroupsAccess, registry: ConstraintRegistry = productionConstraintRegistry): ModelGroupsConfig {
	const loaded = loadScope(scope, access, registry);
	if (loaded.issue?.backupFailed || loaded.issue?.kind === "unsupported-version") {
		throw persistenceError({
			operation: "save",
			scope,
			sourcePath: loaded.issue!.sourcePath,
			targetPath: loaded.issue!.backupPath,
			phase: loaded.issue?.kind === "unsupported-version" ? "config-validation" : "load-recovery",
			message: `Refusing to overwrite ${scope} model-groups config after ${loaded.issue!.kind} recovery because ${loaded.issue!.message}`,
			cause: loaded.issue,
		});
	}
	return loaded.config;
}
function canonicalName(raw: string): string { const name = canonicalizeModelGroupName(raw); if (!name) throw new Error("Model group name is required"); return name; }
function normalizeMutationDef(def: ModelGroupDef, registry: ConstraintRegistry): ModelGroupDef {
	const normalized = normalizeGroups({ group: def }, CURRENT_VERSION, registry);
	if (!normalized.ok) throw persistenceError({ operation: "save", phase: "config-validation", message: normalized.message });
	return normalized.groups.group;
}
/** CRUD-only cap enforcement: every authored override present in the def must be
 * supported by the group's members per its descriptor's optional semantic hook. */
function assertMutationOverridesSupported(def: ModelGroupDef, modelRegistry: Pick<ModelRegistry, "find">, registry: ConstraintRegistry): void {
	const resolution = resolveConstraintMembers(def.models, modelRegistry);
	for (const descriptor of registry.descriptors) {
		const override = def.constraints?.[descriptor.key];
		if (override === undefined) continue;
		const evaluation = evaluateConstraint(descriptor, resolution, override);
		descriptor.assertOverrideSupported?.({ evaluation, override });
	}
}
export function createGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawName: string, def: ModelGroupDef, modelRegistry: Pick<ModelRegistry, "find">, constraintRegistry: ConstraintRegistry = productionConstraintRegistry): void {
	assertScopeAllowed(scope, access);
	const name = canonicalName(rawName);
	const config = loadScopeConfig(scope, access, constraintRegistry);
	if (hasOwnGroup(config.groups, name)) throw new Error(`Model group '${name}' already exists in ${scope} scope`);
	const normalizedDef = normalizeMutationDef(def, constraintRegistry);
	assertMutationOverridesSupported(normalizedDef, modelRegistry, constraintRegistry);
	defineGroup(config.groups, name, normalizedDef);
	saveModelGroups(scope, access, config, constraintRegistry);
}
export function updateGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawName: string, def: ModelGroupDef, modelRegistry: Pick<ModelRegistry, "find">, constraintRegistry: ConstraintRegistry = productionConstraintRegistry): void {
	assertScopeAllowed(scope, access);
	const name = canonicalName(rawName);
	const config = loadScopeConfig(scope, access, constraintRegistry);
	if (!hasOwnGroup(config.groups, name)) throw new Error(`Model group '${name}' does not exist in ${scope} scope`);
	const normalizedDef = normalizeMutationDef(def, constraintRegistry);
	assertMutationOverridesSupported(normalizedDef, modelRegistry, constraintRegistry);
	defineGroup(config.groups, name, normalizedDef);
	saveModelGroups(scope, access, config, constraintRegistry);
}
export function renameGroup(scope: ModelGroupScope, access: ModelGroupsAccess, old: string, next: string): void {
	const config = loadScopeConfig(scope, access);
	const a = canonicalName(old);
	const b = canonicalName(next);
	if (a === b) return;
	if (!hasOwnGroup(config.groups, a)) throw new Error(`Model group '${a}' does not exist in ${scope} scope`);
	if (hasOwnGroup(config.groups, b)) throw new Error(`Model group '${b}' already exists in ${scope} scope`);
	const def = config.groups[a];
	delete config.groups[a];
	defineGroup(config.groups, b, def);
	saveModelGroups(scope, access, config);
}
export function deleteGroup(scope: ModelGroupScope, access: ModelGroupsAccess, rawName: string): { otherScopeHasOverride: boolean } {
	const config = loadScopeConfig(scope, access);
	const name = canonicalName(rawName);
	if (!hasOwnGroup(config.groups, name)) throw new Error(`Model group '${name}' does not exist in ${scope} scope`);
	delete config.groups[name];
	const other = access.policy === "global-only" ? emptyConfig() : loadScopeConfig(scope === "global" ? "project" : "global", access);
	try {
		saveModelGroups(scope, access, config);
	} catch (cause) {
		if (cause instanceof ModelGroupsPersistenceError) {
			throw new ModelGroupsPersistenceError({ operation: "delete", scope: cause.scope, sourcePath: cause.sourcePath, targetPath: cause.targetPath, phase: cause.phase, message: cause.message, cause });
		}
		throw cause;
	}
	return { otherScopeHasOverride: hasOwnGroup(other.groups, name) };
}
export function moveGroup(access: ModelGroupsAccess, rawName: string, newScope: ModelGroupScope): void {
	const name = canonicalName(rawName);
	const oldScope: ModelGroupScope = newScope === "project" ? "global" : "project";
	const source = loadScopeConfig(oldScope, access);
	const target = loadScopeConfig(newScope, access);
	if (!hasOwnGroup(source.groups, name)) throw new Error(`Model group '${name}' does not exist in ${oldScope} scope`);
	if (hasOwnGroup(target.groups, name)) throw new Error(`Model group '${name}' already exists in ${newScope} scope`);
	defineGroup(target.groups, name, source.groups[name]);
	try {
		saveModelGroups(newScope, access, target);
	} catch (cause) {
		if (cause instanceof ModelGroupsPersistenceError) {
			throw new ModelGroupsPersistenceError({ operation: "move", scope: newScope, sourcePath: modelGroupsPath(oldScope, access.cwd), targetPath: cause.targetPath, phase: cause.phase, message: cause.message, cause });
		}
		throw cause;
	}
	delete source.groups[name];
	try {
		saveModelGroups(oldScope, access, source);
	} catch (cause) {
		if (cause instanceof ModelGroupsPersistenceError) {
			throw new ModelGroupsPersistenceError({ operation: "move", scope: oldScope, sourcePath: modelGroupsPath(oldScope, access.cwd), targetPath: modelGroupsPath(newScope, access.cwd), phase: "source-remove", partialMove: "target-written-source-retained", message: cause.message, cause });
		}
		throw cause;
	}
}
export function validateModelGroups(loadResult: ModelGroupsLoadResult, modelRegistry: ModelRegistry, constraintRegistry: ConstraintRegistry = productionConstraintRegistry): ResolvedModelGroup[] {
	const projectNames = new Set(Object.keys(loadResult.configs.project.groups));
	return loadResult.merged.map((group) => {
		const unavailableRefs = group.models
			.filter((ref) => {
				const model = modelRegistry.find(ref.provider, ref.modelId);
				return !model || !modelRegistry.hasConfiguredAuth(model);
			})
			.map(({ provider, modelId }) => ({ provider, modelId }));
		const evaluations = evaluateConstraints(resolveConstraintMembers(group.models, modelRegistry), group.constraints ?? {}, constraintRegistry);
		// The legacy `modalities` projection derives from the modalities descriptor
		// when present; injected registries without it project an empty capability set.
		const modalityEvaluation = evaluations.find((evaluation) => evaluation.key === modalitiesConstraint.key);
		const modalities = (modalityEvaluation?.aggregate as ModelGroupModalities | undefined) ?? { common: [], supported: [], effective: [] };
		const diagnostics = presentConstraintDiagnosticRecords(evaluations, constraintRegistry);
		const unsupportedOverrideModalities = modalityEvaluation ? (diagnostics.find((diagnostic) => diagnostic.key === "modalities" && diagnostic.code === "unsupported-override")?.details as ModelGroupModality[] | undefined) ?? [] : [];
		const shadowedByProject = group.scope === "global" && projectNames.has(group.name);
		const degraded = unavailableRefs.length > 0 && unavailableRefs.length < group.models.length;
		const emptyCommonModalities = modalityEvaluation ? diagnostics.some((diagnostic) => diagnostic.key === "modalities" && diagnostic.code === "empty-common") : false;
		return {
			...group,
			modalities: { ...modalities, effective: (modalityEvaluation?.effective as ModelGroupModality[] | undefined) ?? [] },
			evaluations,
			validation: {
				unavailableRefs,
				shadowedByProject,
				degraded,
				emptyCommonModalities,
				unsupportedOverrideModalities,
			},
		};
	});
}
export function listResolvedModelGroups(access: ModelGroupsAccess, modelRegistry: ModelRegistry, constraintRegistry: ConstraintRegistry = productionConstraintRegistry): ModelGroupsBootValidation {
	const loaded = loadModelGroups(access, constraintRegistry);
	return { groups: validateModelGroups(loaded, modelRegistry, constraintRegistry), loadIssues: loaded.issues };
}
export function summarizeBootValidation(groups: ResolvedModelGroup[], constraintRegistry: ConstraintRegistry = productionConstraintRegistry): { unavailableCount: number; overrideCount: number; emptyModalityCount: number; staleModalityOverrideCount: number } {
	const diagnostics = groups.flatMap((group) => group.evaluations ? presentConstraintDiagnosticRecords(group.evaluations, constraintRegistry) : []);
	return {
		unavailableCount: groups.reduce((sum, group) => sum + group.validation.unavailableRefs.length, 0),
		overrideCount: groups.filter((g) => g.validation.shadowedByProject).length,
		emptyModalityCount: diagnostics.filter((diagnostic) => diagnostic.key === "modalities" && diagnostic.code === "empty-common").length,
		staleModalityOverrideCount: diagnostics.filter((diagnostic) => diagnostic.key === "modalities" && diagnostic.code === "unsupported-override").length,
	};
}
export const EMPTY_MODEL_GROUPS_CONFIG: ModelGroupsConfig = emptyConfig(); export { CURRENT_VERSION as MODEL_GROUPS_CONFIG_VERSION, hasOwnGroup };
