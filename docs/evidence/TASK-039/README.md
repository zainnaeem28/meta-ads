# TASK-039 provider-keys 1/2: evidence notes

- Migration `0030_task-039-provider-keys.sql` (M0004 content, range 0030-0039): `provider_keys`, `key_events`, `fingerprint_pepper_version`.
  Grants: `app_api` SELECT on every `provider_keys` column except `ciphertext`, `nonce`, `wrapped_dek`, plus INSERT/UPDATE/DELETE;
  `app_worker` SELECT/UPDATE/DELETE; `key_events` SELECT/INSERT for both (append-only).
- `KeyWrapPort` seal side `SealedEnvelopeKeyWrap` (AES-256-GCM, random 96-bit nonce, fresh 256-bit DEK per seal, AAD
  `user_id|provider|key_id|version`, DEK wrapped RSA-OAEP-SHA-256 under `KEK_V{n}`); worker-only `KeyUnsealer`
  (`infrastructure/key-unsealer.ts`) bound only in `bootstrap/worker.module.ts`; typed `UnsealFailed` for every failure.
- Tests: `key-wrap.test.ts` (unit, TC-KEY crypto), `provider-keys.integration.test.ts` (real PostgreSQL, grants, constraints,
  real `createApiApp` and `createWorkerApp`, api probe `app.get(KeyUnsealer)` throws, unreadable KEK map fails start-up, log capture).

Deviations and notes for the reviewer:
- The trigger writing `key_events` kind `changed_db` (SECURITY-DESIGN §9.4 item 2) is not built: ARCHITECTURE v4.5 (which supersedes) lists
  no `changed_db` kind and no role-name column; it needs an Architect decision.
- Files outside the listed paths, forced by the ticket's own report flags: `apps/api/vitest.config.ts` and `apps/api/package.json`
  (`reports/keys-crypto` junit and lcov, coverage include), and `apps/api/tests/integration/audit/audit.integration.test.ts`
  (its hard-coded ledger count of 3 now reads the journal length).
- `scripts/ci/layers.sh --probe key-unsealer`: the script has no `--probe` option and ignores it; the static rule is probed by
  `scripts/ci/probes/run-all.sh` (L3) and the runtime probe is in the integration test above.
- `platform-migration.integration.test.ts` (5 cases) and `logging.integration.test.ts` fail in this sandbox because `pg_dump` is not installed; unrelated to this change.
