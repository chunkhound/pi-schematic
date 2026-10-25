/**
 * OS-level sandboxing for readonly-mode bash commands.
 *
 * Wraps bash commands to run inside an OS sandbox that denies filesystem
 * writes to ordinary host files outside the shared temp-root policy.
 * Linux also mounts sandbox-local /dev and /proc. Platform mechanisms:
 *   macOS  → sandbox-exec with Seatbelt profile
 *   Linux  → bubblewrap (bwrap) if available
 *   Windows → not supported (returns command unchanged, classifyBashCommand applies)
 *
 * Complements command classification with kernel-enforced filesystem restrictions.
 * Missing Linux roots under read-only ancestors remain unavailable.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import {
	READONLY_SANDBOX_BLOCK_NOTICE,
	buildReadonlySandboxPathError,
} from "./notifications.js";
import { TEMP_DIR, TEMP_WRITE_ROOTS, TEMP_WRITE_ROOTS_CANONICAL } from "./temp-dir.js";
import { resolveRealPath } from "./resolve-path.js";

// ── Platform detection ───────────────────────────────────────────

/**
 * Check whether we can use OS-level sandboxing on the current platform.
 * Requires a successful launch, not just an installed sandbox executable.
 */
export function canUseOsSandbox(): boolean {
	const platform = process.platform;
	if (platform === "darwin") {
		return _hasSandboxExec();
	}
	if (platform === "linux") {
		return _hasBwrap();
	}

	return false;
}

let _bwrapResult: boolean | undefined;
let _sandboxExecResult: boolean | undefined;

function hasCommand(command: string): boolean {
	try {
		// Shell builtin — `command` is always available as a builtin, but not
		// guaranteed as an external binary on every Linux distribution.
		execSync(`command -v ${command}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function _hasBwrap(): boolean {
	if (_bwrapResult === undefined) {
		if (hasCommand("bwrap")) {
			// Quick functional test: can bwrap actually create a namespace?
			try {
				execSync("bwrap --ro-bind / / true 2>/dev/null", { stdio: "ignore", timeout: 2000 });
				_bwrapResult = true;
			} catch (e) {
				_bwrapResult = false;
			}
		} else {
			_bwrapResult = false;
		}
	}
	return _bwrapResult;
}

function _hasSandboxExec(): boolean {
	if (_sandboxExecResult === undefined) {
		if (hasCommand("sandbox-exec")) {
			// Quick functional test: can sandbox-exec actually enforce a profile?
			try {
				execSync("echo true | sandbox-exec -p '(version 1)(allow default)' /bin/bash 2>/dev/null",
					{ stdio: "ignore", timeout: 2000 });
				_sandboxExecResult = true;
			} catch (e) {
				_sandboxExecResult = false;
			}
		} else {
			_sandboxExecResult = false;
		}
	}
	return _sandboxExecResult;
}

// ── macOS: sandbox-exec ──────────────────────────────────────────

/** Reject paths that would break out of the profile string's quoting layers. */
function assertSafeProfilePaths(paths: Iterable<string>): void {
	// Single quotes (') break outer shell wrapper; double quotes (") break Seatbelt syntax.
	for (const p of paths) {
		if (p.includes("'") || p.includes('"')) {
			throw new Error(buildReadonlySandboxPathError(p));
		}
	}
}

/**
 * Build a Seatbelt sandbox profile string for readonly mode.
 *
 * Pattern: allow everything by default, but deny all file writes except
 * to shared temp roots (including canonical aliases) and /dev/null.
 *
 * Using (allow default) + write denies (permissive pattern) because
 * (deny default) + explicit read allows is fragile — system library
 * reads, dyld, and process execution are complex to enumerate and
 * vary across macOS versions. The permissive pattern keeps standard
 * tooling (node, npm, git, python, etc.) working while correctly
 * blocking ordinary file writes outside the shared temp-root policy.
 *
 * The tempDir parameter is the test seam for quote-injection rejection;
 * production callers pass TEMP_DIR, already a member of TEMP_WRITE_ROOTS.
 */
export function buildMacProfile(tempDir: string): string {
	const writePaths = new Set<string>([
		...TEMP_WRITE_ROOTS,
		resolveRealPath(tempDir),
		tempDir,
	]);
	assertSafeProfilePaths(writePaths);
	const allows = [...writePaths].map((p) => `(allow file-write* (subpath "${p}"))`).join("");
	return `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))${allows}`;
}

/**
 * Generate a unique heredoc delimiter for wrapping commands.
 * Using a random suffix avoids accidental collision with command content.
 */
function generateDelimiter(): string {
	const suffix = crypto.randomBytes(4).toString("hex");
	return `PI_SANDBOX_INNER_${suffix}`;
}

/** Quote a dynamic argument for the outer bash that launches the sandbox. */
export function quoteShellArgument(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Wrap a bash command with sandbox-exec on macOS.
 *
 * Pipes the original command through a heredoc into an inner bash running
 * under sandbox-exec. The inner bash captures combined stdout/stderr via
 * `output=$({ :; <command> } 2>&1)` (the leading `:` is a no-op so the
 * command always executes even when it evaluates to empty), then emits a
 * readonly-block notice on non-zero exit when the captured output matches a
 * denial pattern, and finally re-emits the captured output and exit code.
 * The heredoc preserves all original characters (multiline, quotes, pipes,
 * redirects) so the inner bash receives the exact original command.
 * All descendants inherit the sandbox restrictions.
 */
export function wrapWithSandboxExec(command: string): string {
	const profile = buildMacProfile(TEMP_DIR);
	return wrapSandboxCommand(`sandbox-exec -p '${profile}'`, command);
}

/** Both kernels use the same command transport and visible denial notice. */
function wrapSandboxCommand(launcher: string, command: string): string {
	const delim = generateDelimiter();
	return `${launcher} /bin/bash << '${delim}'
output=\$({
:
${command}
} 2>&1)
${sandboxResultReport()}
${delim}`;
}

/**
 * Substrings that identify a kernel sandbox denial. Shared with the os-sandbox test
 * oracle so the two cannot drift. EACCES ("Permission denied") is deliberately absent:
 * an ordinary command can fail that way for its own reasons, and matching it would
 * mislabel the failure as a sandbox block.
 */
export const SANDBOX_DENIAL_NEEDLES = [
	"Operation not permitted",
	"Read-only file system",
	"denying file-write",
] as const;

/**
 * Emit the readonly-block notice when a wrapped command fails with a sandbox denial text.
 *
 * EPERM ("Operation not permitted") is how Seatbelt reports a denied write; EROFS
 * ("Read-only file system") is how bwrap's read-only bind reports one. The raw output is
 * re-emitted on either path, so no signal is lost.
 * Pinned by tests/unit/os-sandbox.test.ts: the test asserts this list equals its own
 * literal and builds the denial oracle from that literal, so a removed needle fails.
 */
function sandboxResultReport(): string {
	const denialCases = SANDBOX_DENIAL_NEEDLES.map((needle) => `*"${needle}"*`).join("|");
	return `rc=\$?
if [ \$rc -ne 0 ]; then
  case "\$output" in
    ${denialCases})
      echo ""
      echo "${READONLY_SANDBOX_BLOCK_NOTICE}"
      echo ""
      ;;
  esac
