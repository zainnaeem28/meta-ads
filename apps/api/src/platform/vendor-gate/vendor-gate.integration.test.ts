import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import type { EdgeConfig } from '../../bootstrap/api.module.js';
import { createWorkerApp } from '../../bootstrap/worker.module.js';
import type { WorkerApp, WorkerConfig } from '../../bootstrap/worker.module.js';
import { validateConfig } from '../config/index.js';
import { validEnv } from '../config/test-env.js';
import { createTestDatabase } from '../db/test-database.js';
import type { TestDatabase } from '../db/test-database.js';
import { buildLogger, createHttpLogging } from '../logging/index.js';
import { installJobs } from '../jobs/test-support.js';
import { VENDOR_GATE } from './index.js';
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

describe('api composition root', () => {
  const edge = (): EdgeConfig => {
    const result = validateConfig('api', validEnv('api', { DATABASE_URL: database.url }));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.config as EdgeConfig;
  };
  const logging = () => createHttpLogging({ level: 'silent', secretValues: [] });

  it('refuses to start with real OpenAI and no record', async () => {
    vi.stubEnv('PROVIDER_DATA_MODE_OPENAI', 'real');
    await expect(createApiApp(edge(), logging())).rejects.toThrow(/vendor gate: openai refused \(no-contract-record\)/);
  });

  it('starts on stubs by default', async () => {
    const { app } = await createApiApp(edge(), logging());
    try {
      expect(app.get<VendorGate>(VENDOR_GATE).modeOf('clerk')).toBe('synthetic');
    } finally {
      await app.close();
    }
  });
});
