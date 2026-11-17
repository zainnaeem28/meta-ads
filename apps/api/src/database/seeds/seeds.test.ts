import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DbTx } from '../../platform/db/index.js';
import type { SeedStep } from '../index.js';
import { SeedRefusedError, buildSeedSteps, DEV_CAMPAIGNS, DEV_IDENTITY_USERS, DEV_STUB_KEYS } from './index.js';
import { developmentCampaignsStep, developmentKeysStep, developmentUsersStep } from './development.js';
import { platformSettingsStep } from './reference.js';

/** A transaction that records the statements it is given. */
function recorder(): { tx: DbTx; calls: unknown[] } {
  const calls: unknown[] = [];
  const tx = {
    execute: (query: unknown) => {
      calls.push(query);
      return Promise.resolve({ rows: [] });
    },
  } as unknown as DbTx;
  return { tx, calls };
}

function kekEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    KEK_PUBLIC_KEYS: JSON.stringify({ 1: publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
    KEK_ACTIVE_VERSION: '1',
    KEY_FINGERPRINT_PEPPERS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }),
    KEY_FINGERPRINT_PEPPER_ACTIVE: '1',
    ...overrides,
  };
}

describe('seed datasets', () => {
  it('lists the reference steps for the reference dataset and the development steps for development only', () => {
    const steps = buildSeedSteps(kekEnv());
    const names = (dataset: SeedStep['datasets'][number]) =>
      steps.filter((step) => step.datasets.includes(dataset)).map((step) => step.name);
    expect(names('reference')).toEqual(['price_table', 'brand_rules', 'platform_settings']);
    expect(names('staging')).toEqual(['price_table', 'brand_rules', 'platform_settings']);
    expect(names('development')).toEqual([
      'price_table',
      'brand_rules',
      'platform_settings',
      'dev_users',
      'dev_provider_keys',
      'dev_campaigns',
    ]);
  });

  it('writes the settings row, two users and one campaign per state, each by natural key', async () => {
    for (const [step, count] of [
      [platformSettingsStep, 1],
      [developmentUsersStep, DEV_IDENTITY_USERS.length],
      [developmentCampaignsStep, DEV_CAMPAIGNS.length],
    ] as const) {
      const { tx, calls } = recorder();
      expect(await step.run(tx)).toBe(count);
      expect(calls).toHaveLength(count);
    }
    expect(DEV_CAMPAIGNS.map((campaign) => campaign.state).sort()).toEqual(['active', 'deleting']);
    expect(DEV_IDENTITY_USERS).toHaveLength(2);
  });

  it('seals one stub key per provider and refuses when the key material is missing or wrong', async () => {
    const { tx, calls } = recorder();
    expect(await developmentKeysStep(kekEnv()).run(tx)).toBe(DEV_STUB_KEYS.length);
    expect(calls).toHaveLength(DEV_STUB_KEYS.length);
    const cases: Record<string, string | undefined>[] = [
      { KEK_PUBLIC_KEYS: undefined },
      { KEK_PUBLIC_KEYS: '{bad' },
      { KEK_PUBLIC_KEYS: '[]' },
      { KEK_PUBLIC_KEYS: '{"x":"y"}' },
      { KEK_ACTIVE_VERSION: '9' },
      { KEY_FINGERPRINT_PEPPER_ACTIVE: '9' },
    ];
    for (const overrides of cases) {
      await expect(developmentKeysStep(kekEnv(overrides)).run(recorder().tx)).rejects.toThrow(SeedRefusedError);
    }
  });

  it('uses only reserved addresses and synthetic names', () => {
    for (const user of DEV_IDENTITY_USERS) expect(user.email).toMatch(/@example\.invalid$/);
    for (const key of DEV_STUB_KEYS) expect(key.plaintext).toMatch(/seedstub/);
  });
});
