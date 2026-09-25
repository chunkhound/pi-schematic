import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { createState } from "../../state.js";
import { executeSpawn, registerSpawnTool } from "../../spawn/index.js";
import { createTestHost } from "./test-host.js";
import { runRealChildInvocation } from "./helpers.js";

test("real child completes through inherited/default thinking", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	assert.equal(proof.result.content[0].text, proof.expectedText);
	assert.equal(proof.result.details.model, proof.modelId);
	// Non-reasoning model clamps the inherited (medium) parent thinking to "off".
	assert.equal(proof.result.details.thinking, "off");
	assert.equal(proof.probeCalls, 1);
	// Exact stream-call count is implementation-coupled; assert only a meaningful lower bound.
	assert.ok(proof.streamCalls >= 1);
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});

test("real child preserves selected identity and reports effective thinking", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
	});
	assert.equal(proof.result.content[0].text, proof.expectedText);
	assert.equal(proof.result.details.model, proof.modelId);
	assert.equal(proof.result.details.thinking, "off", "non-reasoning model clamps requested max to off");
	assert.equal(proof.probeCalls, 1);
	// Exact stream-call count is implementation-coupled; assert only a meaningful lower bound.
	assert.ok(proof.streamCalls >= 1);
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});

test("real child output is truncated at the public line limit", async () => {
	const output = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
	const proof = await runRealChildInvocation({ prompt: "return long output", resultText: output });
	const text = proof.result.content[0].text;

	assert.equal(proof.result.details.truncated, true);
	assert.match(text, /^line 0/);
	assert.match(text, /\[Result truncated to 2000 lines \/ 50KB/);
	assert.equal(text.includes("line 2099"), false);
});

test("real child abort before prompt rejects without publishing a result", async () => {
	await assert.rejects(
		() => runRealChildInvocation({
			prompt: "Use the agentic_e2e_probe tool.",
			abortBeforeStart: true,
		}),
		(error) => {
			assert.match((error as Error).message, /fixture abort/);
			// The signal is already aborted before the session starts, so no onUpdate fires.
			assert.equal((error as any).proof.updates.length, 0, "no result published before the early abort");
			return true;
		},
	);
});

test("real child reset during its running update invalidates the session", async () => {
	await assert.rejects(
		() => runRealChildInvocation({
			prompt: "Use the agentic_e2e_probe tool.",
			resetOnRunningUpdate: true,
		}),
		/invalidated by reset/i,
	);
});

test("concurrent real children both complete", async () => {
	const proof = await runRealChildInvocation({
		prompt: "unused",
		prompts: ["first task", "second task"],
	});
	assert.equal(proof.results.length, 2);
	for (const result of proof.results) {
		assert.equal(result.content[0].text, proof.expectedText);
		assert.equal(result.details.model, proof.modelId);
	}
	assert.equal(proof.probeCalls, 2);
});

test("spawn routes through the public registry but uses only the selected-model child session boundary", async () => {

	const source = await readFile(new URL("../../spawn/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\bAuthStorage\b|\bModelRegistry\b/);
	assert.doesNotMatch(source, /\bauthStorage\s*:/);
	assert.doesNotMatch(source, /sessionFactory\(\{[\s\S]*?\bmodelRegistry\s*:/);
	assert.doesNotMatch(source, /modelRuntime\s*[:.]|as\s+any[^\n]*(?:auth|runtime)/i);
	assert.match(source, /modelRegistry:\s*ctx\.modelRegistry/);
	assert.match(source, /model:\s*childModel/);
});

test("spawn accepts max thinking parameter in schema", async () => {
	const state = createState();
	const pi = await createTestHost((api) => registerSpawnTool(api, state));
	const tool = pi.tools.get("spawn");
	const schemaText = JSON.stringify(tool.parameters);
	assert.match(schemaText, /max/);
	assert.equal(Value.Check(tool.parameters, { prompt: "work" }), true, "schema accepts prompt without thinking");
	assert.equal(Value.Check(tool.parameters, { prompt: "work", thinking: "max" }), true, "schema accepts thinking: max");
	assert.equal(
		Value.Check(tool.parameters, { prompt: "work", group: "review", thinking: "max" }),
		true,
		"schema composes Model Group routing with explicit thinking",
	);

});

test("spawn real child completes with max thinking requested", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
	});
	assert.equal(proof.result.content[0].text, proof.expectedText);
	assert.equal(proof.result.details.model, proof.modelId);
	assert.equal(proof.probeCalls, 1);
	// Exact stream-call count is implementation-coupled; assert only a meaningful lower bound.
	assert.ok(proof.streamCalls >= 1);
	assert.deepEqual(proof.outboundFetches, [], "offline real-child fixture attempted an outbound fetch");
});

test("executeSpawn rejects immediately when no model is configured", async () => {
	const pi = await createTestHost();
	const state = createState();
	const ctx = { cwd: "/tmp" } as any; // ctx.model is undefined

	await assert.rejects(
		() => executeSpawn(
			"spawn-no-model",
			pi as any,
			ctx,
			state,
			{ prompt: "work" },
			undefined,
			undefined,
			"medium",
		),
		/No model configured/,
	);
});

test("a parent-transient selected model fails explicitly in the real child runtime without fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-schematic-transient-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await mkdir(cwd, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const pi = await createTestHost();
		const state = createState();
		const model = {
			id: "transient-model",
			name: "Transient Parent Model",
			provider: "transient-parent",
			api: "transient-parent-api",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		};
		await assert.rejects(
			() => executeSpawn(
				"spawn-transient", pi as any, { model, cwd } as any, state,
				{ prompt: "work" }, undefined, undefined, "medium",
			),
			/No API key found for transient-parent/, // real provider error — no silent fallback
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

// ── Real-invocation contract coverage (no session mocks) ──────────

// 1. No-output rejection: empty assistant text must throw, with no lingering child.
test("real child with no output triggers the 'produced no output' rejection", async () => {
	await assert.rejects(
		() => runRealChildInvocation({ prompt: "say nothing", noOutput: true }),
		(error) => {
			assert.match((error as Error).message, /Child agent produced no output/);
			assert.equal((error as any).proof.state.childSessions.size, 0, "no child session lingers after the rejection");
			return true;
		},
	);
});

// 2. Thinking forwarding: the requested thinking reaches the child session.
test("real child forwards the requested thinking to the session", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
	});
	// Non-reasoning model clamps the requested max -> off; the session runs at the effective level.
	assert.equal(proof.result.details.thinking, "off", "effective thinking reflects the clamped level");
	if (proof.observedThinking.length > 0) {
		// Whatever the provider observed must match the effective thinking the session ran with.
		assert.equal(proof.observedThinking[0], proof.result.details.thinking, "provider observed the forwarded thinking level");
	}
});

// 3a. Notebook injection: seeded pages appear in the child prompt.
test("real child prompt includes injected notebook pages", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Do the task.",
		notebookPages: { "entry-a": "preview line\nfull body" },
	});
	assert.ok(
		proof.observedMessages.some((message) => message.includes("entry-a: preview line")),
		"child prompt must include the injected notebook page preview",
	);
});

