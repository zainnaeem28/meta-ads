# Releasing an environment (TASK-014, DEVOPS-PLAN 6.1, 14)

`.github/workflows/release.yml` releases **one named environment** (`staging` or `production`) by image digest. It is `workflow_dispatch` only, runs on `refs/heads/main`, holds no credential, and calls the scripts from TASK-013 (`verify-release-approval.sh`, `release-with-recovery.sh`) with the Render adapter `scripts/ci/hosts/render.sh` and the observation script `scripts/ci/observe.sh`.

## Result today: deployment-ready, not deployed

No hosting account, token or environment exists yet. Without them the workflow checks its inputs, downloads `quality.json`, records `deployment-ready-not-deployed` in `deployment-result-<env>.json`, and ends green. It names the missing items in that file. Nothing waits for the owner. Adding the items below deploys with **no code change**.

If the hosting credentials are set but the approval evidence cannot be read, the job fails and deploys nothing. The release never runs without the approval record: `verify-release-approval.sh` fails closed on a missing or mismatching G3 record before the adapter is reached.

## What the owner adds

| Item | Where | Notes |
| --- | --- | --- |
| Render account, one project per environment, services `api`, `worker`, `web`, `migrate` (Job-capable) and the PostgreSQL instance | Render | Automatic deploys **off** on every service. Registry credential for GHCR (`GHCR_PULL_TOKEN`, `read:packages`) set in the Render account |
| `RENDER_API_KEY`, `RENDER_SERVICE_API`, `RENDER_SERVICE_WORKER`, `RENDER_SERVICE_WEB`, `RENDER_SERVICE_MIGRATE`, `RENDER_POSTGRES_ID` | GitHub **environment secrets** of `staging` / `production` (never repository secrets) | Withheld until that environment's G3 (docs/ops/secrets.md) |
| `PAPERCLIP_G3_READER_TOKEN` | environment secret | Read-only credential for the gate record |
| `METRICS_TOKEN` | environment secret | The api's metrics access check, used by `observe.sh` |
| `ALERT_WEBHOOK_URL` | environment secret (optional) | Without it alerts go to the job log and the run fails as usual |
| `PAPERCLIP_API_URL`, `PAPERCLIP_RELEASE_ISSUE_ID` | environment variables | Where the `g3-<env>` and `deployments-<env>` task documents live |
| `RELEASE_IMAGE_PREFIX` | variable | Registry path, for example `ghcr.io/<owner>/<repo>`; images are `<prefix>/api@sha256:...`, `worker`, `web` |
| `RELEASE_EXPECTED_TARGETS` | variable | JSON of the environment's expected hosts, database name and bucket, compared with the G3 record |
| `RENDER_SMOKE_API_URL`, `RENDER_SMOKE_WEB_URL` | variables | The environment's public origins (domain) |
| `OBSERVE_BASELINE_P95_MS`, `OBSERVE_WINDOW_SECONDS` | variables | Baseline measured in staging; the window defaults to 3600 s (set 1800 for staging) |
| A GitHub plan that offers environments on a private repository | GitHub | DEVOPS-PLAN 3.4: on Free the environment secrets above cannot exist, so release option S (the same scripts run on the Paperclip server in the run that follows G3) applies. The scripts do not change |

A G3 for the environment (a staging G3 never authorizes production) is part of the release package, not an owner item.

## Order of a release

`preflight` (approval verification, live state read, backup gate) → `backup` (on-demand export, id recorded) → `db:migrate` → `jobs:migrate` → `db:seed --dataset=reference` → deploy `api` → deploy `worker` (shutdown delay set first) → deploy `web` → `smoke` → `observe` → `record`. A failed migration halts with the old application active: no retry, no data rollback. A failed deploy, smoke or observe step recovers to the **previous digests only**, newest layer first, and never touches the database (`release-with-recovery.sh`; recovery without a previous record or digest exits 2 and stays red).

The migrate service is pointed at the approved **api digest** before its jobs run, so the migration runs the code being released. The seed runs inside the `migrate-jobs` checkpoint, after `jobs:migrate` and before any deploy.

## Observation (observe.sh)

Window 60 minutes in production, 30 in staging; polls every 5 minutes. Abort and recover when: `/health/ready` fails 3 probes in a row; the 5xx ratio is over 2% with at least 100 requests; p95 is over twice the staging baseline with at least 200 requests; a job is stuck in `submitting`; the KEK unseal alert fired; the worker heartbeat is older than 15 minutes; or the metrics cannot be read. Thresholds are proposed (DEVOPS-PLAN 14.4) and calibrated in staging by the Operations owner.

