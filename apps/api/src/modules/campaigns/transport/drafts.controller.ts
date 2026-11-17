import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
import { RateLimitedError } from '../../../platform/rate-limit/index.js';
import type { LimitRule, RateLimiter } from '../../../platform/rate-limit/index.js';
import type { DraftPosition } from '../application/draft-ports.js';
import { DraftsService } from '../application/drafts.service.js';
import { durationSeconds } from '../domain/draft.js';
import type { Audience, Direction, DraftFields, DraftRecord } from '../domain/draft.js';

/** Signs the cursors of API-020 (`CURSOR_SIGNING_KEY`, required in staging and production); a per-process key otherwise. */
export const DRAFT_CURSOR_KEY = Symbol('DRAFT_CURSOR_KEY');
export const DRAFT_LIMITER = Symbol('DRAFT_LIMITER');
export const cursorKeyFrom = (env: Readonly<Record<string, string | undefined>>): string =>
  env['CURSOR_SIGNING_KEY'] ?? randomBytes(32).toString('hex');

/** ARCHITECTURE §3.3: API-021 30 per minute, API-023 60 per minute, per user, on top of the general limit. */
export const CREATE_LIMIT: LimitRule = { limit: 30, windowSeconds: 60 };
export const PATCH_LIMIT: LimitRule = { limit: 60, windowSeconds: 60 };

const Id = z.uuid();
const Params = z.object({ draftId: Id });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
});

const AudienceSchema = z.strictObject({
  ageMin: z.number().int().min(21).max(99).optional(),
  ageMax: z.number().int().min(21).max(99).optional(),
  gender: z.enum(['all', 'female', 'male']).optional(),
  interests: z.array(z.string().min(1).max(40)).max(10).optional(),
});
const DirectionSchema = z.strictObject({
  goal: z.enum(['awareness', 'conversion', 'retention']).optional(),
  tone: z.string().min(1).max(60).optional(),
  segmentCount: z.number().int().min(1).max(4).optional(),
});
/** DraftWrite: closed, every field optional, `null` clears (completeness is checked at submit). */
const DraftWrite = z.strictObject({
  step: z.number().int().min(1).max(5).optional(),
  adStyle: z.enum(['ugc']).optional(),
  intakeMode: z.enum(['description', 'script']).optional(),
  productName: z.string().trim().min(1).max(120).nullable().optional(),
  productDescription: z.string().max(2000).nullable().optional(),
  audience: AudienceSchema.nullable().optional(),
  direction: DirectionSchema.nullable().optional(),
  concept: z.string().max(4000).nullable().optional(),
  script: z.string().max(4000).nullable().optional(),
  productMediaId: Id.nullable().optional(),
});

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

