# TASK-115 evidence

- `run-fixtures.txt`: output of `CI=1 scripts/ci/security/run-fixtures.sh` (each custom Semgrep rule against its positive and negative fixture, the canary secret in a commit, in history and in a built bundle through the real wrappers, the clean tree scans, the push protection read-back). The canary is generated at run time and never stored.
- `push-protection.md`: host push protection read-back. Result is a recorded gap: the token cannot read `security_and_analysis` for the repository. Enabling GitHub secret scanning and push protection is a repository-owner action; re-run `scripts/ci/security/push-protection-readback.sh FILE` afterwards.
- `submit-check.md`: the `submit_check.py` report for the submitted commit.

## Wiring and follow-ups (outside this ticket's allowed paths)

- `scripts/ci/sast.sh` and `scripts/ci/secrets.sh` still use the baseline `scripts/ci/semgrep/rules.yml` and `scripts/ci/gitleaks.toml`. This ticket adds `scripts/ci/security/sast-custom.sh` and `secrets-custom.sh`, which keep the same wrapper contract (same report names, meta files and policy) and add `config/semgrep/` and `config/gitleaks.toml`. DevOps should point `sast.sh` and `secrets.sh` (and the `security` job in `ci.yml`) at these configs, or at these two scripts, so the release pipeline runs them.
- The bundle scan (`scripts/ci/security/bundle-scan.sh`) is proven on a synthetic client chunk. The scan of the real `apps/web/.next` runs once `pnpm build` produces it (no `node_modules` in this workspace, so no real bundle exists yet).
- The WaveSpeed key shape (`ws-` prefix) is verified against the stub fixtures only.
- Semgrep prefixes rule ids with the config path when a directory is passed (`config.semgrep.shroomap...`); the policy lists the stable `shroomap.*` ids.
