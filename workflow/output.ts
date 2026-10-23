// WHY: one module owns the run-scoped structured-output tool: its primer, its schema
// wiring, and the armed life-cycle. The host holds one handle and reads the captured
// value, so tool-registration details never leak into the run orchestration.
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { StructuredOutputRequest } from "./types.js";

/** Host-owned tool name. The same name is re-registered per structured run, so the schema follows the run. */
export const STRUCTURED_OUTPUT_TOOL = "workflow_output";

// A run that omits a schema still returns an object; the model must submit something structured.
const ANY_OBJECT = { type: "object", additionalProperties: true } as const;

// Single wording of the call contract, shared verbatim by the tool primer and the nudge.
const OUTPUT_GUIDELINES = [
	"Call workflow_output exactly once, as your final action, with the finished result.",
	"Put the result in the workflow_output arguments; do not repeat it as prose.",
	"If workflow_output rejects the arguments, fix them and call it again.",
];

/** Host text sent once when a structured run settles without a submission. The tool cannot
 * send it: `execute` runs only when the model calls the tool. The lead states the failure
 * only; the rules are OUTPUT_GUIDELINES verbatim, so the contract never has a second wording. */
export const OUTPUT_NUDGE = [
	"Your result was not submitted through workflow_output.",
	...OUTPUT_GUIDELINES,
].join("\n");

/** Live capture for one structured run; `execute` writes `value`, the handle reads it after settle. */
interface OutputCapture {
	request: StructuredOutputRequest;
	value?: unknown;
}

/** Handle for one armed run: `value` reads the submission, `release` restores the previous active set. */
export interface ArmedStructuredOutput {
	value(): unknown;
	release(): void;
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
			terminate: true,
		});
	};
}

/**
 * Build the output tool for one run. `parameters` is the run's schema, so pi validates
 * a model-issued call before `execute` runs: an invalid submission never reaches the host,
 * it becomes an error tool result the model corrects inside the same settled run.
 */
function buildStructuredOutputTool(capture: OutputCapture): ToolDefinition {
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
 * The handle closes over the previous set, so `release` restores it exactly.
 */
export function armStructuredOutput(pi: ExtensionAPI, request: StructuredOutputRequest): ArmedStructuredOutput {
	const capture: OutputCapture = { request };
	const previous = pi.getActiveTools();
	pi.registerTool(buildStructuredOutputTool(capture));
	pi.setActiveTools([...previous.filter((name) => name !== STRUCTURED_OUTPUT_TOOL), STRUCTURED_OUTPUT_TOOL]);
	return {
		value: () => capture.value,
		release: () => pi.setActiveTools([...previous]),
	};
}
