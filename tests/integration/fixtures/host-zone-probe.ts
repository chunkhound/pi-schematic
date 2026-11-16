// Reads the host zone and the date line formatCurrentDate renders with its default zone, for a Node
// child whose TZ the test pins. This module imports no test runner, so the child loads it under the
// test loader alone.

import { formatCurrentDate, hostZone } from "../../../time/format.js";

/** The host zone and the date line for `instant` in the default zone, joined by `|`. */
export function readHostZoneProbe(instant: number): string {
	return `${hostZone()}|${formatCurrentDate(new Date(instant))}`;
}
