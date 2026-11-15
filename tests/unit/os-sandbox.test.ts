import path from "node:path";
import { expect, test } from "vitest";
import { appendSandboxBlockNotice, appendSandboxBlockNoticeToResult, buildMacProfile, wrapWithBwrap, wrapWithSandboxExec } from "../../os-sandbox.js";
import { resolveRealPath } from "../../resolve-path.js";
import { bashResult, SANDBOX_DENIAL_PHRASES } from "./helpers.js";
import { expectSuffix } from "../assertions.js";

const BLOCK_NOTICE =
	"[readonly mode] If this command failed on a write outside the OS temp dir, the OS sandbox blocked it.\nUse /readonly to disable, or write within the OS temp dir.";
const NOTICE_SUFFIX = `\n\n${BLOCK_NOTICE}`;

/** A blocked write's error on the current host, or `undefined` on a platform without a sandbox. */
const HOST_DENIAL_PHRASE = SANDBOX_DENIAL_PHRASES[process.platform];
const HOST_DENIAL_OUTPUT = HOST_DENIAL_PHRASE === undefined ? undefined : `bash: /outside: ${HOST_DENIAL_PHRASE}`;
/** Every platform's denial phrase except the current host's, so it never matches by default. */
const OTHER_DENIAL_OUTPUT = `bash: /outside: ${Object.entries(SANDBOX_DENIAL_PHRASES)
	.filter(([platform]) => platform !== process.platform)
	.map(([, phrase]) => phrase)
	.join("; ")}`;

// ── Block notice ────────────────────────────────────────────────

// A row without a platform uses the default, the current host.
for (const { platform, output } of [
	{ platform: "darwin", output: "bash: /outside: Operation not permitted" },
	{ platform: "darwin", output: "Error: EPERM: operation not permitted, open '/outside'" },
	{ platform: "linux", output: "bash: /outside: Read-only file system" },
	{ platform: "linux", output: "Error: EROFS: read-only file system, open '/outside'" },
	...(HOST_DENIAL_OUTPUT === undefined ? [] : [{ platform: undefined, output: HOST_DENIAL_OUTPUT }]),
] as { platform?: NodeJS.Platform; output: string }[]) {
	test(`appends the block notice to a failed ${platform ?? "current-platform"} result reporting "${output}"`, () => {
		const result = bashResult(output);

		const noticed = appendSandboxBlockNoticeToResult(result, platform);

		expect(noticed).toStrictEqual({
			content: [{ type: "text", text: `${output}\n\nCommand exited with code 1${NOTICE_SUFFIX}` }],
			structuredContent: { output: `${output}${NOTICE_SUFFIX}`, truncated: false, exit_code: 1, wall_time_seconds: 0.1 },
		});
	});
}

for (const { name, platform, output, isError } of [
	{ name: "Permission denied on darwin", platform: "darwin", output: "bash: /outside: Permission denied", isError: true },
	{ name: "Permission denied on linux", platform: "linux", output: "bash: /outside: Permission denied", isError: true },
	{ name: "the linux phrase on darwin", platform: "darwin", output: "bash: /outside: Read-only file system", isError: true },
	{ name: "the darwin phrase on linux", platform: "linux", output: "bash: /outside: Operation not permitted", isError: true },
	{ name: "a successful result with the darwin phrase", platform: "darwin", output: "bash: /outside: Operation not permitted", isError: false },
	{ name: "both phrases on win32", platform: "win32", output: "bash: /outside: Operation not permitted; Read-only file system", isError: true },
	{ name: "another platform's phrase on the current platform", platform: undefined, output: OTHER_DENIAL_OUTPUT, isError: true },
] as { name: string; platform?: NodeJS.Platform; output: string; isError: boolean }[]) {
	test(`appends no block notice for ${name}`, () => {
		expect(appendSandboxBlockNoticeToResult(bashResult(output, isError), platform)).toBeUndefined();
	});
}

test("appends no block notice to a result whose isError is unset", () => {
	const { isError: _isError, ...result } = bashResult("bash: /outside: Operation not permitted");

	expect(appendSandboxBlockNoticeToResult(result, "darwin")).toBeUndefined();
});

test("block notice leaves the input result unchanged", () => {
	const result = bashResult("bash: /outside: Operation not permitted");
	const before = structuredClone(result);

	appendSandboxBlockNoticeToResult(result, "darwin");

	expect(result).toStrictEqual(before);
});

test("block notice goes on the last text block when a non-text block ends the result", () => {
	const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };

	const noticed = appendSandboxBlockNoticeToResult(
		{
			content: [{ type: "text", text: "bash: /outside: Operation not permitted" }, { type: "text", text: "Command exited with code 1" }, image],
			isError: true,
		},
		"darwin",
	);

	expect(noticed?.content).toStrictEqual([
		{ type: "text", text: "bash: /outside: Operation not permitted" },
		{ type: "text", text: `Command exited with code 1${NOTICE_SUFFIX}` },
		image,
	]);
});

