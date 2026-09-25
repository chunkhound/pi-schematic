/** Handoff copy: the constant continuation frame and the successor's user message. */

/** Delimits extension-owned operational reporting after a successor payload. */
export const HANDOFF_REPORT_DELIMITER = "\n\n## Handoff report\n\n";

/** Versioned durable handoff data stored on its compaction entry. */
export interface HandoffPayload {
	version: 1;
	nextInstruction: string;
	context: string;
}

/**
 * The compaction summary shown to the fresh context.
 *
 * Constant on purpose. The instruction and situational context arrive verbatim in
 * the next real user message (see `buildNextUserMessage`), and readonly state is
 * re-emitted live by the context hook — so nothing session-specific, and no
 * constraints, belong in an immutable summary that a `/tree` rollback cannot fix.
 */
export function buildContinuationFrame(): string {
	return [
		"## Handoff — Continue Previous Work",
		"",
		"You are continuing a previous agent's work in a clean context. Use the available knowledge correctly:",
		"- Notebook pages are a cache for this stream: code facts are re-derivable, while user guidance, decisions, and design live in pages — fetch them with `notebook_read`",
		"- The next user message carries your instruction verbatim, plus the previous agent's remaining situational context",
		"- Use `notebook_index` to scan available pages when needed",
		"- Use `spawn` to delegate isolated subtasks to child agents",
		"- Build on notebook memory and the instruction rather than reconstructing old context",
	].join("\n");
}

/**
 * Add the cut identity Pi needs to report the just-created compaction entry.
 *
 * This comment has no successor instruction or mutable execution posture; the
 * visible continuation frame stays fixed while each persisted summary is unique.
 */
export function buildHandoffCompactionSummary(recoveryKey: string): string {
	return `${buildContinuationFrame()}\n\n<!-- handoff-cut:${recoveryKey} -->`;
}

/**
 * Build the single user message that starts the post-handoff context.
 *
 * The instruction is copied, never summarized, so it cannot be paraphrased away.
 */
export function buildNextUserMessage(input: Pick<HandoffPayload, "nextInstruction"> & { context?: string }): string {
	const context = input.context?.trim();
	const parts = ["## Next instruction", "", input.nextInstruction];
	if (context) parts.push("", "## Context", "", context);
	return parts.join("\n");
}

/** Add an extension-owned operational report without changing the successor payload prefix. */
export function appendHandoffReport(successorMessage: string, report: string): string {
	return successorMessage + HANDOFF_REPORT_DELIMITER + report;
}
