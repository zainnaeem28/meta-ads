-- Compensating forward migration for M0001 (rollback check, run on a copy before go-live; after go-live the
-- runbook restores from the on-demand export instead). Extension, schemas, role grants and defaults stay.
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS rate_limit_buckets;
