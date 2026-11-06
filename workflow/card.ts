// WHY: every workflow transcript card shares one frame (border, padded box, border). A leaf
// module keeps the frame in one place so activity and summary cards cannot drift apart.
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Bordered card: `title` heads the box, each `rows` entry is one line below it. */
export function workflowCard(theme: Theme, title: string, rows: string[]): Component {
	const container = new Container();
	container.addChild(border(theme));
	const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
	for (const line of [title, ...rows]) box.addChild(new Text(line, 0, 0));
	container.addChild(box);
	container.addChild(border(theme));
	// Box pads to the width but never truncates below its own padding, so clamp here:
	// a card must not emit a line wider than the terminal, however narrow it is.
	return {
		render: (width: number) => container.render(width).map((line) => truncateToWidth(line, width)),
		invalidate: () => container.invalidate(),
	};
}

function border(theme: Theme): DynamicBorder {
	return new DynamicBorder((s: string) => theme.fg("borderMuted", s));
}
