# RUN-GUIDE

How to run ShrooMap from a clean clone: install, local stack, database, seed, the api, worker and web, the checks and each CI baseline. Every command below runs from the repository root unless a step says otherwise. Nothing here needs an external account: the local stack, the throwaway key material and the local identity mode (`IDENTITY_MODE=local`, `AUTH_MODE=local`, refused in staging and production) are enough.

`scripts/ci/docs-check.sh` verifies the static facts of this guide (every script, file and `pnpm` command it names exists, every operator command and audit event matches the code). `docs/evidence/TASK-017/guide-run.txt` is the output of running the steps.

## 0. Prerequisites

| Tool                   | Version                                                      | Why                                             |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Node.js                | 24.22.2 or newer, below 27 (`.nvmrc` says 26)                | `package.json` `engines`                        |
| pnpm                   | 10.34.9 (`corepack enable` selects it from `packageManager`) | workspace and lockfile                          |
| Docker with Compose v2 | any current                                                  | PostgreSQL 17, MinIO, provider stubs, mail stub |
| git, curl              | any                                                          | clone, health checks                            |
| Python 3               | 3.11 or newer                                                | the `scripts/ci` wrappers                       |

The CI wrappers install their pinned scanners (semgrep, gitleaks, osv-scanner, trivy, actionlint) into `$XDG_CACHE_HOME/shroomap-ci-tools` (`~/.cache/shroomap-ci-tools` when unset) on first use, with checksums verified. Set `CI_AUTO_INSTALL=0` to refuse that.

## 1. Clone and install

```bash
git clone https://github.com/zainnaeem28/meta-ads.git
cd meta-ads
git checkout dev
corepack enable
pnpm install --frozen-lockfile
```

## 2. Local configuration

`.env.example` names every variable and carries a harmless local default. Each process reads only its own keys, so split it into one file per process. This also generates the throwaway key material (KEK pair, pepper map, signing keys). The folder `.env.local.d` is git-ignored and never holds a real credential.

```bash
node scripts/ci/config-consistency.mjs --local-env .env.local.d
```

It writes `api.env`, `worker.env`, `web.env`, `release.env`, `backup.env` and `monitor.env`. A process refuses (exit 78, naming the key, never the value) a secret it must not hold, so do not merge the files.

## 3. Start the local stack

```bash
docker compose -f docker/compose.dev.yml up -d
until docker compose -f docker/compose.dev.yml exec -T postgres pg_isready -U postgres -d shroomap_dev; do sleep 2; done
```

| Service                            | Address                                                                | Credentials (local only)                   |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| PostgreSQL 17                      | `localhost:5432`, database `shroomap_dev`                              | `postgres` / `shroomap-local`              |
| MinIO (S3)                         | `localhost:9000`, console `localhost:9001`, buckets `app` and `ledger` | `shroomap-local` / `shroomap-local-secret` |
| Provider stubs (OpenAI, WaveSpeed) | `localhost:8089`                                                       |
| Mail stub (Mailpit)                | SMTP `localhost:1025`, UI `http://localhost:8025`                      | none                                       |

Stop with `docker compose -f docker/compose.dev.yml down`; add `-v` to delete the database and bucket volumes (that is also how to reset step 4).

## 4. Provision the database roles (once per volume)

The schema is owned by `app_migrator`; the api and the worker connect as `app_api` and `app_worker`, the backup service as `app_backup`. Migration `0001` refuses to run when a role is missing or `postgres` runs it, so the roles come first. On a host the roles are created at provisioning (`docs/ops/secrets.md`, `docs/ops/release.md`); locally:

