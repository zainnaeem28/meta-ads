import { sql } from 'drizzle-orm';
import type { SeedStep } from '../index.js';

/** The single `platform_settings` row, `invited_only`; an existing row (any mode, any version) is left as it is. */
export const platformSettingsStep: SeedStep = {
  name: 'platform_settings',
  datasets: ['reference', 'development', 'staging'],
  async run(tx) {
    await tx.execute(
      sql`insert into platform_settings (id, signup_mode) values (1, 'invited_only') on conflict (id) do nothing`,
    );
    return 1;
  },
};