test("block notice keeps a non-text block in place and goes after the last text block", () => {
	const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };

	const noticed = appendSandboxBlockNoticeToResult(
		{
			content: [{ type: "text", text: "bash: /outside: Operation not permitted" }, image, { type: "text", text: "Command exited with code 1" }],
			isError: true,
		},
		"darwin",
	);

	expect(noticed?.content).toStrictEqual([
		{ type: "text", text: "bash: /outside: Operation not permitted" },
		image,
		{ type: "text", text: `Command exited with code 1${NOTICE_SUFFIX}` },
	]);
});

test("block notice returns an absent structured content as undefined", () => {
	const noticed = appendSandboxBlockNoticeToResult(
		{
			content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
			isError: true,
		},
		"darwin",
	);

	expect(noticed).toStrictEqual({
		content: [{ type: "text", text: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}` }],
		structuredContent: undefined,
	});
});

test("block notice keeps structured content without a string output as it is", () => {
	const noticed = appendSandboxBlockNoticeToResult(
		{
			content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
			structuredContent: { output: null, exit_code: 1 },
			isError: true,
		},
		"darwin",
	);

	expect(noticed?.structuredContent).toStrictEqual({ output: null, exit_code: 1 });
});

test("block notice adds a text block when the phrase is only in the structured output", () => {
	const noticed = appendSandboxBlockNoticeToResult(
		{
			content: [],
			structuredContent: { output: "bash: /outside: Operation not permitted", exit_code: 1 },
			isError: true,
		},
		"darwin",
	);

	expect(noticed).toStrictEqual({
		content: [{ type: "text", text: BLOCK_NOTICE }],
		structuredContent: { output: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}`, exit_code: 1 },
	});
});

for (const { name, structuredContent } of [
	{ name: "an array", structuredContent: ["bash: /outside: Operation not permitted"] },
	{ name: "a string", structuredContent: "bash: /outside: Operation not permitted" },
]) {
	test(`block notice keeps ${name} structured content as it is`, () => {
		const before = structuredClone(structuredContent);

		const noticed = appendSandboxBlockNoticeToResult(
			{
				content: [{ type: "text", text: "bash: /outside: Operation not permitted" }],
				structuredContent,
				isError: true,
			},
			"darwin",
		);

		expect(noticed?.content).toStrictEqual([{ type: "text", text: `bash: /outside: Operation not permitted${NOTICE_SUFFIX}` }]);
		expect(noticed?.structuredContent).toBe(structuredContent);
		expect(noticed?.structuredContent).toStrictEqual(before);
	});
}

// A row without a platform uses the default, the current host.
for (const { platform, message } of [
	{ platform: "linux", message: "Error: EROFS: read-only file system, open '/outside'" },
	...(HOST_DENIAL_OUTPUT === undefined ? [] : [{ platform: undefined, message: HOST_DENIAL_OUTPUT }]),
] as { platform?: NodeJS.Platform; message: string }[]) {
	test(`text block notice appends the notice on ${platform ?? "the current platform"} to "${message}"`, () => {
		expect(appendSandboxBlockNotice(message, platform)).toBe(`${message}${NOTICE_SUFFIX}`);
	});
}

for (const { name, platform, message } of [
	{ name: "Permission denied", platform: "darwin", message: "bash: /outside: Permission denied" },
	{ name: "the other platform's phrase", platform: "linux", message: "Error: EPERM: operation not permitted" },
	{ name: "another platform's phrase on the current platform", platform: undefined, message: OTHER_DENIAL_OUTPUT },
] as { name: string; platform?: NodeJS.Platform; message: string }[]) {
	test(`text block notice appends nothing for ${name}`, () => {
		expect(appendSandboxBlockNotice(message, platform)).toBeUndefined();
	});
}

// ── Wrapper shape ───────────────────────────────────────────────

test(`sandbox wrappers pass the command as one quoted argument to "$0" -c with nothing added`, () => {
	const command = `printf '%s\\n' "it's quoted"\necho second line`;

	for (const wrapped of [wrapWithSandboxExec(command), wrapWithBwrap(command)]) {
		expectSuffix(wrapped, ` "$0" -c 'printf '"'"'%s\\n'"'"' "it'"'"'s quoted"\necho second line'`);
		expect(wrapped, wrapped).not.toContain("<<");
		expect(wrapped, wrapped).not.toContain(BLOCK_NOTICE);
		expect(wrapped, wrapped).not.toContain("2>&1");
	}
});

// ── buildMacProfile invariants ──────────────────────────────────

test("buildMacProfile rejects paths containing quotes", () => {
	expect(() => buildMacProfile("/tmp/evil'")).toThrow(/contain.*quote/);
	expect(() => buildMacProfile('/tmp/evil"')).toThrow(/contain.*quote/);
});

test("quotes dynamic Linux sandbox paths for the outer shell", () => {
	// Only the canonical form of /tmp (/private/tmp on macOS, a drive path on
	// Windows) and the path separator depend on the host.
	const tmpPrefix = `${resolveRealPath("/tmp")}${path.sep}`;
	const wrapped = wrapWithBwrap("true", "/tmp/readonly' ; echo injected; #");

	expect(wrapped).toContain(`--bind '${tmpPrefix}readonly'"'"' ; echo injected; #' '${tmpPrefix}readonly'"'"' ; echo injected; #'`);
	expect(wrapped).not.toContain(`--bind "${tmpPrefix}readonly' ; echo injected; #" "${tmpPrefix}readonly' ; echo injected; #"`);
});
