# TASK-016 first baseline (DO-10)

Recorded 2026-11-17T22:29:09.288Z by `tests/baselines/evidence.mjs` from the reports of the runs below. Target: the baseline stack of `tests/baselines/stack.mjs` (built api and web on the host, run-suffixed roles and a throwaway database on the shared test PostgreSQL, migrations, reference seed, 25 accounts with 5 running stub jobs each, synthetic sessions). Pass conditions are read from `config/quality-policy.json` (`baselines`).

## OWASP ZAP baseline (TC-NFR-10)

Tool: OWASP ZAP 2.17.0 (spider and passive scan, no active attack), contexts anonymous, user and admin. Scope: the stack's api (`/api/v1`, every operation of `packages/contracts/openapi.yaml` plus real read requests with real identifiers) and web origins only. Blocking severity: policy `failOn.sources.zap`.

| Context | Answered | 2xx | 401 share | By status |
| --- | --- | --- | --- | --- |
| anonymous | 211 | 57 | 38.9% | api:401=82 api:notSent=43 api:404=27 web:200=57 web:notSent=7 web:307=24 api:405=21 |
| user | 212 | 81 | 0.0% | api:200=18 api:notSent=43 api:404=28 api:400=43 api:403=32 web:200=63 web:notSent=8 web:307=2 web:404=5 api:405=21 |
| admin | 203 | 81 | 0.0% | api:200=26 api:notSent=43 api:404=28 api:400=67 api:202=1 web:200=54 web:notSent=7 web:404=4 web:307=2 api:405=21 |

Findings evaluation (`reports/findings/dast.json`): 0 blocking, 11 non-blocking, 6 dismissed by a time-limited disposition (`config/dispositions.json`, expires 2026-12-16). 

Result: sessions accepted in every authenticated context; medium findings below are filed as product defects (see Defects).

## k6 at the scaled-down NFR-01 target (TC-NFR-01)

Tool: k6 2.4.0. Mode: scaled. Target: 25 accounts, 10 virtual users, 5 running stub jobs per account, think 3 s, status poll 3 s, ramp 60 s, steady 600 s, read share 0.8, p95 at most 500 ms, error rate under 1%. Duration 668 s.

| Measure | Value |
| --- | --- |
| Requests | 2089 |
| Throughput | 3.13 req/s |
| Latency avg / med / p95 / p99 / max | 54.1 ms / 9.7 ms / 37.9 ms / 569.9 ms / 8323.6 ms |
| 401 answers | 0 |
| Unexpected answers | 0 |
| Capacity answers (429/502/503/504) | 0 |
| 5xx | 0 |
| Actions read / write | 1092 / 210 |
| DB connections (api role) max / mean of pool | 11 / 4.0 of 40 (333 samples) |

- PASS enough requests answered: 2089 requests
- PASS run not answered by 401s: 0.0% of requests were 401 (limit 5%): the run is not counted when the sessions were refused
- PASS p95 <= 500 ms: p95 37.9 ms
- PASS error rate < 1%: 0.00% (0 of 2089)
- PASS zero failures caused by capacity: 0 capacity answers (429/502/503/504), 0 server errors

Result: pass.

## Lighthouse CI and Playwright web-vitals (TC-NFR-02)

Tools: Lighthouse 13.6.0 (Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/159.0.0.0 Safari/537.36); Playwright web-vitals on Chromium 159.0.8154.6. Built production artifact (`next start`), 5 cold samples per route and profile, medians compared. Budgets: LCP at most 2500 ms, INP at most 200 ms, CLS at most 0.1, TBT at most 200 ms. Mode: baseline. Conditions: {"mobile":{"viewport":{"width":412,"height":823},"deviceScaleFactor":1.75,"cpuSlowdown":4,"rttMs":150,"downKbps":1638.4,"upKbps":750,"cache":"cold (fresh context per sample)","dataSet":"baseline dataset (25 accounts, 125 stub jobs)"},"desktop":{"viewport":{"width":1350,"height":940},"deviceScaleFactor":1,"cpuSlowdown":1,"rttMs":40,"downKbps":10240,"upKbps":10240,"cache":"cold (fresh context per sample)","dataSet":"baseline dataset (25 accounts, 125 stub jobs)"}}; Lighthouse simulated throttling of its own mobile and desktop presets; 2 parallel workers; host 4 CPUs, 1-minute load 10.8 at start and 10.8 at the end (a shared, busy host inflates TBT and LCP; the number is recorded, not corrected).

| Route | Profile | LH LCP | LH CLS | LH TBT | PW LCP | PW CLS | PW INP | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sign-in | mobile | 1010 | 0.000 | 70 | 1012 | 0.005 | 24 | pass |
| sign-in | desktop | 731 | 0.001 | 0 | 496 | 0.001 | 24 | pass |
| history | mobile | 4004 | 0.019 | 990 | 704 | 0.019 | 40 | budget-breach: LCP (lighthouse) 4004 > 2500; TBT 990 > 200 |
| history | desktop | 892 | 0.000 | 90 | 180 | 0.000 | 24 | pass |
| intake-wizard | mobile | 977 | 0.018 | 353 | 620 | 0.018 | 16 | budget-breach: TBT 353 > 200 |
| intake-wizard | desktop | 292 | 0.002 | 84 | 184 | 0.002 | 20 | pass |
| brief-review | mobile | 3762 | 0.001 | 927 | 628 | 0.001 | 32 | budget-breach: LCP (lighthouse) 3762 > 2500; TBT 927 > 200 |
| brief-review | desktop | 890 | 0.000 | 84 | 196 | 0.000 | 40 | pass |
| clips-status | mobile | 4216 | 0.001 | 1904 | 712 | 0.001 | 32 | budget-breach: LCP (lighthouse) 4216 > 2500; TBT 1904 > 200 |
| clips-status | desktop | 885 | 0.000 | 65 | 164 | 0.000 | 24 | pass |
| review-download | mobile | 3850 | 0.001 | 447 | 652 | 0.001 | 32 | budget-breach: LCP (lighthouse) 3850 > 2500; TBT 447 > 200 |
| review-download | desktop | 928 | 0.000 | 106 | 204 | 0.000 | 24 | pass |
| key-management | mobile | 934 | 0.041 | 662 | 612 | 0.010 | 40 | budget-breach: TBT 662 > 200 |
| key-management | desktop | 296 | 0.004 | 137 | 168 | 0.004 | 36 | pass |
| admin-usage-report | mobile | 3745 | 0.000 | 878 | 676 | 0.000 | 40 | budget-breach: LCP (lighthouse) 3745 > 2500; TBT 878 > 200 |
| admin-usage-report | desktop | 879 | 0.006 | 161 | 216 | 0.006 | 16 | pass |

Result: budget breaches recorded. n/o = not observed.

## Defects filed from this baseline

See the task comment of TASK-016: each blocking ZAP finding and each budget breach above is filed to its owner by the Orchestrator; this file only records the measurements.
