// run-output-workflow.js — one structured-output run; the armed workflow_output tool
// captures the scripted object before the turn settles.
return defineWorkflow((workflow) => {
	const result = workflow.run("/review", {
		output: { schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
	});
	workflow.checkpoint({ phase: "settled" });
	return workflow.exit({ reason: "ok", output: result.output });
});
