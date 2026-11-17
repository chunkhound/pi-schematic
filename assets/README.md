# Brand assets

Canonical sources for the pi-schematic mark. Edit here, then regenerate derived files.

| File                 | Role                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logo.svg`           | Tri-colour primary mark (static).                                                                                                  |
| `logo-mono.svg`      | Single-silhouette mark; `currentColor` inherits the surrounding text colour when the SVG is inlined (not when loaded via `<img>`). |
| `logo-animated.svg`  | Animated "Tetris" intro. **Canonical source** for the GIF.                                                                         |
| `logo-animated.gif`  | Rendered animation used as the README hero and the pi.dev gallery preview (`pi.image` in `package.json`).                          |
| `social-preview.png` | GitHub repository social preview. Uploaded manually via repository Settings; not consumed by the build.                            |

## Geometry

Every mark shares Pi's 5x5 grid (origin `106.6125`, unit `117.355`) and palette (`#F09082`, `#4D9ABF`, `#F1BE58`). `tests/unit/brand-assets.test.ts` asserts the same cell set across all three SVGs, so geometry edits must be applied to every variant.

## Regenerating the GIF

The animated SVG is canonical; the GIF is a 360x360 transparent raster export with a 6 s loop (any SVG rasterizer works, e.g. `resvg` or `rsvg-convert`). See the [Brand asset references convention](../docs/conventions/brand-asset-references.md).

## Social preview

`social-preview.png` is uploaded in GitHub → Settings → Social preview. GitHub recommends 1280x640 (2:1); the current file is 1280x630.
