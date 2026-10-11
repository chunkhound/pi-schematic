// command-no-checkpoint.js — the compile gate must reject a workflow with no safe exit
// point before any sandbox or effect runs.
return defineWorkflow((workflow) => {
	workflow.shell("x");
});
