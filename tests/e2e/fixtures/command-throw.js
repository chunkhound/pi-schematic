// command-throw.js — a script throw after the safe exit point must surface as an error
// exit with the sandbox's message, never a silent end.
return defineWorkflow((workflow) => {
	workflow.checkpoint({});
	throw new Error("boom");
});