```bash
docker compose -f docker/compose.dev.yml exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE app_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'shroomap-local';
CREATE ROLE app_api      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'shroomap-local';
CREATE ROLE app_worker   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'shroomap-local';
CREATE ROLE app_backup   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD 'shroomap-local';
ALTER ROLE app_backup   SET default_transaction_read_only = on;
ALTER ROLE app_migrator SET search_path = public;
ALTER ROLE app_api      SET search_path = public;
ALTER ROLE app_worker   SET search_path = public;
ALTER DATABASE shroomap_dev OWNER TO app_migrator;
REVOKE CONNECT ON DATABASE shroomap_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE shroomap_dev TO app_api, app_worker, app_backup;
SQL
docker compose -f docker/compose.dev.yml exec -T postgres psql -U postgres -d shroomap_dev -v ON_ERROR_STOP=1 -c 'ALTER SCHEMA public OWNER TO app_migrator'
```

Then point each process at its own role. These small override files sit beside the generated ones and are loaded after them (a later `--env-file` wins):

```bash
echo 'DATABASE_URL=postgres://app_api:shroomap-local@localhost:5432/shroomap_dev'        > .env.local.d/db-api.env
echo 'DATABASE_URL=postgres://app_worker:shroomap-local@localhost:5432/shroomap_dev'     > .env.local.d/db-worker.env
echo 'MIGRATION_DATABASE_URL=postgres://app_migrator:shroomap-local@localhost:5432/shroomap_dev' > .env.local.d/db-release.env
echo 'BACKUP_DATABASE_URL=postgres://app_backup:shroomap-local@localhost:5432/shroomap_dev'      > .env.local.d/db-backup.env
```

If `DATABASE_URL` is already set in your shell, unset it (`unset DATABASE_URL`): the config loader reads the process environment first and the `release` process refuses it.

## 5. Build

```bash
( set -a; . .env.local.d/web.env; set +a; pnpm build )
```

`NEXT_PUBLIC_*` values are inlined into the web build, which is why `web.env` is loaded for it. The api builds to `apps/api/dist`.

### Local token route (local mode only)

With `IDENTITY_MODE=local` and `APP_ENV=development` or `test`, the api's own in-process identity provider signs the session tokens it verifies, so no other process could get one. For a local-mode web, a script or an end-to-end test, the api serves `POST /api/v1/dev/token` (no Authorization header):

```bash
curl -s -X POST http://localhost:4000/api/v1/dev/token -H 'content-type: application/json' -d '{"email":"owner@example.test"}'
# {"success":true,"data":{"token":"<jwt>","sub":"user_local_...","email":"owner@example.test","expiresInSeconds":3600}}
curl -s http://localhost:4000/api/v1/me -H "authorization: Bearer <jwt>"
```

The body is `{ "email": "<address>", "secondFactor": true|false }` (`secondFactor` defaults to `true`; `false` mints a token with no second-factor evidence, `fva` `[0,-1]`). The route mints a token for that address (one stable subject per address) and registers it with the local provider; the account is then linked by the normal first-token rules (`OWNER_EMAIL` becomes the first administrator, `INVITE_EMAIL_DOMAINS`, invitations and signup mode apply). Tokens carry the same claims as real ones (`iss`, `sub`, `sid`, `iat`, `exp` one hour, `fva`, `azp` = `WEB_ORIGIN`), and every check still runs: signature, issuer, expiry, `azp`, role and status read from the database, MFA, recent authentication and rate limits. The route is not mounted with `IDENTITY_MODE=clerk`, and the process refuses to start with `IDENTITY_MODE=local` when `APP_ENV` is `staging` or `production`. It lives in the api process only: the worker has its own local provider and does not accept these tokens.

The local-mode web (`AUTH_MODE=local`, no Clerk key) uses this route for you: its own `GET /local-token` (answers only in local mode, 404 otherwise) exchanges the signed-in local session for the api token server-side, and the browser sends it as the bearer, cached until shortly before it expires. Run the api with `IDENTITY_MODE=local` and set `NEXT_PUBLIC_API_ORIGIN` to it (default `http://localhost:4000`); nothing else changes in the web steps. With a Clerk key the Clerk session token is the bearer and `/local-token` does not exist in effect.