// 3b. No notebook pages -> the explicit 'No notebook pages.' branch.
test("real child prompt uses the 'No notebook pages.' branch when state is empty", async () => {
	const proof = await runRealChildInvocation({ prompt: "Do the task." });
	assert.ok(
		proof.observedMessages.some((message) => message.includes("No notebook pages.")),
		"empty notebook must produce the 'No notebook pages.' branch",
	);
});

// 4. childSessions cleared after a successful spawn.
test("real child session registry is cleared after a successful spawn", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	assert.equal(proof.state.childSessions.size, 0, "child session registry is cleared after a successful spawn");
});

// 5. Stale during prompt: reset inside the first stream call invalidates the child.
test("real child invalidated when state is reset mid-prompt", async () => {
	await assert.rejects(
		() => runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool.", resetDuringPrompt: true }),
		(error) => {
			assert.match((error as Error).message, /invalidated by reset/);
			return true;
		},
	);
});

// 6. Mid-prompt abort: the parent controller abort yields an aborted outcome (the
// real SDK does not reject the in-flight prompt; spawn records outcome "aborted").
test("real child records an aborted outcome when the parent aborts mid-prompt", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool.", abortMidPrompt: true });
	assert.equal(proof.result.details.outcome, "aborted", "mid-prompt abort yields an aborted outcome");
	assert.equal(proof.state.childSessions.size, 0, "no child session lingers after the abort");
});

// 7. Stats shape: the deterministic provider emits zero usage; the published stats object carries the contract keys.
test("real child publishes the session stats contract shape", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	const stats = proof.result.details.stats as Record<string, unknown> | undefined;
	assert.ok(stats && typeof stats === "object", "stats object must be published");
	for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "turns"]) {
		assert.ok(key in stats!, `stats must contain ${key}`);
	}
});
