/**
 * External pager integration for the /notebook TUI.
 *
 * Resolves a pager command (respecting $PAGER, falling back to `less` on
 * POSIX) and runs it with the page body fed via stdin. Exports a mutable
 * `pagerRuntime` seam so tests can swap resolvePager/spawnPager without
 * shelling out.
 */

import { execSync, spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

export interface ResolvedPager {
	cmd: string;
	args: string[];
}

function defaultCommandExists(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * $PAGER may carry args (e.g. "less -R"). Whitespace-split matches git's
 * historical behavior; no shell quoting, and no `sh -c` (which would be
 * Windows-hostile). Users needing complex pager invocations should wrap
 * them in a script and point $PAGER at it.
 */
export function resolvePager(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	commandExists: (cmd: string) => boolean = defaultCommandExists,
): ResolvedPager | undefined {
	const raw = env.PAGER?.trim();
	if (raw) {
		const [cmd, ...args] = raw.split(/\s+/);
		if (cmd) {
			const executable = platform === "win32" ? win32.basename(cmd).toLowerCase() : posix.basename(cmd);
			if (executable === "less" || (platform === "win32" && executable === "less.exe")) {
				// Override -F (including inherited LESS) so short pages stay readable
				// until dismissed. Keep it last, but before any end-of-options marker.
				const endOfOptions = args.indexOf("--");
				args.splice(endOfOptions === -1 ? args.length : endOfOptions, 0, "-+F");
			}
			return { cmd, args };
		}
	}
	// Skip probing on Windows: `command -v` isn't standard and less is
	// rarely present. Respect $PAGER above, otherwise fall through.
	if (platform === "win32") return undefined;
	if (commandExists("less")) return { cmd: "less", args: ["-R", "-+F"] };
	return undefined;
}

/**
 * Async spawn. Prefer `openInPager` from callers inside the TUI — it owns the
 * suspend/restore + SIGINT dance that `spawnPager` requires to be safe.
 *
 * stdin MUST be piped, not inherited: otherwise the pager swallows Pi's
 * buffered raw-mode escapes and the next overlay opens broken. `less` reads
 * its own keystrokes from /dev/tty when stdin is not a TTY, so navigation
 * still works.
 *
 * ENOENT becomes a readable error. EPIPE on the stdin pipe is normal (the
 * pager quit before consuming all stdin) and stays silent. Nonzero exit
 * codes are intentionally ignored — a pager's exit code shouldn't break the
 * caller's UX.
 */
export function spawnPager(body: string, pager: ResolvedPager): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(pager.cmd, pager.args, {
			stdio: ["pipe", "inherit", "inherit"],
			windowsHide: true,
			shell: process.platform === "win32",
		});
		child.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") reject(new Error(`${pager.cmd} not found`));
			else reject(err);
		});
		// Under shell: true (Windows), a missing binary surfaces as cmd.exe
		// exit 9009 ("not recognized") rather than ENOENT. Promote that one
		// code to a rejection; keep ignoring every other nonzero exit so a
		// pager's own exit code never breaks the caller's UX.
		child.on("close", (code) => {
			if (process.platform === "win32" && code === 9009) {
				reject(new Error(`${pager.cmd} not found`));
			} else {
				resolve();
			}
		});
		child.stdin?.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code !== "EPIPE") reject(err);
		});
		child.stdin?.end(body);
	});
}

/**
 * Run a pager under Pi's TUI. Caller passes the already-resolved pager.
 *
 * Suspends the parent TUI (releases alt screen + raw-mode stdin) before
 * spawning so `less`'s alt-screen restore returns to Pi's screen, not the
 * primary buffer, and keystrokes don't race between Pi's input listener and
 * the child. Mirrors the stop/spawn/start pattern used by upstream Pi for
 * external editors.
 *
 * Guards SIGINT across the whole stop→spawn→start window: `less` keeps ISIG
 * on, so Ctrl+C in the pager fires SIGINT to the whole foreground process
 * group. Pi has no persistent SIGINT handler, so without this guard a Ctrl+C
 * in less kills Pi before the TUI restore runs.
 *
 * Returns the error if `spawnPager` rejected (caller decides how to surface
 * it); returns undefined on success.
 */
export async function openInPager(
	tui: TUI,
	body: string,
	pager: ResolvedPager,
): Promise<Error | undefined> {
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);
	tui.stop();
	try {
		await pagerRuntime.spawnPager(body, pager);
		return undefined;
	} catch (err) {
		return err as Error;
	} finally {
		tui.start();
		tui.requestRender(true);
		process.removeListener("SIGINT", ignoreSigint);
	}
}

/** Test seam: index.ts calls pagerRuntime.* so tests can swap per-test. */
export const pagerRuntime = { resolvePager, spawnPager, openInPager };
