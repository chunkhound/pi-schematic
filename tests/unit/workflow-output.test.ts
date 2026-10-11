import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolCall } from "@earendil-works/pi-ai";
import {
	armStructuredOutput,
	buildStructuredOutputTool,
	disarmStructuredOutput,
	STRUCTURED_OUTPUT_TOOL,
	type OutputCapture,
} from "../../workflow/output.js";

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

test("armStructuredOutput registers the run schema, activates the tool, and returns the previous set", () => {
	const env = fakePi(["bash", "read"]);
	const schema = { type: "object", required: ["test"] };
	const capture: OutputCapture = { request: { schema } };

	const previous = armStructuredOutput(env.pi, capture);

	assert.deepEqual(previous, ["bash", "read"]);
	assert.deepEqual(env.active, ["bash", "read", STRUCTURED_OUTPUT_TOOL]);
	const tool = env.tools.get(STRUCTURED_OUTPUT_TOOL);
	assert.ok(tool);
	assert.deepEqual(tool.parameters, schema);
	assert.equal(tool.exposure, "model-only");
	assert.equal(tool.defaultActive, false);
	assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
});

test("armStructuredOutput replaces a stale tool entry instead of duplicating it in the active set", () => {
	const env = fakePi([STRUCTURED_OUTPUT_TOOL, "bash"]);
	armStructuredOutput(env.pi, { request: {} });
	assert.deepEqual(env.active, ["bash", STRUCTURED_OUTPUT_TOOL]);
});

test("disarmStructuredOutput restores the previous active set exactly", () => {
	const env = fakePi();
	armStructuredOutput(env.pi, { request: {} });
	disarmStructuredOutput(env.pi, ["bash"]);
	assert.deepEqual(env.active, ["bash"]);
});

test("the output tool captures the submitted object and terminates the batch", async () => {
	const env = fakePi();
	const capture: OutputCapture = { request: { schema: { type: "object" } } };
	env.pi.registerTool(buildStructuredOutputTool(capture));
	const tool = env.tools.get(STRUCTURED_OUTPUT_TOOL);
	assert.ok(tool);

	const result = await tool.execute("call-1", { test: "npm test" }, undefined, undefined, undefined);
	assert.deepEqual(capture.value, { test: "npm test" });
	assert.equal(result.terminate, true);
	assert.deepEqual(result.structuredContent, { test: "npm test" });
});

test("an omitted schema accepts any JSON object and instructions extend the primer", () => {
	const capture: OutputCapture = { request: { instructions: "Report the test command." } };
	const tool = buildStructuredOutputTool(capture);
	assert.deepEqual(tool.parameters, { type: "object", additionalProperties: true });
	assert.match(tool.description, /only way to complete/);
	assert.match(tool.description, /Report the test command\./);
	assert.ok((tool.promptGuidelines as string[]).length > 0);
});

// docs/workflows.md (Structured output) correction loop: pi validates a model-issued call against the run's schema
// before `execute`; an invalid submission becomes an error tool result and the model
// corrects it in the same step. Driven through pi's real validator (the agent loop's
// code path) against the real tool definition — no mocks.
test("an invalid submission is rejected before execute; a corrected call captures and terminates", async () => {
	const schema = { type: "object", required: ["command"], properties: { command: { type: "string" } } };
	const capture: OutputCapture = { request: { schema } };
	// Untyped handle, like the registered-tool tests above: execute's ctx param is irrelevant here.
	const tool = buildStructuredOutputTool(capture) as unknown as Record<string, any>;
	const tools = [{ name: tool.name, parameters: tool.parameters }];
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
		return tool.execute(`call-${executed}`, validated, undefined, undefined, undefined);
	};

	// A missing required property cannot coerce, so it fails validation before execute.
	await assert.rejects(() => submit({}), /Validation failed/);
	assert.equal(executed, 0, "execute never ran for the invalid submission");
	assert.equal(capture.value, undefined, "a rejected submission never reaches the capture");

	const result = await submit({ command: "npm test" });
	assert.equal(executed, 1, "the corrected call reaches execute in the same step");
	assert.deepEqual(capture.value, { command: "npm test" }, "the corrected submission captures");
	assert.equal(result.terminate, true);
	assert.deepEqual(result.structuredContent, { command: "npm test" });
});
// Structured output is scoped to one run: after the run, the tool definition stays
// registered (re-arming replaces the stale entry instead of duplicating it) but the
// previous active set is restored exactly, so workflow_output is absent from it.
test("after a structured run the tool definition stays registered but inactive", () => {
	const env = fakePi(["bash"]);
	const previous = armStructuredOutput(env.pi, { request: { schema: { type: "object" } } });
	disarmStructuredOutput(env.pi, previous);
	assert.ok(env.tools.get(STRUCTURED_OUTPUT_TOOL), "the definition stays registered");
	assert.deepEqual(env.active, ["bash"], "workflow_output is absent from the active set");
});
