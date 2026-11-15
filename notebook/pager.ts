/**
 * External pager integration for the /notebook TUI.
 *
 * Resolves a pager command (respecting $PI_PAGER, then $PAGER, falling back to
 * `less` on POSIX) and runs it with the page body fed via stdin.
 */

import { execSync, spawn, type StdioOptions } from "node:child_process";
import { posix, win32 } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

export interface ResolvedPager {
	cmd: string;
	args: string[];
}

/** A $PI_PAGER or $PAGER value that is not a valid command line; `error` names the variable. */
export interface InvalidPager {
	error: string;
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
 * Splits a command line into words with the quoting of a POSIX shell's word
 * splitting and nothing else: no expansion, globbing, pipes or separators.
 * Only space, tab and newline separate words. Double quotes unescape only
 * `"`, `\`, `$` and a backtick; outside quotes a backslash makes the next
 * character literal. Outside quotes and inside double quotes a backslash
 * followed by a newline is removed, as a shell's line continuation is.
 */
function splitCommandLine(line: string): { words: string[] } | { problem: string } {
	const words: string[] = [];
	// undefined until a character or a pair of quotes starts a word, so "" is an empty word.
	let word: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const ch = line.charAt(i);
		if (ch === " " || ch === "\t" || ch === "\n") {
			if (word !== undefined) {
				words.push(word);
				word = undefined;
			}
		} else if (line.startsWith("\\\n", i)) {
			i++;
		} else if (ch === "\\") {
			i++;
			if (i === line.length) {
				return { problem: "ends with an unquoted backslash" };
			}
			word = (word ?? "") + line.charAt(i);
		} else if (ch === "'") {
			const end = line.indexOf("'", i + 1);
			if (end === -1) {
				return { problem: "has an unbalanced single quote" };
			}
			word = (word ?? "") + line.slice(i + 1, end);
			i = end;
		} else if (ch === '"') {
			word ??= "";
			for (i++; line.charAt(i) !== '"'; i++) {
				if (i === line.length) {
					return { problem: "has an unbalanced double quote" };
				}
				if (line.startsWith("\\\n", i)) {
					i++;
					continue;
				}
				if (line.charAt(i) === "\\" && i + 1 < line.length && '"\\$`'.includes(line.charAt(i + 1))) {
					i++;
				}
				word += line.charAt(i);
			}
		} else {
			word = (word ?? "") + ch;
		}
	}
	if (word !== undefined) {
		words.push(word);
	}
	return { words };
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
 * The pager value is a program followed by args (e.g. "less -R"). On POSIX it
 * is split with a shell's quoting rules and spawned without a shell (no
 * `sh -c`), so `"/path with space/pager" -R` works and `$HOME`, `~` or `|`
 * reach the program literally; a backslash-newline is removed outside single
 * quotes. Characters other than space, tab and newline, such as a trailing
 * carriage return, belong to a word. A value with an unbalanced quote, a
 * trailing unquoted backslash or an empty program returns InvalidPager. On Windows the
 * value is split on whitespace with no quoting and spawnPager hands the joined
 * line to cmd.exe, which applies its own quoting. Users needing complex pager
 * invocations should wrap them in a script and point $PI_PAGER or $PAGER at it.
 *
 * The parameters exist for tests: production calls `resolvePager()` with the
 * process environment, platform and `less` probe.
 */
export function resolvePager(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	hasLess: () => boolean = defaultHasLess,
): ResolvedPager | InvalidPager | undefined {
	const source = (env.PI_PAGER?.trim() ?? "") !== "" ? "PI_PAGER" : "PAGER";
	const raw = env[source];
	if (raw !== undefined && raw.trim() !== "") {
		// Parsed untrimmed: an escaped or quoted space at either end belongs to a word.
		const parsed = platform === "win32" ? { words: raw.trim().split(/\s+/) } : splitCommandLine(raw);
		if ("problem" in parsed) {
			return { error: `${source} ${parsed.problem}` };
		}
		const [cmd, ...args] = parsed.words;
		// No word at all is left of a value that is only a line continuation.
		if (parsed.words.length === 0 || cmd === "") {
			return { error: `${source} names an empty program` };
		}
		const executable =
			platform === "win32"
				? win32
						.basename(cmd)
						.toLowerCase()
						.replace(/\.(exe|com)$/, "")
				: posix.basename(cmd);
		if (executable === "cat" || executable === "more") {
			return undefined;
		}
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
	// Skip probing on Windows: `command -v` isn't standard and less is
	// rarely present. Respect $PI_PAGER/$PAGER above, otherwise fall through.
	if (platform === "win32") {
		return undefined;
	}
	if (hasLess()) {
		return { cmd: "less", args: ["-R", ...LESS_KEEP_OPEN] };
	}
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
		const child = process.platform === "win32" ? spawn([pager.cmd, ...pager.args].join(" "), { stdio, shell: true }) : spawn(pager.cmd, pager.args, { stdio });
		child.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				reject(new Error(`${pager.cmd} not found`));
			} else {
				reject(err);
			}
		});
		child.on("close", () => {
			resolve();
		});
		// Windows (libuv) reports a closed read end as EOF rather than EPIPE.
		child.stdin?.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPIPE" && code !== "EOF") {
				reject(err);
			}
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
export async function openInPager(tui: TUI, body: string, pager: ResolvedPager): Promise<Error | undefined> {
	tui.stop();
	const ignoreSigint = () => {
		/* A listener keeps Ctrl+C from killing pi while the pager owns the terminal. */
	};
	process.on("SIGINT", ignoreSigint);
	try {
		await spawnPager(body, pager);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	} finally {
		process.removeListener("SIGINT", ignoreSigint);
		tui.start();
		tui.requestRender(true);
	}
}
