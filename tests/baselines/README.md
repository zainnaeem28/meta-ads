# Baselines (TASK-016, DO-10)

The runnable baselines of QUALITY-RELEASE-PLAN section 6, against a stack started from the repository with no account
and no credential:

| Wrapper                         | Tool                                   | Case                 | Report                                                                     |
| ------------------------------- | -------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `scripts/ci/dast.sh --baseline` | OWASP ZAP (spider and passive)         | TC-NFR-10            | `reports/zap.json`, `reports/findings/dast.json`, `reports/baselines/zap/` |
| `scripts/ci/load.sh --scaled`   | k6                                     | TC-NFR-01            | `reports/baselines/load.json`                                              |
| `scripts/ci/lighthouse.sh`      | Lighthouse CI and Playwright vitals    | TC-NFR-02            | `reports/baselines/frontend.json`                                          |
| `tests/baselines/negative.sh`   | the three above, with refused sessions | TC-NFR-10, TC-NFR-01 | `reports/baselines/negative/`                                              |

All of them append their cases to `reports/baselines/junit.xml` (`lib/results.mjs`), the file `submit_check.py --junit` reads.

- **Stack** (`stack.mjs up|down --state DIR`): the built api and web, a uniquely named database with run-suffixed roles on
  the shared test PostgreSQL (`BASELINE_ADMIN_URL`), the real migrations, jobs install and the reference seed, then the
  baseline dataset (25 accounts, 5 running stub jobs each, an administrator). Synthetic sessions: bearer tokens signed
  with a throwaway key whose key set the api reads through `support/clerk-stub-preload.mjs` (the one provider call it
  answers locally), and the web's local session cookie. Build first (`pnpm build`); the web is rebuilt when the api
  origin it bakes in changes.
- **Pass conditions** are read from `config/quality-policy.json` (`baselines`, `failOn.sources.zap`); nothing is
  hard-coded in the scripts. The tools are installed by `install-tools.sh` (pinned, checksummed).
- **Modes.** `dast.sh --baseline` and `lighthouse.sh` record the first baseline: findings and budget breaches are written
  to the report and filed as product defects, the run still succeeds. `dast.sh` without `--baseline` and
  `lighthouse.sh --enforce` are the gate (QA, AIU-31 and AIU-32). `load.sh --scaled` always enforces. An invalid run
  always fails: sessions refused (more than the policy's share of 401s), too few requests or samples, a signed-in route
  that redirected to sign-in. `--smoke` shortens a run and marks it as not a baseline.
- **Sampling.** Lighthouse and the Playwright vitals run `BASELINE_CONCURRENCY` (default 2) workers on the host; the
  number is recorded with the result.
