# TASK-077 evidence (CMP-025 Provider key card, CMP-026 Final preview, CMP-027 Campaign row, CMP-028 Metric tile)

- `packages/ui/src/components/cmp-025` (`@shroomap/ui/cmp-025`): `ProviderKeyCard` for OpenAI and WaveSpeed; states active, untested, disabled, none, testing, delete-confirm. Hint in monospace, actions named per provider, no reveal control, focus moves to "Keep key" when the delete confirmation opens.
- `cmp-026`: `FinalPreview` (assembling, done, failed, out-of-date); 9:16 player on `--surface-inverse`, max 220 px phone / 320 px desktop, controls, name and duration as its text alternative; Download is a button that calls `requestDownloadUrl` on every click.
- `cmp-027`: `CampaignRow` (history, draft; default, hover, focus-within, deleting); name is the only link (stretched), actions are separate buttons on a second line on phone.
- `cmp-028`: `MetricTile`, `InlineBar` (`role=meter` with a visible numeric label), `MetricGrid` (1 / 2 / 4 up); loading, value, no data; cost tiles read "(estimated)".
- Gallery: `apps/web/src/app/gallery/sections/fe-dom-b.tsx`; client demos `cmp-025|026|027/gallery-demos.tsx`.
- Tests: Testing Library + axe-core in each component folder; Playwright `@TASK-077` through the built web (`next start`) beside the built api; baselines `apps/web/e2e/__baselines__/chromium/dom-b-*` (new; UI/UX approves); screenshots in `screenshots/` (real Inter), axe results in `axe/` (zero violations at 390 and 1440 px).

## Limitations

- Chromium only; 768 px is not captured (the grids are asserted by class).
- Hover and focus are exercised by interaction in tests, not baselined per state; the delete-confirm baseline shows the focused "Keep" button.
- The player has no media file in the gallery (`src` empty), so the done state shows the empty player chrome; captions use an empty WebVTT data URI.
- Playwright ran against a throwaway database with only the pg-boss schema (the gallery does not call the api).
- Files outside the allowed list: `packages/ui/package.json` (subpath exports), `apps/web/e2e/dom-b.spec.ts` and baselines, and `gallery-demos.tsx` inside the component folders.
