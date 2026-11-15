import { expect, test } from "vitest";
import { filterReadonlyToolNames } from "../../spawn/index.js";

// ── Tool filtering ───────────────────────────────────────────────────

test("filterReadonlyToolNames removes write, edit, and powershell in readonly mode", () => {
	const tools = ["read", "bash", "write", "edit", "powershell", "notebook_read"];
	const filtered = filterReadonlyToolNames(tools, true);
	expect(filtered).not.toContain("write");
	expect(filtered).not.toContain("edit");
	expect(filtered).not.toContain("powershell");
	expect(filtered).toContain("read");
	expect(filtered).toContain("bash");
	expect(filtered).toContain("notebook_read");
});

test("filterReadonlyToolNames preserves all tools when readonly is off", () => {
	const tools = ["read", "bash", "write", "edit", "powershell"];
	expect(filterReadonlyToolNames(tools, false)).toStrictEqual(tools);
});
