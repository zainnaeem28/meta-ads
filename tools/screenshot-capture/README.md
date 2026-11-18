# Screenshot capture of the built web app (AIU-29)

No Docker and no running api are needed: the fe-screen specs mock the browser's api calls with `page.route`; the web server only needs `POST /api/v1/dev/token` (local mode), which `stub-api.mjs` answers on 127.0.0.1:4100.

```bash
pnpm build   # then rebuild the web with the capture env baked in:
( cd apps/web && NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:4100 NEXT_PUBLIC_E2E_PROBE=1 GALLERY_ENABLED=true APP_ENV=test NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY= pnpm exec next build )
node tools/screenshot-capture/stub-api.mjs &
cd apps/web && EVIDENCE=1 NODE_ENV=test WEB_PORT=3187 pnpm exec playwright test --config playwright.shots.config.ts --workers=1 e2e/fe-screen e2e/shell-admin e2e/shell-op
```

Images land in `docs/evidence/TASK-xxx/screenshots` (tracked: `git checkout -- docs/evidence` afterwards, or set `EVIDENCE_DIR`). Known limit: the "real api" specs need the real api and fail against the stub; `toHaveScreenshot` baselines can fail when Inter misses the `font-display: optional` window (the capture shows the fallback face), so check the face before using an image.
