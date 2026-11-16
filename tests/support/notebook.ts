// Helpers for tests that drive the notebook through the runner fixture: seeding pages with
// notebook_write, and pressing keys in and rendering the /notebook list a `ctx.ui.custom` call builds.

import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import type { CustomComponentDriver, RunnerFixture } from "./runner.js";

export const ESCAPE = "\x1b";

export function plain(lines: string[]): string {
	return stripTerminalSequences(lines.join("\n"));
}

export function press(component: Component, ...keys: string[]): void {
	for (const key of keys) {
		component.handleInput?.(key);
	}
}

/**
 * A `ctx.ui.custom` driver for the /notebook list: the n-th opened list is rendered into `renders`,
 * then `opens[n]` acts on it; the first list opened after the last step is closed with Esc. A
 * list opened after that one fails the test, so a list that reopens without end ends in a failed
 * assertion instead of a loop that never yields to the test timeout.
 */
export function listDriver(...opens: ((component: Component) => void | Promise<void>)[]) {
	const renders: string[] = [];
	let calls = 0;
	const driver: CustomComponentDriver = async (component) => {
		const open = opens.at(calls);
		calls++;
		expect(calls, "no list opens after the one the driver closed with Esc").toBeLessThanOrEqual(opens.length + 1);
		renders.push(plain(component.render(120)));
		if (open === undefined) {
			component.handleInput?.(ESCAPE);
			return;
		}
		await open(component);
	};
	return {
		driver,
		renders,
		get opened() {
			return calls;
		},
	};
}

export async function writePage(fixture: RunnerFixture, name: string, content: string): Promise<void> {
	await fixture.tool("notebook_write").execute("seed", { name, content });
}
