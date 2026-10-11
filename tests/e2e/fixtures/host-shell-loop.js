// host-shell-loop.js — run `count` shell effects, then checkpoint and exit. The crossing
// shell runs, but guarded effects past the deferred stop are bounded by MAX_DEFERRED_EFFECTS.
return defineWorkflow((workflow) => {
	const spec = JSON.parse(load("intent") || "{}");
	for (let i = 0; i < (spec.count || 1); i++) workflow.shell("echo " + i);
	workflow.checkpoint(spec.checkpoint);
	return workflow.exit({ reason: "ok" });
});
