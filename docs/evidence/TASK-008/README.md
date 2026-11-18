# TASK-008 evidence (containers, DO-04a)

## Ran in this run (no Docker daemon available)
- `docker compose -f docker/compose.dev.yml config` and `docker compose -f docker/compose.ci.yml config` (compose v2.40.3
  binary, config rendering needs no daemon): both valid; ci also valid with `CI_ENV_DIR` set and with two project names (`-p a`, `-p b`).
- `scripts/ci/iac.sh`: Trivy config scan of `docker/`: 0 blocking findings.
- The Dockerfile's own commands, run on the host in the same order: `pnpm install --frozen-lockfile`,
  `pnpm --filter @shroomap/api build`, `pnpm --filter @shroomap/api deploy --prod --legacy`, then the deployed
  `dist/main.api.js` started with `docker/smoke/make-env.sh` synthetic config -> `GET /health/live` = `{"status":"ok"}`;
  with an incomplete config it exits 78. `next build` produced `.next/standalone/apps/web/server.js`, started from a copy
  with `.next/static`: `GET /` = 200. `docker/stubs/run.ts` served `/v1/models` on its published port.

## Not run (needs a Docker daemon)
`docker build` of api/worker/web, non-root and read-only checks, Trivy image scan on the digest, the two-stacks-side-by-side
run, `docker compose up` of the dev stack, digest and reproducibility record. `scripts/ci/container-scan.sh` does all of it
and fails (exit 1, never a pass) without a daemon.

## Findings for the Orchestrator
1. `R2_ENDPOINT` must be https (`apps/api/src/platform/config/registry.ts:111`, `httpsUrl`), also in development. The CI MinIO
   therefore serves TLS with a throwaway certificate, and api/worker trust it through `NODE_EXTRA_CA_CERTS`. A developer
   running the API on the host against `compose.dev.yml` (plain-http MinIO) is rejected with exit 78 until the schema allows
   `anyUrl` outside staging/production (config owner, TASK-020; not in this ticket's paths).
2. `apps/api/src/main.worker.ts` does not exist yet, so the worker's start/health probe is reported as skipped in junit.
3. `.env.example` does not exist (outside this ticket's paths); `compose.dev.yml` carries local-only defaults inline
   (`${VAR:-default}`), so it starts with nothing supplied.
4. MinIO and mc images are pinned by tag (quay.io digests could not be read from the sandbox); postgres, mailpit and node are pinned by digest.

## Hosted CI run (AIU-216)
`ci.yml` job `container-scan` now runs `scripts/ci/container-scan.sh` plus a compose smoke (dev stack, two `compose.ci.yml`
stacks `-p smoke-ci-a/b`). Dispatched with `gh workflow run ci --ref <branch>` (run 43761972457): every job was refused by
GitHub before starting ("recent account payments have failed or your spending limit needs to be increased"). Nothing
ran; the Docker build, smoke and Trivy checks are still NOT run. Owner item: fix GitHub billing for zainnaeem28, then rerun.
