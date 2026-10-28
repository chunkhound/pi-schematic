// run-workflow.js — one workflow.run turn; exit with the settled text and cost so the
// E2E scripted-turn seam is observable through the transcript alone.
return defineWorkflow((workflow) => {
	const result = workflow.run("hello");
	workflow.checkpoint({ phase: "settled" });
	return workflow.exit({ reason: "ok", text: result.text, cost: result.usage.cost.total });
});
