import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { RateLimiter } from '../../platform/rate-limit/index.js';
import { DRAFT_REPOSITORY } from './application/draft-ports.js';
import { DraftsService } from './application/drafts.service.js';
import { HISTORY_REPOSITORY } from './application/history-ports.js';
import { HistoryService } from './application/history.service.js';
import { CAMPAIGN_PROGRESS_READER, noJobsReader } from './application/progress-reader.js';
import type { CampaignProgressReader } from './application/progress-reader.js';
import { DrizzleDraftRepository } from './infrastructure/draft.repository.js';
import { DrizzleHistoryRepository } from './infrastructure/history.repository.js';
import { DRAFT_CURSOR_KEY, DRAFT_LIMITER, DraftsController, cursorKeyFrom } from './transport/drafts.controller.js';
import { HistoryController } from './transport/history.controller.js';

/** The module instances the api composition root passes in: the audit trail (layer 1) and media (layer 3). */
export interface CampaignsEdge {
  readonly audit: DynamicModule;
  readonly media: DynamicModule;
  /** Production's reader of job states (TD-D12); without it no campaign has jobs yet. */
  readonly progress?: CampaignProgressReader;
}

/**
 * Campaigns: drafts CRUD (TASK-046, API-020 to API-023, API-025) and the history, API-040 and API-041 (TASK-047), over
 * `drafts` and `campaigns` (M0008). Needs the database; submit and campaign deletion come with the following slices.
 */
@Module({})
export class CampaignsModule {
  static register(env: Readonly<Record<string, string | undefined>>, edge: CampaignsEdge): DynamicModule {
    return {
      module: CampaignsModule,
      imports: [edge.audit, edge.media],
      providers: [
        { provide: DRAFT_REPOSITORY, useClass: DrizzleDraftRepository },
        { provide: DRAFT_CURSOR_KEY, useFactory: () => cursorKeyFrom(env) },
        { provide: DRAFT_LIMITER, useFactory: (database: Database) => new RateLimiter(database.db), inject: [DATABASE] },
        { provide: HISTORY_REPOSITORY, useClass: DrizzleHistoryRepository },
        { provide: CAMPAIGN_PROGRESS_READER, useValue: edge.progress ?? noJobsReader },
        DraftsService,
        HistoryService,
      ],
      controllers: [DraftsController, HistoryController],
      exports: [DraftsService, HistoryService],
    };
  }
}
