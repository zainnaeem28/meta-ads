# Design source (AIU-14)

- `brand/`: owner logo files (`source/`), traced SVG geometry, `build-brand-assets.mjs`, SVG and icon outputs.
- `mockups/`: token-based HTML frames, renderer, axe check and overview composer. Rendered PNGs are build output (git-ignored except the two overview sheets); `png/manifest.json` lists every frame with its SHA-256.

Render: `cd design/mockups && NODE_PATH=<folder with playwright, pngjs, sharp, axe-core> node render-frames.mjs Inter`.
These are proposed mockups, not screenshots of the running product.