export interface DraftView {
  id: string;
  version: number;
  step: number;
  adStyle: 'ugc';
  intakeMode: 'description' | 'script';
  productName: string | null;
  productDescription: string | null;
  audience: Audience | null;
  direction: Direction | null;
  concept: string | null;
  script: string | null;
  productMediaId: string | null;
  campaignId: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

const view = (d: DraftRecord): DraftView => ({
  id: d.id,
  version: d.version,
  step: d.step,
  adStyle: d.adStyle,
  intakeMode: d.intakeMode,
  productName: d.productName,
  productDescription: d.productDescription,
  audience: d.audience,
  direction: d.direction,
  concept: d.concept,
  script: d.script,
  productMediaId: d.productMediaId,
  campaignId: d.campaignId,
  durationSeconds: durationSeconds(d.direction),
  createdAt: instant(d.createdAt),
  updatedAt: instant(d.updatedAt),
});

/** `If-Match: "<version>"`, the ETag of the last read (ADR-010: a mismatch is 409, not 412). */
export function versionOf(header: string | undefined): number {
  const match = header === undefined ? null : /^"([0-9]{1,9})"$/.exec(header.trim());
  if (match?.[1] === undefined || Number(match[1]) < 1) {
    throw new DomainError('validation_failed', 'The request is not valid.', [
      {
        field: 'If-Match',
        code: header === undefined ? 'required' : 'invalid_format',
        message: 'Send the ETag of the last read, e.g. "3".',
      },
    ]);
  }
  return Number(match[1]);
}

function parsePosition(key: string): DraftPosition {
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

/** The signed-in account of a request; the session guard has already refused every other case. */
function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

const etag = (d: DraftRecord): string => `"${String(d.version)}"`;

/** API-020 to API-023 and API-025: my drafts. Submit (API-024) arrives with the campaign slice. */
@Controller('drafts')
@Scope('U')
export class DraftsController {
  constructor(
    @Inject(DraftsService) private readonly drafts: DraftsService,
    @Inject(DRAFT_CURSOR_KEY) private readonly cursorKey: string,
    @Inject(DRAFT_LIMITER) private readonly limiter: Pick<RateLimiter, 'consume'>,
  ) {}

  @Get()
  async list(
    @CurrentActor() actor: ActorContext | undefined,
    @Query() rawQuery: unknown,
  ): Promise<PageResult<DraftView>> {
    const ownerId = owner(actor);
    const query = parseWith(ListQuery, rawQuery);
    const scope = { owner: ownerId };
    const after =
      query.cursor === undefined
        ? undefined
        : parsePosition(decodeCursor(this.cursorKey, query.cursor, scope));
    const rows = await this.drafts.listOpen(ownerId, query.limit + 1, after);
    const page = buildPage(
      rows,
      query.limit,
      (d) => JSON.stringify([d.updatedAt, d.id]),
      this.cursorKey,
      scope,
    );
    return new PageResult(page.items.map(view), page.pagination);
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentActor() actor: ActorContext | undefined,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DraftView> {
    const ownerId = owner(actor);
    await this.limit(reply, 'draft-create', ownerId, CREATE_LIMIT);
    const fields = parseWith(DraftWrite, rawBody) as DraftFields;
    const draft = await this.drafts.create(ownerId, fields);
    void reply.header('ETag', etag(draft));
    void reply.header('Location', `/api/v1/drafts/${draft.id}`);
    return view(draft);
  }

  @Get(':draftId')
  async get(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DraftView> {
    const { draftId } = parseWith(Params, rawParams);
    const draft = await this.drafts.get(owner(actor), draftId);
    void reply.header('ETag', etag(draft));
    return view(draft);
  }

  @Patch(':draftId')
  async patch(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DraftView> {
    const ownerId = owner(actor);
    await this.limit(reply, 'draft-patch', ownerId, PATCH_LIMIT);
    const { draftId } = parseWith(Params, rawParams);
    const expected = versionOf(ifMatch);
    const fields = parseWith(DraftWrite, rawBody) as DraftFields;
    if (Object.keys(fields).length === 0) {
      throw new DomainError('validation_failed', 'The request is not valid.', [
        { field: 'body', code: 'required', message: 'Send at least one field to change.' },
      ]);
    }
    const draft = await this.drafts.patch(ownerId, draftId, expected, fields);
    void reply.header('ETag', etag(draft));
    return view(draft);
  }

  @Delete(':draftId')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: ActorContext | undefined,
    @Param() rawParams: unknown,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const { draftId } = parseWith(Params, rawParams);
    await this.drafts.remove(owner(actor), draftId, request.id);
  }

  /** The route's own limit, counted per user on top of the general one; a refusal carries `Retry-After`. */
  private async limit(
    reply: FastifyReply,
    scope: string,
    ownerId: string,
    rule: LimitRule,
  ): Promise<void> {
    const result = await this.limiter.consume(scope, ownerId, rule.limit, rule.windowSeconds);
    if (result.allowed) return;
    void reply.header('Retry-After', String(result.retryAfterSeconds));
    throw new RateLimitedError(result.retryAfterSeconds);
  }
}
