// One classification per child process. WHY: the parent test must enforce probe timeouts with
// an outer watchdog, and `execFileSync` blocks the event loop, so only a separate process can
// be killed when a probe never returns.
import { classifyBashCommand } from "../../readonly-bash.js";

const [command, cwd] = process.argv.slice(2);
try {
	const started = Date.now();
	const verdict = classifyBashCommand(command, cwd);
	// Report the classification's own duration: parent wall time includes this child's startup,
	// which is noise for the probe-stall assertion.
	process.stdout.write(`${JSON.stringify({ verdict, elapsedMs: Date.now() - started })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
}
