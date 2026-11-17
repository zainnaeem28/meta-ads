import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: 'reports/config/junit.xml' }],
      ['junit', { outputFile: 'reports/logging/junit.xml' }],
      ['junit', { outputFile: 'reports/http/junit.xml' }],
      ['junit', { outputFile: 'reports/db/junit.xml' }],
      ['junit', { outputFile: 'reports/egress/junit.xml' }],
      ['junit', { outputFile: 'reports/audit/junit.xml' }],
      ['junit', { outputFile: 'reports/identity/junit.xml' }],
      ['junit', { outputFile: 'reports/identity-auth/junit.xml' }],
      ['junit', { outputFile: 'reports/invitations/junit.xml' }],
      ['junit', { outputFile: 'reports/access/junit.xml' }],
      ['junit', { outputFile: 'reports/identity-admin/junit.xml' }],
      ['junit', { outputFile: 'reports/keys-crypto/junit.xml' }],
      ['junit', { outputFile: 'reports/media-core/junit.xml' }],
      ['junit', { outputFile: 'reports/media-api/junit.xml' }],
      ['junit', { outputFile: 'reports/media-worker/junit.xml' }],
      ['junit', { outputFile: 'reports/keys/junit.xml' }],
      ['junit', { outputFile: 'reports/usage/junit.xml' }],
      ['junit', { outputFile: 'reports/campaigns/junit.xml' }],
      ['junit', { outputFile: 'reports/campaigns-list/junit.xml' }],
      ['junit', { outputFile: 'reports/brief-data/junit.xml' }],
      ['junit', { outputFile: 'reports/brief-ai/junit.xml' }],
      ['junit', { outputFile: 'reports/brief-api/junit.xml' }],
      ['junit', { outputFile: 'reports/brief-jobs/junit.xml' }],
      ['junit', { outputFile: 'reports/prod-jobs/junit.xml' }],
      ['junit', { outputFile: 'reports/prod-worker/junit.xml' }],
      ['junit', { outputFile: 'reports/lifecycle-del/junit.xml' }],
      ['junit', { outputFile: 'reports/jobs/junit.xml' }],
      ['junit', { outputFile: 'reports/limits/junit.xml' }],
      ['junit', { outputFile: 'reports/observability/junit.xml' }],
    ],
    coverage: {
      provider: 'v8',
      include: [
        'src/platform/config/**/*.ts',
        'src/platform/logging/**/*.ts',
        'src/platform/http/**/*.ts',
        'src/platform/egress/**/*.ts',
        'src/platform/shared-kernel/**/*.ts',
        'src/platform/db/**/*.ts',
        'src/modules/audit/**/*.ts',
        'src/modules/identity/**/*.ts',
        'src/modules/provider-keys/**/*.ts',
        'src/modules/media/**/*.ts',
        'src/modules/usage/**/*.ts',
        'src/modules/campaigns/**/*.ts',
        'src/modules/brief/**/*.ts',
        'src/modules/production/**/*.ts',
        'src/modules/lifecycle/**/*.ts',
        'src/platform/jobs/**/*.ts',
        'src/platform/rate-limit/**/*.ts',
        'src/platform/idempotency/**/*.ts',
        'src/platform/health/**/*.ts',
        'src/platform/metrics/**/*.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/platform/config/test-env.ts',
        'src/platform/config/index.ts',
        'src/platform/logging/index.ts',
        'src/platform/logging/test-support.ts',
        'src/platform/http/test-support.ts',
        'src/platform/http/index.ts',
        'src/platform/egress/index.ts',
        'src/platform/egress/test-support.ts',
        'src/platform/shared-kernel/index.ts',
        'src/platform/db/index.ts',
        'src/platform/rate-limit/index.ts',
        'src/platform/idempotency/index.ts',
        'src/platform/health/index.ts',
        'src/platform/metrics/index.ts',
        'src/platform/db/schema.ts',
        'src/platform/db/test-database.ts',
        'src/platform/jobs/test-support.ts',
        'src/database/**',
        // Wiring and the Drizzle repository are proven on real PostgreSQL by tests/integration/audit.
        'src/modules/audit/index.ts',
        'src/modules/audit/audit.module.ts',
        'src/modules/audit/infrastructure/audit.repository.ts',
        'src/modules/audit/application/ports.ts',
        // Wiring and the Drizzle repositories are proven on real PostgreSQL by identity.integration.test.ts.
        'src/modules/identity/identity.module.ts',
        'src/modules/identity/index.ts',
        'src/modules/identity/application/linking.service.ts',
        'src/modules/identity/infrastructure/identity.queries.ts',
        'src/modules/identity/infrastructure/identity.repositories.ts',
        // The Drizzle store of the invitations is proven on real PostgreSQL by invitations.integration.test.ts.
        'src/modules/identity/application/invitations.store.ts',
        'src/modules/identity/infrastructure/test-support.ts',
        // Wiring is proven through the real composition roots on real PostgreSQL by provider-keys.integration.test.ts.
        'src/modules/provider-keys/provider-keys.module.ts',
        'src/modules/provider-keys/infrastructure/test-support.ts',
        // The S3 adapter is proven on a real MinIO server by s3-storage.integration.test.ts, the Drizzle repository and
        // the module wiring on real PostgreSQL through the api composition root by media.integration.test.ts.
        'src/modules/media/index.ts',
        'src/modules/media/media.module.ts',
        'src/modules/media/infrastructure/s3-storage.ts',
        'src/modules/media/infrastructure/media.repository.ts',
        // The worker's SQL is proven on real PostgreSQL, MinIO and sharp through the worker composition root by
        // media-worker.integration.test.ts; the port and the type-only contracts have no statements.
        'src/modules/media/infrastructure/media-maintenance.repository.ts',
        'src/modules/media/worker/maintenance.ts',
        'src/modules/media/infrastructure/test-support.ts',
        // The SQL repository, the price-file seed step and the module wiring are proven on real PostgreSQL through the api
        // composition root by usage.integration.test.ts; the fakes are the unit tests' own.
        'src/modules/usage/index.ts',
        'src/modules/usage/usage.module.ts',
        'src/modules/usage/application/fakes.ts',
        'src/modules/usage/application/ports.ts',
        'src/modules/usage/infrastructure/usage.repository.ts',
        'src/modules/usage/infrastructure/price-table-file.ts',
        // The SQL repository and the module wiring are proven on real PostgreSQL through the api composition root by
        // drafts.integration.test.ts; the in-memory fakes are the unit tests' own.
        'src/modules/campaigns/index.ts',
        'src/modules/campaigns/campaigns.module.ts',
        'src/modules/campaigns/application/draft-ports.ts',
        'src/modules/campaigns/infrastructure/draft.repository.ts',
        // The rule repository, the reader, the rules-file seed step and the module wiring are proven on real PostgreSQL
        // through the api composition root by brief.integration.test.ts; the domain is pure and unit tested.
        'src/modules/brief/brief.module.ts',
        'src/modules/brief/domain/index.ts',
        'src/modules/brief/infrastructure/repositories/brand-rules-file.ts',
        'src/modules/brief/infrastructure/repositories/brand-rules.reader.ts',
        'src/modules/brief/infrastructure/repositories/brand-rules.repository.ts',
        // The brief repository is proven on real PostgreSQL through the api composition root by brief.integration.test.ts
        // (transport); the port file holds types only.
        'src/modules/brief/application/brief-ports.ts',
        'src/modules/brief/infrastructure/repositories/brief.repository.ts',
        // The SQL repository, the queue adapter, the S3 ledger adapter, the controller and the module wiring are proven on real
        // PostgreSQL through the api and worker composition roots by campaign-deletion.integration.test.ts; the port file
        // holds types only.
        'src/modules/lifecycle/lifecycle.module.ts',
        'src/modules/lifecycle/application/campaign-deletion-ports.ts',
        'src/modules/lifecycle/infrastructure/campaign-deletion.repository.ts',
        'src/modules/lifecycle/infrastructure/campaign-deletion.queueing.ts',
        'src/modules/lifecycle/infrastructure/campaign-erasure-ledger.ts',
        'src/modules/lifecycle/transport/campaign-deletion.controller.ts',
        // The Drizzle repository of the brief jobs and the key-auth reporter are proven on real PostgreSQL through the worker
        // composition root by brief-ai.integration.test.ts; the handlers and the adapter are unit tested here.
        'src/modules/brief/infrastructure/brief-jobs.repository.ts',
        'src/modules/brief/infrastructure/key-auth.reporter.ts',
        // The job-creating operations (API-024, 035, 036, 053) are proven on real PostgreSQL through the api and worker
        // composition roots by submit.integration.test.ts; the completeness rule, the reuse hash and the job summary are unit
        // tested here (submit.test.ts).
        'src/modules/brief/transport/submit-jobs.ts',
        'src/modules/brief/transport/submit.service.ts',
        'src/modules/brief/transport/submit.controller.ts',
        'src/modules/brief/transport/analysis.service.ts',
        'src/modules/brief/transport/analysis.controller.ts',
        'src/modules/brief/transport/regenerate.service.ts',
        'src/modules/brief/transport/regenerate.controller.ts',
        // The video jobs service and its Drizzle reads, the progress reader, the controller and the module wiring are proven on
        // real PostgreSQL through the api composition root by production.integration.test.ts (API-060 to API-063); the reuse
        // hash, the labels, the out-of-date rule and the progress derivation are pure and unit tested (video-job.test.ts).
        'src/modules/production/production.module.ts',
        'src/modules/production/application/video-ports.ts',
        'src/modules/production/application/video-jobs.service.ts',
        'src/modules/production/infrastructure/video-progress.reader.ts',
        'src/modules/production/transport/video.controller.ts',
        // The worker's handlers (submit, poll, copy, cleanup), the sweep hooks, the SQL repository, the key-auth reporter and the
        // port file are proven on real PostgreSQL through the worker composition root by production-worker.integration.test.ts
        // (TC-CLP-06, TC-PCA-01 to 08 and 10, TC-EGR); the WaveSpeed adapter, the MP4 check and the key gate are unit tested.
        'src/modules/production/application/worker/ports.ts',
        'src/modules/production/application/worker/copy-queue.ts',
        'src/modules/production/application/worker/recovery.ts',
        'src/modules/production/application/worker/video-submit.job.ts',
        'src/modules/production/application/worker/video-poll.job.ts',
        'src/modules/production/application/worker/video-copy.job.ts',
        'src/modules/production/application/worker/provider-copy-cleanup.job.ts',
        'src/modules/production/infrastructure/wavespeed/video-worker.repository.ts',
        'src/modules/production/infrastructure/wavespeed/key-auth.reporter.ts',
      ],
      reporter: ['text', 'lcovonly'],
      reportsDirectory: 'reports/http',
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
