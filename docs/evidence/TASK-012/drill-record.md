# Restore drill record (DO-07b, TASK-012)

Result: **PASS**. Scope: agent baseline on the shared test PostgreSQL, synthetic data and a synthetic KEK. The same drill in the real environment, with RTO and RPO sign-off, stays go-live evidence (TC-H-08).

| Item | Value |
| --- | --- |
| Run | 2026-11-17T12:16:52Z, suffix `52e3cf10`, commit `b98f6c6` |
| Tools | PostgreSQL server 17.11, pg_dump 17.12, age v1.2.1, node v24.22.2 |
| **Restore time** (decrypt, restore, ledger rebuild, verification, media, reconciliation, canary, smoke) | **25.93 s** against the RTO of 8 h (28800 s) |
| **Data lost** (backup moment to the loss of the database) | **49.4 s** against the RPO of 24 h (86400 s); 2 rows written after the backup |
| Migration rollback check | 10 migrations; 9 pre-migration snapshots restored equal; 1 compensating migrations verified |
| Whole drill | 126.19 s |

| # | Step | Result | Seconds | Notes |
| --- | --- | --- | --- | --- |
| 1 | provision roles and database | pass | 1.35 | roles and database provisioned on the shared test server (run suffix 52e3cf10); pg_dump 17.12, server 17.11 |
| 2 | migration rollback check (full history) | pass | 47.10 | 10 migrations applied with drizzle-kit migrate; 9 pre-migration snapshots restored into new databases equal their pre-migration state (structure and rows); 1 compensating forward migrations verified on copies (the others have none yet: TASK-026 fixtures hold 0001 and 0010 only) |
| 3 | seed synthetic data and sealed canary key | pass | 0.36 | seeded 3 users, a sealed canary key row (KEK_V1, public fingerprint 9faeffa1a2adf8420006924cfb56596eced09911cc2b14eaebdae5ceb06541ab), invitation and access request of the later-erased user, 2 campaigns, 6 objects |
| 4 | backup (dump, age, media, ledger mirror) | pass | 2.34 | dump 150963 bytes (age-encrypted, plaintext never on disk), 3 media objects in the manifest, no key material in the backup tree |
| 5 | changes after backup, erasure, disaster | pass | 49.13 | finding F-DR-3 (not a restore defect): on the live database, as shipped, /health/ready answers 503 because app_api has no USAGE on schema drizzle and no SELECT on its ledger, which the schema-head check reads (protected routes 401 401);baseline smoke on the live database with that grant: /health/ready 200; the same grant is part of the ledger rebuild on the restored copy;after the backup: 1 user and 1 campaign written (2 rows, lost by design), user B erased with ledger object erasure/2026-11-17T12-15-37-000Z-c2d17bc5-d00b-4eb1-83dd-ad1dc4cfc9a5; live database dropped |
| 6 | restore into an empty database | pass | 1.73 | finding F-DR-2: the dump of --schema=public does not carry extension pg_trgm, so a one-pass pg_restore fails on the trigram indexes; the drill restores in sections (pre-data, CREATE EXTENSION, data, post-data). The backup service could add --extension=pg_trgm (change request for TASK-011);finding F-DR-1: the logical dump (--schema=public --schema=pgboss) carries no drizzle ledger, so a restored database reports schema head 0 and db:migrate would re-run every migration; the drill rebuilds it from the journal (identical to the lost ledger, 10 rows). The backup service should dump --schema=drizzle too (change request for TASK-011);restored into a new empty database: schema history (10 migrations), row counts equal the backup moment, constraints valid, roles and grants kept, pgboss present; 3 media objects restored with matching SHA-256 |
| 7 | erasure ledger reconciliation (T-22) | pass | 1.84 | before reconciliation the restored database holds the user erased after the backup (as expected from an old backup);ledger reconciliation: 1 subject(s) re-erased from the live and mirrored ledger; synthetic user B absent from users, invitations, access_requests, campaigns, provider_keys and storage; users A and K and their objects intact; second pass is a no-op |
| 8 | KEK canary (KC-6) | pass | 0.48 | canary row (read as the worker role) opens with the held KEK_V1 (public fingerprint 9faeffa1a2adf8420006924cfb56596eced09911cc2b14eaebdae5ceb06541ab matches); a different key and a moved AAD both fail; the restored KEK never touched the backup tree |
| 9 | smoke journey against the restored copy | pass | 21.84 | smoke: the built api (node dist/main.api.js as the app_api role) started on the restored database; /health/live 200; /health/ready answered: 200 (schema head 10, pgboss queue check); unauthenticated protected routes answer: 401 401 |
| 10 | RPO 24 h and RTO 8 h | pass | 0.02 | data lost window 49.4s (backup moment to the loss of the database), 2 rows written after the backup; restore time 25.93s |
