import type { PromptSection } from "../prompt-sections.js";
import type { SchematicState } from "../state.js";
import type { ConstraintRegistry } from "./constraints/registry.js";
import { presentConstraintPrompt } from "./constraints/presentation.js";
import { escapeDisplayLabel } from "./display.js";
import { getEffectiveModelGroups } from "./router.js";
import { MODEL_GROUP_MODALITY_PROSE } from "./types.js";

export function modelGroupsSection(state: SchematicState, constraintRegistry: ConstraintRegistry): PromptSection {
	return {
		name: "schematic_model_groups",
		render() {
			const groups = getEffectiveModelGroups(state.modelGroups.groups);
			if (groups.length === 0) return undefined;
			const labels = groups.map((group) => `${escapeDisplayLabel(group.name)} (${(group.evaluations ? presentConstraintPrompt(group.evaluations, constraintRegistry).filter(Boolean).join(", ") : group.modalities?.effective.join(", ")) || "no common modalities"})`);
			return `## Model Groups for spawn\n` +
				`Available Model Groups: ${labels.join(", ")}\n` +
				`When the operator asks to spawn with one of these groups, or mentions #group-name, call spawn with group set to the exact group name only when the mapping is known and confident. If a delegated task requires ${MODEL_GROUP_MODALITY_PROSE} capability, pass those requirements as constraints. If no known/confident group is requested, omit group and inherit the parent model/thinking. ` +
				`An explicitly-named group is binding: if the operator requests a specific group and the task also needs a capability that group lacks, do NOT fall back to a different group, inherit, or work around the missing capability. Stop and report to the operator that the named group cannot do the task; ask whether to pick a different group or drop the capability. ` +
				`The group list exposes only names and effective modalities; do not assume provider/model membership, thinking levels, auth status, validation details, or storage paths from it.`;
		},
	};
}
