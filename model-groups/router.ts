import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { evaluateConstraint, evaluateGroupRequirement, evaluateModelRequirement } from "./constraints/engine.js";
import { productionConstraintRegistry, type ConstraintRegistry } from "./constraints/registry.js";
import { resolveConstraintMembers } from "./constraints/resolution.js";
import type { AnyConstraintDescriptor, ConstraintViolation } from "./constraints/types.js";
import { type ModelGroupModality, type ResolvedModelGroup } from "./types.js";

export type SpawnRouteStatus = "inherited" | "routed" | "unknown-fallback";
export interface SpawnModelRoute {
	status: SpawnRouteStatus;
	requestedGroup?: string;
	groupName?: string;
	model: Model<Api>;
	provider: string;
	modelId: string;
	thinking: ModelThinkingLevel;
	/** Child-facing notes produced by constraint descriptors for explicit group ceilings. */
	groupCapabilityCeilings?: readonly string[];
}
export type SpawnRouteErrorReason = "empty" | "no-usable-models" | "missing-modality" | "constraint-unsatisfied";
export interface SpawnRouteErrorDetails {
	missingModalities?: ModelGroupModality[];
	missingFromGroup?: ModelGroupModality[];
	missingFromModel?: ModelGroupModality[];
	constraintUnsatisfied?: readonly ConstraintViolation[];
	provider?: string;
	modelId?: string;
	knownGroup?: boolean;
}

function describeRouteError(group: string, reason: SpawnRouteErrorReason, details: SpawnRouteErrorDetails, missingModalities: ModelGroupModality[], missingFromGroup: ModelGroupModality[], missingFromModel: ModelGroupModality[]): string {
	if (reason === "empty") return `Model Group '${group}' has no model entries.`;
	if (reason === "no-usable-models") return `Model Group '${group}' has no configured/authenticated usable models.`;
	if (reason === "missing-modality") {
		if (details.knownGroup) {
			return `Model Group '${group}' cannot satisfy required modalities: ${missingModalities.join(", ")}. Effective group modalities missing: ${missingFromGroup.join(", ") || "none"}. Routed model '${details.provider}/${details.modelId}' missing: ${missingFromModel.join(", ") || "none"}.`;
		}
		return `Spawn model '${details.provider}/${details.modelId}' cannot satisfy required modalities: ${missingModalities.join(", ")}.`;
	}
	return `Spawn route '${group}' cannot satisfy constraint requirements.`;
}

/**
 * Unusable/unsatisfiable spawn route. Carries structured failure detail so
 * callers can branch on reason without parsing the message; message strings
 * are stable and asserted by tests.
 */
export class SpawnRouteError extends Error {
	readonly kind = "unusable-group" as const;
	readonly group: string;
	readonly reason: SpawnRouteErrorReason;
	readonly missingModalities: ModelGroupModality[];
	readonly missingFromGroup: ModelGroupModality[];
	readonly missingFromModel: ModelGroupModality[];
	readonly constraintUnsatisfied?: readonly ConstraintViolation[];

	constructor(group: string, reason: SpawnRouteErrorReason, details: SpawnRouteErrorDetails = {}) {
		const missingModalities = details.missingModalities ?? [];
		const missingFromGroup = details.missingFromGroup ?? [];
		const missingFromModel = details.missingFromModel ?? [];
		super(describeRouteError(group, reason, details, missingModalities, missingFromGroup, missingFromModel));
		this.name = "SpawnRouteError";
		this.group = group;
		this.reason = reason;
		this.missingModalities = missingModalities;
		this.missingFromGroup = missingFromGroup;
		this.missingFromModel = missingFromModel;
		if (details.constraintUnsatisfied) this.constraintUnsatisfied = details.constraintUnsatisfied;
	}
}
function parentProvider(model: Model<Api>): string { return typeof model.provider === "string" ? model.provider : ""; }
function effectiveGroupMap(groups: ResolvedModelGroup[]): Map<string, ResolvedModelGroup> {
	const map = new Map<string, ResolvedModelGroup>();
	for (const group of groups) {
		if (group.validation?.shadowedByProject) continue;
		const current = map.get(group.name);
		if (!current || group.scope === "project") map.set(group.name, group);
	}
	return map;
}
export function getEffectiveModelGroups(groups: ResolvedModelGroup[]): ResolvedModelGroup[] { return [...effectiveGroupMap(groups).values()].sort((a, b) => a.name.localeCompare(b.name)); }
export function getEffectiveModelGroupNames(groups: ResolvedModelGroup[]): string[] { return getEffectiveModelGroups(groups).map((group) => group.name); }

