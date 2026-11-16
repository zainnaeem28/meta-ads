# TASK-077 evidence (CMP-025 Provider key card, CMP-026 Final preview, CMP-027 Campaign row, CMP-028 Metric tile)

- `packages/ui/src/components/cmp-025` (`@shroomap/ui/cmp-025`): `ProviderKeyCard` for OpenAI and WaveSpeed; states active, untested, disabled, none, testing, delete-confirm. Hint in monospace, actions named per provider, no reveal control, focus moves to "Keep key" when the delete confirmation opens.
- `cmp-026`: `FinalPreview` (assembling, done, failed, out-of-date); 9:16 player on `--surface-inverse`, max 220 px phone / 320 px desktop, controls, name and duration as its text alternative; Download is a button that calls `requestDownloadUrl` on every click.
- `cmp-027`: `CampaignRow` (history, draft; default, hover, focus-within, deleting); name is the only link (stretched), actions are separate buttons on a second line on phone.
- `cmp-028`: `MetricTile`, `InlineBar` (`role=meter` with a visible numeric label), `MetricGrid` (1 / 2 / 4 up); loading, value, no data; cost tiles read "(estimated)".
- Gallery: `apps/web/src/app/gallery/sections/fe-dom-b.tsx`; client demos `cmp-025|026|027/gallery-demos.tsx`.
- Tests: Testing Library + axe-core in each component folder; Playwright `@TASK-077` through the built web (`next start`) beside the built api; baselines `apps/web/e2e/__baselines__/chromium/dom-b-*` (new; UI/UX approves); screenshots in `screenshots/` (real Inter), axe results in `axe/` (zero violations at 390 and 1440 px).

## Limitations

- Chromium only. 768 px is captured for the metric grid and the campaign rows (2 up asserted by computed columns); component cells are captured at 390 and 1440 px.
- Every provider has all six key-card states in the gallery; the cost tile has loading and no-data cells; campaign-row hover and focus have their own baselines (`dom-b-campaign-row-hover|focus-*`).
- The done and out-of-date players show a real poster image; the gallery has no video file, so playback is not exercised.
- Playwright ran against a throwaway database with only the pg-boss schema (the gallery does not call the api).
- Files outside the allowed list: `packages/ui/package.json` (subpath exports), `apps/web/e2e/dom-b.spec.ts` and baselines, and `gallery-demos.tsx` inside the component folders.
