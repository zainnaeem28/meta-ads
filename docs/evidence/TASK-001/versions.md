# TASK-001 versions, licences and probes

Recorded on 2026-11-15 in the ticket workspace. Node v24.22.2 (the recorded fallback line), pnpm 10.34.9 (Corepack, from `packageManager`), TypeScript 6.0.3.

## Resolved direct versions (exact pins, from `pnpm ls -r --depth 0`)

```
## shroomap
  dev @eslint/js 10.0.1
  dev @types/node 26.6.6
  dev dependency-cruiser 18.7.2
  dev eslint 10.15.0
  dev prettier 3.10.1
  dev typescript 6.0.3
  dev typescript-eslint 8.72.2
  dev vitest 5.1.0
## @shroomap/api
  dep @aws-sdk/client-s3 3.1169.0
  dep @aws-sdk/s3-request-presigner 3.1169.0
  dep @clerk/backend 3.29.0
  dep @fastify/helmet 13.2.0
  dep @fastify/multipart 10.1.8
  dep @nestjs/common 12.5.0
  dep @nestjs/core 12.5.0
  dep @nestjs/platform-fastify 12.5.0
  dep @sentry/node 11.12.0
  dep drizzle-orm 0.45.4
  dep fastify 5.12.8
  dep nestjs-pino 5.3.1
  dep openai 7.57.0
  dep pg 8.23.1
  dep pg-boss 12.38.2
  dep pino 10.4.0
  dep prom-client 15.1.3
  dep reflect-metadata 0.2.2
  dep rxjs 7.8.2
  dep sharp 0.35.5
  dep undici 8.12.4
  dep uuid 14.0.3
  dep zod 4.6.7
  dev @types/node 26.6.6
  dev @types/pg 8.23.1
  dev drizzle-kit 0.31.11
  dev typescript 6.0.3
## @shroomap/web
  dep @clerk/nextjs 7.10.0
  dep @hookform/resolvers 5.9.2
  dep @sentry/nextjs 11.12.0
  dep @shroomap/ui link:../../packages/ui
  dep @tanstack/react-query 5.107.1
  dep next 16.4.6
  dep react 19.3.1
  dep react-dom 19.3.1
  dep react-hook-form 7.92.0
  dep tailwindcss 4.3.5
  dep zod 4.6.7
  dev @playwright/test 1.65.1
  dev @tailwindcss/postcss 4.3.5
  dev @testing-library/dom 10.4.2
  dev @testing-library/jest-dom 7.0.1
  dev @testing-library/react 16.3.3
  dev @types/node 26.6.6
  dev @types/react 19.3.0
  dev @types/react-dom 19.3.0
  dev msw 3.0.6
  dev typescript 6.0.3
  dev vitest 5.1.0
## @shroomap/contracts
  dep zod 4.6.7
  dev @redocly/cli 2.78.0
  dev @types/js-yaml 4.0.9
  dev ajv 8.20.0
  dev ajv-formats 3.0.1
  dev js-yaml 4.3.2
  dev openapi-sampler 1.7.10
  dev openapi-typescript 7.13.0
  dev orval 8.48.0
## @shroomap/ui
  dep @radix-ui/react-slot 1.5.0
  dep lucide-react 1.73.0
  dep react 19.3.1
  dep react-dom 19.3.1
```

All direct dependencies are exact pins (smoke test `pins every dependency to an exact version`). Every ARCHITECTURE §1.11 package is declared in the manifest of the workspace that owns it, so later feature tickets need no lockfile change.

## Deviations and additions (for the DevOps Reviewer)

| Item | Decision |
| --- | --- |
| drizzle-kit | §1.11 lists "0.45.x" for drizzle-orm and drizzle-kit; drizzle-kit has no 0.45 line (latest 0.31.11). Pinned 0.31.11 with drizzle-orm 0.45.4. Needs a solution-architect note in the next architecture revision. |
| @fastify/multipart | Line says Fastify 5.x; latest is 10.1.8 (the @nestjs/platform-fastify 12.5.0 peer is ^10.1.0). Pinned 10.1.8. |
| @fastify/helmet | 13.2.0 |
| reflect-metadata 0.2.2, rxjs 7.8.2 | Required peers of @nestjs/core and @nestjs/common 12.5.0; not in §1.11. Needed by the minimal Nest app. |
| @tailwindcss/postcss 4.3.5 | Tailwind 4 build integration for Next; part of the tailwindcss 4.x line. |
| @types/node, @types/pg, @types/react, @types/react-dom, @types/js-yaml | Type packages for listed libraries. |
| eslint, @eslint/js, typescript-eslint, prettier | Tooling the ticket requires (ESLint and Prettier configs). |
| pnpm.onlyBuiltDependencies (esbuild, sharp, unrs-resolver) | pnpm 10 blocks install scripts by default. |
| Next lint | `eslint-config-next` is not in §1.11 and is not installed; the root config uses typescript-eslint. |
| Node 26 | `.nvmrc` is 26 (target). This environment has Node 24.22.2 and cannot run Node 26 (`libatomic.so.1` missing, `npx node@26` fails). `engines` is `>=24.22.2 <27`. The fallback is recorded: everything here was verified on Node 24. Node 26 verification is left to hosted CI (DO-02). |

## TS 7 compatibility probe (TD-D27)

`typescript@7.0.2` installed outside the repo; `tsc -p tsconfig.json --noEmit` run in `apps/api` and `apps/web`: both exit 0 with no diagnostics. The repo stays on 6.0.3 (held below 7).

## Licences (`pnpm licenses list`, 565 packages)

MIT 416, Apache-2.0 58, ISC 21, BSD-2-Clause 8, BSD-3-Clause 8, BlueOak-1.0.0 7, MPL-2.0 2 (lightningcss), LGPL-3.0-or-later 1 (`@img/sharp-libvips-linux-x64`, dynamically linked, as §1.11), Python-2.0 1 (argparse), CC-BY-4.0 1 (caniuse-lite data), Unlicense 1, 0BSD 1, (MIT OR CC0-1.0) 1, **FSL-1.1-Apache-2.0 1: `sentry` 0.49.0** (transitive of `@sentry/nextjs`, the Sentry CLI). Flagged for the Security Reviewer: not on the §1.11 licence column; it is a build-time CLI, not shipped in the images. No change made.

## Dependency audit (`pnpm audit`)

0 critical, 0 high, 2 moderate: esbuild dev-server request issue (via drizzle-kit's legacy `@esbuild-kit` loader, dev tool only) and minimatch DoS (via typescript-eslint, dev only). Report: `reports/deps.json`.

## Real-entry-point run

`CI=1 pnpm -w test:foundation` (5 tests, `tools/foundation-tests/foundation.test.ts`): frozen install and typecheck, built api answers `GET /health/live` with `{"status":"ok"}`, built web standalone server returns the route. JUnit: `reports/foundation/junit.xml`.
