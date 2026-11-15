import { expect, test } from "vitest";
import { REGISTER_LOADER_URL, REPO_ROOT } from "../paths.js";
import { spawnNode } from "../support/spawn-node.js";

const PROBE_URL = new URL("fixtures/host-zone-probe.ts", import.meta.url).href;

// Child-process test: a constant "UTC" default would render UTC here, so pinning
// the zone via the host proves the default parameter wires to hostZone(). A child
// process isolates the TZ from the test worker's own zone.
// America/New_York is never reported as an Intl alias, unlike Asia/Kolkata.
// Skipped on Windows: TZ→Intl propagation is POSIX-guaranteed.
test.skipIf(process.platform === "win32")("formatCurrentDate defaults to the host zone under a pinned TZ", () => {
	const instant = Date.UTC(2026, 9, 5, 4, 0);
	const script = `import { readHostZoneProbe } from ${JSON.stringify(PROBE_URL)}; process.stdout.write(readHostZoneProbe(${instant}));`;
	const result = spawnNode(["--input-type=module", "-e", script], {
		cwd: REPO_ROOT,
		env: { TZ: "America/New_York" },
		loader: REGISTER_LOADER_URL,
		timeoutMs: 10_000,
	});
	expect(result.status, result.stderr).toBe(0);
	const out = result.stdout.trim();
	const [zone, formatted] = out.split("|");
	expect(zone, "pinned TZ must reach Intl as the host zone").toBe("America/New_York");
	expect(formatted, "formatCurrentDate(instant) must resolve its default zone to the host zone").toMatch(/America\/New_York/);
});
