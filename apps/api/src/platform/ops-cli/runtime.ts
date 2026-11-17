import type { PgBoss } from 'pg-boss';
import { loadConfigOrExit } from '../config/index.js';
import type { ProcessConfig } from '../config/index.js';
import { createDatabase, dbConfigOf } from '../db/index.js';
import type { Database } from '../db/index.js';
import { createRuntimeBoss, startRuntimeBoss } from '../jobs/boss.js';
import { OpsRefusedError } from './args.js';
import type { OpsInvocation } from './args.js';
import { erasureResume, firstAdminReopen, kekRewrap, keysDisableAll } from './commands.js';
import type { OpsResult } from './commands.js';
import { privateKeysOf, publicKeysOf } from './kek-crypto.js';
import type { OpsRuntime } from './runner.js';

// The production binding of the runner: the real configuration, a small pool as the role of the command and, for
// `erasure:resume`, a queue handle that is started and stopped around the command.

/** The connected database is the configured one: a connection string pointing elsewhere is a refusal, not a run. */
async function connected(config: ProcessConfig): Promise<Database> {
  const database = createDatabase(dbConfigOf({ ...config, DATABASE_POOL_MAX: 2, DATABASE_ACQUIRE_TIMEOUT_MS: config.DATABASE_ACQUIRE_TIMEOUT_MS ?? 5000 }), { applicationName: 'shroomap-ops', max: 2 });
  try {
    const identity = await database.pool.query<{ name: string }>('select current_database() as name');
    const expected = decodeURIComponent(new URL(config.DATABASE_URL ?? '').pathname.slice(1));
    if (identity.rows[0]?.name !== expected) throw new OpsRefusedError('connected database is not the configured one');
    return database;
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}

async function withBoss<T>(config: ProcessConfig, use: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = createRuntimeBoss({ DATABASE_URL: config.DATABASE_URL ?? '', role: 'api', poolMax: 2 });
  boss.on('error', () => undefined);
  await startRuntimeBoss(boss);
  try {
    return await use(boss);
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 }).catch(() => undefined);
  }
}

function rewrapKeys(config: ProcessConfig) {
  const active = config.KEK_ACTIVE_VERSION;
  if (config.KEK_PRIVATE_KEYS === undefined || config.KEK_PUBLIC_KEYS === undefined || active === undefined) {
    throw new OpsRefusedError('kek:rewrap needs KEK_PUBLIC_KEYS, KEK_PRIVATE_KEYS and KEK_ACTIVE_VERSION');
  }
  return { privateKeys: privateKeysOf(config.KEK_PRIVATE_KEYS), publicKeys: publicKeysOf(config.KEK_PUBLIC_KEYS), active };
}

export async function executeCommand(invocation: OpsInvocation, config: ProcessConfig): Promise<OpsResult> {
  // Keys are read before a connection is opened: a configuration fault costs nothing.
  const keys = invocation.command === 'kek:rewrap' ? rewrapKeys(config) : undefined;
  const database = await connected(config);
  try {
    switch (invocation.command) {
      case 'first-admin:reopen':
        return await firstAdminReopen(database);
      case 'keys:disable-all':
        return await keysDisableAll(database);
      case 'kek:rewrap':
        return await kekRewrap(database, keys as NonNullable<typeof keys>);
      case 'erasure:resume':
        return await withBoss(config, (boss) => erasureResume(database, boss, invocation.args[0] ?? ''));
    }
  } finally {
    await database.close();
  }
}

export function productionRuntime(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): OpsRuntime {
  return { loadConfig: (role) => loadConfigOrExit(role), execute: executeCommand, write };
}
