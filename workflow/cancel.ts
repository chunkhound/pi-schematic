// WHY: input suppression and cancellation are one lifecycle: the run raises the input
// flag, arms the two-press cancel funnel, and bridges aborted turns to the host. Keeping
// them together leaves command.ts as the start/execute/finalize owner.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import type { SchematicState } from "../state.js";
import type { RebindableDeps, RebindBundle, RunCtl } from "./rebind.js";
import { notify } from "./errors.js";

interface CancelBundle extends RebindBundle {
	deps: RebindableDeps & { cancelConfirmMs?: number };
}

type CancelKey = "escape" | "ctrl+c";
const CANCEL_KEYS: readonly CancelKey[] = ["escape", "ctrl+c"];
/** Arm-then-confirm window: two presses of the same cancel key within this window abort. Rule: docs/workflows.md (Targets, exit, cancellation, salvage). */
export const CANCEL_CONFIRM_MS = 500;
const CANCEL_LABEL: Record<CancelKey, string> = { escape: "Escape", "ctrl+c": "Ctrl+C" };

/**
 * Suppress non-extension input for the run. Also raises `state.inputSuppressed` so the
 * frontmatter `input` hook (registered at load, hence earlier in pi's dispatch order)
 * skips dropped submissions instead of mutating model/readonly state ahead of the drop.
 * Takes the bundle so rebindRun sets the flag on the replacement's live state.
 *
 * Input exclusion is not atomic, including across `workflow.new`: see docs/workflows.md (Host gaps).
 * {@link registerSessionGuard} covers the boundaries pi dispatches ahead of this hook.
 */
export function suppressInput(bundle: CancelBundle): () => void {
	// Capture the state: the unsubscribe that runs AFTER a rebind must clear the state
	// this subscription raised, not the replacement's (they are one object in production,
	// but distinct in tests — clearing must not depend on that identity).
	const state = bundle.state;
	// Register before raising the flag: a throwing registration then leaves no stuck flag.
	const off = bundle.pi.on("input", (event) => (event.source === "extension" ? undefined : { action: "handled" as const }));
	state.inputSuppressed = true;
	return () => {
		state.inputSuppressed = false;
		off();
	};
}

/** Bridge pi's per-turn outcome to the host: an aborted turn (RPC/print abort, provider abort)
 * must cancel a live workflow even though only TUI keys reach the key funnel. Child sessions run
 * their own extension runner, so a child's abort never fires this parent handler. */
export function subscribeTurnEnd(bundle: CancelBundle, ctl: RunCtl): () => void {
	return bundle.pi.on("turn_end", (event) => {
		if (event.outcome === "aborted") ctl.host?.abort("cancelled");
	});
}

/** Register cancellation for a live context. Arm state is per registration, so a
 * `workflow.new` rebind starts with no inherited armed press. */
export function subscribeCancellation(bundle: CancelBundle, ctl: RunCtl, ctx: ExtensionCommandContext): () => void {
	return registerCancellation(ctx, bundle.deps.cancelConfirmMs ?? CANCEL_CONFIRM_MS, () => ctl.host?.abort("cancelled"));
}

/** Escape / Ctrl+C arm a two-step funnel: the first press warns, a second press of the same
 * key inside the window aborts. This mirrors pi's double-press interrupt guard so a single
 * stray keypress cannot kill a long run. Terminal input is TUI-only. */
function registerCancellation(ctx: ExtensionCommandContext, confirmMs: number, onCancel: () => void): () => void {
	if (ctx.mode !== "tui") return () => {};
	const armedAt = new Map<CancelKey, number>();
	return ctx.ui.onTerminalInput((data) => {
		const press = cancelPressOf(data);
		if (!press) return undefined;
		// A coalesced pair is two physical presses: it already satisfies the guard.
		if (press.confirmed || confirmCancel(armedAt, press.key, Date.now(), confirmMs)) onCancel();
		else notify(ctx, `Press ${CANCEL_LABEL[press.key]} again within ${confirmMs}ms to cancel the workflow`, "warning");
		return { consume: true };
	});
}

/** Map a terminal read to a cancel press, or null to pass it through untouched.
 * pi-tui's StdinBuffer coalesces two Escape presses inside its 10ms escape window into
 * `"\x1b\x1b"` (stdin-buffer.js), which its parser reports as `ctrl+alt+[` and matches
 * against no cancel key (keys.js). Two physical presses must still cancel, so report that
 * read as an already-confirmed Escape. Kitty flag 2 also emits a press then a release for one
 * physical key; `isKeyRelease`/`isKeyRepeat` drop those non-press events. */
export function cancelPressOf(data: string): { key: CancelKey; confirmed: boolean } | null {
	if (data === "\x1b\x1b") return { key: "escape", confirmed: true };
	if (isKeyRelease(data) || isKeyRepeat(data)) return null;
	// Only the funnel's cancel keys are consumed: every other keypress must still reach the
	// editor while a run is active, instead of being swallowed wholesale.
	const key = CANCEL_KEYS.find((candidate) => matchesKey(data, candidate));
	return key ? { key, confirmed: false } : null;
}

/** Arm or confirm per key: a press inside the window consumes the arm and returns true; a
 * first press, or one after the window, (re)arms and returns false. Keys never cross-confirm. */
function confirmCancel(armedAt: Map<CancelKey, number>, key: CancelKey, now: number, windowMs: number): boolean {
	const at = armedAt.get(key);
	armedAt.delete(key);
	if (at !== undefined && now - at < windowMs) return true;
	armedAt.set(key, now);
	return false;
}
