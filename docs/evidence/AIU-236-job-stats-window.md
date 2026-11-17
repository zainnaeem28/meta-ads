# AIU-236 production.jobStatsWindow(from, to, ownerId?)

Exported from `apps/api/src/modules/production/index.ts` (new file; also exports `VideoJobsService`, `JobStats`, `JobStatsWindow`).
`jobStats(since)` and its callers are unchanged.

```ts
interface JobStatsWindow extends JobStats {  // JobStats: windowStart, videoCreated, videoCompleted, videoFailed, videoCancelled, qcCreated
  readonly windowEnd: string;                // ISO, exclusive
}
VideoJobsService.jobStatsWindow(from: Date, to: Date, ownerId?: string): Promise<JobStatsWindow>
```

- Window is [from, to). created counters use `created_at`; completed/failed/cancelled count rows in that state whose `updated_at` (terminal transition time) is in the window. `qcCreated` uses qc_runs `created_at`.
- `ownerId` (optional) scopes every counter to one tenant; omitted = platform-wide like `jobStats`.
- Tests (production.integration.test.ts, real PostgreSQL): `from` inclusive / `to` exclusive, empty window, tenant isolation.
- Results: typecheck clean, eslint clean on production, production integration suite 19/19 passed.
