// WHY: two rapid Escape presses reach the cancel funnel as one coalesced read that pi-tui
// parses as `ctrl+alt+[`, so it never matched the `escape` cancel key. Pin the funnel's pure
// seam against pi-tui's real parser: the pair cancels, a lone Escape only arms.
import assert from "node:assert/strict";
import test from "node:test";
import { matchesKey, parseKey } from "@earendil-works/pi-tui";
import { cancelPressOf } from "../../workflow/command.js";

test("pi-tui parses a coalesced Escape pair as ctrl+alt+[", () => {
	assert.equal(parseKey("\x1b\x1b"), "ctrl+alt+[");
	assert.equal(matchesKey("\x1b\x1b", "escape"), false, "the pair must not match a bare Escape");
});

test("the funnel cancels on the coalesced pair and arms on a lone Escape", () => {
	assert.deepEqual(cancelPressOf("\x1b\x1b"), { key: "escape", confirmed: true });
	assert.deepEqual(cancelPressOf("\x1b"), { key: "escape", confirmed: false });
});

test("Ctrl+C still arms, other keys pass through, and kitty release/repeat never arm", () => {
	assert.deepEqual(cancelPressOf("\x03"), { key: "ctrl+c", confirmed: false });
	assert.equal(cancelPressOf("a"), null);
	assert.equal(cancelPressOf("\x1b[27;5:3u"), null, "an Escape release must not arm");
	assert.equal(cancelPressOf("\x1b[27;5:2u"), null, "an Escape repeat must not arm");
});
