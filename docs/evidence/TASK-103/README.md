# TASK-103: SCREEN-015 admin usage report

- Route `/admin/usage` (`?from=&to=` as UTC dates), `apps/web/src/features/fe-screen-015/`, API-130 only (`adminUsageReport`).
- States built and baselined at 390, 768 and 1440 px: default, loading, empty, error (`service_unavailable`), window-too-large (client pre-check and api 422 `report_window_too_large`); `forbidden_role` shows the shell's unavailable state.
- Screenshots: `screenshots/`; axe results: `axe/` (zero violations); baselines: `apps/web/e2e/__baselines__/chromium/fe-screen-015-*.png`.
- E2E answers for API-130 are labelled contract mocks; one test (`real api`) proves the entry point reaches the running api (401 → sign-in). The real-integration proof is the flow ticket.

## Limitations and change requests
1. **CSV export (API-131) is not offered.** `apps/web/src/lib/api/client.ts` (outside this ticket's paths) runs `JSON.parse` on every response body, so a `text/csv` 200 raises `ApiMalformedResponseError`. A Export CSV button needs the client to pass non-JSON bodies through; a change request goes to the Orchestrator. The spec calls the CSV optional (Could).
2. The mobile screenshots show the shell's fixed bottom navigation mid-page because they are full-page captures; that is a capture artefact of CMP-031, not page content.
3. The ticket's `--findings reports/deps.json` does not exist in this repo: `scripts/ci/deps.sh` writes `reports/deps.sarif` (and `audit.json`); those are used.
4. Cards are plain token-styled sections (CMP-018 is not on this ticket's component list).