type SpawnRouteOptions = {
	requestedGroup?: string;
	constraints?: Readonly<Record<string, unknown>>;
	groups: ResolvedModelGroup[];
	parentModel: Model<Api>;
	parentThinking: ModelThinkingLevel;
	modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
	constraintRegistry?: ConstraintRegistry;
	rng?: () => number;
};
type DeclaredRequirement = { descriptor: AnyConstraintDescriptor; requirement: unknown };
type RoutedMember = { entry: ResolvedModelGroup["models"][number]; model: Model<Api> };

function decodeDeclared(registry: ConstraintRegistry, requirements: Readonly<Record<string, unknown>>): () => readonly DeclaredRequirement[] {
	let declaredRequirements: readonly DeclaredRequirement[] | undefined;
	return () => declaredRequirements ??= Object.entries(requirements).map(([key, rawRequirement]) => {
		const descriptor = registry.get(key);
		if (!descriptor) throw new Error(`Unknown spawn constraint requirement '${key}'.`);
		const decoded = descriptor.requirement.decode(rawRequirement, `constraints.${key}`);
		if (!decoded.ok) throw new Error(decoded.message);
		return { descriptor, requirement: decoded.value };
	});
}

function inheritedRoute(status: "inherited" | "unknown-fallback", requestedGroup: string | undefined, parentModel: Model<Api>, parentThinking: ModelThinkingLevel): SpawnModelRoute {
	return {
		status,
		...(status === "unknown-fallback" && requestedGroup ? { requestedGroup } : {}),
		model: parentModel,
		provider: parentProvider(parentModel),
		modelId: parentModel.id,
		thinking: parentThinking,
	};
}

function usableMembers(group: ResolvedModelGroup, modelRegistry: SpawnRouteOptions["modelRegistry"]): RoutedMember[] {
	return group.models
		.map((entry) => {
			const model = modelRegistry.find(entry.provider, entry.modelId) as Model<Api> | undefined;
			return model && modelRegistry.hasConfiguredAuth(model) ? { entry, model } : undefined;
		})
		.filter((entry): entry is RoutedMember => Boolean(entry));
}

function selectMember(usable: RoutedMember[], declared: readonly DeclaredRequirement[], rng?: () => number): RoutedMember {
	const capable = declared.length
		? usable.filter(({ model }) => declared.every(({ descriptor, requirement }) => descriptor.modelSatisfies({ fact: descriptor.modelFact(model), requirement }).satisfied))
		: usable;
	const pool = capable.length ? capable : usable;
	const randomIndex = Math.min(pool.length - 1, Math.max(0, Math.floor((rng ?? Math.random)() * pool.length)));
	return pool[randomIndex];
}

function buildRoutedRoute(group: ResolvedModelGroup, requestedGroup: string, _usable: RoutedMember[], selected: RoutedMember, options: Pick<SpawnRouteOptions, "parentThinking">): SpawnModelRoute {
	return {
		status: "routed",
		requestedGroup,
		groupName: group.name,
		model: selected.model,
		provider: selected.entry.provider,
		modelId: selected.entry.modelId,
		thinking: clampThinkingLevel(selected.model, selected.entry.thinkingLevel ?? options.parentThinking),
	};
}

function attachCeilings(route: SpawnModelRoute, group: ResolvedModelGroup | undefined, resolution: ReturnType<typeof resolveConstraintMembers> | { members: never[] }, registry: ConstraintRegistry): SpawnModelRoute {
	if (!group || route.status !== "routed") return route;
	const groupCapabilityCeilings = registry.descriptors.flatMap((descriptor) => {
		if (group.constraints?.[descriptor.key] === undefined || !descriptor.present.ceiling) return [];
		const note = descriptor.present.ceiling(evaluateConstraint(descriptor, resolution, group.constraints[descriptor.key]));
		return note ? [note] : [];
	});
	return groupCapabilityCeilings.length ? { ...route, groupCapabilityCeilings } : route;
}

