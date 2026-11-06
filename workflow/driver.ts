// WHY: the driver shares line 1 with the workflow so VM error lines equal author lines.
// The single trailing `;` terminates the driver before the workflow source is appended.
export const WORKFLOW_DRIVER = "function defineWorkflow(fn){return fn(workflow)};";

export function composeWorkflow(compiled: string): string {
	return WORKFLOW_DRIVER + compiled;
}
