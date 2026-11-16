# TASK-047 campaigns 2/2: evidence notes

- API-040 `GET /campaigns`: signed cursor bound to owner, `q` and `filter` (a change of either needs a new first page, else 400 `cursor_invalid`);
  `q` trimmed, 2..100 characters, `%`, `_`, `\` escaped, `ILIKE ... ESCAPE '\'` on name or description (trigram GIN); sort `(updated_at desc, id desc)`
  on `campaigns_owner_active_idx`; `deleting` never listed. API-041 `GET /campaigns/{id}`: foreign, `deleting` and unknown IDs share one 404.
- `CampaignProgressReader` (`application/progress-reader.ts`): `progressFor` and `idsWithProgress` as in ARCHITECTURE §1.3. The `filter` is applied as
  `id IN (reader's set)`; `all` needs no reader call. `CampaignsEdge.progress` is where bootstrap passes production's implementation; until production
  exists the default reader knows no jobs (every campaign reads `in_progress`, brief `generating`; the three filters list nothing).
  `progressFor` returns a snapshot (progress, briefState, finalAvailable, jobCounts, latestAssemblyId, thumbstopperJobId), not only the label, because API-041 needs the rest.
- `HistoryService.assertOwner(tx, ownerId, id)` (404 for foreign or `deleting`) and `isActive(tx, id)` are exported for the later campaign slices (index.ts).
- Empty history and no match are the same shape by design (200, `data: []`); the client tells them apart by whether it sent `q` (tested).
- Proof through the real entry point: `transport/history.integration.test.ts` builds the api with `createApiApp` on real PostgreSQL and MinIO and uses `fastify.inject`.
  TC-HIS-01..11 are covered by the nine tests there plus the unit tests. The filter with a real reader is tested at the service level (same repository, same
  database) because bootstrap has no production reader yet.

Files outside the allowed paths (needed, append-only): `infrastructure/history.repository.ts` (the module's adapter folder; application cannot import drizzle),
`index.ts` exports, and the `reports/campaigns-list` junit and lcov entries in `apps/api/vitest.config.ts` and `package.json` that the ticket's report flags name.
