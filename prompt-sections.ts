import type { BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";

/** A named contribution to the system prompt, rendered fresh on every agent run. */
export interface PromptSection {
	name: string;
	/** Returns the section body, or undefined to omit the section for this run. */
	render(): string | undefined;
}

interface PromptSectionRegistry {
	/** Throws on a name outside `schematic` / `schematic_<part>` or on a duplicate name: both are wiring defects. */
	register(section: PromptSection): void;
	/** Renders every registered section in registration order, omitting undefined and empty bodies. */
	render(): Array<{ name: string; body: string }>;
}

const SECTION_NAME = /^schematic(_[a-z0-9]+)*$/;

export function createPromptSectionRegistry(): PromptSectionRegistry {
	const sections: PromptSection[] = [];
	return {
		register(section) {
			if (!SECTION_NAME.test(section.name)) {
				throw new Error(`Invalid schematic prompt section name: ${section.name}`);
			}
			if (sections.some((existing) => existing.name === section.name)) {
				throw new Error(`Duplicate schematic prompt section: ${section.name}`);
			}
			sections.push(section);
		},
		render() {
			const rendered: Array<{ name: string; body: string }> = [];
			for (const section of sections) {
				const body = section.render();
				if (body === undefined || body === "") continue;
				rendered.push({ name: section.name, body });
			}
			return rendered;
		},
	};
}

/**
 * Writes rendered sections into the event's prompt options. Returns a forced
 * prompt only when an earlier handler already forced one, because pi leaves
 * every section out of the request for a forced run (it still records them in
 * the transcript). The sections appended to that prompt are tagged the way pi
 * renders sections, so the model sees one shape whether or not the prompt is
 * forced.
 */
export function applyPromptSections(
	event: BeforeAgentStartEvent,
	rendered: Array<{ name: string; body: string }>,
): BeforeAgentStartEventResult | undefined {
	for (const { name, body } of rendered) {
		// Written even when forced: pi records sections in the transcript, so they are current once the forcing extension stops.
		event.systemPromptOptions.sections[name] = body;
	}
	if (event.systemPromptOptions.forceSystemPrompt === undefined) return undefined;
	return {
		systemPrompt: [event.systemPrompt, ...rendered.map(({ name, body }) => `<${name}>\n${body}\n</${name}>`)].join("\n\n"),
	};
}
