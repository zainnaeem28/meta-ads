# TASK-117: browser and device matrix (`@matrix`)

Run (from `apps/web`, after `pnpm build`): `CI=1 REPORT_DIR=reports/matrix pnpm exec playwright test --config tests/matrix/playwright.config.ts --grep @matrix`
(the same `matrix-*` projects are in `apps/web/playwright.config.ts`; the ticket's own config only adds the throwaway pg-boss database the built api needs, like TASK-118).

- Journeys: sign-in, FLOW-01 (wizard), FLOW-02 (brief), FLOW-03 (clips), FLOW-04 (assemble/download screen) on each project. Per project: no sideways scroll, full-page baseline (0.1 % pixels), browser version recorded in `versions/`. Phones: touch targets >= 44 px and no sideways scroll at 320 px.
- Zero-test rule: the global setup tries to start each project's browser. A project whose browser starts must pass every journey, or `tests/matrix/teardown.ts` fails the run. A project whose browser cannot start skips with its launch error as the reason, is listed in `not-executed.json` and the run output (`[matrix] NOT EXECUTED`), and never counts as passed. The run also fails if no project could launch.
- Reads are labelled contract-shaped mocks (the a11y suite's groups); sign-in and unanswered calls reach the real api.

## State on this server (2026-11-17)

| Project | Engine | Result |
| --- | --- | --- |
| matrix-chromium | Chrome for Testing 159.0.8154.6 | **executed**: 6 passed against the baselines |
| matrix-android-chrome (Pixel 7) | Chrome for Testing 159.0.8154.6 | **executed**: 6 passed against the baselines, touch targets >= 44 px, no sideways scroll at 320 px |
| matrix-firefox, matrix-webkit, matrix-ios-safari | Firefox / WebKit not launchable | **NOT EXECUTED**: system libraries missing (libgtk-3, libXcursor, libpangocairo, ...), no root. No baselines exist. |
| matrix-edge | none | **NOT EXECUTED**: Edge stable channel not installed (`/opt/microsoft/msedge`). No baseline exists. |

The four projects stay configured and enabled: on a machine where their browser starts they run unskipped and must pass (first run records baselines with `--update-snapshots=missing`, then UI/UX approves).

## Go-live owner item (from AIU-261, cancelled: needs root on the host)

Firefox, WebKit/iOS Safari and Edge matrix projects were not executed on this server. Operator steps: `pnpm exec playwright install-deps firefox webkit`, `pnpm exec playwright install firefox webkit`, install Microsoft Edge stable (`/opt/microsoft/msedge`), run the matrix, record the four missing baselines, UI/UX approval. Real-device runs are also go-live evidence (TC-H-09).

## Touch-target fix (AIU-262, commit 5096d14)

The earlier failures (`ShrooMap home` 136x38, `Campaigns` breadcrumb 74x20) are fixed by AIU-262 in CMP-001 and CMP-033; this branch merges that commit so the phone check passes. The brief, clips and final baselines were regenerated for the taller breadcrumb row and need UI/UX approval. UI/UX approval of all baselines is outstanding.
