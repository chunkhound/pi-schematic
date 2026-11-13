/**
 * pty-harness.ts — Process-isolated child-process harness for E2E tests.
 *
 * Spawns a fresh Node.js process and communicates over stdin/stdout. Process
 * isolation keeps runtime singletons and console output private per test case
 * without depending on PTY availability in CI.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const LOADER = pathToFileURL(resolve(ROOT, "register-loader.mjs")).href;

export const DEFAULT_SCRIPT = resolve(HERE, "test-host.ts");
const DEFAULT_TIMEOUT_MS = 5000;
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;

export class ProcessHarness {
	private readonly child: ChildProcessWithoutNullStreams;
	private output = "";
	private readOffset = 0;
	private readonly timeoutMs: number;
	private readonly waiters = new Set<() => void>();

	constructor(
		scriptPath = DEFAULT_SCRIPT,
		options?: { timeoutMs?: number },
	) {
		this.timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;

		const entry = isAbsolute(scriptPath) ? scriptPath : resolve(ROOT, scriptPath);

		this.child = spawn(process.execPath, ["--import", LOADER, entry], {
			cwd: ROOT,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				FORCE_COLOR: "0",
				NODE_OPTIONS: "",
			},
		});

		// EPIPE is expected when the child exits — the Node.js project
		// considers this by-design OS behavior, not a bug. Without a
		// listener the error crashes the process (delivered async via
		// IOCP on Windows, potentially after the test promise settles).
		this.child.stdin.on("error", () => {});

		const append = (chunk: string | Buffer) => {
			this.output += chunk.toString();
			for (const wake of this.waiters) {wake();}
			this.waiters.clear();
		};

		this.child.stdout.on("data", append);
		this.child.stderr.on("data", append);
	}

	private async waitForOutput(ms: number): Promise<void> {
		if (ms <= 0) {return;}
		await new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				this.waiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			this.waiters.add(wake);
		});
	}

	/** Wait for a fresh substring to appear after the prior match. */
	async waitForText(text: string): Promise<void> {
		const deadline = Date.now() + this.timeoutMs;
		while (Date.now() < deadline) {
			const index = this.output.indexOf(text, this.readOffset);
			if (index !== -1) {
				this.readOffset = index + text.length;
				return;
			}
			await this.waitForOutput(deadline - Date.now());
		}
		throw new Error(
			`waitForText timeout after ${this.timeoutMs}ms looking for fresh "${text}".\n` +
				`Output so far:\n${this.output}`,
		);
	}

	/** Write a line of input to the child process. */
	write(input: string): void {
		this.child.stdin.write(input + "\n");
	}

	/** Return all accumulated output since creation or last clear(). */
	snapshot(): string {
		return this.output;
	}

	/** Clear accumulated output and match cursor, keeping the child running. */
	clear(): void {
		this.output = "";
		this.readOffset = 0;
	}

	/** Kill the child process. */
	close(): void {
		this.child.stdin.end();
		if (!this.child.killed) {this.child.kill();}
	}
}
