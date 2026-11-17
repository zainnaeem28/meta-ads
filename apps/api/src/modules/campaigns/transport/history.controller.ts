import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import type { ActorContext } from '../../../platform/http/index.js';
import {
  DomainError,
  PageResult,
  buildPage,
  decodeCursor,
  parseWith,
} from '../../../platform/http/index.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import type { HistoryPosition } from '../application/history-ports.js';
import { HistoryService } from '../application/history.service.js';
import type { CampaignDetail, CampaignListItem } from '../application/history.service.js';
import { DRAFT_CURSOR_KEY } from './drafts.controller.js';

const Id = z.uuid();
const Params = z.object({ campaignId: Id });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  filter: z.enum(['all', 'processing', 'completed', 'failed']).default('all'),
});

const EXCERPT_CHARS = 160;

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

export interface CampaignSummaryView {
  id: string;
  productName: string;
  productDescriptionExcerpt: string;
  progress: string;
  briefState: string;
  segmentCount: number;
  finalAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignView extends CampaignSummaryView {
  productDescription: string;
  productMediaId: string | null;
  draftId: string;
  jobCounts: Record<string, number>;
  latestAssemblyId: string | null;
  thumbstopperJobId: string | null;
}

const summary = ({ campaign, snapshot }: CampaignListItem): CampaignSummaryView => ({
  id: campaign.id,
  productName: campaign.productName,
  productDescriptionExcerpt: [...campaign.productDescription].slice(0, EXCERPT_CHARS).join(''),
  progress: snapshot.progress,
  briefState: snapshot.briefState,
  segmentCount: campaign.segmentCount,
  finalAvailable: snapshot.finalAvailable,
  createdAt: instant(campaign.createdAt),
  updatedAt: instant(campaign.updatedAt),
});

const detail = (item: CampaignDetail): CampaignView => ({
  ...summary(item),
  productDescription: item.campaign.productDescription,
  productMediaId: item.campaign.productMediaId,
  draftId: item.draftId,
  jobCounts: { ...item.snapshot.jobCounts },
  latestAssemblyId: item.snapshot.latestAssemblyId,
  thumbstopperJobId: item.snapshot.thumbstopperJobId,
});

function parsePosition(key: string): HistoryPosition {
  const bad = (): DomainError =>
    new DomainError('validation_failed', 'The request is not valid.', [
      { field: 'cursor', code: 'cursor_invalid', message: 'The cursor is invalid or has expired.' },
    ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw bad();
  const [updatedAt, id] = parsed as unknown[];
  if (typeof updatedAt !== 'string' || typeof id !== 'string' || !Id.safeParse(id).success)
    throw bad();
  if (Number.isNaN(Date.parse(updatedAt))) throw bad();
  return { updatedAt, id };
}

function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

/** API-040 and API-041: my campaign history. */
@Controller('campaigns')
@Scope('U')
export class HistoryController {
  constructor(
    @Inject(HistoryService) private readonly history: HistoryService,
    @Inject(DRAFT_CURSOR_KEY) private readonly cursorKey: string,
  ) {}

  @Get()
  async list(
    @CurrentActor() actor: ActorContext | undefined,
    @Query() rawQuery: unknown,
  ): Promise<PageResult<CampaignSummaryView>> {
    const ownerId = owner(actor);
    const query = parseWith(ListQuery, rawQuery);
    // A cursor holds for one search and one filter only: changing either needs a new first page.
    const scope = {
      owner: ownerId,
      filters: { list: 'campaigns', q: query.q ?? null, filter: query.filter },
    };
    const after =
      query.cursor === undefined
        ? undefined
        : parsePosition(decodeCursor(this.cursorKey, query.cursor, scope));
    const rows = await this.history.list(ownerId, query.filter, query.q, query.limit + 1, after);
    const page = buildPage(
      rows,
      query.limit,
      (item) => JSON.stringify([item.campaign.updatedAt, item.campaign.id]),
      this.cursorKey,
      scope,
    );
    return new PageResult(page.items.map(summary), page.pagination);
  }

  @Get(':campaignId')
  async get(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
  ): Promise<CampaignView> {
    const { campaignId } = parseWith(Params, rawParams);
    return detail(await this.history.get(owner(actor), campaignId));
  }
}
