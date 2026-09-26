import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import type { ModelGroupsAccess } from "./types.js";
import { createModelGroupsComponent } from "./tui.js";

export function registerModelGroupsCommand(pi: ExtensionAPI, state: SchematicState): void {
	pi.registerCommand("model-groups", {
		description: "Manage Model Groups",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.mode === "rpc") ctx.ui.notify("/model-groups requires TUI mode");
				return;
			}
			if (!ctx.cwd || !ctx.modelRegistry) {
				ctx.ui.notify("Cannot manage model groups: missing working directory or model registry", "error");
				return;
			}
			const access: ModelGroupsAccess = { cwd: ctx.cwd, policy: ctx.isProjectTrusted() ? "global-project" : "global-only" };
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				createModelGroupsComponent(tui, theme, ctx.modelRegistry, access, done, {
					initialValidation: state.modelGroups.validation,
					notify: (message, type) => ctx.ui.notify(message, type),
					onRefresh: (validation) => {
						state.modelGroups.groups = validation.groups;
						state.modelGroups.validation = validation;
					},
				}),
			);
		},
	});
}
