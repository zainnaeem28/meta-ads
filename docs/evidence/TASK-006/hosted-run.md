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

## Round 1 review fixes (F1-F9)

- F1-F5, F9: `validate.sh` parses the workflow with a pinned `yq` 4.54.3 (release tarball, SHA-256 verified) and asserts structure: every `permissions` must be exactly `{}` at top level and `{contents: read}` per job (flow or block form), no job or step `continue-on-error`, no `if:` other than `always()` (first-key list items included), `quality-gate.needs` equals the required job set, the gate runs exactly `scripts/ci/quality-gate.sh --profile release`, each job runs its wrappers as their own lines with no `|| true`. Probes in `probe-6-workflow.txt`.
- F6: the PGDG key is checked against a pinned SHA-256 (`0144068502a1...`) before apt trusts it. Still unproven on a hosted runner until the first run.
- F7: the gate downloads each `reports-<job>` into its own folder, requires every job's artifact, and refuses to merge when two jobs wrote the same file (tested on a fixture).
- F8 (owner/ops item): a `pull_request` into `main` from a fork still starts a run unless the repository setting *Actions > General > Fork pull request workflows > Require approval for all outside collaborators* is on. The owner sets it; the workflow file cannot prove "fork PR creates no run".

## Acceptance map

- actionlint and `validate.sh` pass on the real workflow; removing a required job makes the gate fail: `probe-6-workflow.txt`.
- Trigger rules are literal `branches: [main]`; `validate.sh` rejects the default-branch variable.
