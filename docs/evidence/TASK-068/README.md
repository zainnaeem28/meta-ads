# TASK-068 evidence: CMP-001 brand mark, icons, manifest, social preview, page metadata

- Component: `packages/ui/src/components/cmp-001` (`@shroomap/ui/brand`); artwork generated from the owner files in `design/brand/svg`, geometry and colours unchanged (tests compare every path and fill).
- Assets: `apps/web/public` (copied unchanged from `design/brand/icons`); metadata: `apps/web/src/app/layout.tsx` (origin read per request from `WEB_ORIGIN`, the configured web origin in `config/registry.json`).
- Screenshots: `screenshots/` (390 and 1440 gallery pages, each variant row, 1x and 2x lockup). Axe reports: `axe/`.
- Baselines: `apps/web/e2e/__baselines__/chromium/brand-*.png`; the gallery now has a CMP-001 section, so `icons-390/768/1440.png` were regenerated. UI/UX approves both before merge.

## Limits of this run (recorded, not hidden)
- The build host could run chromium only (headless shell, with system libraries supplied from extracted debs). Firefox, WebKit and iOS Safari projects are configured but did not start (host lacks system libraries); Microsoft Edge is not installable here. Android Chrome emulation ran and passed. These projects need a CI run.
- Inter does not load in the page in this host's headless chromium (`document.fonts` reports `error`, also on `origin/dev`: TASK-066 `design-import` and the TASK-067 home baselines fail the same way here). The brand baselines therefore capture the artwork only, with no text, and do not depend on Inter. Screenshots that include gallery captions show the fallback font and must be re-captured in CI for real-font parity.
- Real-device icon rendering and real link-preview unfurling are go-live evidence, not covered here.
