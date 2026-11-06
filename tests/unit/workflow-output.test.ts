import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolCall } from "@earendil-works/pi-ai";
import { armStructuredOutput, OUTPUT_NUDGE, STRUCTURED_OUTPUT_TOOL } from "../../workflow/output.js";
import type { StructuredOutputRequest } from "../../workflow/types.js";

interface FakePi {
	pi: ExtensionAPI;
	tools: Map<string, Record<string, any>>;
	active: string[];
	activeSets: string[][];
}

function fakePi(seed: string[] = ["bash"]): FakePi {
	const tools = new Map<string, Record<string, any>>();
	const env: FakePi = {
		tools,
		active: [...seed],
		activeSets: [],
		pi: {} as ExtensionAPI,
	};
	env.pi = {
		getActiveTools: () => [...env.active],
		registerTool: (tool: Record<string, any>) => {
			tools.set(tool.name as string, tool);
		},
		setActiveTools: (names: string[]) => {
			env.active = [...names];
			env.activeSets.push([...names]);
		},
	} as unknown as ExtensionAPI;
	return env;
}

/** Arm a run and return the registered tool definition plus the handle. */
function armedTool(env: FakePi, request: StructuredOutputRequest = {}) {
	const armed = armStructuredOutput(env.pi, request);
	const tool = env.tools.get(STRUCTURED_OUTPUT_TOOL);
	assert.ok(tool);
	return { armed, tool };
}

test("armStructuredOutput registers the run schema, activates the tool, and the handle reads the capture", () => {
	const env = fakePi(["bash", "read"]);
	const schema = { type: "object", required: ["test"] };

	const { armed, tool } = armedTool(env, { schema });

	assert.deepEqual(env.active, ["bash", "read", STRUCTURED_OUTPUT_TOOL]);
	assert.equal(armed.value(), undefined);
	assert.deepEqual(tool.parameters, schema);
	assert.equal(tool.exposure, "model-only");
	assert.equal(tool.defaultActive, false);
	assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
});

test("arming replaces a stale tool entry instead of duplicating it in the active set", () => {
	const env = fakePi([STRUCTURED_OUTPUT_TOOL, "bash"]);
	armStructuredOutput(env.pi, {});
	assert.deepEqual(env.active, ["bash", STRUCTURED_OUTPUT_TOOL]);
});

test("release restores the previous active set exactly", () => {
	const env = fakePi();
	const armed = armStructuredOutput(env.pi, {});
	armed.release();
	assert.deepEqual(env.active, ["bash"]);
});

test("the output tool captures the submitted object and terminates the batch", async () => {
	const env = fakePi();
	const { armed, tool } = armedTool(env, { schema: { type: "object" } });

	const result = await tool.execute("call-1", { test: "npm test" }, undefined, undefined, undefined);
	assert.deepEqual(armed.value(), { test: "npm test" });
	assert.equal(result.terminate, true);
});

test("an omitted schema accepts any JSON object and instructions extend the primer", () => {
	const env = fakePi();
	const { tool } = armedTool(env, { instructions: "Report the test command." });
	assert.deepEqual(tool.parameters, { type: "object", additionalProperties: true });
	assert.match(tool.description, /only way to complete/);
	assert.match(tool.description, /Report the test command\./);
	assert.ok((tool.promptGuidelines as string[]).length > 0);
});

// The contract must read the same to a model that has just missed once: a second hand-written
// wording could drift from the tool primer and contradict the rejection it answers.
test("the primer and the one-shot nudge deliver the same contract lines verbatim", () => {
	const { tool } = armedTool(fakePi(), {});
	const contract = tool.promptGuidelines as string[];

	assert.ok(contract.length > 0);
	for (const line of contract) {
		assert.ok(tool.description.includes(line), `primer must carry the contract line: ${line}`);
		assert.ok(OUTPUT_NUDGE.includes(line), `nudge must carry the contract line: ${line}`);
	}
});

// docs/workflows.md (Structured output) correction loop: pi validates a model-issued call against the run's schema
// before `execute`; an invalid submission becomes an error tool result and the model
// corrects it in the same step. Driven through pi's real validator (the agent loop's
// code path) against the real tool definition — no mocks.
test("an invalid submission is rejected before execute; a corrected call captures and terminates", async () => {
	const schema = { type: "object", required: ["command"], properties: { command: { type: "string" } } };
	const env = fakePi();
	const { armed, tool } = armedTool(env, { schema });
	// Untyped handle, like the registered-tool tests above: execute's ctx param is irrelevant here.
	const handle = tool as unknown as Record<string, any>;
	const tools = [{ name: handle.name, parameters: handle.parameters }];
	let executed = 0;
	// pi's pipeline: validate the model call, then execute with the validated arguments.
	const submit = async (args: Record<string, unknown>) => {
		const validated = validateToolCall(tools as never, {
			type: "toolCall",
			id: `call-${executed}`,
			name: STRUCTURED_OUTPUT_TOOL,
			arguments: args,
		} as never);
		executed += 1;
		return handle.execute(`call-${executed}`, validated, undefined, undefined, undefined);
	};

	// A missing required property cannot coerce, so it fails validation before execute.
	await assert.rejects(() => submit({}), /Validation failed/);
	assert.equal(executed, 0, "execute never ran for the invalid submission");
	assert.equal(armed.value(), undefined, "a rejected submission never reaches the capture");

	const result = await submit({ command: "npm test" });
	assert.equal(executed, 1, "the corrected call reaches execute in the same step");
	assert.deepEqual(armed.value(), { command: "npm test" }, "the corrected submission captures");
	assert.equal(result.terminate, true);
});
// Structured output is scoped to one run: after the run, the tool definition stays
// registered (re-arming replaces the stale entry instead of duplicating it) but the
// previous active set is restored exactly, so workflow_output is absent from it.
test("after a structured run the tool definition stays registered but inactive", () => {
	const env = fakePi(["bash"]);
	const armed = armStructuredOutput(env.pi, { schema: { type: "object" } });
	armed.release();
	assert.ok(env.tools.get(STRUCTURED_OUTPUT_TOOL), "the definition stays registered");
	assert.deepEqual(env.active, ["bash"], "workflow_output is absent from the active set");
});
