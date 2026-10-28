// host-handoff-turns.js — run, handoff, run: the summary's `turns` counts only
// workflow.run assistant messages; the handoff's preparation turn never counts
// (invariant: `turns >= steps`, a handoff step contributes no preparation turn).
return defineWorkflow((workflow) => {
	const first = workflow.run("before handoff");
	workflow.handoff("continue the resumed work");
	const second = workflow.run("after handoff");
	workflow.checkpoint({ phase: "done" });
	return workflow.exit({ reason: "ok", first, second });
});
