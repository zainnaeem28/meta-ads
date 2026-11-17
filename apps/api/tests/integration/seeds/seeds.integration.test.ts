import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SeedRefusedError, main, runSeed } from '../../../src/database/seed.js';
import { DEV_IDENTITY_USERS, DEV_STUB_KEYS } from '../../../src/database/seeds/index.js';
import { isUuidV7 } from '../../../src/platform/shared-kernel/index.js';
import { cleanup, drizzleMigrate, provision, renderMigrations, teardown } from '../migrations/support/harness.js';
import type { Env } from '../migrations/support/harness.js';
import { Factories, FixedClock, fixedUuidV7 } from '../../support/factories/index.js';

// TC-OPS-03 (seed rerun): the real seed entry (`main` and `runSeed` with the registered steps) on real PostgreSQL.

const kek = generateKeyPairSync('rsa', { modulusLength: 3072 });
const ENV = {
  KEK_PUBLIC_KEYS: JSON.stringify({ 1: kek.publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
  KEK_ACTIVE_VERSION: '1',
  KEY_FINGERPRINT_PEPPERS: JSON.stringify({ 1: Buffer.alloc(32, 9).toString('base64') }),
  KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
};
const TABLES = ['price_table', 'brand_rules', 'platform_settings', 'users', 'provider_keys', 'campaigns'];

let env: Env;
let dir: string;
let database: { url: string };
let client: pg.Client;

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    out[table] = (await client.query(`select t::text as row from ${table} t order by 1`)).rows;
  }
  return out;
}

const withEnv = async (values: Record<string, string>, fn: () => Promise<void>) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

beforeAll(async () => {
  env = await provision();
  dir = renderMigrations(env);
  expect(drizzleMigrate(env, dir).status).toBe(0);
  database = { url: env.urlFor('migrator') };
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  cleanup(dir);
  await teardown(env);
});
beforeEach(async () => {
  await client.query('truncate users, platform_settings, price_table, brand_rules cascade');
});

