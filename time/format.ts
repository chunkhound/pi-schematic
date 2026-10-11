/**
 * Date anchor — the single source of truth for the ambient temporal
 * fact injected into the system prompt. Full design rationale lives in
 * docs/architecture.md ("Date anchor"); this header carries only the code-level
 * WHY notes that orient a reader of this file.
 *
 * WHY date-only (no clock): a full timestamp in the prompt invites wall-clock
 * hallucination and churns the cached prefix every request. The model needs to
 * know which day it is to resolve relative references.
 *
 * WHY ISO 8601 + weekday + IANA zone: ISO is unambiguous and parseable; the
 * weekday resolves "last Friday" / "this week"; the named zone (never an
 * abbreviation) plus numeric offset fixes the day boundary.
 *
 * WHY every field comes from one Intl call: date, weekday, and offset must all
 * belong to the rendered zone. Mixing host-local getters with a zone argument
 * renders a day the zone disagrees with, and an explicit zone is the only way to
 * pin day-boundary and DST behaviour in a test.
 *
 * WHY pure: the output is a stable contract, so it stays unit-testable and
 * independent of the event glue that injects it.
 */

/** An unset, bogus, or unusable zone must never reach the prompt as text or as a thrown error. */
const UNKNOWN_ZONE_FALLBACK = "UTC";

/**
 * Turn relative and vague time references into absolute dates from the anchor.
 * Without this directive the model holds a fact but no procedure, which is why
 * listing trigger words alone underperforms.
 */
export const TEMPORAL_DIRECTIVE =
	'Resolve every relative or ambiguous time reference ("today", "yesterday", "last Friday", "this week", "recently", "latest") to an absolute date from this anchor before you answer or act. The anchor is the date this request started and is not updated during it; never guess a date.';

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

// `TZ=""` reports `Etc/Unknown`, which Intl rejects; `TZ=Invalid/Zone` reports
// nothing at all. Both degrade here, so no zone failure can throw inside
// before_agent_start. Aliases (`US/Eastern`) are kept verbatim: Intl renders
// them, and canonicalising would rewrite a name the user recognises.
function usableZone(zone: string | undefined): string {
	if (!zone) return UNKNOWN_ZONE_FALLBACK;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return zone;
	} catch {
		return UNKNOWN_ZONE_FALLBACK;
	}
}

/** The host's IANA zone when Intl can render it, else the fallback. */
export function hostZone(): string {
	return usableZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

const ZONE_FIELDS: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	weekday: "long",
	timeZoneName: "longOffset",
};

/** Every calendar field the anchor renders, all resolved by Intl for one zone. */
function zoneFields(date: Date, zone: string) {
	const rendered = usableZone(zone);
	const parts = new Intl.DateTimeFormat("en-US", { ...ZONE_FIELDS, timeZone: rendered }).formatToParts(date);
	const field = (type: string) => parts.find((candidate) => candidate.type === type)!.value;
	return {
		rendered,
		day: `${field("year")}-${field("month")}-${field("day")}`,
		weekday: field("weekday"),
		offset: offsetText(field("timeZoneName"), rendered),
	};
}

/** `GMT` / `GMT+05:30` / `GMT-04:00` → `UTC±HH:MM`. */
function offsetText(longOffset: string, zone: string): string {
	const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(longOffset);
	if (!match) throw new Error(`Intl returned unparseable longOffset ${longOffset} for zone ${zone}`);
	const east = match[1] === undefined ? 0 : (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
	const abs = Math.abs(east);
	return `UTC${east < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** The zone's offset at that instant, rendered as `UTC±HH:MM`. Exported as the offset contract the tests pin against Intl. */
export function formatZoneOffset(date: Date, zone: string): string {
	return zoneFields(date, zone).offset;
}

/** The date line, e.g. `2026-10-05 (Monday), America/New_York (UTC-04:00)`. Defaults to the host zone. */
export function formatCurrentDate(date: Date, zone: string = hostZone()): string {
	const { rendered, day, weekday, offset } = zoneFields(date, zone);
	return `${day} (${weekday}), ${rendered} (${offset})`;
}

/**
 * The complete `## Current date` block: anchor fact plus the conversion
 * directive. Caller supplies the leading separator.
 */
export function formatCurrentDatePrompt(date: Date, zone?: string): string {
	return `## Current date\n${formatCurrentDate(date, zone)}\n\n${TEMPORAL_DIRECTIVE}`;
}
