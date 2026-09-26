/**
 * Readonly rehydration logic — extract branch-scanning into a pure function
 * for testability. The rehydrateReadonlyState wrapper in index.ts calls this
 * and handles the nudge side-effect.
 */

/**
 * Scan a session branch for the `pi-schematic-readonly` custom entry and
 * return whether readonly should be enabled. The most recent entry (found
 * by scanning in reverse) wins.
 *
 * @param branch - Session branch entries from sessionManager.getBranch()
 * @param pi - Used to check the `--readonly` CLI flag as fallback
 * @returns `true` if readonly should be enabled after rehydration
 */
export function getReadonlyFromBranch(
	branch: readonly unknown[],
	pi: { getFlag: (name: string) => unknown },
): boolean {
	// Scan branch in reverse for the most recent readonly entry
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "custom" || e.customType !== "pi-schematic-readonly") continue;
		const d = e.data as Record<string, unknown> | undefined;
		return d?.enabled === true;
	}
	// No branch entry found — fall back to CLI flag
	if (pi.getFlag("readonly") === true) {
		return true;
	}
	return false;
}
