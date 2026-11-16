import { eq, sql } from 'drizzle-orm';
import { platformSettings } from '../../../database/schema/identity.js';
import type { DbTx } from '../../../platform/db/index.js';
import type { SignupMode } from '../domain/records.js';

export const SETTINGS_ADMIN_STORE = Symbol('SETTINGS_ADMIN_STORE');

export type SettingsDb = Pick<DbTx, 'select' | 'insert' | 'update' | 'execute'>;

export interface SettingsAdminRow {
  readonly signupMode: SignupMode;
  readonly openModeVerificationId: string | null;
}

/** Persistence of API-120 and API-121 on the single `platform_settings` row. */
export class SettingsAdminStore {
  /** The row (created with its defaults on first use); `lock` serializes concurrent mode changes. */
  async read(db: SettingsDb, lock = false): Promise<SettingsAdminRow> {
    await db.insert(platformSettings).values({ id: 1 }).onConflictDoNothing();
    const query = db
      .select({
        signupMode: platformSettings.signupMode,
        openModeVerificationId: platformSettings.openModeVerificationId,
      })
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));
    const rows = await (lock ? query.for('update') : query);
    return rows[0] as SettingsAdminRow;
  }

  async setSignupMode(db: SettingsDb, mode: SignupMode, updatedBy: string): Promise<void> {
    await db
      .update(platformSettings)
      .set({
        signupMode: mode,
        updatedBy,
        version: sql`${platformSettings.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(platformSettings.id, 1));
  }
}

export type SettingsAdminStorePort = { [K in keyof SettingsAdminStore]: SettingsAdminStore[K] };
