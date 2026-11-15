-- Probe stand-in for the role-related part of M0001 (TASK-025 owns the real migration).
-- Role names are the tokens {{migrator}}, {{api}}, {{worker}} and {{backup}}; the test replaces them with
-- the run-suffixed names before `drizzle-kit migrate` runs. Executed as app_migrator.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
CREATE SCHEMA pgboss;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO {{api}}, {{worker}}, {{backup}};--> statement-breakpoint
GRANT USAGE ON SCHEMA pgboss TO {{api}}, {{worker}}, {{backup}};--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON probe_items TO {{api}}, {{worker}};--> statement-breakpoint
GRANT USAGE ON SEQUENCE probe_items_id_seq TO {{api}}, {{worker}};--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE {{migrator}} IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {{api}}, {{worker}};--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO {{backup}};--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO {{backup}};--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE {{migrator}} IN SCHEMA public GRANT SELECT ON TABLES TO {{backup}};--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE {{migrator}} IN SCHEMA public GRANT SELECT ON SEQUENCES TO {{backup}};--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE {{migrator}} IN SCHEMA pgboss GRANT SELECT ON TABLES TO {{backup}};--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE {{migrator}} IN SCHEMA pgboss GRANT SELECT ON SEQUENCES TO {{backup}};
