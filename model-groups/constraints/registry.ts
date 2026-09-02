import { modalitiesConstraint } from "./modalities.js";
import type { AnyConstraintDescriptor } from "./types.js";

export interface ConstraintRegistry {
	readonly descriptors: readonly AnyConstraintDescriptor[];
	get(key: string): AnyConstraintDescriptor | undefined;
}

export function createConstraintRegistry(descriptors: readonly AnyConstraintDescriptor[]): ConstraintRegistry {
	const ordered = [...descriptors].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
	const keys = new Set<string>();
	for (const descriptor of ordered) {
		if (keys.has(descriptor.key)) throw new Error(`Duplicate model-group constraint key: ${descriptor.key}.`);
		keys.add(descriptor.key);
	}
	return { descriptors: ordered, get: (key) => ordered.find((descriptor) => descriptor.key === key) };
}

// Internal, fixed production catalog. Tests inject a registry with createConstraintRegistry.
const productionDescriptors = [modalitiesConstraint] as const;
export const productionConstraintRegistry = createConstraintRegistry(productionDescriptors);