## Release record: where "previous release" lives

Per environment, the Paperclip release task document `deployments-<env>` (append-only JSON array of entries: `environment`, `digests`, `recordedAt`, `runId`, `g3Ref`, `sourceSha`, `result`). The workflow reads it (read-only token) into `--release-record`; `release-with-recovery.sh` takes the newest entry of the environment as the recovery target. The adapter's `rollback-*` operations additionally require that the target digest appears in the service's deploy history on Render, so the record and the host must agree, and a disagreement stops that step.

After a successful release the adapter writes `release-record-entry-<env>.json` (uploaded as the run artifact `release-<env>-<run_id>`). **Appending it to `deployments-<env>` is a write the reader token cannot make:** the DevOps run that owns the release appends it from the artifact and attaches `deployment-result-<env>.json` to the `v<semver>` GitHub Release. Until it is appended the next release sees no previous entry, so its recovery exits 2. **Owner of that append: the DevOps Engineer, listed as a go-live evidence item** (release record appended for `<env>`), done right after each release.

## Open VERIFY items (owner: DevOps, DO-11 spike)

None of these was checked against a live Render account; the adapter is exercised only against recorded response fixtures (`scripts/ci/release-tests/test/fixtures/render`) served by a local stand-in (`fake-render.ts`).

1. **Deploy by image digest:** `POST /v1/services/{id}/deploys` with `{"imageUrl": "<prefix>/<name>@sha256:..."}`, the deploy statuses (`live`, `update_failed`, `build_failed`, `pre_deploy_failed`, `canceled`, `deactivated`) and `image.sha` on the deploy object. Private GHCR credential on the Render account.
2. **Jobs:** `POST /v1/services/{migrateId}/jobs` with `startCommand`, job statuses (`succeeded`, `failed`, `canceled`), that Jobs work on the chosen service type, and that the migrate service can take an image update without starting. The commands `pnpm db:migrate`, `pnpm jobs:migrate`, `pnpm db:seed --dataset=reference` are defaults of `RENDER_CMD_*`, to be set to what the api image really runs. Fallback: DEVOPS-PLAN 10.1 (runner against the external database URL).
3. **Shutdown delay:** `PATCH /v1/services/{id}` with `serviceDetails.maxShutdownDelaySeconds` and the maximum Render allows (worker drain; default 120 s here).
4. **Backups:** `POST` and `GET /v1/postgres/{id}/export` as the on-demand backup and its listing (`createdAt`). The adapter waits for the new export to be listed as ready (status `completed`/`succeeded`/`ready`/`available`, or a download url when no status exists), fails on `failed`/`canceled` and on `RENDER_EXPORT_TIMEOUT_SECONDS`, so the migration never starts without a usable backup; the status field and its words are unverified. The gate counts only exports that are not failed/pending and reads `createdAt` with fractions and offsets. If Render cannot report export status or offers no on-demand trigger, the gate stays on an existing completed export and the independent logical dump (DEVOPS-PLAN 10.3) runs first.
5. **Deploy history:** `GET /v1/services/{id}/deploys` rows shaped `{deploy: {image: {sha}}}` for the rollback-target check.
6. **Metrics:** the `/internal/metrics/window` field names (`requests`, `errors5xx`, `p95Ms`, `stuckSubmitting`, `kekUnsealFailures`, `workerHeartbeatAgeSeconds`) are requested of the api (AIU-13). `observe.sh` aborts the window when any of them is absent or not a number, so a renamed field cannot switch a threshold off.
7. **Gate record API:** the read path `/api/issues/{id}/documents/{key}` and the document body shape the workflow uses, and whether Paperclip can issue a read-only credential (otherwise the GitHub Release asset fallback of DEVOPS-PLAN 14.2).
8. **Smoke depth:** the adapter checks `/health/ready` and the web origin. The authenticated and synthetic upload checks of DEVOPS-PLAN 14.3 step 7 need app endpoints (AIU-13) and are not claimed here.
9. **Digest check:** `docker manifest inspect` of each approved reference must equal the G3 digest (`actual.json`); first verified on the first runner use.

## Tests

`pnpm --filter release-scripts test:render` runs the release suite (one shared coverage measurement): `render.test.ts` (adapter contract tests: deploy by digest, failed-deploy and wrong-image detection, rollback target, migration order, backup gate, smoke, record), `observe.test.ts` (every abort threshold) and the real `release-with-recovery.sh` entry point run end to end against the stand-in. Evidence: `docs/evidence/TASK-014/adapter.txt`.
