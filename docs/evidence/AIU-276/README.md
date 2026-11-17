# AIU-276 — NewBriefWizard focus-assertion flake (L2, owner TASK-091)

Cause: five `toHaveFocus()` assertions in `fe-screen-006a/NewBriefWizard.test.tsx` ran synchronously right after a render/click; focus moves in a post-commit effect, so under full-suite load the assertion could run first.
Fix: each focus assertion is wrapped in `waitFor` (test-only; component unchanged).
Checks (NODE_ENV=test CI=1, apps/web): 006a suite 3 consecutive runs 15/15 pass; full web suite 43 files / 440 tests pass.
