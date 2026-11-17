import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DomainError,
  PageResult,
  buildPage,
  decodeCursor,
  parseWith,
} from '../../../platform/http/index.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { CurrentActor } from '../../../platform/http/auth.guard.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { RateLimitedError } from '../../../platform/rate-limit/index.js';
import { ProviderKeysService } from '../application/provider-keys.service.js';
import type { KeyStatusView, StoredKeyView } from '../application/provider-keys.service.js';
import type { KeyEventPosition, KeyEventRecord } from '../application/ports.js';
import { PROVIDERS } from '../domain/key-wrap.js';

/** Signs the cursors of API-013 (`CURSOR_SIGNING_KEY`, required in staging and production); a per-process key otherwise. */
export const KEY_EVENT_CURSOR_KEY = Symbol('KEY_EVENT_CURSOR_KEY');
export const cursorKeyFrom = (env: Readonly<Record<string, string | undefined>>): string =>
  env['CURSOR_SIGNING_KEY'] ?? randomBytes(32).toString('hex');

const ProviderParams = z.object({ provider: z.enum(PROVIDERS) });
// The contract asks for 20 to 512 characters after trimming; a shorter key is refused as `key_invalid` (format), not as
// a malformed request, so the reason class is the same for every kind of bad key (TC-KEY-02).
const PutBody = z.strictObject({ apiKey: z.string().max(512) });
const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  provider: z.enum(PROVIDERS).optional(),
});

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

export interface KeyEventView {
  id: string;
  provider: string;
  kind: string;
  at: string;
}

const eventView = (e: KeyEventRecord): KeyEventView => ({
  id: e.id,
  provider: e.provider,
  kind: e.kind,
  at: instant(e.at),
});

function parsePosition(key: string): KeyEventPosition {
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
  const [at, id] = parsed as unknown[];
  if (typeof at !== 'string' || typeof id !== 'string') throw bad();
  return { at, id };
}

/** The signed-in account of a request; the session guard has already refused every other case. */
function owner(actor: ActorContext | undefined): string {
  if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
  return actor.userId;
}

/** API-010 to API-013: my provider keys (hint and fingerprint only) and my key-event trail. */
@Controller('me')
export class ProviderKeysController {
  constructor(
    @Inject(ProviderKeysService) private readonly keys: ProviderKeysService,
    @Inject(KEY_EVENT_CURSOR_KEY) private readonly cursorKey: string,
  ) {}

  @Get('provider-keys')
  @Scope('U')
  list(@CurrentActor() actor: ActorContext | undefined): Promise<KeyStatusView[]> {
    return this.keys.keyStatus(owner(actor));
  }

  /** The body is parsed here, not by a pipe: a validation message names the field and never carries the value. */
  @Put('provider-keys/:provider')
  @Scope('U+RA')
  async put(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param() rawParams: unknown,
    @Body() rawBody: unknown,
  ): Promise<StoredKeyView> {
    const ownerId = owner(actor);
    const { provider } = parseWith(ProviderParams, rawParams);
    const { apiKey } = parseWith(PutBody, rawBody);
    try {
      return await this.keys.storeKey(ownerId, provider, apiKey, { requestId: request.id });
    } catch (error) {
      if (error instanceof RateLimitedError)
        void reply.header('Retry-After', String(error.retryAfterSeconds));
      throw error;
    }
  }

  @Delete('provider-keys/:provider')
  @Scope('U+RA')
  @HttpCode(204)
  async remove(
    @CurrentActor() actor: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Param() rawParams: unknown,
  ): Promise<void> {
    const ownerId = owner(actor);
    const { provider } = parseWith(ProviderParams, rawParams);
    await this.keys.deleteKey(ownerId, provider, { requestId: request.id });
  }

  @Get('key-events')
  @Scope('U')
  async events(
    @CurrentActor() actor: ActorContext | undefined,
    @Query() rawQuery: unknown,
  ): Promise<PageResult<KeyEventView>> {
    const ownerId = owner(actor);
    const query = parseWith(EventsQuery, rawQuery);
    const scope = { owner: ownerId, filters: { provider: query.provider ?? null } };
    const after =
      query.cursor === undefined
        ? undefined
        : parsePosition(decodeCursor(this.cursorKey, query.cursor, scope));
    const rows = await this.keys.listEvents(ownerId, {
      limit: query.limit + 1,
      ...(query.provider === undefined ? {} : { provider: query.provider }),
      ...(after === undefined ? {} : { after }),
    });
    const page = buildPage(
      rows,
      query.limit,
      (e) => JSON.stringify([e.at, e.id]),
      this.cursorKey,
      scope,
    );
    return new PageResult(page.items.map(eventView), page.pagination);
  }
}
