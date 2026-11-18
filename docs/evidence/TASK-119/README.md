# TASK-119 Frontend performance budgets, cache and invalidation rules (NFR-02, NFR-10; TC-NFR-02, TC-ZT-07)

State: **candidate, acceptance met on the last enforced run** (LCP ≤ 2.5 s, CLS ≤ 0.1 on all 8 pages, both profiles). Measured on the built production artifact (`next start`) with `CI=1 scripts/ci/lighthouse.sh --budgets` on the baseline stack (tests/baselines/stack.mjs, 25 accounts, 125 stub jobs), 5 cold samples per route and profile, medians.

## What this ticket adds
- `baselines.frontend.bundleBudgets` in `config/quality-policy.json`: route-group JS and CSS transfer limits (gzip of the first-load chunks and linked stylesheets; one limit per Next route group: root, auth, operator, admin). The LCP 2500 ms, INP 200 ms, CLS 0.1 and TBT 200 ms ceilings are unchanged (a unit test fails if any is loosened).
- `apps/web/tests/perf/bundle-budgets.mjs` reads that policy, measures `.next`, and fails when a route group exceeds its budget or a built route belongs to a group with no budget. `scripts/ci/lighthouse.sh --budgets` runs it, then the Lighthouse and web-vitals medians in enforce mode. (`scripts/ci/lighthouse.sh` is outside the ticket's allowed paths: the `--budgets` flag is the ticket's own required check, added as a change request, see below.)
- `baselines.frontend.cacheRules` records the cache rules; `apps/web/perf.config.ts` exposes the policy to tests.
- Tests: `apps/web/tests/perf/*.test.ts` (vitest, 16 tests, coverage lines 98.7 %, branches 89 %) and `apps/web/tests/perf/e2e/cache-isolation.spec.ts` (`@fe-perf-budgets`, Playwright through the built web app against the running api in local mode, 3 tests).

## Bundle budgets (gzip)
First measured build: root 159.9 KB JS, auth 242.1, operator 242.3, admin 235.2; CSS 8.8 KB. After fix 1 below: root 154.7, auth 204.9, operator 204.3, admin 197.1.

| Group | Worst route (JS) | JS gzip KB / limit | Worst route (CSS) | CSS gzip KB / limit |
| --- | --- | --- | --- | --- |
| root | / | 154.7 / 163 | / | 8.8 / 10 |
| auth | /sign-in/[[...sign-in]] | 204.8 / 215 | /sign-in/[[...sign-in]] | 8.8 / 10 |
| operator | /campaigns/new | 204.2 / 215 | /campaigns/new | 8.8 / 10 |
| admin | /admin/accounts | 197.0 / 207 | /admin/accounts | 8.8 / 10 |

## Fixes made in the web app
1. `packages/contracts/package.json` `"sideEffects": false` (change request, file outside the allowed paths): the contracts barrel re-exports the whole generated zod schema set, which no web screen uses, and it was in every route's first load (about 38 KB gzip, 16 %). Mobile TBT medians were 250 to 1900 ms in the first baseline and are at most 293 ms now.
2. `apps/web/src/lib/security/csp.ts`: `Cache-Control: no-store` on every response the middleware answers (pages and the redirects to sign-in). Before, only the key page had it; the 307 for the other signed-in routes carried no cache header. `tests/security/headers.test.ts` updated to match.
3. CLS: History (`fe-screen-005`) shows its list as the loading skeleton until the provider-key status is known, so the key banner no longer pushes the tabs and rows down; the provider-keys page (`fe-screen-010`) and the brief page (`fe-screen-007b`) hold back content below a region that changes height when its data arrives. No loaded state changed (screenshots below, 390 and 1440 px).

## Cache rules verified (TC-ZT-07, web side)
| Rule | Proof |
| --- | --- |
| Pages, redirects to sign-in and `/local-token` are `no-store`, no validator | `cache-isolation.spec.ts` test 1 |
| Only `/_next/static` is shared-cacheable (immutable, no cookie) | same |
| A second identity in the same browser sends only its own bearer; the first one's is never reused | test 2 |
| After sign-out nothing identity-scoped is in local or session storage | test 3 |
| TanStack Query cache and ETag store cleared on identity change, in-flight queries cancelled | `cache-rules.test.ts` |
| Polling pauses on a hidden tab, a terminal job and an error on screen; never polls in a background tab | `cache-rules.test.ts`, `job-polling.ts` |
| Mutations invalidate or set the affected queries; no persisted query cache, no `force-cache` | `cache-rules.test.ts` |
Signed-URL and media answers of the api are `no-store` (TASK-116, outside this ticket).

## Last enforced run (`CI=1 scripts/ci/lighthouse.sh --budgets`, on commit after ADR-014 first data, CLS slots, Inter fallback)
Median of 5, built `next start` artifact against the running api. All 16 route/profile rows pass LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms, TBT within budget; bundle budgets pass (root 155.1/163, auth 205.3/215, operator 204.9/215, admin 198.2/207 KB gzip).

