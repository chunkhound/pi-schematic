// command-checkpoint-shell.js — checkpoint first, then a shell. The harness can hold the
// shell so a cancel or a footer read lands after the checkpoint but before the run ends.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	workflow.checkpoint(spec.metadata ?? {});
	workflow.shell(spec.command ?? "echo held");
	return workflow.exit({ reason: "ok" });
});
