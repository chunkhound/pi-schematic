/** Handoff copy: the constant continuation frame, the successor message, and handoff reports. */

/** Custom type of the successor message written in the handoff boundary. */
export const HANDOFF_SUCCESSOR_CUSTOM_TYPE = "pi-schematic-handoff";
/** Custom type of the hidden system-prompt note written after the successor. */
export const HANDOFF_NOTE_CUSTOM_TYPE = "pi-schematic-handoff-note";
/** Custom type of the failure message sent when a handoff leaves no cut. */
export const HANDOFF_FAILED_CUSTOM_TYPE = "pi-schematic-handoff-failed";

/**
 * The compaction summary shown to the fresh context.
 *
 * Constant on purpose. The instruction and situational context arrive verbatim in
 * the next message (see `buildNextUserMessage`), and readonly state is
 * re-emitted live by the context hook — so nothing session-specific, and no
 * constraints, belong in an immutable summary that a `/tree` rollback cannot fix.
 */
export function buildContinuationFrame(): string {
	return [
		"## Handoff — Continue Previous Work",
		"",
		"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
		"- Notebook pages are a cache for this stream: code facts are re-derivable, while user guidance, decisions, and design live in pages — fetch them with `notebook_read`",
		"- The next message carries your instruction verbatim, plus the previous agent's remaining situational context",
		"- Use `notebook_index` to scan available pages when needed",
		"- Use `spawn` to delegate isolated subtasks to child agents",
		"- Build on notebook memory and the instruction rather than reconstructing old context",
	].join("\n");
}

/**
 * Build the successor message that starts the post-handoff context.
 *
 * The instruction is copied, never summarized, so it cannot be paraphrased away.
 */
export function buildNextUserMessage(input: { nextInstruction: string; context?: string }): string {
	const context = input.context?.trim();
	const parts = ["## Next instruction", "", input.nextInstruction];
	if (context) parts.push("", "## Context", "", context);
	return parts.join("\n");
}

/**
 * Hidden note after the successor. The successor turn continues the calling run,
 * so its system prompt still carries the pre-handoff topic and page list.
 */
export function buildHandoffSystemPromptNote(): string {
	return "The system prompt above was written before this handoff and is refreshed when the next run starts; a message typed during this run does not refresh it. Until then, ignore its notebook topic (the topic is cleared) and its notebook page list (use `notebook_index` for the current pages).";
}

/** Model-facing failure guidance for a handoff that did not cut. */
export function formatHandoffFailure(reason: string, pendingRequest: boolean): string {
	const nextStep = pendingRequest
		? "The required handoff remains pending; retry when context usage is eligible."
		: "No required handoff remains pending; retry when ready.";
	return `Handoff failed — ${reason}. ${nextStep}`;
}

/** Completion report; with a discard request it states the notebook outcome. */
export function formatHandoffComplete(discardRequested: boolean, kept: number, discarded: number): string {
	if (!discardRequested) return "Handoff complete.";
	return `Handoff complete. Notebook: ${kept} page${kept === 1 ? "" : "s"} kept` +
		(discarded > 0 ? `, ${discarded} discarded.` : ".");
}