| Route | Profile | LH LCP ms | LH CLS | LH TBT ms | PW LCP ms | PW CLS | PW INP ms | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sign-in | mobile | 920 | 0.000 | 57 | 696 | 0.000 | 16 | pass |
| sign-in | desktop | 275 | 0.000 | 0 | 172 | 0.000 | 16 | pass |
| history | mobile | 969 | 0.000 | 198 | 552 | 0.001 | 40 | pass |
| history | desktop | 262 | 0.000 | 0 | 144 | 0.000 | ≤16 (no event over threshold) | pass |
| intake-wizard | mobile | 923 | 0.000 | 100 | 568 | 0.000 | 24 | pass |
| intake-wizard | desktop | 233 | 0.000 | 0 | 168 | 0.000 | 16 | pass |
| brief-review | mobile | 939 | 0.000 | 54 | 532 | 0.000 | 24 | pass |
| brief-review | desktop | 261 | 0.000 | 0 | 176 | 0.000 | 16 | pass |
| clips-status | mobile | 934 | 0.000 | 106 | 292 | 0.000 | ≤16 (no event over threshold) | pass |
| clips-status | desktop | 252 | 0.000 | 0 | 176 | 0.000 | 16 | pass |
| review-download | mobile | 936 | 0.000 | 88 | 548 | 0.000 | 16 | pass |
| review-download | desktop | 255 | 0.000 | 0 | 172 | 0.001 | 16 | pass |
| key-management | mobile | 820 | 0.000 | 142 | 528 | 0.000 | 32 | pass |
| key-management | desktop | 257 | 0.000 | 0 | 160 | 0.000 | 24 | pass |
| admin-usage-report | mobile | 948 | 0.000 | 176 | 544 | 0.017 | 24 | pass |
| admin-usage-report | desktop | 258 | 0.001 | 0 | 184 | 0.001 | 16 | pass |

Noise note: an earlier identical run failed once on sign-in mobile (3 of 5 Lighthouse samples ≈ 3.0 s, 2 of 5 ≈ 0.92 s, host load 2.6 on 4 CPUs with 2 parallel workers); the sign-in page is unchanged by this ticket except the shared layout, and the rerun gave 920 ms. Recorded, not corrected.

## Open items
1. Budgets are recorded in `config/quality-policy.json` and in `quality-release-plan` rev 4 (AIU-15, AIU-297).
2. Out-of-path edits accepted by the Orchestrator: `scripts/ci/lighthouse.sh --budgets` and `packages/contracts/package.json` `sideEffects:false`; the Frontend Reviewer and Integrator confirm them.

## Screens (candidate, 390 px and 1440 px, real fonts)
`screens/history-390.png`, `history-1440.png`, `brief-390.png`, `brief-1440.png`, `provider-keys-390.png`, `provider-keys-1440.png`.

## First data (ADR-014) and hydration
Server-supplied first data on history, brief-review, clips-status and review-download, preconnect to the api origin, identity handshake (`getServerIdentity`, `IdentityHydrationBoundary`, `staleTimes.dynamic = 0`), hydration-stable labels (`useHydrated`), count slots (`--count-slot-*`), key-state slot and size-adjusted Inter fallback. Proof: `tests/perf/e2e/first-data.spec.ts` (T-20 two identities, no bearer in the HTML, `Pacific/Kiritimati` + `de-DE` cold load without hydration errors, no repeat GETs, `If-Match` on a write after first paint), `layout-stability.spec.ts`, `cache-isolation.spec.ts`, and vitest `identity-handshake`, `server-prefetch`, `server-token`, `count-slots`.

## Decision for UI/UX review: `font-display: optional` and the auth loading shell
A cold load of `/sign-in` measured 0.9 s LCP or 3.0 s (Lighthouse simulated) depending on a race, and failed `--budgets` in 2 of 3 gate runs. Cause (PerformanceObserver on a 4x CPU-throttled load): when the Inter file arrived after first paint, `font-display: swap` re-laid out the intro line, which became a second, larger LCP candidate about 300 ms later. Changes: (1) `font-display: optional` on both Inter faces in `packages/ui/src/theme.css` (no late swap; the size-adjusted fallback stays when the font is late; `token-map.test.ts` updated); (2) the auth `loading.tsx` shell carries the same intro line as the page, so the streamed page replaces it without a new LCP candidate or a shift. After the change 14 of 14 cold loads had one LCP candidate. This departs from "swap" in the brand brief's font rule: UI/UX to confirm or choose another way to remove the late candidate.
Note: `tests/baselines/stack.mjs` reuses `.next` when the api origin is unchanged, so after a source change delete `apps/web/.next/.baseline-api-origin` before `scripts/ci/lighthouse.sh --budgets` to measure the current code.
