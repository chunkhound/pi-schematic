import { expect, test } from "vitest";
import { applyReadonlyBashGuard } from "../../readonly-bash.js";

// The guard probes for the OS sandbox in a child process, so this test is an integration test.
test("bash guard uses centralized readonly block copy", () => {
	expect(applyReadonlyBashGuard("touch /outside-temp-file", process.cwd())).toStrictEqual({
		action: "block",
		reason: "Readonly mode: command blocked.\nReason: touch blocked outside temp dir: /outside-temp-file\nCommand: touch /outside-temp-file",
	});
});
