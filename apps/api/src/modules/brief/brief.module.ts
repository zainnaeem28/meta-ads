import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { BriefGenerationJob, BRIEF_GENERATE_QUEUE } from './application/worker/brief-generation.job.js';
import { BRIEF_ANALYZE_IMAGE_QUEUE, ImageAnalysisJob } from './application/worker/image-analysis.job.js';
import {
  BRIEF_AUTH_THRESHOLD,
  BRIEF_JOB_REPOSITORY,
  BRIEF_WORKER_CONFIG,
  CLAIM_RULES,
  IMAGE_SOURCE,
  KEY_AUTH_REPORTER,
  KEY_OPENER,
} from './application/worker/ports.js';
import type { BriefWorkerConfig, JobLog, KeyOpener } from './application/worker/ports.js';
import { ProviderCallRunner } from './application/worker/provider-call.js';
import { TEXT_AI_PORT } from './application/worker/text-ai.port.js';
import { BRIEF_REPOSITORY, BRIEF_RULES } from './application/brief-ports.js';
import { BriefService } from './application/brief.service.js';
import { IssuesService } from './application/issues.service.js';
import { DrizzleBriefRepository } from './infrastructure/repositories/brief.repository.js';
import { BriefController } from './transport/brief.controller.js';
import { AnalysisController } from './transport/analysis.controller.js';
import { AnalysisService } from './transport/analysis.service.js';
import { RegenerateController } from './transport/regenerate.controller.js';
import { RegenerateService } from './transport/regenerate.service.js';
import { SubmitController } from './transport/submit.controller.js';
import { SubmitService } from './transport/submit.service.js';
import { BRIEF_JOB_MODELS, BriefJobCreator, JOB_IDEMPOTENCY_TTL } from './transport/submit-jobs.js';
import { IssuesController } from './transport/issues.controller.js';
import { DEFAULT_BRAND_RULES_FILE, loadBrandRulesFile } from './infrastructure/repositories/brand-rules-file.js';
import { BRAND_RULE_FILE, BrandRulesReader } from './infrastructure/repositories/brand-rules.reader.js';
import { DrizzleBrandRulesRepository } from './infrastructure/repositories/brand-rules.repository.js';
import { DrizzleBriefJobs } from './infrastructure/brief-jobs.repository.js';
import { DrizzleKeyAuthReporter } from './infrastructure/key-auth.reporter.js';
import { OpenAiTextAi } from './infrastructure/openai-text-ai.js';
import { StorageImageSource } from './infrastructure/storage-image-source.js';
import type { StoragePort } from '../media/index.js';

export { BriefGenerationJob, ImageAnalysisJob };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * What the worker composition root passes in: the instances of the audit, egress and usage modules (this module's
 * only way to the provider, to the spend ledger and to the trail), the key opener (bound to the unsealer by the worker
 * root alone, layer rule L3) and the worker's own object storage, resolved when the first image is read.
 */
