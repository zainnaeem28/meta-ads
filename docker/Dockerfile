# syntax=docker/dockerfile:1.7
# Shroomap images (DEVOPS-PLAN 9, ARCHITECTURE 1.6 VII/IX): targets api, worker, web. Build once, deploy by digest.
# The `backup` target (DO-07a) holds no application code. Build from the repository root: docker build -f docker/Dockerfile --target api .
# Base image pinned by digest (node 24.22.2, Debian bookworm slim).
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production PNPM_HOME=/pnpm CI=1
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /repo

# Dependency layer: only manifests and the lockfile, so source edits do not reinstall.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY tools/provider-stubs/package.json tools/provider-stubs/
COPY tools/foundation-tests/db/package.json tools/foundation-tests/db/
COPY tools/foundation-tests/slices/package.json tools/foundation-tests/slices/
COPY tools/foundation-tests/media/package.json tools/foundation-tests/media/
COPY scripts/backup/package.json scripts/backup/
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --prod=false

FROM deps AS source
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages

# ---- api: compile, then keep only production dependencies ----
FROM source AS api-build
RUN pnpm --filter @shroomap/api build \
 && pnpm --filter @shroomap/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/src /out/api/tsconfig*.json /out/api/vitest*.ts && cp -r apps/api/dist /out/api/dist

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_PORT=4000
WORKDIR /app
COPY --from=api-build --chown=node:node /out/api/ ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.api.js"]

# ---- worker: the api build plus the pinned static FFmpeg 7.1 (LGPL build, no GPL or nonfree parts) and libvips ----
FROM base AS ffmpeg
ARG FFMPEG_TAG=autobuild-2026-07-31-14-10
ARG FFMPEG_ARCHIVE=ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-lgpl-7.1.tar.xz
ARG FFMPEG_SHA256=58057a52db17bd2fefa87f271956f04aa2277d55efc13f288594cc2c65c59479
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL -o /tmp/ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/${FFMPEG_ARCHIVE}" \
 && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum --check --status \
 && mkdir /ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /ffmpeg --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'

FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends libvips42 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg/ffmpeg /ffmpeg/ffprobe /usr/local/bin/
WORKDIR /app
COPY --from=api-build --chown=node:node /out/api/ ./
USER node
CMD ["node", "dist/main.worker.js"]

# ---- web: built per environment, public build values only (NEXT_PUBLIC_*); no secret may be a build argument ----
FROM source AS web-build
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
ARG NEXT_PUBLIC_APP_ENV=development
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @shroomap/web build

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ---- backup (DO-07a, SB v6 7.1 A): the copy script, the PostgreSQL client of the server's major version and age. No
# application code (no apps/api, ops-cli, unsealer, Drizzle or pg-boss) and no KEK or age private key. Runs only as the
# `backup` cron service. Two repository stages: the script with production dependencies only, then the runtime image. ----
FROM deps AS backup-build
COPY scripts/backup scripts/backup
RUN pnpm --filter backup deploy --prod --legacy /out/backup \
 && rm -rf /out/backup/tests /out/backup/vitest.config.ts /out/backup/tsconfig.json

FROM ${NODE_IMAGE} AS backup
# The client major version must equal the server's (DO-11 records it); the PGDG key is pinned by the checksum file.
ARG PG_MAJOR=17
ENV NODE_ENV=production
COPY docker/backup/pgdg.asc.sha256 /tmp/pgdg.asc.sha256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl age \
 && curl -fsSL -o /usr/share/keyrings/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && sha256sum --check --status /tmp/pgdg.asc.sha256 \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
 && apt-get purge -y --auto-remove curl && rm -rf /var/lib/apt/lists/* /tmp/pgdg.asc.sha256 \
 && pg_dump --version && age --version
WORKDIR /app
COPY --from=backup-build --chown=node:node /out/backup/ ./
USER node
CMD ["node", "src/main.ts"]
