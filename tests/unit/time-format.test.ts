import { expect, test } from "vitest";
import fc from "fast-check";
import { formatCurrentDate, formatCurrentDatePrompt } from "../../time/format.js";
import { assertPresent, expectPrefix, expectSuffix } from "../assertions.js";

// Instants are built with Date.UTC throughout, so a run in any host zone
// exercises the same instants — the tests never inherit the runner's wall clock.
const MINUTE = 60_000;

/** An absolute instant, so tests never depend on the host zone. */
function utc(year: number, month: number, day = 1, hour = 0, minute = 0, second = 0): Date {
	return new Date(Date.UTC(year, month, day, hour, minute, second));
}

/** The Intl `longOffset` for `date` in `zone`, normalised to `UTC±HH:MM`. */
function intlOffset(date: Date, zone: string): string {
	const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
	const zoneName = formatter.formatToParts(date).find((part) => part.type === "timeZoneName");
	assertPresent(zoneName, "Intl renders the timeZoneName part");
	const gmt = zoneName.value;
	return gmt === "GMT" ? "UTC+00:00" : gmt.replace("GMT", "UTC");
}

// ── UTC offset ────────────────────────────────────────────────────────

test("formatCurrentDate renders the UTC offset of named zones", () => {
	expectSuffix(formatCurrentDate(utc(2026, 6, 1), "UTC"), "(UTC+00:00)");
	expectSuffix(formatCurrentDate(utc(2026, 6, 1), "America/New_York"), "(UTC-04:00)"); // EDT
	expectSuffix(formatCurrentDate(utc(2026, 11, 21), "America/New_York"), "(UTC-05:00)"); // EST
	expectSuffix(formatCurrentDate(utc(2026, 6, 1), "Asia/Kolkata"), "(UTC+05:30)"); // half-hour
	expectSuffix(formatCurrentDate(utc(2026, 6, 1), "Asia/Kathmandu"), "(UTC+05:45)"); // quarter-hour
	expectSuffix(formatCurrentDate(utc(2026, 6, 1), "Pacific/Kiritimati"), "(UTC+14:00)"); // extreme east
});

// Property across the whole valid offset range (UTC±14:00) in 15-minute steps,
// the resolution real zones actually use. The oracle is Intl fed an offset-string
// zone (Node >=22), independent of the arithmetic under test.
test("formatCurrentDate offset property: minutes east of UTC match Intl", () => {
	const pad = (n: number) => String(n).padStart(2, "0");
	fc.assert(
		fc.property(
			fc.integer({ min: -840, max: 840 }).map((m) => m - (m % 15)),
			(minutesEast) => {
				const abs = Math.abs(minutesEast);
				const zone = `${minutesEast < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
				expectSuffix(formatCurrentDate(utc(2026, 0, 1), zone), `(${intlOffset(utc(2026, 0, 1), zone)})`);
			},
		),
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

// ── formatCurrentDate ─────────────────────────────────────────────────

// Every field must come from the rendered zone, so an instant that is still the
// previous day in that zone renders the previous day.
test("formatCurrentDate renders the calendar day of the zone, not the host", () => {
	expect(formatCurrentDate(utc(2026, 9, 5, 4, 0), "America/New_York")).toBe("2026-10-05 (Monday), America/New_York (UTC-04:00)");
	expect(formatCurrentDate(utc(2026, 9, 5, 2, 0), "America/New_York")).toBe("2026-10-04 (Sunday), America/New_York (UTC-04:00)");
	expect(formatCurrentDate(utc(2026, 9, 5, 2, 0), "Asia/Jerusalem")).toBe("2026-10-05 (Monday), Asia/Jerusalem (UTC+03:00)");
});

// ── the caching contract the docs promise ─────────────────────────────

// docs/architecture.md "Date anchor": the block is byte-stable within a calendar
// day. Sweep every minute of a zone's day so no time-of-day reading can leak in.
test("formatCurrentDatePrompt is byte-stable across a whole calendar day", () => {
	const start = utc(2026, 9, 5, 4).getTime(); // 2026-10-05 00:00 in America/New_York
	const baseline = formatCurrentDatePrompt(new Date(start), "America/New_York");
	expectPrefix(baseline, "## Current date\n2026-10-05 (Monday), America/New_York (UTC-04:00)");
	for (let minute = 0; minute < 1440; minute++) {
		const instant = new Date(start + minute * MINUTE);
		expect(formatCurrentDatePrompt(instant, "America/New_York"), `minute ${minute} drifted`).toBe(baseline);
	}
});

// The offset must be instant-correct against Intl, so a DST flip can never
// render an offset that belongs to the other side of the transition.
test("formatCurrentDate offset matches Intl longOffset authority incl. DST", () => {
	const instants = [utc(2026, 2, 8, 6), utc(2026, 2, 8, 9), utc(2026, 10, 1, 6), utc(2026, 10, 1, 9)];
	for (const instant of instants) {
		expectSuffix(formatCurrentDate(instant, "America/New_York"), `(${intlOffset(instant, "America/New_York")})`);
	}
	expectSuffix(formatCurrentDate(utc(2026, 2, 8, 6), "America/New_York"), "(UTC-05:00)");
	expectSuffix(formatCurrentDate(utc(2026, 2, 8, 9), "America/New_York"), "(UTC-04:00)");
});

// ── formatCurrentDatePrompt ───────────────────────────────────────────

// Pin the entire block with one expect: it covers both the date line and
// the directive, so a rewording of either fails here. Importing the directive
// constant would pass even after a regression.
test("formatCurrentDatePrompt anchors the date and instructs resolution", () => {
	expect(formatCurrentDatePrompt(utc(2026, 9, 5), "UTC")).toBe(
		"## Current date\n2026-10-05 (Monday), UTC (UTC+00:00)\n\n" +
			'Resolve every relative or ambiguous time reference ("today", "yesterday", "last Friday", "this week", "recently", "latest") to an absolute date from this anchor before you answer or act. The anchor is the date this request started and is not updated during it; never guess a date.',
	);
});
