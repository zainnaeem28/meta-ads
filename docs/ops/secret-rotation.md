# Secret rotation runbook

Owner: DevOps; the Operations owner performs and records each rotation. Names and sets: `docs/ops/secrets.md`
(generated from `config/registry.json`). This runbook holds procedures and names only: **no value is ever written to a
ticket, comment, log, screenshot or file.** Source: DEVOPS-PLAN section 8, ARCHITECTURE section 6.

## The eight steps (every rotation)

1. **Inventory consumers.** Read the key's "Held by" in `docs/ops/secrets.md`. Those services, and only those, change.
2. **Provision the new credential** with least privilege, in the provider's console or with the host admin user.
3. **Distribute** it through the host secret store under the name from the secret-name map
   (`shroomap/<env>/<service>/<KEY>`). Never through a repository secret, YAML, build argument, image layer or log.
4. **Reload the consumers** under an overlap: the old and the new credential are both valid.
5. **Verify the new identity works:** `/health/ready` on the api, the next job on the worker, a signed URL, a probe call
   (whichever the consumer does); check the service log for `config error` lines (key names only).
6. **Revoke the old credential** at its provider.
7. **Verify the old credential fails** (a request made with it is refused).
8. **Record evidence:** who, when, which key names, steps 5 and 7 outcomes. No value.

A compromised credential is revoked at once (step 6 first), never rolled back to; then continue with steps 2-5 and 7-8.

## Per key

| Key                                                                                                   | Procedure                                                                                                                                                                                                                                             | Cadence                               |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `KEK_PRIVATE_KEYS` / `KEK_PUBLIC_KEYS` / `KEK_ACTIVE_VERSION` (**KEK**, worker holds the private map) | See "KEK re-wrap" below                                                                                                                                                                                                                               | On the custody schedule or compromise |
| `KEY_FINGERPRINT_PEPPERS` / `KEY_FINGERPRINT_PEPPER_ACTIVE`                                           | Add a new version to the map, switch the active version, redeploy the api. Old fingerprints stay valid display values (TD-D6); no re-fingerprinting job runs                                                                                          | On compromise or yearly               |
| `CURSOR_SIGNING_KEY`                                                                                  | Replace in the api secret set and redeploy. Open cursors become invalid; clients restart at page 1                                                                                                                                                    | On compromise or yearly               |
| `RATE_LIMIT_IP_KEY`                                                                                   | Replace in the api secret set and redeploy. IP buckets reset                                                                                                                                                                                          | On compromise                         |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (**tokens A and B**: api holds A, worker holds B)         | Rotate one token at a time: create a replacement for A, set it on the api, verify an upload, revoke the old A; repeat for B on the worker. The other token keeps serving, so there is no downtime                                                     | Yearly or on compromise               |
| `R2_LEDGER_ACCESS_KEY_ID` / `R2_LEDGER_SECRET_ACCESS_KEY` (**token C**, worker only)                  | New write-once and read token on the `erasure-ledger` bucket only; set on the worker; verify a ledger write and read; revoke old. It must differ from token B (startup refuses equal values)                                                          | Yearly or on compromise               |
| `R2_BACKUP_SOURCE_*` (**backup token, source**)                                                       | New Object Read only token scoped to the `app` and `erasure-ledger` buckets; set on `backup`; verify the next backup reads; revoke old                                                                                                                | Yearly or on compromise               |
| `R2_BACKUP_SINK_*` (**backup token, sink**)                                                           | New Object Read and Write token scoped to the `backup` bucket only (never Admin); set on `backup`; verify the next backup writes; revoke old. Lock and lifecycle rules are set with the owner's Admin credential at provisioning, never by this token | Yearly or on compromise               |
| `BACKUP_AGE_RECIPIENT` (**age recipient**, public)                                                    | See "age key pair" below                                                                                                                                                                                                                              | With the key pair                     |
| `BACKUP_DATABASE_URL`                                                                                 | Two-step role password rotation for `app_backup`: set the second password in the database, update the `backup` secret, verify the next dump, then retire the old password                                                                             | Yearly or on compromise               |
| `DATABASE_URL`                                                                                        | Same two-step role password rotation for `app_api` and `app_worker`; never rotate both roles in one window                                                                                                                                            | Yearly or on compromise               |
| `MIGRATION_DATABASE_URL`                                                                              | Set only on the `migrate` step. Rotate after use if the owner wants; always on compromise                                                                                                                                                             | Optional                              |
| `CLERK_SECRET_KEY`                                                                                    | Roll the key in the owner's Clerk account with the overlap the provider allows; update api, worker and web; revoke the old                                                                                                                            | Yearly or on compromise               |
| `METRICS_TOKEN`                                                                                       | Set the new token on the `api` first (the api accepts it), then on `monitor` and the release observation step; revoke the old by replacing it on the api                                                                                              | Yearly or on compromise               |
| `SENTRY_DSN`, `HEARTBEAT_URL_*`, `SHOTSTACK_API_KEY`                                                  | Regenerate at the provider; update the consuming services; revoke old                                                                                                                                                                                 | On compromise                         |

## KEK re-wrap (`kek:rewrap`)

The worker alone holds `KEK_PRIVATE_KEYS`; the api and worker both hold `KEK_PUBLIC_KEYS` and `KEK_ACTIVE_VERSION`.

1. Generate the new key pair `n+1` under the named custody procedure. The private half never leaves the custody
   channel and never appears in a ticket.
2. Add version `n+1` to **both** maps: public map on api and worker, private map on the worker. Do not yet remove
   version `n`.
3. Set `KEK_ACTIVE_VERSION` to `n+1` on api and worker and redeploy. Startup refuses the release unless the active
   version is present in both maps (exit 78 naming `KEK_ACTIVE_VERSION` or `KEK_PRIVATE_KEYS`).
4. Run `kek:rewrap` as the controlled one-off task: it re-wraps every stored data key to version `n+1`. Verify its
   report shows zero rows remaining on version `n`.
5. Remove the version `n` private key from the worker `KEK_PRIVATE_KEYS` after the destroy margin, redeploy, confirm
   the worker starts.
6. Record the steps and the new public-key fingerprint. Never roll back to a destroyed version.

## age key pair (backups)

The `backup` service holds only the public **age recipient** (`BACKUP_AGE_RECIPIENT`). The age private key is escrowed
under the custody procedure of DEVOPS-PLAN section 10.4 and is **never** an environment variable of any service
(`AGE_SECRET_KEY`, `AGE_PRIVATE_KEY`, `BACKUP_AGE_IDENTITY` are on the forbidden list).

1. Generate the new age key pair offline; escrow the private key.
2. Set the new recipient on `backup`; the next backup is encrypted to it. Keep the old private key until every backup
   encrypted to the old recipient has aged out of retention (`BACKUP_RETENTION_DAYS`) or been re-encrypted.
3. Run a restore drill with the new private key against the first new backup before retiring the old one.

## Guard rails in the repository

- `node scripts/ci/config-consistency.mjs` fails when `config/registry.json` and
  `apps/api/src/platform/config/registry.ts` disagree on a name, class, requirement or default, when a variable is
  missing from `.env.example`, and when a container definition sets a forbidden variable (api, worker, web and backup
  hold different secret sets; backup never holds the KEK or the age private key).
- Startup validation exits 78 naming the key only; a secret set in a process that must not hold it is refused.
- gitleaks scans every ticket range; a finding blocks.