fi
[ -n "\$output" ] && echo "\$output"
exit \$rc`;
}

// ── Linux: bubblewrap ────────────────────────────────────────────

/**
 * Wrap a bash command with bubblewrap on Linux.
 *
 * Uses the same heredoc approach as sandbox-exec for consistent behavior.
 *
 * --ro-bind / /  makes entire root read-only
 * --bind <root> <root> exposes each existing canonical shared temp root writable.
 * Aliases resolve to the same bind. Absent roots are not fabricated in the host;
 * roots under read-only ancestors stay unavailable instead of breaking startup.
 * --proc /proc, --dev /dev for proper /proc and /dev
 * --unshare-all --share-net for isolation while allowing network
 * --die-with-parent --new-session for clean termination
 *
 * WHY the host /tmp stays bound (no --tmpfs /tmp): os.tmpdir() normally lives
 * under /tmp, so privatizing it would hide the TEMP_WRITE_ROOTS the classifier
 * just approved and break legitimate scratch sharing. Decision in
 * docs/architecture.md (Shared /tmp TOCTOU); Seatbelt is unchanged.
 */
export function wrapWithBwrap(command: string, tempDir: string = TEMP_DIR): string {
	const flags = [
		"--ro-bind / /",
		...buildWritableBinds(tempDir),
		"--proc /proc",
		"--dev /dev",
		"--unshare-all",
		"--share-net",
		"--die-with-parent",
		"--new-session",
	];
	return wrapSandboxCommand(`bwrap ${flags.join(" ")}`, command);
}

/** Never bind an alias twice or ask bwrap to create a missing source directory.
 *
 * Throws when no root is a live directory (exotic TMPDIR under a read-only
 * ancestor). Callers fail closed; see TEMP_WRITE_ROOTS in temp-dir.ts. */
function buildWritableBinds(tempDir: string): string[] {
	// Use the frozen canonical roots (resolved once in temp-dir.ts) so the sandbox and the
	// classifier share one source of truth; re-resolving the shared roots per command let a
	// symlink retarget drift the two layers apart. Only the caller-supplied temp dir is
	// canonicalized here, and it is TEMP_DIR (already a member) in production.
	return buildWritableBindsFromRoots([...TEMP_WRITE_ROOTS_CANONICAL, resolveRealPath(tempDir)]);
}

/** Pure bind builder: dedupes, keeps live directories, throws on empty. Testable without mocks. */
export function buildWritableBindsFromRoots(roots: readonly string[]): string[] {
	// WHY no assertSafeProfilePaths: Linux paths escape every root via quoteShellArgument
	// (os-sandbox.ts); Seatbelt's raw profile interpolation is the only injection surface.
	const unique = [...new Set(roots)];
	// Skip non-directory roots (fail closed per-root): a file at a scratch path must not crash the wrap path.
	const dirs = unique.filter((root) => { try { return fs.statSync(root).isDirectory(); } catch { return false; } });
	if (dirs.length === 0) throw new Error("Sandbox has no writable temp root directory");
	return dirs.map((root) => {
		const quoted = quoteShellArgument(root);
		return `--bind ${quoted} ${quoted}`;
	});
}

// ── Unified dispatch ─────────────────────────────────────────────

/**
 * Wrap a bash command string to run inside an OS-level filesystem sandbox.
 *
 * On macOS: wraps with sandbox-exec (native, no deps).
 * On Linux: wraps with bubblewrap if available.
 * On other platforms / when unavailable: returns command unchanged.
 *
 * The returned command must be passed to /bin/bash -c (or equivalent) for
 * execution — the shell tool handles this automatically.
 */
export function wrapCommandWithOsSandbox(command: string): string {
	const platform = process.platform;
	if (platform === "darwin") {
		return wrapWithSandboxExec(command);
	}
	if (platform === "linux" && _hasBwrap()) {
		return wrapWithBwrap(command);
	}
	// No OS sandbox available — command unchanged, classifyBashCommand
	// fallback will handle it at the call site.
	return command;
}
