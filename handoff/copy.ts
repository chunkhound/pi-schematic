/** Shared handoff status copy used by command and tool lifecycle paths. */

/** Status shown after a handoff is requested but is not yet eligible. */
export const HANDOFF_REQUESTED_STATUS = "🤝 Handoff requested — waiting for eligible context";
/** Status shown when a topic boundary requires an eligible handoff. */
export const HANDOFF_REQUIRED_STATUS = "🤝 Handoff required — ready to compact";
/** Status shown while a handoff is staged in the current turn. */
export const HANDOFF_IN_PROGRESS_STATUS = "🤝 Handoff in progress";

/** Tool result of an accepted handoff call. */
export const HANDOFF_STAGED_RESULT = "Handoff staged. This context is cut when the turn ends, and the successor continues in the same run.";
/** Refusal for a tool call that shares an assistant message with handoff. */
export const HANDOFF_SIBLING_REFUSAL = "Not run: this call shares an assistant message with handoff, which ends this context. Call it again after the handoff if the successor needs it.";
/** Refusal for every handoff call after the first in one assistant message. */
export const HANDOFF_EXTRA_CALL_REFUSAL = "Not run: only the first handoff call in an assistant message runs.";
/** Tool rejection while another handoff is staged. */
export const HANDOFF_ALREADY_STAGED = "A handoff is already staged in this turn; wait for it to complete.";
/** `/handoff` rejection while a handoff is staged. */
export const HANDOFF_COMMAND_BUSY = "A handoff is in progress; wait for it to complete before requesting another handoff.";
/** Warning when the cut persisted but its continuation turn did not run. */
export const HANDOFF_SUCCESSOR_NOT_RUN = "Handoff complete, but the successor turn did not run. Send a message to continue.";

/** Failure reasons, completing "Handoff failed: <reason>". */
export const REASON_ABORTED = "the run was aborted before the cut";
export const REASON_NO_BOUNDARY = "the turn ended without writing the cut";
export const REASON_RESULT_MISSING = "the handoff result was missing from its turn";
export const REASON_NOT_PERSISTED = "pi did not persist the cut (another extension replaced the turn_end entries, or pi rejected them)";
