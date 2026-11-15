# TASK-009 (AIU-88) runtime configuration, DO-05

- `config/registry.json`: single registry (DEVOPS-PLAN section 8 merged with ARCHITECTURE section 6 and 6.1; names follow ARCHITECTURE): 119 keys, 22 secret. Also holds per-service secret sets, the secret-name pattern `shroomap/<env>/<service>/<KEY>`, the backup forbidden list and the forbidden-elsewhere names.
- `scripts/ci/config-consistency.mjs`: check (default), `--write` (regenerates `.env.example` and `docs/ops/secrets.md`), `--probe` (21 injected mismatches, all caught), `--local-env DIR` (one env file per process with throwaway key material; git-ignored).
- `.env.example`, `docs/ops/secrets.md` (secret-name map per environment, per-process sets, forbidden variables), `docs/ops/secret-rotation.md`.
- `apps/api/package.json` script `test:startup-config` and `apps/api/src/platform/config/example-env.test.ts` (outside the listed allowed paths; needed for the required check, see the ticket comment).
- `IDENTITY_MODE` (TASK-033) and `AUTH_MODE` (TASK-084) are in the registry as `pending:`: the schema does not read them yet; the consistency script switches to full comparison once `registry.ts` adds them. "Refused when hosted" is enforced by those tickets; this ticket fixes the default (`local`, with `APP_ENV=development`) and the registry flag `refusedIn`.
- Container definitions (`docker/Dockerfile`, `docker/compose*.yml`) are scanned for forbidden variables per image when present; they are not on `dev` yet (TASK-008), so the scan ran on probe fixtures only.
