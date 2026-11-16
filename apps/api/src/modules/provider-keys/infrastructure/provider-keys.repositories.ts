import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { keyEvents, providerKeys } from '../../../database/schema/provider-keys.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import type {
  AuthResultRow,
  Executor,
  KeyEventInput,
  KeyEventQuery,
  KeyEventRecord,
  KeyEventRepository,
  KeyRecord,
  KeyWrite,
  ProviderKeyRepository,
} from '../application/ports.js';
import type { KeyEventKind, KeyStatus } from '../domain/key-policy.js';
import type { Provider } from '../domain/key-wrap.js';

// Drizzle persistence of `provider_keys` and `key_events`. Every statement names its columns: `app_api` holds no
// SELECT on ciphertext, nonce or wrapped_dek (M0004), so a `select()` of the whole row would be refused by the database.

const keyColumns = {
  id: providerKeys.id,
  ownerId: providerKeys.ownerId,
  provider: providerKeys.provider,
  status: providerKeys.status,
  version: providerKeys.version,
  last4: providerKeys.last4,
  fingerprint: providerKeys.fingerprint,
  consecutiveAuthFailures: providerKeys.consecutiveAuthFailures,
  createdAt: providerKeys.createdAt,
  updatedAt: providerKeys.updatedAt,
  lastValidatedAt: providerKeys.lastValidatedAt,
};

const authColumns = {
  id: providerKeys.id,
  ownerId: providerKeys.ownerId,
  provider: providerKeys.provider,
  status: providerKeys.status,
  consecutiveAuthFailures: providerKeys.consecutiveAuthFailures,
};

type KeyRow = {
  id: string;
  ownerId: string;
  provider: string;
  status: string;
  version: number;
  last4: string;
  fingerprint: string;
  consecutiveAuthFailures: number;
  createdAt: Date;
  updatedAt: Date;
  lastValidatedAt: Date | null;
};

const toRecord = (row: KeyRow): KeyRecord => ({
  ...row,
  provider: row.provider as Provider,
  status: row.status as KeyStatus,
});

const toAuth = (row: Omit<AuthResultRow, 'provider' | 'status'> & { provider: string; status: string }): AuthResultRow => ({
  ...row,
  provider: row.provider as Provider,
  status: row.status as KeyStatus,
});

/** The columns a store or a replacement sets; the sealed bytes are written, never read back. */
const writeValues = (write: KeyWrite) => ({
  status: write.status,
  version: write.version,
  ciphertext: write.sealed.ciphertext,
  nonce: write.sealed.nonce,
  wrappedDek: write.sealed.wrappedDek,
  kekVersion: write.sealed.kekVersion,
  last4: write.last4,
  fingerprint: write.fingerprint,
  fingerprintPepperVersion: write.fingerprintPepperVersion,
  consecutiveAuthFailures: 0,
  lastValidatedAt: write.validatedAt,
});

