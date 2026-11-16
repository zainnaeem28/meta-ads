import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedStep } from '../../../../database/index.js';
import { parseBrandRules } from '../../domain/brand-rules.js';
import type { BrandRuleSet } from '../../domain/brand-rules.js';
import { DrizzleBrandRulesRepository } from './brand-rules.repository.js';

/** `config/brand-rules.json` at the repository root (SB-D10); `BRAND_RULES_FILE` points the module and the seed at another file. */
export const DEFAULT_BRAND_RULES_FILE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'config',
  'brand-rules.json',
);

/** Reads and validates the file; throws `BrandRulesInvalidError` naming the faulty rules, never a partial set. */
export function loadBrandRulesFile(path: string = DEFAULT_BRAND_RULES_FILE): BrandRuleSet {
  return parseBrandRules(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/** The release seed's step (ARCHITECTURE §2.2 seed table): upserts the file's rules by id, so a rerun changes nothing. */
export function brandRulesSeedStep(path?: string): SeedStep {
  const repository = new DrizzleBrandRulesRepository();
  return {
    name: 'brand_rules',
    datasets: ['reference', 'development', 'staging'],
    run: (tx) =>
      repository.upsert(
        tx,
        loadBrandRulesFile(path ?? process.env['BRAND_RULES_FILE'] ?? DEFAULT_BRAND_RULES_FILE).rules,
      ),
  };
}
