# Dependency bots and milestone rescans (DO-09, NFR-10)

## Dependabot

`.github/dependabot.yml` opens weekly (Monday), grouped PRs against **`dev`** for npm (`/`), GitHub Actions (`/`)
and the CI tool requirements (`/scripts/ci`). Hosted CI does not run on `dev` branches or ticket branches, so a bot
PR is judged on the server, like a ticket. Dependabot reads its config from the repository default branch, so
it starts only after the file reaches `main` (see `docs/evidence/TASK-015/bot-pr.md`).
Schema and policy check (target `dev`, weekly, grouped): `docs/evidence/TASK-015/check-dependabot.py`.

### Integrator procedure for a bot PR

1. Confirm the PR base is `dev` and the author is `dependabot[bot]`; touch only lockfiles, manifests, pins or
   workflow action versions. Anything else: close it and open a ticket.
2. Check out the PR head in a work copy (`workcopy.py open <ref>`), merge the latest `origin/dev`.
3. Run `CI=1 scripts/ci/submit-check.sh` (lint, types, layers, unit, contract, SAST, deps, secrets, probes). Any
   failure or new Critical/High finding: comment the failure on the PR, do not merge.
4. Run `scripts/ci/rescan.sh --dry-run`; it must pass.
5. Merge the PR alone into `dev` (squash), record the PR number, commit and report in the Integrator's ticket.
   Major-version updates (excluded from the groups) need a ticket and DevOps Reviewer review.

## Milestone rescan (server task, never a hosted schedule)

At each milestone the Orchestrator creates a DevOps task: `CI=1 scripts/ci/rescan.sh` from the latest `dev`.
It runs the same wrappers as the pipeline, each to completion even if an earlier one fails:

| Scan                           | Wrapper                                                                         | Report                                     |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| Dependencies                   | `deps.sh` (osv-scanner + pnpm audit)                                            | `reports/deps.sarif`, `reports/audit.json` |
| SAST                           | `sast.sh` (Semgrep, pinned rules)                                               | `reports/sast.sarif`                       |
| Secrets, **whole git history** | `secrets.sh` with `CI_SECRETS_FULL=1`                                           | `reports/secrets.sarif`                    |
| Container                      | `container.sh` (needs `CI_IMAGE_REF`; not applicable until a Dockerfile exists) | `reports/container.sarif`                  |
| IaC                            | `iac.sh`                                                                        | `reports/iac.sarif`                        |

Outputs: `reports/ci/rescan-junit.xml` (one case per scan), `reports/deps.json` (merged dependency findings),
`reports/rescan/summary.json`. Exit 1 on any Critical/High finding (policy `config/quality-policy.json`, reviewed
dismissals in `config/dispositions.json`), a secret of any severity, or a tool failure. A failure becomes
correction tickets through the Orchestrator. `--dry-run` scans secrets over the ticket range only and is the
per-ticket check.
