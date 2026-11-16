# TASK-075 evidence (CMP-021 File upload)

- `packages/ui/src/components/cmp-021` (subpath `@shroomap/ui/cmp-021`, no barrel). Image-only drop zone that is a labelled button opening the picker (Enter/Space, no drag-only path); states idle, drag-over, uploading (progress bar), processing, ready, rejected. Rejected rows show `reason` (the server message when there is one; local checks use `validateImageFile`: JPEG/PNG/WebP/GIF, 10 MiB). Each row has a polite live status text, a badge and a remove button. Tokens only (`--input`, `--primary-subtle`, `--destructive` via theme classes); reuses CMP-003, CMP-007, CMP-008.
- Gallery: `apps/web/src/app/gallery/sections/fe-comp-upload.tsx`; client demos in `cmp-021/gallery-demos.tsx` (pinned states and a simulated interactive upload).
- Tests: Testing Library + axe unit tests (rules, keyboard, picker, drop, every row state, demos); Playwright `@TASK-075` through the built web (`next start`) beside the built api: picker flow (ready / rejected with reason / remove), keyboard opens the file chooser, baselines at 390 and 1440 px with axe (0 violations, `axe/`). Baselines `apps/web/e2e/__baselines__/chromium/comp-upload-{390,1440}.png` are new; UI/UX approves. Screenshots with real Inter in `screenshots/`.

## Outside the allowed list (needed)
`packages/ui/package.json` (subpath exports), `apps/web/e2e/comp-upload.spec.ts`, `apps/web/e2e/__baselines__/chromium/comp-upload-*.png`.

## Limitations
- The product screen that uses it (SCREEN-006) and the real upload API are later tickets; the gallery demo simulates upload and processing, so nothing here claims real API integration.
- Hover/focus are reachable but only default states are baselined; chromium only; 768 px not captured.
