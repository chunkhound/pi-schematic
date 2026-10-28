/**
 * Invariant tests for the brand assets consumed by the README hero and the
 * pi.dev gallery (`pi.image`).
 *
 * Expectations are derived from the referencing documents (README.md,
 * package.json) and from the SVGs themselves, so the assets have a single
 * source of truth instead of a duplicated list that drifts on every edit.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT_URL = new URL("../../", import.meta.url);
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
		assert.ok(fill, `path missing fill: ${path}`);
		return fill;
	});
}

function piImage(): { url: string; repoPath: string } {
	const packageJson = JSON.parse(readText(PACKAGE_JSON_URL)) as { pi?: { image?: string } };
	const url = packageJson.pi?.image;
	assert.ok(url, "pi.image must be set for the pi.dev gallery");
	const path = url.match(PI_IMAGE_PATTERN)?.groups?.path;
	assert.ok(path, `pi.image must be a raw main-branch brand asset URL: ${url}`);
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
	assert.ok(existsSync(repoPath(target)), `missing pi.image target: ${target}`);
});

test("the gallery image is a 360x360 GIF89a", () => {
	const { repoPath: target } = piImage();
	const gif = readFileSync(repoPath(target));
	assert.equal(gif.toString("ascii", 0, 6), "GIF89a");
	assert.equal(gif.readUInt16LE(6), 360);
	assert.equal(gif.readUInt16LE(8), 360);
});

test("README hero references the same asset as pi.image", () => {
	const { url } = piImage();
	assert.ok(readText(README_URL).includes(url), "README hero must use the absolute pi.image URL");
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
	assert.ok(refs.length > 0, "README references no assets");
	for (const ref of refs) {
		assert.ok(existsSync(repoPath(ref)), `missing README asset: ${ref}`);
	}
});

test("the static and monochrome marks use their intended fills", () => {
	assert.deepStrictEqual(pathFills(assetText("logo.svg")).sort(), [...PALETTE].sort());
	assert.deepStrictEqual(pathFills(assetText("logo-mono.svg")), ["currentColor"]);
});

test("the S silhouette is identical across the three SVGs", () => {
	const logo = markCells(assetText("logo.svg"));
	assert.ok(logo.size > 0, "no grid cells parsed from logo.svg");
	assert.deepStrictEqual(markCells(assetText("logo-mono.svg")), logo);
	assert.deepStrictEqual(markCells(assetText("logo-animated.svg")), logo);
});
