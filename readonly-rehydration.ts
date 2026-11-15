/**
 * Readonly rehydration logic — extract branch-scanning into a pure function
 * for testability. The rehydrateReadonlyState wrapper in index.ts calls this
 * and handles the nudge side-effect.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Scan a session branch for the `pi-schematic-readonly` custom entry and
 * return whether readonly should be enabled. The most recent entry (found
 * by scanning in reverse) wins.
 *
 * @param branch - Session branch entries from sessionManager.getBranch()
 * @param pi - Used to check the `--readonly` CLI flag as fallback
 * @returns `true` if readonly should be enabled after rehydration
 */
export function getReadonlyFromBranch(branch: readonly SessionEntry[], pi: { getFlag: (name: string) => unknown }): boolean {
	// Scan branch in reverse for the most recent readonly entry
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== "pi-schematic-readonly") {
			continue;
		}
		const d = entry.data;
		return typeof d === "object" && d !== null && "enabled" in d && d.enabled === true;
	}
	// No branch entry found — fall back to CLI flag
	if (pi.getFlag("readonly") === true) {
		return true;
	}
	return false;
}
