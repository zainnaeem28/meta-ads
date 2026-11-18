# TASK-119 Frontend performance budgets, cache and invalidation rules (NFR-02, NFR-10; TC-NFR-02, TC-ZT-07)

State: **candidate, acceptance NOT fully met** (see Open items). Measured on the built production artifact (`next start`) with `CI=1 scripts/ci/lighthouse.sh --budgets` on the baseline stack (tests/baselines/stack.mjs, 25 accounts, 125 stub jobs), 5 cold samples per route and profile, medians.

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

## Last enforced run (`lighthouse.sh --budgets`, after the fixes)
| Route | Profile | LH LCP | LH CLS | LH TBT | PW LCP | PW CLS | PW INP | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sign-in | mobile | 934 | 0.005 | 115 | 888 | 0.005 | 32 | pass |
| sign-in | desktop | 663 | 0.004 | 0 | 468 | 0.001 | 16 | pass |
| history | mobile | 3691 | 0.017 | 121 | 2308 | 0.117 | 32 | fail |
| history | desktop | 817 | 0.002 | 0 | 244 | 0.071 | ≤16 (no event over threshold) | pass |
| intake-wizard | mobile | 913 | 0.018 | 105 | 636 | 0.018 | 16 | pass |
| intake-wizard | desktop | 257 | 0.002 | 0 | 172 | 0.002 | 24 | pass |
| brief-review | mobile | 3681 | 0.146 | 293 | 2284 | 0.152 | 20 | fail |
| brief-review | desktop | 817 | 0.001 | 0 | 464 | 0.001 | 16 | pass |
| clips-status | mobile | 3667 | 0.048 | 108 | 344 | 0.001 | ≤16 (no event over threshold) | fail |
| clips-status | desktop | 801 | 0.080 | 0 | 452 | 0.071 | 16 | pass |
| review-download | mobile | 3548 | 0.025 | 108 | 2320 | 0.012 | 16 | fail |
| review-download | desktop | 789 | 0.031 | 0 | 464 | 0.029 | 24 | pass |
| key-management | mobile | 923 | 0.006 | 132 | 604 | 0.006 | 20 | pass |
| key-management | desktop | 796 | 0.001 | 0 | 464 | 0.001 | 24 | pass |
| admin-usage-report | mobile | 930 | 0.000 | 141 | 612 | 0.000 | 16 | pass |
| admin-usage-report | desktop | 252 | 0.006 | 0 | 176 | 0.007 | 16 | pass |

## Open items (acceptance not met)
1. **Mobile LCP (Lighthouse, simulated) 3.5 to 3.7 s on history, brief-review, clips-status and review-download.** Observed LCP in the browser is about 0.2 to 0.3 s and Playwright's own LCP is 2.3 s; Lighthouse's simulated figure follows the dependency chain scripts (about 205 KB gzip at 1.6 Mbps and 4x CPU) then hydrate, `/local-token`, CORS preflight and the 8 parallel api calls of the history screen, then render of the data-dependent element (the key-status banner or a row). Bundle and TBT fixes cut it from about 4.0 to 3.6 s; the remaining 1.1 s needs a change to how first data reaches the page (server-supplied first data or an earlier token and api start), which is an architecture decision, not a local fix. Filed to the Orchestrator for the Solution Architect.
2. **CLS on mobile** remains 0.117 (history, Playwright) and 0.15 (brief-review): staggered status-chip and tab counts widen chips after first paint (needs reserved width in the shared FilterBar and Tabs components, UI/UX and `packages/ui`) and the shell's key-state chip in the header grows from 70 to 122 px (`cmp-030`).
3. The font swap (`font-display: swap`, Inter) shifts text on a cold load (about 0.02); a size-adjusted fallback or preload needs the `packages/ui` theme and a design decision.
4. Budgets are recorded in `config/quality-policy.json`; the quality plan document revision (`quality-release-plan`) was not edited from this workspace and needs the matching entry from the Quality owner.

## Screens (candidate, 390 px and 1440 px, real fonts)
`screens/history-390.png`, `history-1440.png`, `brief-390.png`, `brief-1440.png`, `provider-keys-390.png`, `provider-keys-1440.png`.
