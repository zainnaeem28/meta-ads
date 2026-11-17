# AIU-234: restore of TASK-045 files deleted by 562a3df (TASK-091 stale-tree merge)

Removed by 562a3df inside the allowed paths, all restored from f339aad:
- apps/api/src/modules/usage/application/aggregate.ts (UsageAggregator)
- apps/api/src/modules/usage/application/abuse.ts (AbuseMonitor)
- apps/api/src/modules/usage/application/abuse.test.ts
- apps/api/src/modules/usage/abuse.integration.test.ts
- apps/api/src/modules/usage/usage.module.ts (AbuseMonitor, UsageAggregator, USAGE_ABUSE_CONFIG, abuseConfigFrom; current file matched f339aad apart from these)
- docs/evidence/TASK-045/submit-check.md, integration-check.md

Added: usage/index.ts exports UsageAggregator, AbuseMonitor, USAGE_ABUSE_CONFIG and their types.

Other files 562a3df touched: only TASK-091 additions (apps/web fe-screen-006a, docs/evidence/TASK-091). No other ticket's files were removed.

Checks (apps/api): typecheck clean; eslint src/modules/usage clean; unit usage 6 files / 44 tests pass; integration usage 2 files / 25 tests pass (real PostgreSQL).
