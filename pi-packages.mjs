// pi-coding-agent ships its own copies of the pi packages and of typebox, and loads those copies
// at runtime. Resolving a specifier with pi's package.json as its parent gives the extension the
// same copies, so it shares pi's module-level state (registries, keybindings) and checks schemas
// with the typebox pi itself uses. This is not a copy of pi's own resolution: pi additionally maps
// some entries, such as pi-ai's `/compat` entry, which the extension needs only when it imports
// that entry itself.

import { findPackageJSON } from "node:module";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Package.json of the installed pi-coding-agent; test module resolution uses its directory as the parent. */
export const piManifestPath = findPackageJSON(PI_PACKAGE, import.meta.url);
if (piManifestPath === undefined) throw new Error(`Cannot find the package.json of ${PI_PACKAGE}`);

/** Packages pi loads itself, so the extension must share pi's instances of them. */
export const PI_SHARED_PACKAGES = /^(?:@earendil-works\/(?:pi-ai|pi-tui|pi-agent-core)|typebox)(?:\/.*)?$/;
