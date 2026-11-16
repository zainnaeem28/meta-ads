-- Compensating migration for 0050_task-044-usage (M0006): removes the three usage tables and their grants with them.
-- Run on a copy by the rollback check; the harness fixture directory is owned by the platform ticket.
DROP TABLE IF EXISTS spend_reservations;
DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS price_table;
