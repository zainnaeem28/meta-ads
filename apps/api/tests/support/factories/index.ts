import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../src/platform/db/index.js';

// Per-test factories (TASK-063): every id is a fixed UUIDv7 derived from the factory's clock and counter, every timestamp
// comes from the clock, so a test never depends on the wall clock or on random ids. Synthetic data only (OD-15).

/** A clock the test moves by hand. */
export class FixedClock {
  constructor(private ms: number = Date.UTC(2026, 0, 1)) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): Date {
    this.ms += ms;
    return this.now();
  }
}

/** Deterministic UUIDv7: 48-bit millisecond clock, then the counter; the same clock and counter give the same id. */
export function fixedUuidV7(ms: number, counter: number): string {
  const time = ms.toString(16).padStart(12, '0');
  const rand = counter.toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${rand}`;
}

export interface UserRow {
  id: string;
  idpSubject: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'removed';
  linkedVia: 'first_admin' | 'invitation' | 'access_request' | 'open_signup';
  createdAt: Date;
}

export interface CampaignRow {
  id: string;
  ownerId: string;
  state: 'active' | 'deleting';
  productName: string;
  productDescription: string;
  segmentCount: number;
  createdAt: Date;
}

export class Factories {
  private counter = 0;
  constructor(readonly clock: FixedClock = new FixedClock()) {}

  /** The next fixed id; ids of one factory never repeat. */
  id(): string {
    this.counter += 1;
    return fixedUuidV7(this.clock.now().getTime(), this.counter);
  }

  user(overrides: Partial<UserRow> = {}): UserRow {
    const id = overrides.id ?? this.id();
    return {
      id,
      idpSubject: `user_test_${id.slice(-12)}`,
      email: `user.${id.slice(-12)}@example.invalid`,
      role: 'user',
      status: 'active',
      linkedVia: 'invitation',
      createdAt: this.clock.now(),
      ...overrides,
    };
  }

  campaign(ownerId: string, overrides: Partial<CampaignRow> = {}): CampaignRow {
    const id = overrides.id ?? this.id();
    return {
      id,
      ownerId,
      state: 'active',
      productName: `Test product ${id.slice(-6)}`,
      productDescription: 'Synthetic product of a test.',
      segmentCount: 1,
      createdAt: this.clock.now(),
      ...overrides,
    };
  }

  async insertUser(tx: DbTx, overrides: Partial<UserRow> = {}): Promise<UserRow> {
    const row = this.user(overrides);
    await tx.execute(sql`
      insert into users (id, idp_subject, email, role, status, linked_via, created_at, updated_at)
      values (${row.id}, ${row.idpSubject}, ${row.email}, ${row.role}, ${row.status}, ${row.linkedVia},
              ${row.createdAt.toISOString()}::timestamptz, ${row.createdAt.toISOString()}::timestamptz)`);
    return row;
  }

  async insertCampaign(tx: DbTx, ownerId: string, overrides: Partial<CampaignRow> = {}): Promise<CampaignRow> {
    const row = this.campaign(ownerId, overrides);
    await tx.execute(sql`
      insert into campaigns (id, owner_id, state, product_name, product_description, segment_count, created_at, updated_at)
      values (${row.id}, ${row.ownerId}, ${row.state}, ${row.productName}, ${row.productDescription}, ${row.segmentCount},
              ${row.createdAt.toISOString()}::timestamptz, ${row.createdAt.toISOString()}::timestamptz)`);
    return row;
  }
}
