import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { classifyBashCommand } from "../../readonly-bash.js";
import { shellPath } from "./helpers.js";

// Concurrency smoke: the classifier holds per-call state only (cwd/stack/vars
// travel in ShellState, no shared mutable cache). Parallel batches over a mixed
// corpus must match sequential baselines exactly — verdict and reason.
const workspace = path.join(os.tmpdir(), "readonly-concurrency-probe");
const outside = path.join(os.homedir(), "readonly-concurrency-outside");
const corpus: Array<{ command: string; cwd: string }> = [
	{ command: "echo hi", cwd: workspace },
	{ command: "touch /etc/x", cwd: workspace },
	{ command: `touch ${shellPath(path.join(workspace, "f"))}`, cwd: workspace },
	{ command: "cd /etc && touch f", cwd: workspace },
	{ command: `cd ${shellPath(workspace)} && touch f`, cwd: workspace },
	{ command: "D=$(mktemp -d) && touch f", cwd: workspace },
	{ command: "echo $(touch /etc/x)", cwd: workspace },
	{ command: "cat <<EOF > /etc/x\nhi\nEOF", cwd: workspace },
	{ command: "cat <<EOF\nhi\nEOF", cwd: workspace },
	{ command: "git log --oneline", cwd: workspace },
	{ command: "git add -Z file", cwd: workspace },
	{ command: "touch /etc/x; echo hi", cwd: outside },
	{ command: `touch ${shellPath(path.join(os.tmpdir(), "g"))}`, cwd: outside },
	{ command: "false || touch /etc/x", cwd: workspace },
	{ command: "{ cd /etc; false; } || touch leak", cwd: workspace },
	{ command: "touch 'C:\\Temp\\x'", cwd: workspace },
	{ command: "touch '\\\\?\\C:\\x'", cwd: workspace },
	{ command: "echo '$(touch /etc/x)'", cwd: workspace },
	{ command: "cd -P /tmp && touch f", cwd: workspace },
	{ command: "V=/etc; touch $V/x", cwd: workspace },
];

function fingerprint(command: string, cwd: string): string {
	const verdict = classifyBashCommand(command, cwd);
	return verdict.ok ? "allow" : `block:${verdict.reason}`;
}

test("parallel classifications match sequential baselines", async () => {
	const baseline = corpus.map(({ command, cwd }) => fingerprint(command, cwd));
	const lanes = 8;
	const batches = Array.from({ length: lanes }, async (_, lane) => {
		await Promise.resolve(); // Yield so lanes interleave before classifying.
		return corpus.map(({ command, cwd }) => fingerprint(command, cwd));
	});
	const results = await Promise.all(batches);
	for (const [lane, fingerprints] of results.entries()) {
		assert.deepEqual(fingerprints, baseline, `lane ${lane} diverged from baseline`);
	}
});

test("repeated identical calls stay deterministic", () => {
	for (const { command, cwd } of corpus) {
		assert.equal(fingerprint(command, cwd), fingerprint(command, cwd), command);
	}
});
