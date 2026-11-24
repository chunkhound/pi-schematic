import { expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertPresent } from "../assertions.js";
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
	assertPresent(tool, "structured output tool is not registered");
	return { armed, tool };
}

test("armStructuredOutput registers the run schema and activates the tool", () => {
	const env = fakePi(["bash", "read"]);
	const schema = { type: "object", required: ["test"] };

	const { armed, tool } = armedTool(env, { schema });

	expect(env.active).toStrictEqual(["bash", "read", STRUCTURED_OUTPUT_TOOL]);
	expect(armed.value()).toBeUndefined();
	expect(tool.parameters).toStrictEqual(schema);
});

test("armStructuredOutput configures the tool's exposure and sampling", () => {
	const env = fakePi(["bash", "read"]);
	const schema = { type: "object", required: ["test"] };

	const { tool } = armedTool(env, { schema });

	expect(tool.exposure).toBe("model-only");
	expect(tool.defaultActive).toBe(false);
	expect(tool.constrainedSampling).toStrictEqual({ type: "json_schema", strict: "prefer" });
});

test("arming replaces a stale tool entry instead of duplicating it in the active set", () => {
	const env = fakePi([STRUCTURED_OUTPUT_TOOL, "bash"]);
	armStructuredOutput(env.pi, {});
	expect(env.active).toStrictEqual(["bash", STRUCTURED_OUTPUT_TOOL]);
});

test("release restores the previous active set exactly", () => {
	const env = fakePi();
	const armed = armStructuredOutput(env.pi, {});
	armed.release();
	expect(env.active).toStrictEqual(["bash"]);
});

test("the output tool captures the submitted object and terminates the batch", async () => {
	const env = fakePi();
	const { armed, tool } = armedTool(env, { schema: { type: "object" } });

	const result = await tool.execute("call-1", { test: "npm test" }, undefined, undefined, undefined);
	expect(armed.value()).toStrictEqual({ test: "npm test" });
	expect(result.terminate).toBe(true);
});

test("an omitted schema accepts any JSON object and instructions extend the primer", () => {
	const env = fakePi();
	const { tool } = armedTool(env, { instructions: "Report the test command." });
	expect(tool.parameters).toStrictEqual({ type: "object", additionalProperties: true });
	expect(tool.description).toMatch(/only way to complete/);
	expect(tool.description).toMatch(/Report the test command\./);
	expect((tool.promptGuidelines as string[]).length > 0).toBe(true);
});

// The contract must read the same to a model that has just missed once: a second hand-written
// wording could drift from the tool primer and contradict the rejection it answers.
test("the primer and the one-shot nudge deliver the same contract lines verbatim", () => {
	const { tool } = armedTool(fakePi(), {});
	const contract = tool.promptGuidelines as string[];

	expect(contract.length > 0).toBe(true);
	for (const line of contract) {
		expect(tool.description, `primer must carry the contract line: ${line}`).toContain(line);
		expect(OUTPUT_NUDGE, `nudge must carry the contract line: ${line}`).toContain(line);
	}
});

// docs/workflows.md (Structured output) correction loop: pi validates a model-issued call against the run's schema
// before `execute`; an invalid submission becomes an error tool result and the model
// corrects it in the same step. Driven through pi's real validator (the agent loop's
// code path) against the real tool definition — no mocks.
function submitFixture(): { submit: (args: Record<string, unknown>) => Promise<unknown>; executed: () => number; armed: { value: () => unknown } } {
	const schema = { type: "object", required: ["command"], properties: { command: { type: "string" } } };
	const env = fakePi();
	const { armed, tool } = armedTool(env, { schema });
	// Untyped handle, like the registered-tool tests above: execute's ctx param is irrelevant here.
	const handle = tool;
	const tools = [{ name: handle.name, parameters: handle.parameters }];
	let executed = 0;
	// pi's pipeline: validate the model call, then execute with the validated arguments.
	const submit = async (args: Record<string, unknown>) => {
		const validated = validateToolCall(
			tools as never,
			{
				type: "toolCall",
				id: `call-${executed}`,
				name: STRUCTURED_OUTPUT_TOOL,
				arguments: args,
			} as never,
		);
		executed += 1;
		return await handle.execute(`call-${executed}`, validated, undefined, undefined, undefined);
	};
	return { submit, executed: () => executed, armed };
}

test("an invalid submission is rejected before execute", async () => {
	const { submit, executed, armed } = submitFixture();
	// A missing required property cannot coerce, so it fails validation before execute.
	await expect(() => submit({})).rejects.toThrow(/Validation failed/);
	expect(executed(), "execute never ran for the invalid submission").toBe(0);
	expect(armed.value(), "a rejected submission never reaches the capture").toBeUndefined();
});

test("a corrected submission captures and terminates", async () => {
	const { submit, executed, armed } = submitFixture();
	const result = await submit({ command: "npm test" });
	expect(executed(), "the corrected call reaches execute in the same step").toBe(1);
	expect(armed.value(), "the corrected submission captures").toStrictEqual({ command: "npm test" });
	expect(result, "the corrected submission terminates").toMatchObject({ terminate: true });
});
// Structured output is scoped to one run: after the run, the tool definition stays
// registered (re-arming replaces the stale entry instead of duplicating it) but the
// previous active set is restored exactly, so workflow_output is absent from it.
test("after a structured run the tool definition stays registered but inactive", () => {
	const env = fakePi(["bash"]);
	const armed = armStructuredOutput(env.pi, { schema: { type: "object" } });
	armed.release();
	assertPresent(env.tools.get(STRUCTURED_OUTPUT_TOOL), "the definition stays registered");
	expect(env.active, "workflow_output is absent from the active set").toStrictEqual(["bash"]);
});
