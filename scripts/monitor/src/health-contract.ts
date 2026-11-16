import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validEnv } from '../../../apps/api/src/platform/config/test-env.ts';

// API-900 / API-901 contract in CI (DEVOPS-PLAN 11.1): the BUILT api (apps/api/dist/main.api.js, the real entry point)
// is started against a throwaway database on the shared test PostgreSQL, and both health answers are validated against
// HealthResponse of packages/contracts/openapi.yaml, including the denial and drain behaviour that uptime probes rely on.
// Run through scripts/ci/health-contract-check.sh, which builds the api first.

const root = join(import.meta.dirname, '..', '..', '..');
const apiDir = join(root, 'apps', 'api');
const contractsDir = join(root, 'packages', 'contracts');
const adminUrl =
  process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres@test-db:5432/postgres';
const database = `health_contract_${randomBytes(4).toString('hex')}`;
const apiRequire = createRequire(join(apiDir, 'package.json'));
const contractsRequire = createRequire(join(contractsDir, 'package.json'));

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}\n`);
  if (!ok) failures.push(name);
};

interface AjvLike {
  addSchema(schema: object, key: string): void;
  compile(schema: object): Validate;
}
type Validate = ((value: unknown) => boolean) & { errors?: unknown };
function healthValidator(): Validate {
  const Ajv2020 = (contractsRequire('ajv/dist/2020') as { default: new (o: object) => AjvLike })
    .default;
  const addFormats = (contractsRequire('ajv-formats') as { default: (a: unknown) => void }).default;
  const yaml = contractsRequire('js-yaml') as {
    load(text: string): { components: unknown; paths: Record<string, unknown> };
  };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  for (const path of ['/health/live', '/health/ready'])
    check(`openapi declares ${path}`, path in spec.paths);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ components: spec.components }, 'spec');
  return ajv.compile({ $ref: 'spec#/components/schemas/HealthResponse' });
}

async function start(
  port: number,
  databaseUrl: string,
  env: Record<string, string>,
): Promise<{ child: ChildProcess; base: string }> {
  let err = '';
  const child = spawn('node', ['dist/main.api.js'], {
    cwd: apiDir,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...validEnv('api', { DATABASE_URL: databaseUrl, API_PORT: String(port), ...env }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health/live`)).ok) return { child, base };
    } catch {
      if (Date.now() > deadline) throw new Error(`the api did not start: ${err.slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const pg = apiRequire('pg') as {
  Client: new (o: { connectionString: string }) => {
    connect(): Promise<void>;
    query(q: string): Promise<unknown>;
    end(): Promise<void>;
  };
};
const children: ChildProcess[] = [];

async function main(): Promise<void> {
  const validate = healthValidator();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  try {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const databaseUrl = url.toString();
    const setup = new pg.Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query('CREATE SCHEMA IF NOT EXISTS pgboss');
    await setup.end();
    const jobs = (await import(
      pathToFileURL(join(apiDir, 'dist', 'database', 'jobs-migrate.js')).href
    )) as {
      migrateJobs(url: string, a: undefined, b: null): Promise<unknown>;
    };
    await jobs.migrateJobs(databaseUrl, undefined, null);

    const healthy = await start(3961, databaseUrl, {});
    children.push(healthy.child);
    for (const headers of [{}, { authorization: 'Bearer anything' }]) {
      const live = await fetch(`${healthy.base}/health/live`, { headers });
      const body = (await live.json()) as { data?: unknown };
      check(
        'API-900 answers 200 with the enveloped HealthResponse, whatever Authorization says',
        live.status === 200 && validate(body) && JSON.stringify(body.data) === '{"status":"ok"}',
        JSON.stringify(validate.errors),
      );
    }
    const ready = await fetch(`${healthy.base}/health/ready`);
    const readyBody = (await ready.json()) as unknown;
    check(
      'API-901 answers 200 with a valid HealthResponse and no detail',
      ready.status === 200 &&
        validate(readyBody) &&
        !/database|queue|schema/i.test(JSON.stringify(readyBody)),
      JSON.stringify(validate.errors),
    );

    const unready = await start(3962, databaseUrl, { MIN_SCHEMA_HEAD: '99' });
    children.push(unready.child);
    const down = await fetch(`${unready.base}/health/ready`);
    const downBody = (await down.json()) as { error?: { code?: string; details?: unknown } };
    check(
      'API-901 answers 503 service_unavailable without detail when the schema head is out of range',
      down.status === 503 &&
        downBody.error?.code === 'service_unavailable' &&
        downBody.error.details === undefined &&
        !/schema|head|database/i.test(JSON.stringify(downBody)),
    );
    check(
      'API-900 stays 200 while API-901 is 503',
      (await fetch(`${unready.base}/health/live`)).status === 200,
    );

    const draining = await start(3963, databaseUrl, { API_DRAIN_SECONDS: '3' });
    check(
      'API-901 is 200 before a stop signal',
      (await fetch(`${draining.base}/health/ready`)).status === 200,
    );
    const exited = new Promise((resolve) => draining.child.once('exit', resolve));
    draining.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      'API-901 is 503 while draining after SIGTERM',
      (await fetch(`${draining.base}/health/ready`)).status === 503,
    );
    await exited;
  } finally {
    for (const child of children) child.kill('SIGKILL');
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await cleanup.end();
  }
}

try {
  await main();
} catch (error) {
  check('health contract run', false, error instanceof Error ? error.message : 'error');
}
process.stdout.write(
  failures.length === 0
    ? 'health-contract-check: PASS\n'
    : `health-contract-check: FAIL (${failures.length})\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
