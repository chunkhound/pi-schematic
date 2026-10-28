// WHY: session boundaries are guarded independently from command dispatch. pi offers
// `session_before_*` hooks before the `input` hook, so a live run needs one place that
// decides which session change it owns and which must cancel.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SchematicState } from "../state.js";
import { registeredState } from "../process-state.js";

/** The only session change a workflow can own: `workflow.new` starts a new session (pi's
 * `reason: "new"` switch). Admission is this token, never a blocklist of commands, so a
 * fork, a tree move, or a `/resume` has no grant and always cancels. `workflow.handoff`
 * needs no admission: the turn_end boundary writes its entries without a session change. */
type AdmittedChange = "new";

/** pi's own capacity compactions: blocking one only defers the same shift into the run's next
 * turn and can fail it outright (overflow recovery), so they always pass. Every other reason is
 * a session change the run does not own: a handoff no longer requests one. */
const HOST_MANAGED_COMPACTIONS: readonly string[] = ["threshold", "overflow"];

/** Notice text per switch reason, so the operator learns which command to retry. */
const SWITCH_LABELS: Record<"new" | "resume", string> = { new: "start a new session", resume: "switch session" };

/**
 * Session boundaries cancel while a run owns the session. pi dispatches `/new`, `/resume`,
 * `/fork`, `/tree` and `/compact` before the `input` hook, so suppression alone cannot exclude
 * them and a lifecycle command can replace the session under a live run. The guard answers each
 * boundary pi offers; rule and residual windows: docs/workflows.md (Constraints, Host gaps).
 */
export function registerSessionGuard(pi: ExtensionAPI, state: SchematicState): void {
	pi.on("session_before_switch", (event, ctx) => {
		// Only pi's `new` switch can be the workflow's own; a `resume` never is.
		return rejectBoundary(state, ctx, event.reason === "new" ? "new" : null, SWITCH_LABELS[event.reason]);
	});
	pi.on("session_before_fork", (_event, ctx) => rejectBoundary(state, ctx, null, "fork this session"));
	pi.on("session_before_tree", (_event, ctx) => rejectBoundary(state, ctx, null, "move in the session tree"));
	pi.on("session_before_compact", (event, ctx) =>
		HOST_MANAGED_COMPACTIONS.includes(event.reason) ? undefined : rejectBoundary(state, ctx, null, "compact this session"));
}

/** Decide one boundary: pass when no run owns the session, or when this run asked for it.
 * `state.inputSuppressed` is the run's own flag, raised with the `input` handler and cleared on
 * release, so the guard follows the serial invariant instead of mirroring the reservation. */
function rejectBoundary(state: SchematicState, ctx: ExtensionContext, kind: AdmittedChange | null, label: string): { cancel: true } | undefined {
	if (!state.inputSuppressed) return undefined;
	if (kind !== null && spendAdmission(kind)) return undefined;
	warnOperator(ctx, `A workflow is running. Wait for it to finish, or press Escape or Ctrl+C twice to stop it, before you ${label}.`);
	return { cancel: true };
}

/** Advisory only: pi reports a throwing `session_before_*` handler and lets the boundary
 * through, so the cancel must stand even when the notice cannot be shown. Without a UI, the
 * caller still gets pi's own cancellation (`{ cancelled: true }`, "Compaction cancelled"). */
function warnOperator(ctx: ExtensionContext, message: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	} catch {
		// The cancel is what the operator's safety depends on, and it already stands.
	}
}

/** Admission slot. Process-global because module copies are not shared state: after
 * `workflow.new` the run requests its next handoff through the replacement runtime, whose guard
 * handler is a second copy of this module (jiti `moduleCache:false`, see process-state.ts). */
const admissionSlot = registeredState<{ granted: AdmittedChange | null }>("pi-schematic.workflow-session-admission", () => ({ granted: null }));

/** Hold one grant while the workflow asks pi for its own session change, so the guard admits
 * exactly that change and cancels every other boundary until the grant is spent. Releasing on
 * return means a change that never reached pi leaves no standing admission behind. */
export async function admitted<T>(kind: AdmittedChange, change: () => Promise<T>): Promise<T> {
	const slot = admissionSlot;
	slot.granted = kind;
	try {
		return await change();
	} finally {
		if (slot.granted === kind) slot.granted = null;
	}
}

/** Spend the grant once, and only on the change it was held for. */
function spendAdmission(kind: AdmittedChange): boolean {
	const slot = admissionSlot;
	if (slot.granted !== kind) return false;
	slot.granted = null;
	return true;
}
