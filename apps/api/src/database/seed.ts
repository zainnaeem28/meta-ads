import { pathToFileURL } from 'node:url';
import { APP_ENVS, loadConfigOrExit } from '../platform/config/index.js';
import type { AppEnv } from '../platform/config/index.js';
import { createDatabase } from '../platform/db/index.js';
import { DATASETS } from './index.js';
import type { Dataset, SeedStep } from './index.js';
import { SeedRefusedError } from './seeds/errors.js';
import { buildSeedSteps } from './seeds/index.js';

export { SeedRefusedError };

/** The environment each non-reference dataset may run in; `reference` runs everywhere, production included. */
const DATASET_ENV: Readonly<Partial<Record<Dataset, AppEnv>>> = {
  development: 'development',
  staging: 'staging',
};

export function parseDataset(argv: readonly string[]): Dataset {
  const arg = argv.find((item) => item.startsWith('--dataset='));
  const value = arg?.slice('--dataset='.length);
  const dataset = DATASETS.find((candidate) => candidate === value);
  if (dataset === undefined)
    throw new SeedRefusedError(`--dataset must be one of ${DATASETS.join(', ')}`);
  return dataset;
}

export function authorizeDataset(dataset: Dataset, appEnv: AppEnv): void {
  const required = DATASET_ENV[dataset];
  if (required !== undefined && required !== appEnv) {
    throw new SeedRefusedError(`dataset ${dataset} runs only with APP_ENV=${required}`);
  }
  if (appEnv === 'production' && dataset !== 'reference') {
    throw new SeedRefusedError('production accepts only the reference dataset');
  }
}

export interface SeedRun {
  readonly dataset: Dataset;
  readonly appEnv: AppEnv;
  readonly databaseUrl: string;
  readonly steps?: readonly SeedStep[];
  /** Run every step, then roll the transaction back: the counts are real, nothing stays. */
  readonly dryRun?: boolean;
}

class DryRunRollback extends Error {
  constructor(readonly counts: SeedCount[]) {
    super('dry run');
  }
}

/** The step names a dataset runs, in order (authorization is checked first). */
export function planSeed(
  dataset: Dataset,
  appEnv: AppEnv,
  steps: readonly SeedStep[] = buildSeedSteps(),
): string[] {
  authorizeDataset(dataset, appEnv);
  return steps.filter((step) => step.datasets.includes(dataset)).map((step) => step.name);
}

export interface SeedCount {
  readonly step: string;
  readonly count: number;
}

/** Validate environment and database identity, then run every step of the dataset in one transaction. */
export async function runSeed(run: SeedRun): Promise<SeedCount[]> {
  authorizeDataset(run.dataset, run.appEnv);
  const database = createDatabase(
    { DATABASE_URL: run.databaseUrl, DATABASE_POOL_MAX: 2, DATABASE_ACQUIRE_TIMEOUT_MS: 5000 },
    { applicationName: 'shroomap-seed' },
  );
  try {
    const identity = await database.pool.query<{ name: string }>(
      'select current_database() as name',
    );
    const expected = decodeURIComponent(new URL(run.databaseUrl).pathname.slice(1));
    if (identity.rows[0]?.name !== expected)
      throw new SeedRefusedError('connected database is not the configured one');
    if (run.dataset !== 'reference' && /prod/i.test(expected)) {
      throw new SeedRefusedError('a production-named database accepts only the reference dataset');
    }
    const steps = (run.steps ?? buildSeedSteps()).filter((step) =>
      step.datasets.includes(run.dataset),
    );
    try {
      return await database.uow.run(async (tx) => {
        const counts: SeedCount[] = [];
        for (const step of steps) counts.push({ step: step.name, count: await step.run(tx) });
        if (run.dryRun === true) throw new DryRunRollback(counts);
        return counts;
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.counts;
      throw error;
    }
  } finally {
    await database.close();
  }
}

/** Counts only: no row values, no connection string. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const dataset = parseDataset(argv);
  const dryRun = argv.includes('--dry-run');
  if (dryRun) {
    // No configuration load: a dry run needs no secret. With a migration database it runs and rolls back, without one it lists the plan.
    const appEnv = APP_ENVS.find((env) => env === process.env['APP_ENV']) ?? 'test';
    const databaseUrl = process.env['MIGRATION_DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl === '') {
      for (const name of planSeed(dataset, appEnv))
        process.stdout.write(`seed ${dataset} ${name}: planned\n`);
      process.stdout.write(`seed ${dataset} dry run done: plan only, no database configured\n`);
      return;
    }
    const counts = await runSeed({ dataset, appEnv, databaseUrl, dryRun });
    for (const { step, count } of counts)
      process.stdout.write(`seed ${dataset} ${step}: ${String(count)}\n`);
    process.stdout.write(
      `seed ${dataset} dry run done: ${String(counts.length)} steps, rolled back\n`,
    );
    return;
  }
  const config = loadConfigOrExit('release');
  const databaseUrl = config.MIGRATION_DATABASE_URL;
  if (databaseUrl === undefined) throw new SeedRefusedError('MIGRATION_DATABASE_URL is required');
  const counts = await runSeed({ dataset, appEnv: config.APP_ENV, databaseUrl });
  for (const { step, count } of counts)
    process.stdout.write(`seed ${dataset} ${step}: ${String(count)}\n`);
  process.stdout.write(`seed ${dataset} done: ${String(counts.length)} steps\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'seed failed'}\n`);
    process.exit(error instanceof SeedRefusedError ? 2 : 1);
  });
}
