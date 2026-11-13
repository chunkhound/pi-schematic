import { expect, onTestFinished, test, vi } from "vitest";
import { assertPresent, expectPrefix } from "../assertions.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, type SessionStats } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { createState } from "../../state.js";
import { THINKING_LEVELS } from "../../thinking-levels.js";
import { executeSpawn, registerSpawnTool } from "../../spawn/index.js";
import { createTestHost, getTool } from "./test-host.js";
import { isRecord, assertErrorResult, createExtensionContext, EMPTY_CHILD_USAGE, recordOf, runRealChildInvocation } from "./helpers.js";
import { REPO_ROOT_URL } from "../paths.js";

// The fields isSpawnToolResult checks; everything else stays unknown.
interface CheckedSpawnResult {
	content: { type: "text"; text: string }[];
	details: { model: string; thinking: string; truncated: boolean; outcome: string; stats?: unknown };
	usage: Record<string, unknown>;
	isError?: unknown;
}

function isSpawnToolResult(value: unknown): value is CheckedSpawnResult {
	if (!isRecord(value) || !Array.isArray(value.content) || !isRecord(value.details) || !isRecord(value.usage)) {return false;}
	const { details } = value;
	return value.content.every((block: unknown) => isRecord(block) && block.type === "text" && typeof block.text === "string")
		&& typeof details.model === "string"
		&& typeof details.thinking === "string"
		&& typeof details.truncated === "boolean"
		&& typeof details.outcome === "string";
}

// The real-child fixture reports the spawn tool's result untyped; this checks its shape.
function spawnResult(value: unknown): CheckedSpawnResult {
	if (!isSpawnToolResult(value)) {throw new Error(`Expected a spawn tool result with text content, details and usage, got ${JSON.stringify(value)}.`);}
	return value;
}

test("real child completes through inherited/default thinking", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	const result = spawnResult(proof.result);
	expect(result.content[0].text).toBe(proof.expectedText);
	expect(result.details.model).toBe(proof.modelId);
	// Non-reasoning model clamps the inherited (medium) parent thinking to "off".
	expect(result.details.thinking).toBe("off");
	expect(proof.probeCalls).toBe(1);
	// Exact stream-call count is implementation-coupled; assert only a meaningful lower bound.
	expect(proof.streamCalls).toBeGreaterThanOrEqual(1);
	expect(proof.outboundFetches, "offline real-child fixture attempted an outbound fetch").toStrictEqual([]);
});

test("real child preserves selected identity and reports effective thinking", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
	});
	const result = spawnResult(proof.result);
	expect(result.content[0].text).toBe(proof.expectedText);
	expect(result.details.model).toBe(proof.modelId);
	expect(result.details.thinking, "non-reasoning model clamps requested max to off").toBe("off");
	expect(proof.probeCalls).toBe(1);
	// Exact stream-call count is implementation-coupled; assert only a meaningful lower bound.
	expect(proof.streamCalls).toBeGreaterThanOrEqual(1);
	expect(proof.outboundFetches, "offline real-child fixture attempted an outbound fetch").toStrictEqual([]);
});

test("real child output is truncated at the public line limit", async () => {
	const output = Array.from({ length: 2_100 }, (_, index) => `line ${String(index)}`).join("\n");
	const proof = await runRealChildInvocation({ prompt: "return long output", resultText: output });
	const result = spawnResult(proof.result);
	const text = result.content[0].text;

	expect(result.details.truncated).toBe(true);
	expectPrefix(text, "line 0");
	// Pins Pi's public limits on purpose, so a change to them in Pi fails here.
	expect(text).toMatch(/\[Result truncated to 2000 lines \/ 50 KiB \(51200 bytes\)\. Spawn a new child with a narrower request if more is needed\.\]/);
	expect(text).not.toContain("line 2099");
});

test("real child abort before prompt returns an aborted result without a running update", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool.",
		abortBeforeStart: true,
	});
	const result = spawnResult(proof.result);

	expect(result.isError).toBe(true);
	expect(result.content).toStrictEqual([{ type: "text", text: "Child agent aborted: fixture abort" }]);
	expect(result.details.outcome).toBe("aborted");
	expect(result.usage).toStrictEqual(EMPTY_CHILD_USAGE);
	expect(proof.updates).toHaveLength(0);
});

