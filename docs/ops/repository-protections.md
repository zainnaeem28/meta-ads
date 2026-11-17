# Repository protections (DO-03)

Read back with `scripts/ci/protections-readback.sh --check`; the output is `docs/evidence/TASK-007/readback.txt`
and `reports/ci/protections-junit.xml`. Repository: `zainnaeem28/meta-ads`, private, user-owned, GitHub Free
(DEVOPS-PLAN 3.3, 3.4). The script prints PASS only for a control it read back; every control the plan cannot
hold is a GAP with an owner and a compensating control, and nothing is claimed as enforced that is not.

## Applied and read back

| Control            | State                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Default branch     | `dev` (set by this ticket, read back)                                                                           |
| Actions token      | read-only default, workflows cannot approve pull requests (read back)                                           |
| Deploy credentials | none stored in GitHub: 0 repository secrets, 0 environments, no `secrets.*` reference in a workflow (read back) |

## Gaps (recorded, listed in the go-live evidence as owner items)

| Control                                                   | Why                                                              | Owner item                     | Compensating control                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rulesets / branch protection for `main`, `dev`, `v*` tags | API returns 403 "Upgrade to GitHub Pro"                          | DOP-OI-2 (owner-only purchase) | Paperclip review stages, `submit-check` reports, the `quality-gate` job blocks a release workflow (not a push). Ruleset JSON is committed in `.github/rulesets/`; `protections-readback.sh --apply-rulesets` creates it the day the plan allows, then `--check` and `--probe-push` are rerun |
| Only the Integrator pushes `dev`                          | bypass actors need an organization                               | DOP-OI-2c                      | process control (WORKFLOW Branches)                                                                                                                                                                                                                                                          |
| Separate identities per duty                              | one managed token for all agents                                 | DOP-OI-2b                      | Paperclip task ownership and reviews; separation of duties is not claimed                                                                                                                                                                                                                    |
| Environments, environment secrets, deployment-branch rule | private repository, Free                                         | DOP-OI-2                       | no deploy credential in GitHub; release executor option S                                                                                                                                                                                                                                    |
| Fork-PR approval setting                                  | API 422 "not allowed for private repositories"                   | DOP-OI-2c                      | workflows trigger only on `pull_request`/`push` to `main` and `workflow_dispatch`; no `pull_request_target`; no outside collaborators                                                                                                                                                        |
| "Allow forking" off                                       | changeable only on organization-owned private repositories (422) | DOP-OI-2c                      | as above                                                                                                                                                                                                                                                                                     |

## Unauthorized push (TC-OPS-06): BLOCKED

Not attempted. No protection exists on `main`, so a push would succeed and change `main`, and a rejected
non-fast-forward push would not show a protection. `--probe-push` runs only after the `main` ruleset is read back
and then requires the push to be rejected. Result recorded in `readback.txt` as `BLOCKED`.