## 6. Migrate and seed

Order is fixed (release order, `docs/ops/release.md`): `db:migrate`, `jobs:migrate`, `db:seed`.

```bash
( set -a; . .env.local.d/db-release.env; set +a; CI=1 pnpm --filter @shroomap/api db:migrate )
( cd apps/api && node --env-file=../../.env.local.d/release.env --env-file=../../.env.local.d/db-release.env dist/database/jobs-migrate.js )
( cd apps/api && node --env-file=../../.env.local.d/release.env --env-file=../../.env.local.d/db-release.env dist/database/seed.js --dataset=reference )
```

- `CI=1` makes `drizzle-kit` print its errors instead of a spinner. `db:migrate` runs as `app_migrator` through `MIGRATION_DATABASE_URL` and applies the journal in `apps/api/src/database/migrations`. Schema push is forbidden (`scripts/ci/lint-db.sh`).
- `jobs:migrate` installs the pg-boss schema and every queue.
- `db:seed --dataset=reference|development|staging` is idempotent (upserts by natural key); a rerun changes nothing. `development` runs only with `APP_ENV=development`, `staging` only with `APP_ENV=staging`, production accepts `reference` only. Rerun the same command to prove the rerun is a no-op.

The ledger grant for `app_api` is migration `0120`, applied by `db:migrate`, so `/health/ready` is 200 after a clean migrate. `db:seed --dataset=reference` also loads `config/price-table.json` into `price_table` (the worker refuses to start with no price row); no manual SQL is needed.

## 7. Run the api, worker and web

One terminal each, from the repository root. Each process loads only its own files.

```bash
# api (http://localhost:4000)
cd apps/api && node --env-file=../../.env.local.d/api.env --env-file=../../.env.local.d/db-api.env dist/main.api.js

# worker (jobs, media sanitising, provider calls, assembly, erasure)
cd apps/api && node --env-file=../../.env.local.d/worker.env --env-file=../../.env.local.d/db-worker.env dist/main.worker.js

# web (http://localhost:3000)
cd apps/web && node --env-file=../../.env.local.d/web.env node_modules/next/dist/bin/next start -p 3000
```

Check it:

```bash
curl -s -o /dev/null -w 'live %{http_code}\n'  http://localhost:4000/health/live
curl -s -o /dev/null -w 'ready %{http_code}\n' http://localhost:4000/health/ready
curl -s -o /dev/null -w 'protected route without a session %{http_code}\n' http://localhost:4000/api/v1/campaigns
curl -s -o /dev/null -w 'web sign-in %{http_code}\n' http://localhost:3000/sign-in
```

Expected: `live 200`, `ready 200`, `401`, `200`. `/health/ready` answers 200 only when PostgreSQL answers, pg-boss is installed, the applied migration count is within `MIN_SCHEMA_HEAD`..`MAX_SCHEMA_HEAD` and the configuration is valid. Open `http://localhost:3000/sign-in`: in local mode the page shows the local password and the local second-step code. The first administrator is the account whose email equals `OWNER_EMAIL` (set it in `.env.local.d/api.env` before the first sign-in; `ops first-admin:reopen` re-arms the link).

### Pointing the worker at the provider stubs (test seam)

The built worker (`node dist/main.worker.js`) calls `https://api.wavespeed.ai` and `https://api.openai.com` (the QC transcription and the thumbnail image). To run it against `tools/provider-stubs` set, in the worker's environment:

```bash
APP_ENV=test                                   # or development; the setting is refused (start-up stops) in staging and production
WORKER_PROVIDER_ORIGIN_OVERRIDE=https://provider-stubs.internal
EGRESS_ALLOWED_HOSTS='{"openai":["api.openai.com","provider-stubs.internal"],"wavespeed":["api.wavespeed.ai","provider-stubs.internal"]}'
```

