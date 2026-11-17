# TASK-106 evidence: FLOW-03 end to end (generate clips, QC, retry)

Spec: `apps/web/tests/e2e/flow-03/flow-03.spec.ts` (tags `@TASK-106 @TC-FLW-03 @FLOW-03`).
Run: `CI=1 pnpm exec playwright test apps/web/tests/e2e/flow-03 --config apps/web/tests/e2e/flow-03/playwright.config.ts --project=chromium`
(needs `ffmpeg` and `ffprobe` on the PATH or `FFMPEG_PATH` / `FFPROBE_PATH`; the shared test PostgreSQL; `pnpm build` first).

## What runs for real
Built web (`next start`), built api (`dist/main.api.js`), real PostgreSQL (throwaway database per run with the real
migrations' tables, pg-boss schema and price table), the api queues jobs in pg-boss, the worker handles them
(`production.video-submit`, `production.poll`, `video.copy-output`, `production.qc-run`), real FFmpeg and ffprobe extract
the audio of real clips for the quality check. The browser gets its bearer from `/local-token` and calls the api directly.

## What is a stand-in
- WaveSpeed and OpenAI answer from one local TLS server (`harness.mjs`); clips are stored in an S3 stand-in.
- The brief is seeded as accepted (its acceptance is FLOW-02). Accounts, keys and the spend already reserved (cap case) are
  inserted by SQL through the control server; the stub is steered through it (one clip fails once; one check mismatches).

## Not exercised by this e2e (AIU-259 decision D-1, condition C-6)
The worker runs in-process through `createWorkerApp` with a programmatic `Egress` that admits only the stub host
(allowed hosts, resolver and `isBlockedAddress` limited to 127.0.0.1, stub CA and port). The production entry
`main.worker.js` and the production egress wiring are therefore NOT exercised here; they are covered by the
startup-config tests, the TASK-008 container probe, the egress unit tests and the staging smoke.
Config goes through the real worker validator (`validateConfig('worker', ...)`); no `handlers` or `registry` override.

## Paths covered
Journey (keyboard only): SCREEN-007 accepted -> SCREEN-008 (4 clips, segment 2 fails with its cause class and Retry, no
automatic retry, Retry, QC review, segment 3 check fails then Re-run passes) -> SCREEN-009; Back; outcome unknown (never
re-sent by itself, explicit new clip); cap reached; key disabled; key missing; brief not accepted; leave and return while
clips run (no clip sent twice); session expiry; another account's campaign. Screenshots at 390 and 1440 px per step and
axe results (zero violations) are in `screenshots/` and `axe/`.

## Mismatches found and where they went
See the ticket's blocker task (browser-to-api path: `/local-token` envelope and client credentials vs api CORS).
