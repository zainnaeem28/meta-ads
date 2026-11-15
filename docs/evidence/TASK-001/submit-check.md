# TASK-001 submit-check

The `submit_check.py --base origin/dev` report for the submitted commit is the task document `submit-check` on AIU-74 (it names the commit it ran on). Checks: frozen install, typecheck, lint, build, the foundation smoke suite (5 tests), `pnpm audit` (0 high or critical), gitleaks over the committed file set (0 findings).