test("real child reset during its running update invalidates the session", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool.",
		resetOnRunningUpdate: true,
	});
	assertErrorResult(proof.result, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
});

test("concurrent real children both complete", async () => {
	const proof = await runRealChildInvocation({
		prompt: "unused",
		prompts: ["first task", "second task"],
	});
	const results: unknown[] = proof.results;
	expect(results).toHaveLength(2);
	for (const value of results) {
		const result = spawnResult(value);
		expect(result.content[0].text).toBe(proof.expectedText);
		expect(result.details.model).toBe(proof.modelId);
	}
	expect(proof.probeCalls).toBe(2);
});

test("spawn routes through the public registry and keeps source boundaries exact", async () => {
	const source = await readFile(new URL("spawn/index.ts", REPO_ROOT_URL), "utf8");
	expect(source).not.toMatch(/\bAuthStorage\b|\bModelRegistry\b/);
	expect(source).not.toMatch(/\bauthStorage\s*:/);
	expect(source).not.toMatch(/sessionFactory\(\{[\s\S]*?\bmodelRegistry\s*:/);
	expect(source).not.toMatch(/modelRuntime\s*[:.]|as\s+any[^\n]*(?:auth|runtime)/i);
	expect(source).toMatch(/modelRegistry:\s*ctx\.modelRegistry/);
	expect(source).toMatch(/model:\s*childModel/);
	expect(source).toMatch(/session\.dispose\(\)/);
	const renderer = await readFile(new URL("spawn/renderer.ts", REPO_ROOT_URL), "utf8");
	expect(renderer).not.toMatch(/console\.(?:debug|warn|error|log)\s*\(/);
	expect(renderer).not.toMatch(/process\.(?:stdout|stderr)\.write\s*\(/);
});

test("spawn schema advertises the thinking levels as a plain string enum and rejects other values", async () => {
	const state = createState();
	const pi = await createTestHost((api) => { registerSpawnTool(api, state); });
	const tool = getTool(pi, "spawn");
	const schema = recordOf(JSON.parse(JSON.stringify(tool.parameters)), "the spawn schema");
	const thinkingSchema = recordOf(recordOf(schema.properties, "the spawn schema properties").thinking, "the thinking schema");
	expect(thinkingSchema.type).toBe("string");
	expect(thinkingSchema.enum).toStrictEqual([...THINKING_LEVELS]);
	expect(JSON.stringify(thinkingSchema)).not.toMatch(/"(?:anyOf|const)"\s*:/);
	expect(Value.Check(tool.parameters, { prompt: "work" }), "schema accepts prompt without thinking").toBe(true);
	expect(Value.Check(tool.parameters, { prompt: "work", thinking: "ultra" }), "schema rejects unknown thinking levels").toBe(false);
	expect(Value.Check(tool.parameters, { prompt: "work", group: "review", thinking: "max" }), "schema composes Model Group routing with explicit thinking").toBe(true);
});

test.for([...THINKING_LEVELS])("spawn schema accepts thinking: %s", async (thinking) => {
	const pi = await createTestHost((api) => { registerSpawnTool(api, createState()); });
	expect(Value.Check(getTool(pi, "spawn").parameters, { prompt: "work", thinking })).toBe(true);
});

test("spawn real child completes with max thinking requested", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
	});
	const result = spawnResult(proof.result);
	expect(result.content[0].text).toBe(proof.expectedText);
	expect(result.details.model).toBe(proof.modelId);
	expect(proof.probeCalls).toBe(1);
	// Exact stream-call count is implementation-coupled; assert only a meaningful lower bound.
	expect(proof.streamCalls).toBeGreaterThanOrEqual(1);
	expect(proof.outboundFetches, "offline real-child fixture attempted an outbound fetch").toStrictEqual([]);
});

test("executeSpawn rejects immediately when no model is configured", async () => {
	const pi = await createTestHost();
	const state = createState();
	const ctx = createExtensionContext({ cwd: "/tmp" }); // ctx.model is undefined

	await expect(
		executeSpawn(
			"spawn-no-model",
			pi,
			ctx,
			state,
			{ prompt: "work" },
			undefined,
			undefined,
			"medium",
		),
	).rejects.toThrow(/No model configured/);
});

test("a parent-transient selected model fails explicitly in the real child runtime without fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-schematic-transient-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	const pi = await createTestHost();
	const state = createState();
	const model: Model<Api> = {
		id: "transient-model",
		name: "Transient Parent Model",
		provider: "transient-parent",
		api: "transient-parent-api",
		baseUrl: "http://localhost.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
	const result = await executeSpawn(
		"spawn-transient", pi, createExtensionContext({ model, cwd }), state,
		{ prompt: "work" }, undefined, undefined, "medium",
	);

	expect(result.isError).toBe(true);
	expect(result.content[0].text).toMatch(/No API key found for transient-parent/);
});

// ── Real-invocation contract coverage (no session mocks) ──────────

// 1. No output: empty assistant text returns an error result, with no lingering child.
test("real child with no output returns the 'produced no output' error result", async () => {
	const proof = await runRealChildInvocation({ prompt: "say nothing", noOutput: true });
	assertErrorResult(proof.result, "Child agent produced no output.", EMPTY_CHILD_USAGE);
	expect(proof.state.childSessions.size, "no child session lingers after the error").toBe(0);
});

// 2. Thinking forwarding: the requested thinking reaches the child session.
test("real child forwards the requested thinking to the session", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK.",
		thinking: "max",
		reasoning: true,
	});
	const result = spawnResult(proof.result);
	// A reasoning model that maps neither xhigh nor max clamps the requested max to high.
	expect(result.details.thinking, "effective thinking reflects the clamped level").toBe("high");
	// Every stream call carries the effective level. The call count stays a lower bound, as above.
	expect(proof.streamCalls).toBeGreaterThanOrEqual(1);
	expect(proof.observedThinking, "provider observed the forwarded thinking level on every stream call")
		.toStrictEqual(Array.from({ length: proof.streamCalls }, () => "high"));
});

