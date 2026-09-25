import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SchematicState } from "../state.js";
import { normalizeNotebookTopic, setActiveNotebookTopic } from "./topic.js";

export function registerNotebookTopicTool(
	pi: ExtensionAPI,
	state: SchematicState,
): void {
	pi.registerTool({
		name: "notebook_topic_set",
		label: "Notebook Topic Set",
		description:
			"Set the active notebook topic for the current session. " +
			"Use this to establish the current semantic frame when no topic is set yet. " +
			"Human-set topics are authoritative and cannot be overridden by the agent.",
		promptSnippet: "Set the active notebook topic for the current session",
		promptGuidelines: [
			"Use this early in a fresh session when no active notebook topic exists yet.",
			"Do not use this to override a human-set topic. If the work no longer fits the current topic, prefer handoff.",
		],
		parameters: Type.Object({
			topic: Type.String({
				description: "Short stable notebook topic name for the current semantic frame.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const normalized = normalizeNotebookTopic(params.topic);
			if (state.activeNotebookTopic) {
				if (state.activeNotebookTopic !== normalized) {
					throw new Error(
						state.activeNotebookTopicSource === "human"
							? "Human-set notebook topic is authoritative. Use handoff instead of overriding it."
							: "Active notebook topic already exists. Use handoff instead of changing it mid-session.",
					);
				}
				return {
					content: [{ type: "text", text: `Notebook topic already set to \"${state.activeNotebookTopic}\".` }],
					details: {
						topic: state.activeNotebookTopic,
						source: state.activeNotebookTopicSource,
						changed: false,
					},
				};
			}
			const result = setActiveNotebookTopic(state, params.topic, "agent");
			return {
				content: [{ type: "text", text: `Active notebook topic: \"${result.current}\".` }],
				details: { topic: result.current, source: "agent" as const, changed: result.changed },
			};
		},
	});
}
