# TASK-006 hosted CI evidence

Commit under test: see the `submit-check` report on the ticket (branch `feature/AIU-129-…`, pushed to `origin`).

## One manual hosted run: `not run: hosted CI unavailable` (workflow not yet on a branch GitHub can dispatch)

- `gh workflow run ci.yml --ref main` → `HTTP 404: Not Found (…/actions/workflows/ci.yml)`. `GET /repos/zainnaeem28/meta-ads/actions/workflows` lists no workflow: `.github/workflows/ci.yml` exists only on this ticket branch. `dev` (the default branch) and `main` (holds only `README.md`) do not have it yet, and this ticket may not write to either. GitHub dispatches only a workflow that exists on the default branch.
- **Next permitted action** (after the Integrator merges this ticket into `dev`): `gh workflow run ci.yml --ref dev`, then record the run ID and the downloaded `quality.json` here. Once `main` holds the file the run uses `--ref main` (DEVOPS-PLAN 3.2). This is a follow-up item, not a pass.
- Meanwhile the same wrappers ran on the server (below).

## Probe 8 (triggers), what has been seen so far

| Event | Expected | Seen |
| --- | --- | --- |
| push of this `feature/AIU-129-…` branch to `origin` | no run | `GET /actions/runs` total_count = 0 after the push: PASS |
| push to `dev`, tag push, schedule, fork PR | no run | not yet testable (no workflow on `dev`); `validate.sh` rejects any `schedule`, `tags`, `pull_request_target`, `workflow_run` or non-literal-`main` trigger (see probe-6-workflow.txt) |
| PR into `main`, push to `main`, manual run | a run | NOT_RUN until the workflow is on `dev`/`main` |

## Same wrappers on the server (scripts/ci/*.sh with CI=1, tools pinned and checksum-verified)

lint, types, layers, contract (stub until TASK-019), unit (40 tests, coverage 98.0 % lines / 96.2 % branches), sast, deps, deps-audit, secrets, iac, build, container and e2e (both not applicable: no Dockerfile or Playwright config yet) all exit 0; `scripts/ci/validate.sh` (actionlint 1.7.12 + pinned-action/permission/trigger check) exits 0.

`integration.sh`: the database suite `db-roles.test.ts` failed with `spawnSync pg_dump ENOENT`, because this server has no PostgreSQL client. The two slice suites passed. The hosted `integration` job installs `postgresql-client-17` from the PGDG apt repository before the suite, so this is a server-environment gap and has not been proven green on a hosted runner. It is the first thing to check in the first hosted run.

`dast-baseline` has no wrapper in `scripts/ci/` yet (outside this ticket's allowed paths): the job prints "not applicable: no compose stack yet" and fails if a compose stack appears before a wrapper does. A `scripts/ci/dast.sh` change request goes to the Orchestrator.

## Acceptance map

- actionlint and `validate.sh` pass on the real workflow; removing a required job makes the gate fail: `probe-6-workflow.txt`.
- Trigger rules are literal `branches: [main]`; `validate.sh` rejects the default-branch variable.
