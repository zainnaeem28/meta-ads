import {
  constants,
  createCipheriv,
  createHmac,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SeedStep } from '../index.js';
import { SeedRefusedError } from './errors.js';
import { DEV_CAMPAIGNS, DEV_IDENTITY_USERS, DEV_STUB_KEYS } from './fixtures.js';

type Env = Readonly<Record<string, string | undefined>>;

export const developmentUsersStep: SeedStep = {
  name: 'dev_users',
  datasets: ['development'],
  async run(tx) {
    for (const user of DEV_IDENTITY_USERS) {
      await tx.execute(sql`
        insert into users (id, idp_subject, email, role, status, linked_via)
        values (${user.id}, ${user.sub}, ${user.email}, ${user.role}, 'active', ${user.linkedVia})
        on conflict do nothing`);
    }
    return DEV_IDENTITY_USERS.length;
  },
};

export const developmentCampaignsStep: SeedStep = {
  name: 'dev_campaigns',
  datasets: ['development'],
  async run(tx) {
    for (const campaign of DEV_CAMPAIGNS) {
      await tx.execute(sql`
        insert into campaigns (id, owner_id, state, product_name, product_description, segment_count)
        values (${campaign.id}, ${DEV_IDENTITY_USERS[1].id}, ${campaign.state}, ${campaign.productName},
                'Synthetic campaign of the development dataset.', ${campaign.segmentCount})
        on conflict (id) do nothing`);
    }
    return DEV_CAMPAIGNS.length;
  },
};

function jsonMap(env: Env, name: string): Map<number, string> {
  const raw = env[name];
  if (raw === undefined || raw === '') throw new SeedRefusedError(`${name} is required for the development keys`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SeedRefusedError(`${name} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new SeedRefusedError(`${name} must be a JSON map of version to value`);
  const out = new Map<number, string>();
  for (const [version, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !Number.isInteger(Number(version)) || Number(version) <= 0)
      throw new SeedRefusedError(`${name} must be a JSON map of version to value`);
    out.set(Number(version), value);
  }
  return out;
}

/**
 * The stub keys of the development dataset, sealed as ADR-004 describes (AES-256-GCM with AAD `user|provider|key|version`,
 * the data key wrapped by RSA-OAEP-SHA-256 under the active public KEK). Public key material only: the step cannot open them.
 * An existing row is kept, so a rerun changes nothing even though a fresh seal would differ.
 */
export function developmentKeysStep(env: Env = process.env): SeedStep {
  return {
    name: 'dev_provider_keys',
    datasets: ['development'],
    async run(tx) {
      const publicKeys = jsonMap(env, 'KEK_PUBLIC_KEYS');
      const kekVersion = Number(env['KEK_ACTIVE_VERSION']);
      const kekPem = publicKeys.get(kekVersion);
      if (kekPem === undefined) throw new SeedRefusedError('KEK_ACTIVE_VERSION must name a version in KEK_PUBLIC_KEYS');
      const peppers = jsonMap(env, 'KEY_FINGERPRINT_PEPPERS');
      const pepperVersion = Number(env['KEY_FINGERPRINT_PEPPER_ACTIVE']);
      const pepperB64 = peppers.get(pepperVersion);
      if (pepperB64 === undefined)
        throw new SeedRefusedError('KEY_FINGERPRINT_PEPPER_ACTIVE must name a version in KEY_FINGERPRINT_PEPPERS');
      const kek = createPublicKey(kekPem);
      const pepper = Buffer.from(pepperB64, 'base64');
      const ownerId = DEV_IDENTITY_USERS[1].id;
      for (const stub of DEV_STUB_KEYS) {
        const plaintext = Buffer.from(stub.plaintext, 'utf8');
        const dek = randomBytes(32);
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: 16 });
        cipher.setAAD(Buffer.from(`${ownerId}|${stub.provider}|${stub.id}|1`, 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        const wrappedDek = publicEncrypt(
          { key: kek, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          dek,
        );
        dek.fill(0);
        const fingerprint = createHmac('sha256', pepper).update(plaintext).digest('hex');
        await tx.execute(sql`
          insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek,
                                     kek_version, last4, fingerprint, fingerprint_pepper_version)
          values (${stub.id}, ${ownerId}, ${stub.provider}, 'untested', 1, ${ciphertext}, ${nonce}, ${wrappedDek},
                  ${kekVersion}, ${stub.plaintext.slice(-4)}, ${fingerprint}, ${pepperVersion})
          on conflict do nothing`);
      }
      return DEV_STUB_KEYS.length;
    },
  };
}