// 3a. Notebook injection: seeded pages appear in the child prompt.
test("real child prompt includes injected notebook pages", async () => {
	const proof = await runRealChildInvocation({
		prompt: "Do the task.",
		notebookPages: { "entry-a": "preview line\nfull body" },
	});
	expect(proof.observedMessages, "child prompt must include the injected notebook page preview").toContainEqual(expect.stringContaining("entry-a: preview line"));
});

// 3b. No notebook pages -> the explicit 'No notebook pages.' branch.
test("real child prompt uses the 'No notebook pages.' branch when state is empty", async () => {
	const proof = await runRealChildInvocation({ prompt: "Do the task." });
	expect(proof.observedMessages, "empty notebook must produce the 'No notebook pages.' branch").toContainEqual(expect.stringContaining("No notebook pages."));
});

// 4. childSessions cleared after a successful spawn.
test("real child session registry is cleared after a successful spawn", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	expect(proof.state.childSessions.size, "child session registry is cleared after a successful spawn").toBe(0);
});

// 5. Stale during prompt: reset inside the first stream call invalidates the child.
test("real child invalidated when state is reset mid-prompt", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool.", resetDuringPrompt: true });
	assertErrorResult(proof.result, "Spawn invalidated by reset.", EMPTY_CHILD_USAGE);
});

// 6. Mid-prompt abort: the parent controller abort yields an aborted outcome (the
// real SDK does not reject the in-flight prompt; spawn records outcome "aborted").
test("real child records an aborted outcome when the parent aborts mid-prompt", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool.", abortMidPrompt: true });
	const result = spawnResult(proof.result);
	expect(result.details.outcome, "mid-prompt abort yields an aborted outcome").toBe("aborted");
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toBe("Child agent aborted: mid-prompt abort");
	expect(proof.state.childSessions.size, "no child session lingers after the abort").toBe(0);
});

