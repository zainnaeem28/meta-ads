-- Compensating forward migration for TASK-032 (audit). Drops the audit tables; nothing else depends on them.
DROP TABLE IF EXISTS admin_alerts;
DROP TABLE IF EXISTS audit_events;
