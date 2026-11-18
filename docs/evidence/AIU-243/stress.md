# AIU-243 stress evidence
Two integration files (production-worker, account-lifecycle; 29 tests) run 10 consecutive times
under CPU load (6 busy-loop processes) on the shared test PostgreSQL: 10/10 passed, 29/29 tests each run.
Fix: periodic recovery sweep stopped in tests (test-support helper) and fixed delays replaced by waiting on observable state; assertions unchanged.
