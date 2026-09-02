import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelGroupModel } from "../types.js";
import type { ConstraintMemberResolution } from "./types.js";

/** Host adapter: group algebra deliberately receives this snapshot, not a registry. */
export function resolveConstraintMembers(
	members: readonly ModelGroupModel[],
	modelRegistry: Pick<ModelRegistry, "find">,
): ConstraintMemberResolution {
	return { members: members.map((ref) => ({ ref, model: modelRegistry.find(ref.provider, ref.modelId) as Model<Api> | undefined })) };
}