export class DrizzleProviderKeyRepository implements ProviderKeyRepository {
  async find(db: Executor, ownerId: string, provider: Provider): Promise<KeyRecord | null> {
    const rows = await db
      .select(keyColumns)
      .from(providerKeys)
      .where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.provider, provider)))
      .limit(1);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async list(db: Executor, ownerId: string): Promise<KeyRecord[]> {
    const rows = await db.select(keyColumns).from(providerKeys).where(eq(providerKeys.ownerId, ownerId));
    return rows.map(toRecord);
  }

  async insert(db: Executor, id: string, ownerId: string, provider: Provider, write: KeyWrite): Promise<boolean> {
    const rows = await db
      .insert(providerKeys)
      .values({ id, ownerId, provider, ...writeValues(write) })
      .onConflictDoNothing()
      .returning({ id: providerKeys.id });
    return rows.length === 1;
  }

  /** Overwrites the sealed bytes of the old key in place: nothing of it is kept (REQ-017). */
  async replace(db: Executor, id: string, expectedVersion: number, write: KeyWrite): Promise<boolean> {
    const rows = await db
      .update(providerKeys)
      .set({ ...writeValues(write), disabledAt: null, updatedAt: sql`now()` })
      .where(and(eq(providerKeys.id, id), eq(providerKeys.version, expectedVersion)))
      .returning({ id: providerKeys.id });
    return rows.length === 1;
  }

  async delete(db: Executor, ownerId: string, provider: Provider): Promise<string | null> {
    const rows = await db
      .delete(providerKeys)
      .where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.provider, provider)))
      .returning({ id: providerKeys.id });
    return rows[0]?.id ?? null;
  }

  async deleteAll(db: Executor, ownerId: string): Promise<{ id: string; provider: Provider }[]> {
    const rows = await db
      .delete(providerKeys)
      .where(eq(providerKeys.ownerId, ownerId))
      .returning({ id: providerKeys.id, provider: providerKeys.provider });
    return rows.map((row) => ({ id: row.id, provider: row.provider as Provider }));
  }

  async recordFailure(db: Executor, id: string, version: number, threshold: number): Promise<AuthResultRow | null> {
    const next = sql`${providerKeys.consecutiveAuthFailures} + 1`;
    const reached: SQL = sql`${next} >= ${threshold}`;
    const rows = await db
      .update(providerKeys)
      .set({
        consecutiveAuthFailures: next,
        status: sql`case when ${reached} then 'disabled' else ${providerKeys.status} end`,
        disabledAt: sql`case when ${reached} then now() else ${providerKeys.disabledAt} end`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(providerKeys.id, id), eq(providerKeys.version, version), ne(providerKeys.status, 'disabled')))
      .returning(authColumns);
    return rows[0] === undefined ? null : toAuth(rows[0]);
  }

  async recordSuccess(
    db: Executor,
    id: string,
    version: number,
  ): Promise<{ row: AuthResultRow; activated: boolean } | null> {
    const live = and(eq(providerKeys.id, id), eq(providerKeys.version, version));
    const reset = { consecutiveAuthFailures: 0, lastValidatedAt: sql`now()`, updatedAt: sql`now()` };
    const activated = await db
      .update(providerKeys)
      .set({ ...reset, status: 'active' })
      .where(and(live, eq(providerKeys.status, 'untested')))
      .returning(authColumns);
    if (activated[0] !== undefined) return { row: toAuth(activated[0]), activated: true };
    const kept = await db
      .update(providerKeys)
      .set(reset)
      .where(and(live, eq(providerKeys.status, 'active')))
      .returning(authColumns);
    return kept[0] === undefined ? null : { row: toAuth(kept[0]), activated: false };
  }

  async disableAll(db: Executor): Promise<{ id: string; ownerId: string; provider: Provider }[]> {
    const rows = await db
      .update(providerKeys)
      .set({ status: 'disabled', disabledAt: sql`now()`, updatedAt: sql`now()` })
      .where(ne(providerKeys.status, 'disabled'))
      .returning({ id: providerKeys.id, ownerId: providerKeys.ownerId, provider: providerKeys.provider });
    return rows.map((row) => ({ ...row, provider: row.provider as Provider }));
  }
}

export class DrizzleKeyEventRepository implements KeyEventRepository {
  async insert(db: Executor, event: KeyEventInput): Promise<void> {
    await db.insert(keyEvents).values({ id: newId(), ...event });
  }

  /** Newest first by (at desc, id desc); `at` is read as text so the cursor keeps microseconds. */
  async list(db: Executor, ownerId: string, query: KeyEventQuery): Promise<KeyEventRecord[]> {
    const filters: SQL[] = [eq(keyEvents.ownerId, ownerId)];
    if (query.provider !== undefined) filters.push(eq(keyEvents.provider, query.provider));
    if (query.after !== undefined) {
      filters.push(sql`(${keyEvents.at}, ${keyEvents.id}) < (${query.after.at}::timestamptz, ${query.after.id}::uuid)`);
    }
    const rows = await db
      .select({ id: keyEvents.id, provider: keyEvents.provider, kind: keyEvents.kind, at: sql<string>`${keyEvents.at}::text` })
      .from(keyEvents)
      .where(and(...filters))
      .orderBy(desc(keyEvents.at), desc(keyEvents.id))
      .limit(query.limit);
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider as Provider,
      kind: row.kind as KeyEventKind,
      at: row.at,
    }));
  }
}

