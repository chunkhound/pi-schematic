/**
 * Invariant tests for the brand assets consumed by the README hero and the
 * pi.dev gallery (`pi.image`).
 *
 * Expectations are derived from the referencing documents (README.md,
 * package.json) and from the SVGs themselves, so the assets have a single
 * source of truth instead of a duplicated list that drifts on every edit.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertDefined, assertPresent } from "../assertions.js";
import { REPO_ROOT_URL } from "../paths.js";

const PACKAGE_JSON_URL = new URL("package.json", REPO_ROOT_URL);
const README_URL = new URL("README.md", REPO_ROOT_URL);

// The gallery preview uses a stable raw URL on the default branch:
// npm renders the README from the published tarball, where relative paths
// cannot resolve, so absolute URLs are the only reliable form.
const PI_IMAGE_PATTERN = /^https:\/\/raw\.githubusercontent\.com\/chunkhound\/pi-schematic\/main\/(?<path>assets\/.+)$/;

// Pi's 5x5 mark grid: origin and cell size shared by every SVG.
const GRID_BASE = 106.6125;
const GRID_UNIT = 117.355;
const PALETTE: readonly string[] = ["#F09082", "#4D9ABF", "#F1BE58"];

function readText(url: URL): string {
	return readFileSync(url, "utf8");
}

function repoPath(relative: string): URL {
	return new URL(relative, REPO_ROOT_URL);
}

function assetText(asset: string): string {
	return readText(repoPath(`assets/${asset}`));
}

function pathFills(svg: string): string[] {
	return [...svg.matchAll(/<path\b[^>]*>/g)].map(([path]) => {
		const fill = path.match(/\bfill="([^"]+)"/)?.[1];
		assertPresent(fill, `path missing fill: ${path}`);
		return fill;
	});
}

function piImage(): { url: string; repoPath: string } {
	const packageJson = JSON.parse(readText(PACKAGE_JSON_URL)) as { pi?: { image?: string } };
	const url = packageJson.pi?.image;
	expect(url, "pi.image must be set for the pi.dev gallery").toBeTruthy();
	assertDefined(url);
	const path = url.match(PI_IMAGE_PATTERN)?.groups?.path;
	assertPresent(path, `pi.image must be a raw main-branch brand asset URL: ${url}`);
	return { url, repoPath: path };
}

function cellIndex(value: string): number {
	return Math.round((Number(value) - GRID_BASE) / GRID_UNIT);
}

/**
 * Collects the grid cells occupied by palette-coloured `<path>` squares.
 * Bevel `<rect>` shading and non-palette filler (the animated intro's
 * turquoise counter rows and white clear-flash) are ignored, leaving only the
 * persistent mark.
 */
function markCells(svg: string): Set<string> {
	const cells = new Set<string>();
	for (const [, fill = "", d = ""] of svg.matchAll(/<path\b[^>]*fill="([^"]+)"[^>]*\bd="([^"]+)"/g)) {
		if (fill.toLowerCase() !== "currentcolor" && !PALETTE.includes(fill.toUpperCase())) continue;
		for (const [, x = "", y = ""] of d.matchAll(/M([\d.]+) ([\d.]+)h[\d.]+v[\d.]+h-[\d.]+Z/gi)) {
			cells.add(`${cellIndex(x)},${cellIndex(y)}`);
		}
	}
	return cells;
}

test("pi.image resolves to an existing brand asset", () => {
	const { repoPath: target } = piImage();
	expect(existsSync(repoPath(target)), `missing pi.image target: ${target}`).toBeTruthy();
});

test("the gallery image is a 360x360 GIF89a", () => {
	const { repoPath: target } = piImage();
	const gif = readFileSync(repoPath(target));
	expect(gif.toString("ascii", 0, 6)).toBe("GIF89a");
	expect(gif.readUInt16LE(6)).toBe(360);
	expect(gif.readUInt16LE(8)).toBe(360);
});

test("README hero references the same asset as pi.image", () => {
	const { url } = piImage();
	expect(readText(README_URL), "README hero must use the absolute pi.image URL").toContain(url);
});

test("every local asset referenced by README exists", () => {
	const readme = readText(README_URL);
	// Relative links for readers in the repository; absolute raw URLs for npm,
	// which renders the README from the published tarball where relative paths
	// cannot resolve.
	const refs = [
		...readme.matchAll(/(?:src="|\]\()(assets\/[^")\s]+)/g),
		...readme.matchAll(/https:\/\/raw\.githubusercontent\.com\/chunkhound\/pi-schematic\/main\/(assets\/[^")\s]+)/g),
	].map((match) => match[1]);
	expect(refs.length, "README references no assets").toBeGreaterThan(0);
	for (const ref of refs) {
		expect(existsSync(repoPath(ref)), `missing README asset: ${ref}`).toBeTruthy();
	}
});

test("the static and monochrome marks use their intended fills", () => {
	expect(pathFills(assetText("logo.svg")).sort()).toStrictEqual([...PALETTE].sort());
	expect(pathFills(assetText("logo-mono.svg"))).toStrictEqual(["currentColor"]);
});

test("the S silhouette is identical across the three SVGs", () => {
	const logo = markCells(assetText("logo.svg"));
	expect(logo.size, "no grid cells parsed from logo.svg").toBeGreaterThan(0);
	expect(markCells(assetText("logo-mono.svg"))).toStrictEqual(logo);
	expect(markCells(assetText("logo-animated.svg"))).toStrictEqual(logo);
});
