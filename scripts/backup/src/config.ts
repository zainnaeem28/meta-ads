import { forbiddenPresent } from './forbidden.ts';

/** Exit code for a refused start (sysexits EX_CONFIG), the one every Shroomap process uses. */
export const EXIT_CONFIG = 78;
/** The run could not start in time because a release migration was running (EX_TEMPFAIL). */
export const EXIT_MIGRATION_WINDOW = 75;

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BackupConfig {
  appEnv: string;
  databaseUrl: string;
  endpoint: string;
  region: string;
  appBucket: string;
  ledgerBucket: string;
  backupBucket: string;
  source: S3Credentials;
  sink: S3Credentials;
  ageRecipient: string;
  retentionDays: number;
  heartbeatUrl: string | null;
  pgDumpBin: string;
  ageBin: string;
  spoolDir: string;
  concurrency: number;
  migrationWaitMs: number;
  migrationPollMs: number;
}

export class ConfigError extends Error {
  readonly names: readonly string[];
  constructor(message: string, names: readonly string[]) {
    super(message);
    this.name = 'ConfigError';
    this.names = names;
  }
}

const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

/**
 * Startup validation. Refuses, naming the variables and never a value, when a forbidden variable is set (SB v6 7.1 D),
 * a required one is missing or malformed, or the three buckets are not distinct.
 */
export function loadConfig(env: NodeJS.ProcessEnv): BackupConfig {
  const forbidden = forbiddenPresent(env);
  if (forbidden.length > 0) {
    throw new ConfigError(
      `refusing to run: forbidden variable(s) present in the backup environment: ${forbidden.join(', ')}`,
      forbidden,
    );
  }
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value.trim();
  };
  const appEnv = need('APP_ENV');
  const databaseUrl = need('BACKUP_DATABASE_URL');
  const endpoint = need('R2_ENDPOINT');
  const appBucket = need('R2_BUCKET');
  const ledgerBucket = need('R2_LEDGER_BUCKET');
  const backupBucket = need('R2_BACKUP_BUCKET');
  const source = {
    accessKeyId: need('R2_BACKUP_SOURCE_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_BACKUP_SOURCE_SECRET_ACCESS_KEY'),
  };
  const sink = {
    accessKeyId: need('R2_BACKUP_SINK_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_BACKUP_SINK_SECRET_ACCESS_KEY'),
  };
  const ageRecipient = need('BACKUP_AGE_RECIPIENT');

  if (ageRecipient !== '' && !AGE_RECIPIENT.test(ageRecipient)) {
    problems.push('BACKUP_AGE_RECIPIENT must be an age1 public recipient');
  }
  if (databaseUrl !== '' && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('BACKUP_DATABASE_URL must be a PostgreSQL URL');
  }
  if (endpoint !== '') {
    try {
      const url = new URL(endpoint);
      if (['staging', 'production'].includes(appEnv) && url.protocol !== 'https:') {
        problems.push('R2_ENDPOINT must be https in staging and production');
      }
    } catch {
      problems.push('R2_ENDPOINT must be a URL');
    }
  }
  if (
    new Set([appBucket, ledgerBucket, backupBucket]).size !== 3 &&
    !problems.some((p) => /bucket/i.test(p))
  ) {
    problems.push('R2_BUCKET, R2_LEDGER_BUCKET and R2_BACKUP_BUCKET must be three distinct names');
  }
  // The local stack's MinIO has one root user, so development and test may share one credential; hosted environments never.
  const sharedAllowed =
    ['development', 'test'].includes(appEnv) && env['BACKUP_ALLOW_SHARED_TOKEN'] === '1';
  if (source.accessKeyId !== '' && source.accessKeyId === sink.accessKeyId && !sharedAllowed) {
    problems.push('R2_BACKUP_SOURCE_* and R2_BACKUP_SINK_* must be two different tokens');
  }
  const retentionDays = integer(
    env['BACKUP_RETENTION_DAYS'],
    30,
    7,
    365,
    'BACKUP_RETENTION_DAYS',
    problems,
  );
  const heartbeatUrl = env['HEARTBEAT_URL_BACKUP']?.trim() || null;
  if (heartbeatUrl !== null && !/^https?:\/\//.test(heartbeatUrl)) {
    problems.push('HEARTBEAT_URL_BACKUP must be a URL');
  }
  if (
    heartbeatUrl !== null &&
    ['staging', 'production'].includes(appEnv) &&
    !heartbeatUrl.startsWith('https://')
  ) {
    problems.push('HEARTBEAT_URL_BACKUP must be https in staging and production');
  }
  const concurrency = integer(
    env['BACKUP_COPY_CONCURRENCY'],
    4,
    1,
    16,
    'BACKUP_COPY_CONCURRENCY',
    problems,
  );
  const waitSeconds = integer(
    env['BACKUP_MIGRATION_WAIT_SECONDS'],
    3600,
    0,
    86_400,
    'BACKUP_MIGRATION_WAIT_SECONDS',
    problems,
  );
  const pollSeconds = integer(
    env['BACKUP_MIGRATION_POLL_SECONDS'],
    15,
    1,
    600,
    'BACKUP_MIGRATION_POLL_SECONDS',
    problems,
  );

  if (problems.length > 0) {
    throw new ConfigError(`refusing to run: ${problems.join('; ')}`, []);
  }
  return {
    appEnv,
    databaseUrl,
    endpoint,
    region: env['R2_REGION']?.trim() || 'auto',
    appBucket,
    ledgerBucket,
    backupBucket,
    source,
    sink,
    ageRecipient,
    retentionDays,
    heartbeatUrl,
    pgDumpBin: env['BACKUP_PG_DUMP_BIN']?.trim() || 'pg_dump',
    ageBin: env['BACKUP_AGE_BIN']?.trim() || 'age',
    spoolDir: env['BACKUP_SPOOL_DIR']?.trim() || '',
    concurrency,
    migrationWaitMs: waitSeconds * 1000,
    migrationPollMs: pollSeconds * 1000,
  };
}

function integer(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}
