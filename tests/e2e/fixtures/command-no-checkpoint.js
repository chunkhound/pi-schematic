// command-no-checkpoint.js — a checkpoint-less (unbounded) workflow. workflow.checkpoint
// is optional, so the compile gate no longer rejects it; it runs unbounded: no cost/time
// dialog, no info notice, `∞ unbounded` in the live footer, and a UI/transcript-only
// workflow-limits entry. Repurposed from the former "compile rejects no-checkpoint" case.
return defineWorkflow((workflow) => {
	workflow.shell("x");
	return workflow.exit({ reason: "ok" });
});
