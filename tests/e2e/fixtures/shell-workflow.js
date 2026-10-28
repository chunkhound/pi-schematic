// shell-workflow.js — one shell effect; exit with the wire-contract ok flag so the
// readonly guard's block is observable through the transcript.
return defineWorkflow((workflow) => {
	const result = workflow.shell("npm install lodash");
	workflow.checkpoint({ phase: "shell", ok: result.ok });
	return workflow.exit({ reason: "ok", ok: result.ok });
});
