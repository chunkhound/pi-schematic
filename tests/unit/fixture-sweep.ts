import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** Ownership marker each fixture dir carries. The sweeper deletes only a directory that
 * contains it, so a stale user directory that merely shares the prefix is never removed. */
export const FIXTURE_MARKER = ".pi-readonly-fixture";

// Killed runs (SIGKILL, CI cancellation) leave mkdtemp fixtures behind; the OS eventually
// cleans the temp dir but never the home directory, and a per-run exit hook cannot run.
// One-hour threshold: a younger sibling dir may belong to a live concurrent run.
const STALE_AFTER_MS = 60 * 60 * 1000;

/** Remove killed-run fixture dirs under `dir` older than one hour. Best-effort by design:
 * losing a race with another sweeper or the OS only delays cleanup to the next run. */
export function sweepStaleFixtures(dir: string, prefix: string): void {
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return; } // unwritable dir: nothing to sweep
	const cutoff = Date.now() - STALE_AFTER_MS;
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const target = path.join(dir, entry);
		// Marker gate: without it, a same-prefix user dir older than the cutoff was deleted.
		if (!existsSync(path.join(target, FIXTURE_MARKER))) continue;
		try {
			if (statSync(target).mtimeMs < cutoff) rmSync(target, { recursive: true, force: true });
		} catch { /* removed by a concurrent sweeper or the OS — done either way */ }
	}
}
