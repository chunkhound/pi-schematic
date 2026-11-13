import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { escapeDisplayLabel } from "../../model-groups/display.js";
import { canonicalizeModelGroupName } from "../../model-groups/names.js";
import type { ModelGroupModel, ModelGroupsAccess, ModelGroupsBootValidation } from "../../model-groups/types.js";
import { createState } from "../../state.js";

const nativeMax: ModelThinkingLevel = "max";
const model: ModelGroupModel = { provider: "provider", modelId: "model", thinkingLevel: nativeMax };
const access: ModelGroupsAccess = { cwd: "/project", policy: "global-only" };
const canonical = canonicalizeModelGroupName(" canonical ");
const displayed = escapeDisplayLabel("controlled\nlabel");
const validation: ModelGroupsBootValidation = { groups: [], loadIssues: [] };
const state = createState();
state.modelGroups = { groups: validation.groups, validation };

[model, access, canonical, displayed, state];