describe('db:seed', () => {
  it('reference: seeds the settings row invited_only and a rerun changes nothing', async () => {
    await withEnv(ENV, async () => {
      const run = { dataset: 'reference' as const, appEnv: 'production' as const, databaseUrl: database.url };
      const first = await runSeed(run);
      expect(first.map((entry) => entry.step)).toEqual(['price_table', 'brand_rules', 'platform_settings']);
      const before = await snapshot();
      expect(await runSeed(run)).toEqual(first);
      expect(await snapshot()).toEqual(before);
    });
    const settings = await client.query('select signup_mode, version from platform_settings');
    expect(settings.rows).toEqual([{ signup_mode: 'invited_only', version: 1 }]);
    expect((await client.query('select count(*)::int as n from users')).rows[0]).toEqual({ n: 0 });
  });

  it('reference leaves an operator-changed settings row alone', async () => {
    await client.query("insert into platform_settings (id, signup_mode, version) values (1, 'open', 4)");
    await withEnv(ENV, async () => {
      await runSeed({ dataset: 'reference', appEnv: 'production', databaseUrl: database.url });
    });
    expect((await client.query('select signup_mode, version from platform_settings')).rows).toEqual([
      { signup_mode: 'open', version: 4 },
    ]);
  });

  it('development: two users, one campaign per state, stub keys sealed under the KEK; rerun changes nothing', async () => {
    await withEnv(ENV, async () => {
      const run = { dataset: 'development' as const, appEnv: 'development' as const, databaseUrl: database.url };
      const first = await runSeed(run);
      expect(first.filter((entry) => entry.step.startsWith('dev_'))).toEqual([
        { step: 'dev_users', count: 2 },
        { step: 'dev_provider_keys', count: 2 },
        { step: 'dev_campaigns', count: 2 },
      ]);
      const before = await snapshot();
      expect(await runSeed(run)).toEqual(first);
      expect(await snapshot()).toEqual(before);
    });
    expect((await client.query('select state from campaigns order by state')).rows).toEqual([
      { state: 'active' },
      { state: 'deleting' },
    ]);
    const users = await client.query('select idp_subject, email from users order by email');
    expect(users.rows).toEqual(
      [...DEV_IDENTITY_USERS].sort((a, b) => a.email.localeCompare(b.email)).map((u) => ({ idp_subject: u.sub, email: u.email })),
    );
    for (const row of users.rows) expect(String(row.email)).toMatch(/@example\.invalid$/);

    // The sealed bytes open under the private KEK with the documented envelope (AES-256-GCM, AAD user|provider|key|version).
    const keys = await client.query(
      'select id, owner_id, provider, version, ciphertext, nonce, wrapped_dek from provider_keys',
    );
    expect(keys.rows).toHaveLength(2);
    for (const row of keys.rows) {
      const dek = privateDecrypt(
        { key: kek.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        row.wrapped_dek as Buffer,
      );
      const sealed = row.ciphertext as Buffer;
      const decipher = createDecipheriv('aes-256-gcm', dek, row.nonce as Buffer, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`${row.owner_id}|${row.provider}|${row.id}|${row.version}`));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString();
      expect(plain).toBe(DEV_STUB_KEYS.find((stub) => stub.id === row.id)?.plaintext);
    }
  });

  it('refuses development outside APP_ENV=development and anything but reference in production', async () => {
    for (const appEnv of ['test', 'staging', 'production'] as const) {
      await expect(runSeed({ dataset: 'development', appEnv, databaseUrl: database.url })).rejects.toThrow(
        SeedRefusedError,
      );
    }
    await expect(runSeed({ dataset: 'staging', appEnv: 'production', databaseUrl: database.url })).rejects.toThrow(
      'dataset staging runs only with APP_ENV=staging',
    );
    expect((await client.query('select count(*)::int as n from users')).rows[0]).toEqual({ n: 0 });
  });

  it('refuses development without the KEK, leaving nothing behind', async () => {
    await withEnv({ ...ENV, KEK_PUBLIC_KEYS: '' }, async () => {
      await expect(
        runSeed({ dataset: 'development', appEnv: 'development', databaseUrl: database.url }),
      ).rejects.toThrow('KEK_PUBLIC_KEYS is required');
    });
    expect((await client.query('select count(*)::int as n from users')).rows[0]).toEqual({ n: 0 });
  });

  it('--dry-run through main runs the steps and rolls everything back', async () => {
    await withEnv({ ...ENV, APP_ENV: 'development', MIGRATION_DATABASE_URL: database.url }, async () => {
      await main(['--dataset=development', '--dry-run']);
    });
    for (const table of TABLES) {
      if (table === 'price_table' || table === 'brand_rules') continue;
      expect((await client.query(`select count(*)::int as n from ${table}`)).rows[0]).toEqual({ n: 0 });
    }
    await withEnv({ APP_ENV: 'production', MIGRATION_DATABASE_URL: database.url }, async () => {
      await expect(main(['--dataset=staging', '--dry-run'])).rejects.toThrow(SeedRefusedError);
    });
  });

  it('--dry-run without a database lists the plan', async () => {
    const saved = process.env['MIGRATION_DATABASE_URL'];
    delete process.env['MIGRATION_DATABASE_URL'];
    try {
      await main(['--dataset=reference', '--dry-run']);
    } finally {
      if (saved !== undefined) process.env['MIGRATION_DATABASE_URL'] = saved;
    }
  });
});

describe('factories', () => {
  it('give fixed UUIDv7 ids and clock-stamped rows that insert on real PostgreSQL', async () => {
    const a = new Factories(new FixedClock(1_800_000_000_000));
    const b = new Factories(new FixedClock(1_800_000_000_000));
    const ids = [a.id(), a.id()];
    expect(ids).toEqual([b.id(), b.id()]);
    for (const id of ids) expect(isUuidV7(id)).toBe(true);
    expect(isUuidV7(fixedUuidV7(0, 0))).toBe(true);

    const factories = new Factories(new FixedClock(Date.UTC(2026, 5, 1)));
    const seeded = await runDb(async (tx) => {
      const user = await factories.insertUser(tx, { role: 'admin' });
      factories.clock.advance(60_000);
      const campaign = await factories.insertCampaign(tx, user.id, { state: 'deleting' });
      return { user, campaign };
    });
    const row = await client.query('select created_at, role from users where id = $1', [seeded.user.id]);
    expect(row.rows[0].role).toBe('admin');
    expect((row.rows[0].created_at as Date).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    const campaign = await client.query('select state, created_at from campaigns where id = $1', [seeded.campaign.id]);
    expect(campaign.rows[0].state).toBe('deleting');
  });
});

async function runDb<T>(fn: (tx: import('../../../src/platform/db/index.js').DbTx) => Promise<T>): Promise<T> {
  const { createDatabase } = await import('../../../src/platform/db/index.js');
  const db = createDatabase(
    { DATABASE_URL: database.url, DATABASE_POOL_MAX: 2, DATABASE_ACQUIRE_TIMEOUT_MS: 5000 },
    { applicationName: 'seed-test' },
  );
  try {
    return await db.uow.run(fn);
  } finally {
    await db.close();
  }
}
