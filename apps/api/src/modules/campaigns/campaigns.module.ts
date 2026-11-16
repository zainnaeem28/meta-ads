import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { RateLimiter } from '../../platform/rate-limit/index.js';
import { DRAFT_REPOSITORY } from './application/draft-ports.js';
import { DraftsService } from './application/drafts.service.js';
import { DrizzleDraftRepository } from './infrastructure/draft.repository.js';
import { DRAFT_CURSOR_KEY, DRAFT_LIMITER, DraftsController, cursorKeyFrom } from './transport/drafts.controller.js';

/** The module instances the api composition root passes in: the audit trail (layer 1) and media (layer 3). */
export interface CampaignsEdge {
  readonly audit: DynamicModule;
  readonly media: DynamicModule;
}

/**
 * Campaigns, part 1 (TASK-046): drafts CRUD, API-020 to API-023 and API-025, over `drafts` and `campaigns` (M0008).
 * Needs the database; submit, history and campaign deletion come with the following slices.
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
        DraftsService,
      ],
      controllers: [DraftsController],
      exports: [DraftsService],
    };
  }
}
