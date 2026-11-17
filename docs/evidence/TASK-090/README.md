# TASK-090 SCREEN-005 Campaigns (history, drafts, search and filters, delete)

- `apps/web/src/app/(operator)/campaigns/page.tsx`: the `/campaigns` route (`?tab=history|drafts&q=&status=&page=`), renders `CampaignsScreen`.
- `apps/web/src/features/fe-screen-005/`: `CampaignsScreen` (tabs with counts, search, status chips, list, paging, delete dialog, toast, key-missing banner), `model.ts` (URL state, row status and links, draft helpers), `copy.ts` (UI-UX §8, §9.1 and frame text).
- API: API-040 (`GET /campaigns`, `q`, `filter`, cursor), API-020 (`GET /drafts`), API-042 (`DELETE /campaigns/{id}`, 202), API-025 (`DELETE /drafts/{id}`, 204). The operator shell also reads API-001 (role) and API-010 (key state, key-missing banner), as every operator screen does.
- Errors: load failures go through `ErrorNotice` (UI-UX §9.1: internal_error, service_unavailable, rate_limited, unauthenticated); a delete failure (not_found, state_conflict, others) shows the §9.1 message inside the dialog and refreshes the list.
- States at 390 and 1440 px: default, loading, empty, no-results, error, delete-confirm, deleted, drafts, key-missing, menu-open. Screenshots in `screenshots/`, axe results (zero violations) in `axe/`, Playwright baselines in `apps/web/e2e/__baselines__/chromium/fe-screen-005-*`.
- Tests: `CampaignsScreen.test.tsx` and `model.test.ts` (MSW); `apps/web/e2e/fe-screen-005.spec.ts` (`@TASK-090`, 25 tests: states, keyboard-only search/chip/paging, both deletes, real-api entry point).

## Decisions and limits to know

- **Counts.** The api has no totals (cursor pages only). The tab and chip counts are read with one page of 50 per count (`limit=50`); more than 50 shows no count rather than a wrong one. A totals field in API-040/API-020 would replace these extra reads (Architect decision).
- **Paging.** `?page=N` is a client number over cursors: page N fetches pages 1..N-1 once (cached) and follows `nextCursor`; ids already shown on an earlier page are dropped so a campaign that moved is not repeated. Next is enabled by `hasNextPage`, so there is no "n rows" total (CMP-017 `Pagination` needs a total, so the footer is two CMP-003 buttons).
- **Drafts search and paging** run in the browser over the drafts list (API-020 has no `q`); the list is read in pages of 50, up to 300 drafts.
- **Search** is sent to API-040 from 2 characters; one character filters nothing.
- **CMP-027 extended (UXV-1, UXV-2, UXV-4; backward-compatible props):** a row action may be icon-only (`icon: 'trash-2'`, ghost, full name as aria-label and title, 44 px at 390); `segments` is optional (drafts omit it) and drafts use the file-text poster; `format` meta item and a badge `icon` are supported. Status badges carry CMP-012-style icons. **Contract gaps:** API-040 has no format (UXV-3: not shown) and no per-clip detail (badge detail text such as "2 of 3 generating" stays the short status). CMP-017 `FilterBar` still says "Clear all" for its own button; the no-results action reads "Clear filters". Footer reads "10 campaigns per page" (UXV-5).
- The e2e state tests answer API-001, 010, 020, 040, 042 and 025 with contract-shaped route mocks (labelled in the spec); the `real api` test calls the running built api through the built web app and checks it answers 401 and the user goes to sign-in. The real operator journey is the flow ticket.
- `apps/web/e2e/` and `apps/web/e2e/__baselines__/` are outside the ticket's allowed paths but are where the `--grep @TASK-090` test and its baselines must live (as for every earlier screen ticket).
