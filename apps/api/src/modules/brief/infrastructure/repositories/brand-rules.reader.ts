import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database } from '../../../../platform/db/index.js';
import { compileRules } from '../../domain/claim-check.js';
import type { CompiledRules } from '../../domain/claim-check.js';
import type { BrandRuleSet } from '../../domain/brand-rules.js';
import { DrizzleBrandRulesRepository } from './brand-rules.repository.js';

export const BRAND_RULE_FILE = Symbol('BRAND_RULE_FILE');

/** The seeded rules are missing or older than the file: claim checks stop rather than pass text unchecked. */
export class BrandRulesNotSeededError extends Error {
  constructor(reason: string) {
    super(`brand rules are not seeded: ${reason}; run the release seed`);
    this.name = 'BrandRulesNotSeededError';
  }
}

/**
 * The rules claim checks run with: the active rows of `brand_rules`, compiled. The file the process started with sets the
 * version the table must have reached, so a release that forgot the seed fails closed.
 */
@Injectable()
export class BrandRulesReader {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(DrizzleBrandRulesRepository) private readonly repository: DrizzleBrandRulesRepository,
    @Inject(BRAND_RULE_FILE) private readonly file: BrandRuleSet,
  ) {}

  async activeRules(): Promise<CompiledRules> {
    const rows = await this.database.uow.run((tx) => this.repository.list(tx));
    const active = rows.filter((row) => row.active);
    if (active.length === 0) throw new BrandRulesNotSeededError('no active rule');
    if (active.some((row) => row.rulesVersion < this.file.rulesVersion)) {
      throw new BrandRulesNotSeededError(
        `the table is older than rules version ${String(this.file.rulesVersion)}`,
      );
    }
    return compileRules(active);
  }
}