The override is not an open redirect. It must be a bare `https` origin (a DNS name, port 443, no path, query or credentials), and its host must be named exactly, with no wildcard, under both `openai` and `wavespeed` in `EGRESS_ALLOWED_HOSTS`; otherwise the worker refuses to start. Every call still goes through the egress layer, which checks the host, the resolved address and the redirects as for the real providers. The stub must therefore be reachable as that name over TLS on port 443 (put a TLS front in front of the stub and trust its CA with `NODE_EXTRA_CA_CERTS`). Names that resolve to loopback or private addresses are refused by the egress layer's address check outside the in-process tests.

The S3 endpoint override already exists: `R2_ENDPOINT` (and `STORAGE_PUBLIC_ORIGIN` for the api) takes any URL, including MinIO's `http://localhost:9000`, in development and test; staging and production require https.

`next start` prints a warning that `output: standalone` prefers `node .next/standalone/server.js`; the container image does that, `next start` is the local shortcut.

## 8. Operator commands (one-off tasks of the release image)

`node dist/bin/ops.js <command> --env=<APP_ENV>` from `apps/api`. Each writes an audit event (`actor_type = 'operator'`) in the transaction of its change and prints counts only. `--env` must equal the process's `APP_ENV`, otherwise it exits 2 before opening a connection. Names, audit events and recovery use: `docs/ops/ROLLBACK-RUNBOOK.md`.

```bash
cd apps/api
node --env-file=../../.env.local.d/api.env --env-file=../../.env.local.d/db-api.env dist/bin/ops.js first-admin:reopen --env=development
node --env-file=../../.env.local.d/api.env --env-file=../../.env.local.d/db-api.env dist/bin/ops.js keys:disable-all --env=development
node --env-file=../../.env.local.d/worker.env --env-file=../../.env.local.d/db-worker.env dist/bin/ops.js kek:rewrap --env=development
node --env-file=../../.env.local.d/worker.env --env-file=../../.env.local.d/db-worker.env dist/bin/ops.js erasure:resume <run-id> --env=development
```

## 9. Run the checks

Workspace commands (no external service; lint and format are gated by the CI wrapper below):

```bash
pnpm typecheck
pnpm test:foundation
pnpm --filter @shroomap/api test:startup-config
pnpm --filter @shroomap/api test:unit
pnpm --filter @shroomap/web test:unit
pnpm --filter @shroomap/web test:brand
pnpm --filter @shroomap/web test:headers
pnpm --filter @shroomap/ui test
node scripts/ci/config-consistency.mjs
scripts/ci/docs-check.sh
```