function collectViolations(getDeclared: () => readonly DeclaredRequirement[], group: ResolvedModelGroup | undefined, resolution: ReturnType<typeof resolveConstraintMembers> | { members: never[] }, route: SpawnModelRoute, _registry: ConstraintRegistry): ConstraintViolation[] {
	const violations: ConstraintViolation[] = [];
	for (const { descriptor, requirement } of getDeclared()) {
		if (group) {
			const override = group.constraints?.[descriptor.key];
			const evaluation = evaluateConstraint(descriptor, resolution, override);
			const violation = evaluateGroupRequirement(descriptor, evaluation, requirement);
			if (violation) violations.push(violation);
		}
		const violation = evaluateModelRequirement(descriptor, route.model, requirement);
		if (violation) violations.push(violation);
	}
	return violations;
}

function raiseRouteFailure(violations: ConstraintViolation[], group: ResolvedModelGroup | undefined, requestedGroup: string | undefined, route: SpawnModelRoute, registry: ConstraintRegistry): never {
	const modalityViolations = violations.filter((violation) => violation.key === "modalities");
	if (modalityViolations.length) {
		const groupViolations = modalityViolations.filter((violation) => violation.scope === "group");
		const missingFromGroup = groupViolations.flatMap((violation) => violation.satisfaction.missing as ModelGroupModality[] ?? []);
		const modelViolations = modalityViolations.filter((violation) => violation.scope === "model");
		const missingFromModel = modelViolations.flatMap((violation) => violation.satisfaction.missing as ModelGroupModality[] ?? []);
		const codec = registry.get("modalities")!.requirement;
		const ordered = (values: readonly ModelGroupModality[]) => {
			const decoded = codec.decode({ required: values }, "modalities");
			return decoded.ok ? decoded.value as ModelGroupModality[] : [...values];
		};
		const missingModalities = ordered([...missingFromGroup, ...missingFromModel]);
		throw new SpawnRouteError(group?.name ?? (requestedGroup || "<inherited>"), "missing-modality", {
			missingModalities,
			missingFromGroup: ordered(missingFromGroup),
			missingFromModel: ordered(missingFromModel),
			provider: route.provider,
			modelId: route.modelId,
			knownGroup: Boolean(group),
		});
	}
	throw new SpawnRouteError(group?.name ?? (requestedGroup || "<inherited>"), "constraint-unsatisfied", { constraintUnsatisfied: violations, provider: route.provider, modelId: route.modelId, knownGroup: Boolean(group) });
}

/** Route selection remains auth-aware; constraint evaluation receives its explicit member snapshot. */
export function resolveSpawnModelRoute(options: SpawnRouteOptions): SpawnModelRoute {
	const requestedGroup = options.requestedGroup?.trim();
	const requirements = options.constraints ?? {};
	const registry = options.constraintRegistry ?? productionConstraintRegistry;
	const getDeclaredRequirements = decodeDeclared(registry, requirements);
	const group = requestedGroup ? effectiveGroupMap(options.groups).get(requestedGroup) : undefined;
	let route = !requestedGroup
		? inheritedRoute("inherited", requestedGroup, options.parentModel, options.parentThinking)
		: !group
			? inheritedRoute("unknown-fallback", requestedGroup, options.parentModel, options.parentThinking)
			: undefined;
	if (group) {
		if (group.models.length === 0) throw new SpawnRouteError(group.name, "empty");
		const usable = usableMembers(group, options.modelRegistry);
		if (!usable.length) throw new SpawnRouteError(group.name, "no-usable-models");
		const selected = selectMember(usable, getDeclaredRequirements(), options.rng);
		route = buildRoutedRoute(group, requestedGroup!, usable, selected, options);
	}
	const resolution = group ? resolveConstraintMembers(group.models, options.modelRegistry) : { members: [] };
	route = attachCeilings(route!, group, resolution, registry);
	if (!Object.keys(requirements).length) return route;
	const violations = collectViolations(getDeclaredRequirements, group, resolution, route, registry);
	return violations.length ? raiseRouteFailure(violations, group, requestedGroup, route, registry) : route;
}
