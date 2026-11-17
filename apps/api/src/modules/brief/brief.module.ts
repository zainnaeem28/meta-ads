import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { BRIEF_REPOSITORY, BRIEF_RULES } from './application/brief-ports.js';
import { BriefService } from './application/brief.service.js';
import { IssuesService } from './application/issues.service.js';
import { DrizzleBriefRepository } from './infrastructure/repositories/brief.repository.js';
import { BriefController } from './transport/brief.controller.js';
import { IssuesController } from './transport/issues.controller.js';
import { DEFAULT_BRAND_RULES_FILE, loadBrandRulesFile } from './infrastructure/repositories/brand-rules-file.js';
import { BRAND_RULE_FILE, BrandRulesReader } from './infrastructure/repositories/brand-rules.reader.js';
import { DrizzleBrandRulesRepository } from './infrastructure/repositories/brand-rules.repository.js';

/**
 * Brief: the M0009 tables, the claim-check engine and the brand rules (TASK-048), and the brief read, edit, accept and
 * claim-issue clear operations, API-050 to API-052 and API-054 (TASK-050). The rules file is read and
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
        { provide: BRIEF_REPOSITORY, useClass: DrizzleBriefRepository },
        { provide: BRIEF_RULES, useExisting: BrandRulesReader },
        BriefService,
        IssuesService,
      ],
      controllers: [BriefController, IssuesController],
      exports: [BrandRulesReader],
    };
  }
}
