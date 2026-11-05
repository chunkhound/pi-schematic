import { expect, test } from "vitest";
import fc from "fast-check";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	formatCurrentDate,
	formatCurrentDatePrompt,
	formatZoneOffset,
	hostZone,
} from "../../time/format.js";
import { spawnNode } from "./spawn-node.js";

// Instants are built with Date.UTC throughout, so a run in any host zone
// exercises the same instants — the tests never inherit the runner's wall clock.
const MINUTE = 60_000;

// Project root + TS loader so a spawned child can import the .ts sources.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOADER = pathToFileURL(resolve(ROOT, "register-loader.mjs")).href;

/** An absolute instant, so tests never depend on the host zone. */
function utc(year: number, month: number, day = 1, hour = 0, minute = 0, second = 0): Date {
	return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/** Start of `instant`'s calendar day in `zone`, as epoch milliseconds. */
function localMidnight(instant: Date, zone: string = hostZone()): number {
	const offset = localTimeOfDayMillis(instant, zone);
	const midnight = Math.floor((instant.getTime() + offset) / 86_400_000) * 86_400_000;
	return midnight - offset;
}

// Milliseconds past local midnight. Equivalent to the zone's offset modulo a day,
// which is all the day-boundary arithmetic above needs — west of UTC included.
function localTimeOfDayMillis(instant: Date, zone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
	const field = (type: string) => Number(parts.find((candidate) => candidate.type === type)!.value);
	return ((field("hour") * 60 + field("minute")) * 60 + field("second")) * 1000;
}

/** The Intl `longOffset` for `date` in `zone`, normalised to `UTC±HH:MM`. */
function intlOffset(date: Date, zone: string): string {
	const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
	const gmt = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")!.value;
	return gmt === "GMT" ? "UTC+00:00" : gmt.replace("GMT", "UTC");
}

// ── formatZoneOffset ──────────────────────────────────────────────────

test("formatZoneOffset renders Intl offsets for named zones", () => {
	expect(formatZoneOffset(utc(2026, 6, 1), "UTC")).toBe("UTC+00:00");
	expect(formatZoneOffset(utc(2026, 6, 1), "America/New_York")).toBe("UTC-04:00"); // EDT
	expect(formatZoneOffset(utc(2026, 11, 21), "America/New_York")).toBe("UTC-05:00"); // EST
	expect(formatZoneOffset(utc(2026, 6, 1), "Asia/Kolkata")).toBe("UTC+05:30"); // half-hour
	expect(formatZoneOffset(utc(2026, 6, 1), "Asia/Kathmandu")).toBe("UTC+05:45"); // quarter-hour
	expect(formatZoneOffset(utc(2026, 6, 1), "Pacific/Kiritimati")).toBe("UTC+14:00"); // extreme east
});

// Property across the whole valid offset range (UTC±14:00) in 15-minute steps,
// the resolution real zones actually use. The oracle is Intl fed an offset-string
// zone (Node >=22), independent of the arithmetic under test.
test("formatZoneOffset property: minutes east of UTC match Intl", () => {
	const pad = (n: number) => String(n).padStart(2, "0");
	fc.assert(
		fc.property(fc.integer({ min: -840, max: 840 }).map((m) => m - (m % 15)), (minutesEast) => {
			const abs = Math.abs(minutesEast);
			const zone = `${minutesEast < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
			expect(formatZoneOffset(utc(2026, 0, 1), zone)).toBe(intlOffset(utc(2026, 0, 1), zone));
		}),
		{ numRuns: 200 },
	);
});

// ── hostZone ──────────────────────────────────────────────────────────

// A bogus, empty, or unusable zone must degrade to the fallback: the old failure
// modes were the literal text "undefined" in the prompt, then a RangeError that
// killed before_agent_start. Driven through the public entry point so the branch
// is covered on every runner, whatever the host reports.
test("formatCurrentDate degrades an unusable zone to the fallback", () => {
	for (const zone of ["", "Invalid/Zone", "Etc/Unknown"]) {
		const line = formatCurrentDate(utc(2025, 0, 1, 12), zone);
		expect(line, `${JSON.stringify(zone)} leaked into the prompt`).not.toMatch(/undefined|Invalid|Unknown/);
		expect(line, `${JSON.stringify(zone)} must fall back to UTC`).toBe("2025-01-01 (Wednesday), UTC (UTC+00:00)");
	}
});

// The host zone is what the prompt renders by default, so it must be renderable
// too — never the text "undefined", never a throw.
test("hostZone drives a renderable default anchor", () => {
	const zone = hostZone();
	expect(zone, "host zone must not be empty").not.toBe("");
	expect(() => formatCurrentDatePrompt(new Date(), zone)).not.toThrow();
	expect(formatCurrentDate(utc(2025, 0, 1, 12), zone)).not.toMatch(/undefined/);
});

// ── formatCurrentDate ─────────────────────────────────────────────────

// Every field must come from the rendered zone, so an instant that is still the
// previous day in that zone renders the previous day.
test("formatCurrentDate renders the calendar day of the zone, not the host", () => {
	expect(formatCurrentDate(utc(2026, 9, 5, 4, 0), "America/New_York")).toBe("2026-10-05 (Monday), America/New_York (UTC-04:00)");
	expect(formatCurrentDate(utc(2026, 9, 5, 2, 0), "America/New_York")).toBe("2026-10-04 (Sunday), America/New_York (UTC-04:00)");
	expect(formatCurrentDate(utc(2026, 9, 5, 2, 0), "Asia/Jerusalem")).toBe("2026-10-05 (Monday), Asia/Jerusalem (UTC+03:00)");
});

test("formatCurrentDate zero-pads month and day", () => {
	expect(formatCurrentDate(utc(2025, 0, 1), "UTC")).toMatch(/^2025-01-01 /);
	expect(formatCurrentDate(utc(2025, 8, 9), "UTC")).toMatch(/^2025-09-09 /);
});

// The host zone is interpolated into the prompt, so a host that reports no
// usable zone must render the fallback rather than the literal text "undefined".
test("formatCurrentDate never renders an unknown zone as text", () => {
	const line = formatCurrentDate(utc(2025, 0, 1, 12));
	expect(line).not.toMatch(/undefined/);
	expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \(\w+\), \S+ \(UTC[+-]\d{2}:\d{2}\)$/);
});

test("formatCurrentDate carries no clock reading", () => {
	const out = formatCurrentDate(utc(2026, 9, 5, 14, 30, 45), "UTC");
	expect(out, "no hh:mm:ss").not.toMatch(/\d{2}:\d{2}:\d{2}/);
	expect(out, "no ISO time separator or Z suffix").not.toMatch(/\dT\d|\dZ/);
});

// ── the caching contract the docs promise ─────────────────────────────

// docs/architecture.md "Date anchor": the block is byte-stable within a calendar
// day. Sweep every minute of a zone's day so no time-of-day reading can leak in.
test("formatCurrentDatePrompt is byte-stable across a whole calendar day", () => {
	const start = utc(2026, 9, 5, 4).getTime(); // 2026-10-05 00:00 in America/New_York
	const baseline = formatCurrentDatePrompt(new Date(start), "America/New_York");
	expect(baseline).toMatch(/^## Current date\n2026-10-05 \(Monday\), America\/New_York \(UTC-04:00\)/);
	for (let minute = 0; minute < 1440; minute++) {
		const instant = new Date(start + minute * MINUTE);
		expect(formatCurrentDatePrompt(instant, "America/New_York"), `minute ${minute} drifted`).toBe(baseline);
	}
});

// Same claim for the host zone. The sweep starts at local midnight and runs 22
// hours — shorter than a 23-hour DST day — so it cannot leave that day.
test("formatCurrentDatePrompt is byte-stable across the host day", () => {
	const start = localMidnight(utc(2026, 9, 5, 0));
	const baseline = formatCurrentDatePrompt(new Date(start));
	for (let minute = 0; minute <= 1320; minute++) {
		expect(formatCurrentDatePrompt(new Date(start + minute * MINUTE)), `minute ${minute} drifted`).toBe(baseline);
	}
});

// On a DST transition day the offset flips once while the date holds, so record
// the ordered sequence per 15-minute step and assert a single monotonic flip —
// a Set-size check would miss flapping (A→B→A→B).
test("formatCurrentDatePrompt holds one date change and one offset flip across a DST transition", () => {
	const start = utc(2026, 2, 8, 6).getTime(); // 2026-03-08 01:00 in America/New_York
	const dates: string[] = [];
	const offsets: string[] = [];
	for (let minute = 0; minute <= 1320; minute += 15) {
		const line = formatCurrentDate(new Date(start + minute * MINUTE), "America/New_York");
		expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \(\w+\), America\/New_York \(UTC[+-]\d{2}:\d{2}\)$/);
		dates.push(line.slice(0, 10));
		offsets.push(line.slice(line.indexOf("(UTC")));
	}
	// Offsets must run [-05:00 … -05:00, -04:00 … -04:00] with exactly one flip.
	expect(offsets[0], "sweep must start on EST").toBe("(UTC-05:00)");
	expect(offsets[offsets.length - 1], "sweep must end on EDT").toBe("(UTC-04:00)");
	for (const offset of offsets) {
		expect(offset === "(UTC-05:00)" || offset === "(UTC-04:00)", `unexpected offset ${offset}`).toBe(true);
	}
	const offsetFlips = offsets.filter((offset, i) => i > 0 && offset !== offsets[i - 1]).length;
	expect(offsetFlips, `offset must flip exactly once, got ${offsetFlips}: ${[...new Set(offsets)].join(", ")}`).toBe(1);
	// Dates are ISO so lexicographic order is chronological: non-decreasing,
	// at most one change (the midnight boundary), never alternating back.
	for (let i = 1; i < dates.length; i++) {
		expect(dates[i] >= dates[i - 1], `date moved backwards at step ${i}: ${dates[i - 1]} → ${dates[i]}`).toBe(true);
	}
	const dateFlips = dates.filter((date, i) => i > 0 && date !== dates[i - 1]).length;
	expect(dateFlips <= 1, `date changed more than once: ${[...new Set(dates)].join(", ")}`).toBe(true);
});

// The offset must be instant-correct against Intl, so a DST flip can never
// render an offset that belongs to the other side of the transition.
test("formatCurrentDate offset matches Intl longOffset authority incl. DST", () => {
	const instants = [utc(2026, 2, 8, 6), utc(2026, 2, 8, 9), utc(2026, 10, 1, 6), utc(2026, 10, 1, 9)];
	for (const instant of instants) {
		expect(formatZoneOffset(instant, "America/New_York")).toBe(intlOffset(instant, "America/New_York"));
	}
	expect(formatZoneOffset(utc(2026, 2, 8, 6), "America/New_York")).toBe("UTC-05:00");
	expect(formatZoneOffset(utc(2026, 2, 8, 9), "America/New_York")).toBe("UTC-04:00");
});

// ── formatCurrentDatePrompt ───────────────────────────────────────────

// Child-process test: a constant "UTC" default would render UTC here, so pinning
// the zone via the host proves the default parameter wires to hostZone(). A child
// process isolates the TZ from the in-process host-day stability tests above.
// America/New_York is never reported as an Intl alias, unlike Asia/Kolkata.
// Skipped on Windows: TZ→Intl propagation is POSIX-guaranteed.
test.skipIf(process.platform === "win32")("formatCurrentDate defaults to the host zone under a pinned TZ", () => {
	const instant = Date.UTC(2026, 9, 5, 4, 0);
	const script =
		`import { formatCurrentDate, hostZone } from "./time/format.js"; ` +
		`console.log(hostZone() + "|" + formatCurrentDate(new Date(${instant})));`;
	const result = spawnNode(["--input-type=module", "-e", script], {
		cwd: ROOT,
		env: { TZ: "America/New_York" },
		loader: LOADER,
		timeoutMs: 10_000,
	});
	expect(result.status, result.stderr).toBe(0);
	const out = result.stdout.trim();
	const [zone, formatted] = out.split("|");
	expect(zone, "pinned TZ must reach Intl as the host zone").toBe("America/New_York");
	expect(formatted, "formatCurrentDate(instant) must resolve its default zone to the host zone").toMatch(/America\/New_York/);
});

// Pin the entire block with one expect: it covers both the date line and
// the directive, so a rewording of either fails here. Importing the directive
// constant would pass even after a regression.
test("formatCurrentDatePrompt anchors the date and instructs resolution", () => {
	expect(formatCurrentDatePrompt(utc(2026, 9, 5), "UTC")).toBe('## Current date\n2026-10-05 (Monday), UTC (UTC+00:00)\n\n' +
			'Resolve every relative or ambiguous time reference ("today", "yesterday", "last Friday", "this week", "recently", "latest") to an absolute date from this anchor before you answer or act. The anchor is the date this request started and is not updated during it; never guess a date.');
});

test("formatCurrentDatePrompt renders exactly one ISO date", () => {
	const block = formatCurrentDatePrompt(utc(2026, 9, 5), "UTC");
	expect(block.match(/\d{4}-\d{2}-\d{2}/g)?.length, "exactly one anchor date, no yesterday/tomorrow lines").toBe(1);
});
