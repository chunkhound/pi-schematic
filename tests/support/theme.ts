// The real pi Theme for render assertions. Every token has its own truecolor value, so an assertion
// that wraps a literal text with `realTheme.fg(token, text)` or `realTheme.bg(token, text)` proves
// the token. The colour mode is fixed, never detected from the terminal.

import { Theme, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";

// Full records: a token pi adds or renames fails the type check here.
const FOREGROUND: Record<ThemeColor, string> = {
	accent: "#010000",
	border: "#020000",
	borderAccent: "#030000",
	borderMuted: "#040000",
	success: "#050000",
	error: "#060000",
	warning: "#070000",
	muted: "#080000",
	dim: "#090000",
	text: "#0a0000",
	thinkingText: "#0b0000",
	scrollbarTrack: "#0c0000",
	scrollbarThumb: "#0d0000",
	searchMatchText: "#0e0000",
	userMessageText: "#0f0000",
	customMessageText: "#100000",
	customMessageLabel: "#110000",
	toolTitle: "#120000",
	toolOutput: "#130000",
	mdHeading: "#140000",
	mdLink: "#150000",
	mdLinkUrl: "#160000",
	mdCode: "#170000",
	mdCodeBlock: "#180000",
	mdCodeBlockBorder: "#190000",
	mdQuote: "#1a0000",
	mdQuoteBorder: "#1b0000",
	mdHr: "#1c0000",
	mdListBullet: "#1d0000",
	toolDiffAdded: "#1e0000",
	toolDiffRemoved: "#1f0000",
	toolDiffContext: "#200000",
	syntaxComment: "#210000",
	syntaxKeyword: "#220000",
	syntaxFunction: "#230000",
	syntaxVariable: "#240000",
	syntaxString: "#250000",
	syntaxNumber: "#260000",
	syntaxType: "#270000",
	syntaxOperator: "#280000",
	syntaxPunctuation: "#290000",
	thinkingOff: "#2a0000",
	thinkingMinimal: "#2b0000",
	thinkingLow: "#2c0000",
	thinkingMedium: "#2d0000",
	thinkingHigh: "#2e0000",
	thinkingXhigh: "#2f0000",
	thinkingMax: "#300000",
	bashMode: "#310000",
};

const BACKGROUND: Record<ThemeBg, string> = {
	selectedBg: "#000001",
	searchMatchBg: "#000002",
	userMessageBg: "#000003",
	customMessageBg: "#000004",
	toolPendingBg: "#000005",
	toolSuccessBg: "#000006",
	toolErrorBg: "#000007",
};

/** A pi `Theme` over the fixture's colour map with `foreground` replacing its tokens' colours, rendering truecolor escape sequences. */
export function createRealTheme(foreground: Partial<Record<ThemeColor, string>> = {}): Theme {
	return new Theme({ ...FOREGROUND, ...foreground }, BACKGROUND, "truecolor");
}

/** pi's `Theme` over the fixture's colour map, rendering truecolor escape sequences. */
export const realTheme = createRealTheme();
