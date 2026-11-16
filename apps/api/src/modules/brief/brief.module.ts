import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DEFAULT_BRAND_RULES_FILE, loadBrandRulesFile } from './infrastructure/repositories/brand-rules-file.js';
import { BRAND_RULE_FILE, BrandRulesReader } from './infrastructure/repositories/brand-rules.reader.js';
import { DrizzleBrandRulesRepository } from './infrastructure/repositories/brand-rules.repository.js';

/**
 * Brief (TASK-048, brief 1/4): the M0009 tables, the claim-check engine and the brand rules. The rules file is read and
 * checked when the module is built, so a missing or invalid `config/brand-rules.json` stops the process at start-up
 * (a configuration fault, never a partial rule set). Needs the database.
 */
@Module({})
export class BriefModule {
  static register(env: Readonly<Record<string, string | undefined>>): DynamicModule {
    const file = loadBrandRulesFile(env['BRAND_RULES_FILE'] ?? DEFAULT_BRAND_RULES_FILE);
    return {
      module: BriefModule,
      providers: [
        { provide: BRAND_RULE_FILE, useValue: file },
        DrizzleBrandRulesRepository,
        BrandRulesReader,
      ],
      exports: [BrandRulesReader],
    };
  }
}
