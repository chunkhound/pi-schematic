import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ErasedConstraintEvaluation } from "./constraints/types.js";

export const MODEL_GROUP_MODALITIES = ["text", "image", "reasoning"] as const;
export const MODEL_GROUP_MODALITY_PROSE = MODEL_GROUP_MODALITIES.join(", ").replace(/, ([^,]+)$/, ", or $1");
export type ModelGroupModality = typeof MODEL_GROUP_MODALITIES[number];
export interface ModelGroupModalities {
	common: ModelGroupModality[];
	supported: ModelGroupModality[];
	effective: ModelGroupModality[];
}
export type ModelGroupScope = "project" | "global";
export type ModelGroupsAccessPolicy = "global-project" | "global-only";
export interface ModelGroupsAccess { cwd: string; policy: ModelGroupsAccessPolicy }
export interface ModelGroupModel { provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel }
export interface ModelGroupDef {
	models: ModelGroupModel[];
	/** Canonical v2 keyed override envelope. Unknown keys are retained opaquely. */
	constraints?: Record<string, unknown>;
}
export interface ModelGroupsConfig { version: 2; groups: Record<string, ModelGroupDef> }
export interface ModelGroupValidation {
	unavailableRefs: Array<{ provider: string; modelId: string }>;
	shadowedByProject: boolean;
	degraded: boolean;
	emptyCommonModalities: boolean;
	unsupportedOverrideModalities: ModelGroupModality[];
}
export interface ModelGroupsLoadedGroup extends ModelGroupDef { name: string; scope: ModelGroupScope; sourcePath: string }
export interface ResolvedModelGroup extends ModelGroupsLoadedGroup { modalities: ModelGroupModalities; validation: ModelGroupValidation; /** Ordered descriptor evaluations; presentation consumers must iterate these. */ evaluations?: readonly ErasedConstraintEvaluation[] }
export type ModelGroupsLoadIssueKind = "corrupt-json" | "schema-invalid" | "unsupported-version";
export interface ModelGroupsLoadIssue { scope: ModelGroupScope; sourcePath: string; kind: ModelGroupsLoadIssueKind; message: string; backupPath?: string; backupFailed?: boolean; version?: number }
export type ModelGroupsPersistenceOperation = "save" | "delete" | "move";
export type ModelGroupsPersistencePhase = "config-validation" | "temp-write" | "rename" | "source-remove" | "load-recovery";
export class ModelGroupsPersistenceError extends Error {
	readonly operation!: ModelGroupsPersistenceOperation; readonly scope?: ModelGroupScope; readonly sourcePath?: string; readonly targetPath?: string; readonly phase!: ModelGroupsPersistencePhase; readonly partialMove?: "target-written-source-retained"; readonly cause?: unknown;
	constructor(details: {
		operation: ModelGroupsPersistenceOperation;
		scope?: ModelGroupScope;
		sourcePath?: string;
		targetPath?: string;
		phase: ModelGroupsPersistencePhase;
		partialMove?: "target-written-source-retained";
		message: string;
		cause?: unknown;
	}) {
		super(details.message);
		this.name = "ModelGroupsPersistenceError";
		Object.assign(this, details);
	}
}
export interface ModelGroupsLoadResult { configs: Record<ModelGroupScope, ModelGroupsConfig>; merged: ModelGroupsLoadedGroup[]; issues: ModelGroupsLoadIssue[] }
export interface ModelGroupsBootValidation { groups: ResolvedModelGroup[]; loadIssues: ModelGroupsLoadIssue[] }
