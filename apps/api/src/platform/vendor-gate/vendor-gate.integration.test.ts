import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import type { EdgeConfig } from '../../bootstrap/api.module.js';
import { createWorkerApp } from '../../bootstrap/worker.module.js';
import type { WorkerApp, WorkerConfig } from '../../bootstrap/worker.module.js';
import { validateConfig } from '../config/index.js';
import { validEnv } from '../config/test-env.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { buildLogger, createHttpLogging } from '../logging/index.js';
import { installJobs } from '../jobs/test-support.js';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { runSeed } from '../../database/seed.js';
import type { SeedStep } from '../../database/index.js';
import { sql } from 'drizzle-orm';
import { DiscoveryService, NestFactory } from '@nestjs/core';
import { VENDOR_GATE, VendorGateError, VendorGateModule } from './index.js';
import type { VendorGate } from './index.js';

// TC-NFR-09, TC-ZT-vendor through the real composition roots on real PostgreSQL: the worker and the api refuse to
// start when a vendor is `real` without a recorded contract, and start on stubs by default.

let database: TestDatabase;
const { logger } = buildLogger({ level: 'silent' });
const apps: WorkerApp[] = [];

const workerConfig = (): WorkerConfig => ({
  DATABASE_URL: database.url,
  DATABASE_POOL_MAX: 4,
  DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
  WORKER_WATCHDOG_SECONDS: 180,
  WORKER_DRAIN_SECONDS: 5,
  WORKER_CONCURRENCY_PROVIDER: 2,
  WORKER_CONCURRENCY_SANITIZE: 1,
  WORKER_CONCURRENCY_DELETION: 1,
});

beforeAll(async () => {
  database = await createTestDatabase({ label: 'task064', migrations: false });
  await installJobs(database.url);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const app of apps.splice(0)) {
    await app.runtime.drain();
    await app.context.close();
  }
});

afterAll(async () => {
  await database.drop();
});

/** The release seed's price-table step, read straight from `config/price-table.json` (platform code does not import modules). */
function priceTableStep(): SeedStep {
  const file = join(REAL_MIGRATIONS, '..', '..', '..', '..', '..', 'config', 'price-table.json');
  const rows = (
    JSON.parse(readFileSync(file, 'utf8')) as { rows: Array<Record<string, string | number>> }
  ).rows;
  return {
    name: 'price_table',
    datasets: ['reference'],
    run: async (tx) => {
      for (const row of rows) {
        await tx.execute(sql`
          insert into price_table (provider, operation, effective_from, unit, unit_price_usd, units_per_call)
          values (${row['provider']}, ${row['operation']}, ${row['effectiveFrom']}::date, ${row['unit']},
                  ${row['unitPriceUsd']}::numeric, ${row['unitsPerCall']}::numeric)
          on conflict do nothing`);
      }
      return rows.length;
    },
  };
}

describe('worker composition root', () => {
  it('starts on stubs in the default configuration and holds the gate', async () => {
    const app = await createWorkerApp(workerConfig(), { logger, env: {} });
    apps.push(app);
    const gate = app.context.get<VendorGate>(VENDOR_GATE);
    expect(gate.modeOf('openai')).toBe('synthetic');
    expect(gate.modeOf('wavespeed')).toBe('synthetic');
  });

  for (const key of ['CLERK', 'R2', 'OPENAI', 'WAVESPEED', 'SHOTSTACK']) {
    it(`fails to start for PROVIDER_DATA_MODE_${key}=real without a contract record`, async () => {
      await expect(
        createWorkerApp(workerConfig(), { logger, env: { [`PROVIDER_DATA_MODE_${key}`]: 'real' } }),
      ).rejects.toThrow(/vendor gate: .* refused/);
    });
  }
});

