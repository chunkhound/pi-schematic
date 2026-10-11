/**
 * Pure short-bundle expansion core for git option parsing.
 * No FS, no shell, no cache — shared by mutable and immutable paths.
 * Extracted from readonly-bash-git.ts to keep that domain file smaller;
 * further splits stay deferred to avoid cycles across flag tables.
 */

/** Short-bundle walker options: mutable fails closed on unknown chars, immutable is lenient. */
export type GitBundleOptions =
	| { kind: "mutable"; booleans: ReadonlySet<string> }
	| { kind: "immutable"; injection: RegExp | undefined };

/** Expansion outcome: the expanded args, or the short bundle that failed closed. */
export type GitExpansion = { ok: true; args: string[] } | { ok: false; blocked: string };

/**
 * Drive short-bundle expansion over a token list. Long flags, the `--` separator,
 * and operands pass through whole; only single-dash bundles are split by `walk`.
 */
export function expandGitShortBundlesArgs(args: string[], values: ReadonlySet<string>, walk: (token: string) => string[] | null): GitExpansion {
	const expanded: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i]!;
		if (token === "--") return { ok: true, args: [...expanded, ...args.slice(i)] };
		if (values.has(token)) {
			expanded.push(token);
			if (args[i + 1] !== undefined) expanded.push(args[++i]!);
			continue;
		}
		if (!/^-[A-Za-z]/.test(token)) { expanded.push(token); continue; }
		const walked = walk(token);
		if (walked === null) return { ok: false, blocked: token };
		expanded.push(...walked);
	}
	return { ok: true, args: expanded };
}
