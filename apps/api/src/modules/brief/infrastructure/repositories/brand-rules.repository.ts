import { eq } from 'drizzle-orm';
import { brandRules } from '../../../../database/schema/brief.js';
import type { DbTx } from '../../../../platform/db/index.js';
import { parseStoredRule } from '../../domain/brand-rules.js';
import type { BrandRule } from '../../domain/brand-rules.js';

/** Drizzle access to `brand_rules`: the release seed writes it (owner role), the runtime roles only read it. */
export class DrizzleBrandRulesRepository {
  /** Upserts by id and returns the number of rules written. Rules that left the file stay, switched off. */
  async upsert(tx: DbTx, rules: readonly BrandRule[]): Promise<number> {
    for (const rule of rules) {
      const values = {
        class: rule.class,
        clearable: rule.clearable,
        kind: rule.kind,
        params: rule.params,
        message: rule.message,
        rulesVersion: rule.rulesVersion,
        active: rule.active,
      };
      await tx
        .insert(brandRules)
        .values({ id: rule.id, ...values })
        .onConflictDoUpdate({ target: brandRules.id, set: values });
    }
    const keep = new Set(rules.map((rule) => rule.id));
    const stored = await tx
      .select({ id: brandRules.id, active: brandRules.active })
      .from(brandRules);
    for (const row of stored) {
      if (row.active && !keep.has(row.id)) {
        await tx.update(brandRules).set({ active: false }).where(eq(brandRules.id, row.id));
      }
    }
    return rules.length;
  }

  /** Every stored rule, checked with the file's own rules; a row that fails the check throws. */
  async list(tx: DbTx): Promise<BrandRule[]> {
    const rows = await tx.select().from(brandRules).orderBy(brandRules.id);
    return rows.map((row) =>
      parseStoredRule({
        id: row.id,
        class: row.class as BrandRule['class'],
        clearable: row.clearable,
        kind: row.kind as BrandRule['kind'],
        params: row.params as Record<string, unknown>,
        message: row.message,
        rulesVersion: row.rulesVersion,
        active: row.active,
      }),
    );
  }
}
