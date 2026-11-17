import type { DbTx } from '../platform/db/index.js';

export const DATASETS = ['reference', 'development', 'staging'] as const;
export type Dataset = (typeof DATASETS)[number];

/**
 * One seed-owned set of rows. Owner modules provide their step and `seeds/index.ts` lists it; a step
 * upserts by natural key so a rerun changes nothing, and returns the number of rows it wrote or kept.
 */
export interface SeedStep {
  readonly name: string;
  readonly datasets: readonly Dataset[];
  run(tx: DbTx): Promise<number>;
}

/**
 * `jobs:migrate` wiring point: the platform/jobs ticket provides `database/jobs-migrate.ts`
 * (pg-boss schema install and the queue catalogue, run after `db:migrate`); `package.json` runs its build output.
 */
export const JOBS_MIGRATE_ENTRY = 'dist/database/jobs-migrate.js';
