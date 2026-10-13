/**
 * External pager integration for the /notebook TUI.
 *
 * Resolves a pager command (respecting $PI_PAGER, then $PAGER, falling back to
 * `less` on POSIX) and runs it with the page body fed via stdin. Exports a
 * mutable `pagerRuntime` seam so tests can swap resolvePager/spawnPager
 * without shelling out.
 */

import { execSync, spawn, type StdioOptions } from "node:child_process";
import { posix, win32 } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

export interface ResolvedPager {
	cmd: string;
	args: string[];
}

// Override -F and -X (including inherited LESS) so short pages stay readable
// until dismissed and page text doesn't linger in the terminal's scrollback.
const LESS_KEEP_OPEN = ["-+F", "-+X"];

function defaultHasLess(): boolean {
	try {
		execSync("command -v less", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * $PI_PAGER takes precedence over $PAGER, as $GIT_PAGER does in git, so a
 * pager can be chosen for Pi alone. This matters for bat < 0.22, which uses
 * $PAGER as its own pager and recurses forever on PAGER=batcat. Unlike git,
 * a blank value counts as unset and falls through; it never disables paging.
 *
 * A `cat` or `more` pager returns undefined so the caller shows its inline
 * preview: both exit at end of input, and Pi's TUI redraws over whatever they
 * printed once it restarts. Unlike git, which only skips an exact `cat`,
 * `/bin/cat` and `cat -v` match too.
 *
 * The pager value may carry args (e.g. "less -R"), split on whitespace with no
 * quoting, matching git's historical behavior. POSIX spawns it without a shell
 * (no `sh -c`); on Windows spawnPager hands the joined line to cmd.exe. Users
 * needing complex pager invocations should wrap them in a script and point
 * $PI_PAGER or $PAGER at it.
 */
export function resolvePager(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	hasLess: () => boolean = defaultHasLess,
): ResolvedPager | undefined {
	const raw = env.PI_PAGER?.trim() || env.PAGER?.trim();
	if (raw) {
		const [cmd, ...args] = raw.split(/\s+/);
		if (cmd) {
			const executable = platform === "win32" ? win32.basename(cmd).toLowerCase().replace(/\.(exe|com)$/, "") : posix.basename(cmd);
			if (executable === "cat" || executable === "more") return undefined;
			// Injected args go last, but before any end-of-options marker.
			const endOfOptions = args.indexOf("--");
			const at = endOfOptions === -1 ? args.length : endOfOptions;
			if (executable === "less") {
				args.splice(at, 0, ...LESS_KEEP_OPEN);
			} else if (executable === "bat" || executable === "batcat") {
				// bat's default --paging=auto runs less with -F, so short pages
				// would vanish immediately. The last --paging wins in bat. An
				// inherited LESS=-F still applies to bat's less; not overridden.
				args.splice(at, 0, "--paging=always");
			}
			return { cmd, args };
		}
	}
	// Skip probing on Windows: `command -v` isn't standard and less is
	// rarely present. Respect $PI_PAGER/$PAGER above, otherwise fall through.
	if (platform === "win32") return undefined;
	if (hasLess()) return { cmd: "less", args: ["-R", ...LESS_KEEP_OPEN] };
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
 * ENOENT becomes a readable error. EPIPE/EOF on the stdin pipe is normal (the
 * pager quit before consuming all stdin) and stays silent. Nonzero exit
 * codes are intentionally ignored — a pager's exit code shouldn't break the
 * caller's UX. On Windows (shell: true) a missing binary is just a cmd.exe
 * exit code, so it is ignored too, matching Pi's external editor.
 */
export function spawnPager(body: string, pager: ResolvedPager): Promise<void> {
	return new Promise((resolve, reject) => {
		// cmd.exe parses one joined line on Windows. Join it here as Node would
		// (unquoted): passing args with shell: true makes Node 24+ print DEP0190 to stderr.
		const stdio: StdioOptions = ["pipe", "inherit", "inherit"];
		const child = process.platform === "win32"
			? spawn([pager.cmd, ...pager.args].join(" "), { stdio, shell: true })
			: spawn(pager.cmd, pager.args, { stdio });
		child.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") reject(new Error(`${pager.cmd} not found`));
			else reject(err);
		});
		child.on("close", () => resolve());
		// Windows (libuv) reports a closed read end as EOF rather than EPIPE.
		child.stdin?.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPIPE" && code !== "EOF") reject(err);
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
 * the child. Uses the same stop/spawn/start + forced redraw as Pi's external
 * editor, though Pi's editor stays mounted throughout while /notebook closes
 * its list first.
 *
 * Guards SIGINT across the spawn→start window: `less` keeps ISIG on, so
 * Ctrl+C in the pager fires SIGINT to the whole foreground process group. Pi
 * has no persistent SIGINT handler, so without this guard a Ctrl+C in less
 * kills Pi before the TUI restore runs.
 *
 * Returns the error if `spawnPager` rejected (caller decides how to surface
 * it); returns undefined on success. `tui.stop()` and `tui.start()` failures
 * throw: like Pi's editor, a failed stop never reaches start, which would
 * attach a second set of input listeners.
 */
export async function openInPager(
	tui: TUI,
	body: string,
	pager: ResolvedPager,
): Promise<Error | undefined> {
	tui.stop();
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);
	try {
		await pagerRuntime.spawnPager(body, pager);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	} finally {
		process.removeListener("SIGINT", ignoreSigint);
		tui.start();
		tui.requestRender(true);
	}
}

interface PagerRuntime {
	resolvePager: typeof resolvePager;
	spawnPager: typeof spawnPager;
}

const defaultPagerRuntime: PagerRuntime = { resolvePager, spawnPager };

/** Test seam: index.ts and openInPager call pagerRuntime.* so tests can swap per-test. */
export let pagerRuntime: PagerRuntime = defaultPagerRuntime;

/** Test seam: swap one or more pagerRuntime methods; pass null to restore the originals. */
export function __setPagerRuntimeForTests(next: Partial<PagerRuntime> | null): void {
	pagerRuntime = next ? { ...defaultPagerRuntime, ...next } : defaultPagerRuntime;
}