/** The environment that makes the worker root build the production, QC and thumbnail adapters (nothing is called). */
function fullWorkerEnv(): Record<string, string | undefined> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  return {
    KEK_PUBLIC_KEYS: JSON.stringify({
      1: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }),
    KEK_PRIVATE_KEYS: JSON.stringify({
      1: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    KEK_ACTIVE_VERSION: '1',
    R2_ENDPOINT: 'http://127.0.0.1:1',
    R2_BUCKET: 'task064',
    R2_ACCESS_KEY_ID: 'task064',
    R2_SECRET_ACCESS_KEY: 'task064-secret',
    MEDIA_MAX_PIXEL_DIMENSION: '300',
    MEDIA_MAX_PIXELS: '40000',
    MEDIA_UNATTACHED_TTL_HOURS: '24',
    KEY_AUTO_DISABLE_THRESHOLD: '2',
    OPENAI_IMAGE_MODEL: 'local-stub-image',
    POLL_INTERVAL_SEC: '2',
    POLL_LEASE_SEC: '5',
    SUBMIT_ORPHAN_AFTER_SEC: '60',
    PROVIDER_OUTPUT_COPY_WINDOW_HOURS: '1',
    PROVIDER_OUTPUT_MAX_BYTES: '20000',
  };
}

describe('worker composition root: call-time refusal on real adapter instances', () => {
  const ADAPTERS: Record<string, [string, string]> = {
    OPENAI: ['OpenAiTranscribe', 'openai'],
    WAVESPEED: ['WaveSpeedVideoGen', 'wavespeed'],
  };
  let fullDb: TestDatabase;
  beforeAll(async () => {
    // The production adapters need the tables and the seeded price table the start-up price check reads.
    fullDb = await createTestDatabase({ label: 'task064full', migrations: false });
    const pool = new pg.Pool({ connectionString: fullDb.url, max: 2 });
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      for (const file of [
        '0010_task-032-audit.sql',
        '0020_task-033-identity.sql',
        '0030_task-039-provider-keys.sql',
        '0040_task-041-media.sql',
        '0050_task-044-usage.sql',
        '0070_task-046-campaigns.sql',
        '0080_task-048-brief.sql',
        '0090_task-052-production-video.sql',
        '0100_task-055-production-assembly.sql',
        '0110_task-057-production-thumbstopper.sql',
      ]) {
        const tables =
          readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
        for (const statement of tables.split('--> statement-breakpoint')) {
          const sql = statement
            .split('\n')
            .filter((line) => !line.trim().startsWith('--'))
            .join('\n')
            .trim();
          if (sql !== '') await pool.query(sql);
        }
      }
    } finally {
      await pool.end();
    }
    await installJobs(fullDb.url);
    await runSeed({
      dataset: 'reference',
      appEnv: 'development',
      databaseUrl: fullDb.url,
      steps: [priceTableStep()],
    });
  });
  afterAll(async () => {
    await fullDb.drop();
  });

  for (const [key, [className]] of Object.entries(ADAPTERS)) {
    it(`${className} built by the root refuses a call once PROVIDER_DATA_MODE_${key} turns real`, async () => {
      const env: Record<string, string | undefined> = fullWorkerEnv();
      const app = await createWorkerApp(
        { ...workerConfig(), DATABASE_URL: fullDb.url },
        { logger, env, exit: () => undefined },
      );
      apps.push(app);
      const found = app.context
        .get(DiscoveryService)
        .getProviders()
        .map((w) => w.instance as object | null)
        .find((i) => i?.constructor.name === className);
      expect(found).toBeDefined();
      const method = Object.getOwnPropertyNames(Object.getPrototypeOf(found)).find(
        (n) => n !== 'constructor' && typeof (found as Record<string, unknown>)[n] === 'function',
      )!;
      env[`PROVIDER_DATA_MODE_${key}`] = 'real';
      expect(() => (found as Record<string, (...a: unknown[]) => unknown>)[method]!()).toThrow(
        VendorGateError,
      );
    });
  }
});

describe('a missing or malformed register fails closed at the root', () => {
  it('VendorGateModule with an empty register refuses to start, even with no mode set', async () => {
    await expect(
      NestFactory.createApplicationContext(
        VendorGateModule.register({}, { vendors: [], absentAdapters: [] }),
        { logger: false },
      ),
    ).rejects.toThrow(/vendor gate: .* refused \(register-incomplete\)/);
  });
});

describe('api composition root', () => {
  const edge = (): EdgeConfig => {
    const result = validateConfig('api', validEnv('api', { DATABASE_URL: database.url }));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.config as EdgeConfig;
  };
  const logging = () => createHttpLogging({ level: 'silent', secretValues: [] });

  it('refuses to start with real OpenAI and no record', async () => {
    vi.stubEnv('PROVIDER_DATA_MODE_OPENAI', 'real');
    await expect(createApiApp(edge(), logging())).rejects.toThrow(
      /vendor gate: openai refused \(no-contract-record\)/,
    );
  });

  for (const key of ['OPENAI', 'WAVESPEED', 'CLERK', 'R2']) {
    it(`refuses to start with PROVIDER_DATA_MODE_${key}=real (gate, not config, is the thrower)`, async () => {
      vi.stubEnv(`PROVIDER_DATA_MODE_${key}`, 'real');
      await expect(createApiApp(edge(), logging())).rejects.toThrow(
        /vendor gate: .* refused|PROVIDER_DATA_MODE_/,
      );
    });
  }

  it('starts on stubs by default', async () => {
    const { app } = await createApiApp(edge(), logging());
    try {
      expect(app.get<VendorGate>(VENDOR_GATE).modeOf('clerk')).toBe('synthetic');
    } finally {
      await app.close();
    }
  });
});
