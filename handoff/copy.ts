/** Shared handoff status copy used by command and tool lifecycle paths. */

/** Status shown after a handoff is requested but is not yet eligible. */
export const HANDOFF_REQUESTED_STATUS = "🤝 Handoff requested — waiting for eligible context";
/** Status shown when a topic boundary requires an eligible handoff. */
export const HANDOFF_REQUIRED_STATUS = "🤝 Handoff required — ready to compact";
/** Status shown while a handoff is staged in the current turn. */
export const HANDOFF_IN_PROGRESS_STATUS = "🤝 Handoff in progress";

/** Tool result of an accepted handoff call. */
export const HANDOFF_STAGED_RESULT = "Handoff staged. This context is cut when the turn ends, and the successor continues in the same run.";
/** Refusal for every handoff call in an assistant message that also holds other tool calls. */
export const HANDOFF_NOT_ALONE_REFUSAL = "Not run: handoff must be the only tool call in its message. The other calls in this message were handled on their own; call handoff alone in your next message.";
/** Refusal for every handoff call after the first in one assistant message. */
export const HANDOFF_EXTRA_CALL_REFUSAL = "Not run: only the first handoff call in an assistant message runs.";
/** Refusal for a handoff call after a handoff failed earlier in the same run. */
export const HANDOFF_FAILED_IN_RUN_REFUSAL = "Not run: a handoff already failed in this run. Do not call handoff again in this run.";
/** Tool rejection while another handoff is staged. */
export const HANDOFF_ALREADY_STAGED = "A handoff is already staged in this turn; wait for it to complete.";
/** `/handoff` rejection while a handoff is staged. */
export const HANDOFF_COMMAND_BUSY = "A handoff is in progress; wait for it to complete before requesting another handoff.";
/** Warning when the cut persisted but its continuation turn did not run. */
export const HANDOFF_SUCCESSOR_NOT_RUN = "Handoff complete, but the successor turn did not run. Send a message to continue.";

/** Why a handoff left no cut; inserted into the failure notification and guidance. */
export const REASON_ABORTED = "the run was aborted before the cut";
export const REASON_NO_BOUNDARY = "the turn ended without writing the cut";
export const REASON_TURN_FAILED = "the turn ended with an error";
export const REASON_RESULT_MISSING = "the handoff result was missing from its turn";
export const REASON_NOT_PERSISTED = "pi did not persist the cut (another extension replaced the turn_end entries, or pi rejected them)";
export const REASON_SUCCESSOR_NOT_PERSISTED = "the cut was written but its successor instruction was not persisted after it (another extension's turn_end handler may have dropped it or written a later compaction)";
