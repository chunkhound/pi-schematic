// WHY: one module owns the run-scoped structured-output tool: its primer, its schema
// wiring, and the armed/deactivated lifecycle. The host only calls arm/disarm and reads
// the captured value, so tool-registration details never leak into the run orchestration.
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { StructuredOutputRequest } from "./types.js";

/** Host-owned tool name. The same name is re-registered per structured run, so the schema follows the run. */
export const STRUCTURED_OUTPUT_TOOL = "workflow_output";

// A run that omits a schema still returns an object; the model must submit something structured.
const ANY_OBJECT = { type: "object", additionalProperties: true } as const;

// Three lines, addressed to the model, so the primer stays the single source of the call contract.
const OUTPUT_GUIDELINES = [
	"Call workflow_output exactly once, as your final action, with the finished result.",
	"Put the result in the workflow_output arguments; do not repeat it as prose.",
	"If workflow_output rejects the arguments, fix them and call it again.",
];

/** Live capture for one structured run; `execute` writes `value`, the host reads it after settle. */
export interface OutputCapture {
	request: StructuredOutputRequest;
	value?: unknown;
}

// WHY: the primer is the tool's job, not a second prompt line. A model that never calls it
// leaves the contract unsatisfied, so the model must be told this is the only way to finish.
// The call contract itself is OUTPUT_GUIDELINES verbatim: one wording, two surfaces.
const PRIMER_LEAD = "Return this run's structured result. This is the only way to complete the run.";

function primer(request: StructuredOutputRequest): string {
	const base = [PRIMER_LEAD, ...OUTPUT_GUIDELINES].join("\n");
	return request.instructions ? `${base}\n${request.instructions}` : base;
}

/** Capture the model's submission; `terminate` ends the agent's follow-up when the whole batch agrees. */
function captureSubmission(capture: OutputCapture): ToolDefinition["execute"] {
	return (_toolCallId, params) => {
		capture.value = params;
		return Promise.resolve({
			content: [{ type: "text", text: "Structured output received; the run is complete." }],
			details: undefined,
			structuredContent: params as AgentToolResult["structuredContent"],
			terminate: true,
		});
	};
}

/**
 * Build the output tool for one run. `parameters` is the run's schema, so pi validates
 * a model-issued call before `execute` runs: an invalid submission never reaches the host,
 * it becomes an error tool result the model corrects inside the same settled run.
 */
export function buildStructuredOutputTool(capture: OutputCapture): ToolDefinition {
	return {
		name: STRUCTURED_OUTPUT_TOOL,
		label: "workflow output",
		description: primer(capture.request),
		promptSnippet: "Return this run's structured result and end the run",
		promptGuidelines: OUTPUT_GUIDELINES,
		parameters: capture.request.schema ?? ANY_OBJECT,
		// "prefer" matches the edit tool: send the schema when the provider supports strict sampling.
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		// model-only: declared to the model, never callable from sandbox scripts.
		exposure: "model-only",
		defaultActive: false,
		execute: captureSubmission(capture),
	};
}

/**
 * Register (replace) the output tool with this run's schema and add it to the active set.
 * Returns the previous active set so the caller can restore it exactly.
 */
export function armStructuredOutput(pi: ExtensionAPI, capture: OutputCapture): string[] {
	const previous = pi.getActiveTools();
	pi.registerTool(buildStructuredOutputTool(capture));
	pi.setActiveTools([...previous.filter((name) => name !== STRUCTURED_OUTPUT_TOOL), STRUCTURED_OUTPUT_TOOL]);
	return previous;
}

/** Deactivate the output tool; the definition stays registered but unreachable. */
export function disarmStructuredOutput(pi: ExtensionAPI, previousActive: readonly string[]): void {
	pi.setActiveTools([...previousActive]);
}
