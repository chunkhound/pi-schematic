// WHY: two rapid Escape presses reach the cancel funnel as one coalesced read that pi-tui
// parses as `ctrl+alt+[`, so it never matched the `escape` cancel key. Pin the funnel's pure
// seam against pi-tui's real parser: the pair cancels, a lone Escape only arms.
import { expect, test } from "vitest";
import { matchesKey, parseKey } from "@earendil-works/pi-tui";
import { cancelPressOf } from "../../workflow/command.js";

test("pi-tui parses a coalesced Escape pair as ctrl+alt+[", () => {
	expect(parseKey("\x1b\x1b")).toBe("ctrl+alt+[");
	expect(matchesKey("\x1b\x1b", "escape"), "the pair must not match a bare Escape").toBe(false);
});

test("the funnel cancels on the coalesced pair and arms on a lone Escape", () => {
	expect(cancelPressOf("\x1b\x1b")).toStrictEqual({ key: "escape", confirmed: true });
	expect(cancelPressOf("\x1b")).toStrictEqual({ key: "escape", confirmed: false });
});

test("Ctrl+C still arms, other keys pass through, and kitty release/repeat never arm", () => {
	expect(cancelPressOf("\x03")).toStrictEqual({ key: "ctrl+c", confirmed: false });
	expect(cancelPressOf("a")).toBeNull();
	expect(cancelPressOf("\x1b[27;5:3u"), "an Escape release must not arm").toBeNull();
	expect(cancelPressOf("\x1b[27;5:2u"), "an Escape repeat must not arm").toBeNull();
});
