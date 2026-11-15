# TASK-023 evidence
Checks run with CI=1 on the branch: eslint, tsc, unit (264 passed, coverage lines 99.5 / branches 93.7), integration (30 passed, real api entry point `main.api.js` on the shared test PostgreSQL), scripts/ci/layers.sh (0 violations), scripts/ci/contract.sh, sast, deps, secrets (all PASS). Official report: the submit-check document uploaded on the task.
Note: TASK-022 integration expectations for POST /health/live changed from 400/404 to 405 (`Allow: GET, HEAD`), the TASK-023 router answers a method miss before the body is read.
