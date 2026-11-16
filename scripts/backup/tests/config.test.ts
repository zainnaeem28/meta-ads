import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, EXIT_CONFIG, loadConfig } from '../src/config.ts';
import { FORBIDDEN_NAMES, forbiddenPresent } from '../src/forbidden.ts';
import { isoDate, jsonLogger, pool, ulid } from '../src/util.ts';
import { libpqEnv } from '../src/dump.ts';
import { BUCKETS, TOKENS, makeRig, repoRoot } from './support/fixture.ts';
import { runMain } from './support/run.ts';

// TC-BKP-12: the startup check refuses each forbidden name, names it and never prints its value; only the allowed names start.

const SENTINEL = 'sentinel-secret-value-do-not-print-7f3a';
const valid = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  APP_ENV: 'test',
  BACKUP_DATABASE_URL: 'postgres://app_backup:pw@db.internal:5432/shroomap',
  R2_ENDPOINT: 'http://r2.local:9000',
  R2_BUCKET: BUCKETS.app,
  R2_LEDGER_BUCKET: BUCKETS.ledger,
  R2_BACKUP_BUCKET: BUCKETS.backup,
  R2_BACKUP_SOURCE_ACCESS_KEY_ID: TOKENS.source.id,
  R2_BACKUP_SOURCE_SECRET_ACCESS_KEY: TOKENS.source.secret,
  R2_BACKUP_SINK_ACCESS_KEY_ID: TOKENS.sink.id,
  R2_BACKUP_SINK_SECRET_ACCESS_KEY: TOKENS.sink.secret,
  BACKUP_AGE_RECIPIENT: `age1${'q'.repeat(58)}`,
  HEARTBEAT_URL_BACKUP: 'https://hc.example.test/ping',
  ...extra,
});

const NAMED = [
  'KEK_PRIVATE_KEYS',
  'KEK_V1',
  'KEK_V12',
  'AGE_SECRET_KEY',
  'AGE_PRIVATE_KEY',
  'BACKUP_AGE_IDENTITY',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_LEDGER_ACCESS_KEY_ID',
  'R2_LEDGER_SECRET_ACCESS_KEY',
  'CLERK_SECRET_KEY',
  'HMAC_PEPPER',
  'CURSOR_SIGNING_KEY',
  'RATE_LIMIT_IP_KEY',
  'METRICS_TOKEN',
  'RENDER_API_KEY',
  'GHCR_PULL_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

describe('forbidden variables (TC-BKP-12)', () => {
  it('covers every name the registry lists for the backup service', () => {
    const registry = JSON.parse(
      readFileSync(join(repoRoot, 'config', 'registry.json'), 'utf8'),
    ) as { backupForbidden: string[] };
    for (const name of registry.backupForbidden) {
      if (name.endsWith('*')) expect(forbiddenPresent({ KEK_V7: 'x' })).toEqual(['KEK_V7']);
      else expect(FORBIDDEN_NAMES, name).toContain(name);
    }
  });

  for (const name of NAMED) {
    it(`refuses ${name}, names it, never prints its value`, () => {
      let error: unknown;
      try {
        loadConfig(valid({ [name]: SENTINEL }));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain(name);
      expect((error as ConfigError).message).not.toContain(SENTINEL);
      expect((error as ConfigError).names).toEqual([name]);
    });
  }

  it('refuses an age private key under any name, by its value, without printing it', () => {
    const key = ['AGE', 'SECRET', 'KEY', `1${'Q'.repeat(60)}`].join('-');
    expect(() => loadConfig(valid({ SOME_RANDOM_NAME: key }))).toThrow(/SOME_RANDOM_NAME/);
    try {
      loadConfig(valid({ SOME_RANDOM_NAME: key }));
    } catch (e) {
      expect((e as Error).message).not.toContain(key);
    }
  });

  it('starts with only the allowed names', () => {
    const config = loadConfig(valid());
    expect(config.retentionDays).toBe(30);
    expect(config.region).toBe('auto');
    expect(config.source.accessKeyId).toBe(TOKENS.source.id);
  });
});

describe('the real entry point refuses a forbidden variable (TC-BKP-12, integration)', () => {
  it('exits 78 naming the variable, before any connection is made', async () => {
    const rig = await makeRig();
    try {
      for (const name of ['KEK_V3', 'BACKUP_AGE_IDENTITY', 'DATABASE_URL']) {
        const r = await runMain({
          ...(rig.env('postgres://nobody:pw@127.0.0.1:1/none') as Record<string, string>),
          [name]: SENTINEL,
        });
        expect(r.status).toBe(EXIT_CONFIG);
        expect(r.stderr).toContain(name);
        expect(r.stderr + r.stdout).not.toContain(SENTINEL);
        expect(rig.emu.requests).toEqual([]);
      }
    } finally {
      await rig.dispose();
    }
  });
});

describe('configuration validation', () => {
  const refuse = (extra: Record<string, string>, pattern: RegExp) =>
    expect(() => loadConfig(valid(extra))).toThrow(pattern);
  it('refuses missing, malformed and unsafe values', () => {
    refuse({ BACKUP_DATABASE_URL: '' }, /BACKUP_DATABASE_URL is required/);
    refuse({ BACKUP_DATABASE_URL: 'mysql://x' }, /PostgreSQL URL/);
    refuse({ BACKUP_AGE_RECIPIENT: 'not-an-age-key' }, /age1 public recipient/);
    refuse({ R2_ENDPOINT: 'not a url' }, /R2_ENDPOINT must be a URL/);
    refuse({ APP_ENV: 'production', R2_ENDPOINT: 'http://r2.example.test' }, /https/);
    refuse({ R2_LEDGER_BUCKET: BUCKETS.app }, /three distinct/);
    refuse({ R2_BACKUP_SINK_ACCESS_KEY_ID: TOKENS.source.id }, /two different tokens/);
    refuse({ BACKUP_RETENTION_DAYS: '3' }, /BACKUP_RETENTION_DAYS/);
    refuse({ BACKUP_COPY_CONCURRENCY: '0' }, /BACKUP_COPY_CONCURRENCY/);
    refuse({ HEARTBEAT_URL_BACKUP: 'ftp://x' }, /HEARTBEAT_URL_BACKUP/);
    refuse(
      {
        APP_ENV: 'staging',
        R2_ENDPOINT: 'https://r2.example.test',
        HEARTBEAT_URL_BACKUP: 'http://hc.example.test',
      },
      /https/,
    );
  });

  it('keeps the database password out of the dump command line', () => {
    expect(
      libpqEnv('postgres://app_backup:p%40ss@db.internal:6432/shroomap?sslmode=require'),
    ).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6432',
      PGUSER: 'app_backup',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'shroomap',
      PGSSLMODE: 'require',
    });
  });
});

describe('helpers', () => {
  it('ulid is 26 Crockford characters, ordered by time', () => {
    const a = ulid(new Date('2026-01-01T00:00:00Z'));
    const b = ulid(new Date('2026-01-02T00:00:00Z'));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(isoDate(new Date('2026-11-15T23:59:59Z'))).toBe('2026-11-15');
  });
  it('pool runs everything with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it('the logger writes JSON lines', () => {
    const lines: string[] = [];
    jsonLogger((l) => lines.push(l)).info('hello', { n: 1 });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'info', event: 'hello', n: 1 });
  });
});