export interface BriefWorkerEdge {
  readonly audit: DynamicModule;
  readonly egress: DynamicModule;
  readonly usage: DynamicModule;
  readonly opener: KeyOpener;
  readonly storage: () => StoragePort;
  /** Test seam: a local stand-in for the OpenAI chat completions URL. The product never sets it. */
  readonly chatUrl?: string;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required for brief generation`);
  return value;
}

/** `KEY_AUTO_DISABLE_THRESHOLD`, 1 to 20, 5 by default (the same setting the api's key module reads). */
function authThreshold(env: Env): number {
  const text = env['KEY_AUTO_DISABLE_THRESHOLD'];
  const value = text === undefined || text === '' ? 5 : Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error('KEY_AUTO_DISABLE_THRESHOLD must be an integer from 1 to 20');
  }
  return value;
}

/**
 * What the api composition root passes in for the job-creating operations (API-024, 035, 036, 053): the media module
 * (the product image is attached to the campaign) and the usage module (the cap check and the reservation). Without it the
 * module serves the brief read, edit, accept and clear operations only.
 */
export interface BriefApiEdge {
  readonly media: DynamicModule;
  readonly usage: DynamicModule;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** `IDEMPOTENCY_TTL_HOURS`, 24 by default (the same setting the platform cleanup reads). */
function idempotencyTtl(env: Env): number {
  const text = optional(env, 'IDEMPOTENCY_TTL_HOURS');
  const value = text === undefined ? 24 : Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error('IDEMPOTENCY_TTL_HOURS must be a positive integer');
  return value;
}

/**
 * Brief: the M0009 tables, the claim-check engine and the brand rules (TASK-048), and the brief read, edit, accept and
 * claim-issue clear operations, API-050 to API-052 and API-054 (TASK-050), and the worker's two provider jobs `brief.generate` and `brief.analyze-image` over the OpenAI TextAIPort
 * (TASK-049). The rules file is read and
 * checked when the module is built, so a missing or invalid `config/brand-rules.json` stops the process at start-up
 * (a configuration fault, never a partial rule set). Needs the database.
 */
@Module({})
export class BriefModule {
  static register(env: Env, edge?: BriefApiEdge): DynamicModule {
    const file = loadBrandRulesFile(env['BRAND_RULES_FILE'] ?? DEFAULT_BRAND_RULES_FILE);
    const jobs = edge === undefined ? undefined : this.jobOperations(env, edge);
    return {
      module: BriefModule,
      imports: jobs?.imports ?? [],
      providers: [
        ...(jobs?.providers ?? []),
        { provide: BRAND_RULE_FILE, useValue: file },
        DrizzleBrandRulesRepository,
        BrandRulesReader,
        { provide: BRIEF_REPOSITORY, useClass: DrizzleBriefRepository },
        { provide: BRIEF_RULES, useExisting: BrandRulesReader },
        BriefService,
        IssuesService,
      ],
      controllers: [BriefController, IssuesController, ...(jobs?.controllers ?? [])],
      exports: [BrandRulesReader],
    };
  }

  /** API-024, 035, 036 and 053 (TASK-051): the job-creating rule SB-D14 and the operations that use it. */
  private static jobOperations(env: Env, edge: BriefApiEdge): Required<Pick<DynamicModule, 'imports' | 'providers' | 'controllers'>> {
    return {
      imports: [edge.media, edge.usage],
      providers: [
        { provide: BRIEF_JOB_MODELS, useValue: { text: optional(env, 'OPENAI_TEXT_MODEL'), vision: optional(env, 'OPENAI_VISION_MODEL') } },
        { provide: JOB_IDEMPOTENCY_TTL, useValue: idempotencyTtl(env) },
        BriefJobCreator,
        SubmitService,
        AnalysisService,
        RegenerateService,
      ],
      controllers: [SubmitController, AnalysisController, RegenerateController],
    };
  }

  /** The worker side. Fails at construction, so the process does not start, when a setting is missing or out of range. */
  static registerWorker(env: Env, edge: BriefWorkerEdge): DynamicModule {
    const file = loadBrandRulesFile(env['BRAND_RULES_FILE'] ?? DEFAULT_BRAND_RULES_FILE);
    const config: BriefWorkerConfig = {
      textModel: required(env, 'OPENAI_TEXT_MODEL'),
      visionModel: required(env, 'OPENAI_VISION_MODEL'),
      sensitiveTerms: file.sensitiveTerms,
      ...(edge.chatUrl === undefined ? {} : { chatUrl: edge.chatUrl }),
    };
    return {
      module: BriefModule,
      imports: [edge.audit, edge.egress, edge.usage],
      providers: [
        { provide: BRAND_RULE_FILE, useValue: file },
        DrizzleBrandRulesRepository,
        BrandRulesReader,
        { provide: CLAIM_RULES, useExisting: BrandRulesReader },
        { provide: BRIEF_WORKER_CONFIG, useValue: config },
        { provide: BRIEF_AUTH_THRESHOLD, useValue: authThreshold(env) },
        { provide: BRIEF_JOB_REPOSITORY, useClass: DrizzleBriefJobs },
        { provide: KEY_OPENER, useValue: edge.opener },
        { provide: KEY_AUTH_REPORTER, useClass: DrizzleKeyAuthReporter },
        { provide: TEXT_AI_PORT, useClass: OpenAiTextAi },
        { provide: IMAGE_SOURCE, useValue: new StorageImageSource(edge.storage) },
        ProviderCallRunner,
        BriefGenerationJob,
        ImageAnalysisJob,
      ],
      exports: [BriefGenerationJob, ImageAnalysisJob, BrandRulesReader],
    };
  }
}

/** The queue handlers of this module, resolved when a job arrives (the worker composition root binds them). */
export function briefJobHandlers(resolve: {
  readonly generate: () => BriefGenerationJob;
  readonly analyze: () => ImageAnalysisJob;
}): Readonly<Record<string, (job: { id: string; data: unknown }, log: JobLog) => Promise<void>>> {
  return {
    [BRIEF_GENERATE_QUEUE]: async (job, log) => {
      await resolve.generate().handle(job, log);
    },
    [BRIEF_ANALYZE_IMAGE_QUEUE]: async (job, log) => {
      await resolve.analyze().handle(job, log);
    },
  };
}
