import type { PromptSection } from "../prompt-sections.js";
import type { SchematicState } from "../state.js";
import { formatPageList } from "./store.js";

export function notebookTopicSection(state: SchematicState): PromptSection {
	return {
		name: "schematic_topic",
		render() {
			if (state.activeNotebookTopic !== null && state.activeNotebookTopic !== "") {
				return (
					`## Active Notebook Topic\n` +
					`Current topic: \`${state.activeNotebookTopic}\` (${state.activeNotebookTopicSource ?? "unknown"}-set).\n` +
					`Treat this as the current semantic frame. If new work fits it, prefer spawn for isolated noisy subtasks. If it does not fit it, prefer handoff.`
				);
			}
			return (
				`## Active Notebook Topic\n` +
				`No active notebook topic is set. Early in the next substantive task, assign a short stable topic with \`notebook_topic_set\`. Human-set topics are authoritative.`
			);
		},
	};
}

export function notebookPagesSection(state: SchematicState): PromptSection {
	return {
		name: "schematic_notebook",
		render() {
			if (state.notebookPages.size === 0) {
				return undefined;
			}
			const listing = formatPageList(state);
			return (
				`## Active Notebook Pages\n` +
				`The following pages are available via notebook_read by name:\n${listing}\n` +
				`Reference pages by name — never paste bodies into prompts.`
			);
		},
	};
}