// 7. Stats shape: the deterministic provider emits zero usage; the published stats object carries the contract keys.
test("real child publishes the session stats contract shape", async () => {
	const proof = await runRealChildInvocation({ prompt: "Use the agentic_e2e_probe tool and return AGENTIC_E2E_PROBE_OK." });
	const result = spawnResult(proof.result);
	const stats = result.details.stats;
	assertPresent(stats, "stats object must be published");
	expect(stats, "stats object must be published").toBeTypeOf("object");
	for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "turns"]) {
		expect(stats, `stats must contain ${key}`).toHaveProperty(key);
	}
});

// 8. Usage parity: the usage spawn returns matches Pi's own session stats on a real child session.
test("real child usage matches the session stats across assistant, tool result, usage, compaction and branch-summary entries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-schematic-usage-parity-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const faux = fauxProvider();
	const usageOf = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
		input, output, cacheRead, cacheWrite, totalTokens: total,
		cost: { input: total / 1024, output: 0, cacheRead: 0, cacheWrite: 0, total: total / 1024 },
	});
	faux.setResponses([fauxAssistantMessage("child done")]);
	// The faux provider replaces a scripted usage with its own estimate, so read the assistant usage it recorded.
	let assistant!: Usage;
	let piStats!: SessionStats;
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir: root, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await resourceLoader.reload();
	const model = faux.getModel();
	const pi = await createTestHost();
	const state = createState();
	const result = await executeSpawn(
		"spawn-usage-parity", pi, createExtensionContext({ model, cwd: root }), state,
		{ prompt: "work" }, undefined, undefined, "medium",
		async (config) => {
			const created = await createAgentSession({ ...config, agentDir: root, modelRuntime, resourceLoader });
			const { session } = created;
			const runPrompt = session.prompt.bind(session);
			// Entries beyond assistant messages that Pi's stats also count, written through the real session manager.
			session.prompt = async (...args: Parameters<typeof runPrompt>) => {
				await runPrompt(...args);
				const lastAssistant = session.messages.filter((message) => message.role === "assistant").at(-1);
				assertPresent(lastAssistant, "the prompt produced an assistant message");
				assistant = lastAssistant.usage;
				const manager = session.sessionManager;
				manager.appendMessage({
					role: "toolResult", toolCallId: "parity-tool", toolName: "parity_probe", content: [{ type: "text", text: "ok" }],
					usage: usageOf(11, 2, 0, 0, 13), isError: false, timestamp: Date.now(),
				});
				manager.appendUsage("title", model.provider, model.id, usageOf(30, 3, 1, 0, 34));
				manager.appendCompaction("summary", null, 500, undefined, false, usageOf(200, 20, 0, 4, 224));
				manager.branchWithSummary(null, "branch", undefined, false, usageOf(7, 1, 0, 0, 8));
				piStats = session.getSessionStats();
			};
			return created;
		},
	);

	const stats = result.details.stats;
	expect(result.isError).toBeUndefined();
	// Hand-computed extras on top of the assistant usage: tool result 11/2/0/0 + usage entry 30/3/1/0 + compaction 200/20/0/4 + branch summary 7/1/0/0 = 248/26/1/4, cost 279/1024.
	// The faux provider always reports zero cost for an assistant message, so cost.total covers the extras' cost only.
	expect(result.usage).toMatchObject({
		input: assistant.input + 248,
		output: assistant.output + 26,
		cacheRead: assistant.cacheRead + 1,
		cacheWrite: assistant.cacheWrite + 4,
		totalTokens: assistant.totalTokens + 279,
		cost: { total: 0.2724609375 },
	});
	expect(stats).toStrictEqual({
		inputTokens: piStats.tokens.input,
		outputTokens: piStats.tokens.output,
		cacheReadTokens: piStats.tokens.cacheRead,
		cacheWriteTokens: piStats.tokens.cacheWrite,
		totalTokens: piStats.tokens.total,
		cost: piStats.cost,
		turns: piStats.assistantMessages,
	});
	expect(result.usage).toMatchObject({
		input: piStats.tokens.input,
		output: piStats.tokens.output,
		cacheRead: piStats.tokens.cacheRead,
		cacheWrite: piStats.tokens.cacheWrite,
		cost: { total: piStats.cost },
	});
	// Provider-reported usage.totalTokens need not match Pi's four-field stats total.
});
