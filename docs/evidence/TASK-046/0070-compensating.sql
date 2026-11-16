-- Compensating migration for 0070_task-046-campaigns (M0008): removes both tables and their grants with them.
-- `drafts` first because it holds the foreign key to `campaigns`. Run on a copy by the rollback check; the harness
-- fixture directory (tests/integration/migrations-check/fixtures/compensating) is owned by the platform ticket.
DROP TABLE IF EXISTS drafts;
DROP TABLE IF EXISTS campaigns;