Integration tests need the shared test PostgreSQL (a uniquely named database per run, dropped afterwards; they never use the local stack's PostgreSQL). Point them at any PostgreSQL where you may create roles and databases, for example the compose one above with the `postgres` user: `TEST_DATABASE_ADMIN_URL` (foundation harness) and `DRILL_PG_ADMIN_URL` (restore drill) name it; both default to `postgres://postgres@test-db:5432/postgres`.

```bash
CI=1 scripts/ci/integration.sh
```

## 10. Run each baseline (the CI wrappers)

The hosted pipeline (`.github/workflows/ci.yml`, triggers `pull_request`, push to `main` and manual dispatch) and the server run the same wrappers. Each writes its report under `reports/<baseline>/` (for example `reports/integration/junit.xml`) and a meta file under `reports/meta/` that the quality gate reads back. Run with `CI=1`.

| Baseline                                         | Command                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| Lint and format                                  | `CI=1 scripts/ci/lint.sh`                           |
| Types                                            | `CI=1 scripts/ci/types.sh`                          |
| Workflow validation                              | `CI=1 scripts/ci/validate.sh`                       |
| Layer boundaries                                 | `CI=1 scripts/ci/layers.sh`                         |
| Database lint                                    | `CI=1 scripts/ci/lint-db.sh`                        |
| Migration history, upgrade, rollback, seed rerun | `CI=1 pnpm --filter @shroomap/api db:check-history` |
| Unit (CI tooling)                                | `CI=1 scripts/ci/unit.sh`                           |
| API contract                                     | `CI=1 scripts/ci/contract.sh`                       |
| Integration                                      | `CI=1 scripts/ci/integration.sh`                    |
| Build                                            | `CI=1 scripts/ci/build.sh`                          |
| SAST                                             | `CI=1 scripts/ci/sast.sh`                           |
| Secrets                                          | `CI=1 scripts/ci/secrets.sh`                        |
| Dependencies                                     | `CI=1 scripts/ci/deps.sh`                           |
| IaC                                              | `CI=1 scripts/ci/iac.sh`                            |
| Container image                                  | `CI=1 scripts/ci/container.sh`                      |
| End to end                                       | `CI=1 scripts/ci/e2e.sh`                            |
| Health contract (API-900/901)                    | `CI=1 scripts/ci/health-contract-check.sh`          |
| Restore drill                                    | `CI=1 scripts/backup/restore-drill.sh --local`      |
| Final quality gate                               | `CI=1 scripts/ci/quality-gate.sh`                   |

A ticket is submitted with `scripts/ci/submit-check.sh --base origin/dev` (the same wrappers plus the report flags).

### Known failures on `dev` at the time of this guide

These fail on an untouched clone of `dev`; they are recorded for their owners (see `docs/evidence/TASK-017/README.md`), not hidden:

- `pnpm lint` and `pnpm format:check` (so `scripts/ci/lint.sh`): ESLint reports errors in the `e2e-with-database.mjs` evidence scripts of tickets TASK-091 to TASK-094, and Prettier reports 465 files.
- `pnpm --filter @shroomap/api db:check-history`: compensating fixtures exist for migrations `0001` and `0010` only (finding F-DR-4 of the restore drill).

## 11. Release, rollback and operations

| Need                                                                                       | Where                                                |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Release one environment (deployment-ready, not deployed, until the owner adds credentials) | `docs/ops/release.md`                                |
| Roll back, recover, restore; operator commands and their audit events                      | `docs/ops/ROLLBACK-RUNBOOK.md`                       |
| Operations ownership, alerts, runbooks, on-call, handoff                                   | `docs/ops/OPERATIONS-HANDOFF.md`                     |
| Secrets, per-process secret sets, rotation                                                 | `docs/ops/secrets.md`, `docs/ops/secret-rotation.md` |
| Backups, restore drill                                                                     | `docs/ops/backup.md`, `docs/ops/restore-drill.md`    |
| Owner items for the go-live evidence list                                                  | `docs/ops/owner-items.md`                            |
| Alert runbooks `RB-*`                                                                      | `docs/ops/runbooks/`                                 |

## 12. Troubleshooting

| Symptom                                                                | Cause and fix                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `M0001 refused: required database role(s) missing`                     | Step 4 was not run.                                                                                                           |
| `M0001 refused: must run as app_migrator, not postgres`                | `MIGRATION_DATABASE_URL` still names `postgres`; source `db-release.env` (step 6).                                            |
| `drizzle-kit migrate` prints only `applying migrations...` and exits 1 | Run with `CI=1` to see the error.                                                                                             |
| `config error (release): DATABASE_URL is forbidden`                    | `DATABASE_URL` is set in your shell: `unset DATABASE_URL`.                                                                    |
| `/health/ready` answers 503 with `schema_head` in the api log          | The migrations were not applied (`db:migrate` includes the ledger grant, migration `0120`).                                   |
| `listen EADDRINUSE`                                                    | Another process holds port 4000, 3000 or 5432. Set `API_PORT` in `api.env`, `-p` for the web, or `POSTGRES_PORT` for compose. |
| A process exits 78                                                     | Startup validation: the log names the key (never a value). Fix that key in the process's own env file.                        |
| The worker cannot reach storage                                        | Check `docker compose -f docker/compose.dev.yml ps` and that `minio-init` created the `app` and `ledger` buckets.             |
