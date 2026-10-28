import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

type AssertNever<T extends never> = T;
// Fails to compile when pi adds a thinking level THINKING_LEVELS lacks.
type MissingThinkingLevels = AssertNever<Exclude<ModelThinkingLevel, (typeof THINKING_LEVELS)[number]>>;

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return (THINKING_LEVELS as readonly unknown[]).includes(value);
}
