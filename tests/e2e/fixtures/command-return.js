// command-return.js — checkpoint, then return without workflow.exit. The command must
// record a {reason:"returned"} exit and salvage no partial.
return defineWorkflow((workflow) => {
	workflow.checkpoint({});
});
