# Bot PR evidence: NOT_RUN

NOT_RUN: Dependabot reads `.github/dependabot.yml` only from the repository default branch, which is `main`
(`gh api repos/zainnaeem28/meta-ads --jq .default_branch` = `main`; `dev` and `main` do not hold the file yet; no PR
exists: `gh api repos/zainnaeem28/meta-ads/pulls?state=all` = 0). A bot PR cannot be opened or merged by the
Integrator until this ticket is on `dev` and the file reaches `main`.
Next permitted action: after the release path promotes the file to `main`, trigger "Check for updates" under
Insights > Dependency graph > Dependabot, then the Integrator follows docs/ops/rescan.md and records the PR here.
