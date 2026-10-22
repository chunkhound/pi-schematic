/**
 * Environment restore semantics of the temp-directory helpers.
 *
 * pi reads PI_CODING_AGENT_DIR before HOME when it resolves its agent
 * directory, so each helper must leave the variable as it found it: the prior
 * value when one was set, and absent (not the string "undefined") when it was
 * unset.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setTempHome, withTempAgentDir, withTempHome } from "./helpers.js";

const KEY = "PI_CODING_AGENT_DIR";

async function withPriorAgentDir(prior: string | undefined, body: () => Promise<void>): Promise<void> {
	const ambient = process.env[KEY];
	if (prior === undefined) delete process.env[KEY];
	else process.env[KEY] = prior;
	try {
		await body();
	} finally {
		if (ambient === undefined) delete process.env[KEY];
		else process.env[KEY] = ambient;
	}
}

function assertAgentDirRestored(prior: string | undefined): void {
	if (prior === undefined) assert.equal(KEY in process.env, false);
	else assert.equal(process.env[KEY], prior);
}

const priors = [
	{ label: "a previously set", prior: "/prior/agent-dir" },
	{ label: "a previously unset", prior: undefined },
];

for (const { label, prior } of priors) {
	test(`withTempAgentDir points PI_CODING_AGENT_DIR at its temp dir and restores ${label} value`, async () => {
		await withPriorAgentDir(prior, async () => {
			let seen: string | undefined;
			let created: string | undefined;
			await withTempAgentDir(async (agentDir) => {
				seen = process.env[KEY];
				created = agentDir;
			});
			assert.equal(seen, created);
			assertAgentDirRestored(prior);
		});
	});

	test(`withTempAgentDir restores ${label} PI_CODING_AGENT_DIR when the run throws`, async () => {
		await withPriorAgentDir(prior, async () => {
			await assert.rejects(withTempAgentDir(async () => { throw new Error("run failed"); }), /run failed/);
			assertAgentDirRestored(prior);
		});
	});

	test(`withTempHome clears PI_CODING_AGENT_DIR during the run and restores ${label} value`, async () => {
		await withPriorAgentDir(prior, async () => {
			let presentDuringRun: boolean | undefined;
			await withTempHome(async () => {
				presentDuringRun = KEY in process.env;
			});
			assert.equal(presentDuringRun, false);
			assertAgentDirRestored(prior);
		});
	});

	test(`withTempHome restores ${label} PI_CODING_AGENT_DIR when the run throws`, async () => {
		await withPriorAgentDir(prior, async () => {
			await assert.rejects(withTempHome(async () => { throw new Error("run failed"); }), /run failed/);
			assertAgentDirRestored(prior);
		});
	});

	test(`setTempHome clears PI_CODING_AGENT_DIR until its restore function restores ${label} value`, async () => {
		await withPriorAgentDir(prior, async () => {
			const restoreHome = setTempHome("/temp/home");
			const presentWhileSet = KEY in process.env;
			restoreHome();
			assert.equal(presentWhileSet, false);
			assertAgentDirRestored(prior);
		});
	});
}
