import { randomBytes } from 'node:crypto';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import {
  DomainError,
  PageResult,
  buildPage,
  decodeCursor,
  parseWith,
} from '../../../platform/http/index.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { CurrentActor, requireRecentAuth } from '../../../platform/http/auth.guard.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { AlertService, AuditService } from '../application/audit.service.js';
import type { AlertPosition, AlertRecord } from '../application/ports.js';

/** Signs list cursors (`CURSOR_SIGNING_KEY`, required in staging and production); a per-process key otherwise. */
export const ALERT_CURSOR_KEY = Symbol('ALERT_CURSOR_KEY');
export const cursorKeyFrom = (env: NodeJS.ProcessEnv): string =>
  env['CURSOR_SIGNING_KEY'] ?? randomBytes(32).toString('hex');

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  acknowledged: z.enum(['true', 'false']).optional(),
});
const AlertParams = z.object({ alertId: z.uuid() });

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

export interface AlertView {
  id: string;
  kind: string;
  subjectUserId: string | null;
  raisedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  counts: Record<string, number>;
}

/** User IDs and counts only; an alert never carries an email (REQ-027). */
const view = (a: AlertRecord): AlertView => ({
  id: a.id,
  kind: a.kind,
  subjectUserId: a.subjectUserId,
  raisedAt: instant(a.raisedAt),
  acknowledgedAt: a.acknowledgedAt === null ? null : instant(a.acknowledgedAt),
  acknowledgedBy: a.acknowledgedBy,
  counts: { ...a.counts },
});

const positionKey = (a: AlertRecord): string =>
  JSON.stringify([a.acknowledgedAt, a.raisedAt, a.id]);

function parsePosition(key: string): AlertPosition {
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
  if (!Array.isArray(parsed) || parsed.length !== 3) throw bad();
  const [acknowledgedAt, raisedAt, id] = parsed as unknown[];
  if (
    (acknowledgedAt !== null && typeof acknowledgedAt !== 'string') ||
    typeof raisedAt !== 'string' ||
    typeof id !== 'string'
  )
    throw bad();
  return { acknowledgedAt, raisedAt, id };
}

/** API-125 and API-126: administrator alerts, scope A plus recent authentication. */
@Controller('admin/alerts')
@Scope('A')
export class AlertsController {
  constructor(
    @Inject(AlertService) private readonly alerts: AlertService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(DATABASE) private readonly database: Pick<Database, 'db'> | undefined,
    @Inject(ALERT_CURSOR_KEY) private readonly cursorKey: string,
  ) {}

  /** Without a database there is no session guard either: such a request is refused, never served. */
  private db(actor: ActorContext | undefined): {
    actor: ActorContext;
    db: Pick<Database, 'db'>['db'];
  } {
    if (actor === undefined || this.database === undefined) {
      throw new DomainError('unauthenticated', 'Sign in to continue.');
    }
    return { actor, db: this.database.db };
  }

  /** The guard has checked token, status, MFA and role; this adds recent authentication and audits its denial. */
  private async recentAuth(
    actor: ActorContext,
    db: Pick<Database, 'db'>['db'],
    requestId: string,
  ): Promise<void> {
    try {
      requireRecentAuth(actor);
    } catch (error) {
      try {
        await this.audit.record(db, {
          actorId: actor.userId,
          actorType: 'admin',
          action: 'auth.denied',
          objectType: 'route',
          objectId: null,
          outcome: 'denied',
          requestId,
        });
      } catch {
        // The refusal is what the caller must see.
      }
      throw error;
    }
  }

  @Get()
  async list(
    @CurrentActor() current: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Query() rawQuery: unknown,
  ): Promise<PageResult<AlertView>> {
    const { actor, db } = this.db(current);
    await this.recentAuth(actor, db, request.id);
    const query = parseWith(ListQuery, rawQuery);
    const acknowledged =
      query.acknowledged === undefined ? undefined : query.acknowledged === 'true';
    const scope = { owner: actor.userId, filters: { acknowledged: acknowledged ?? null } };
    const after =
      query.cursor === undefined
        ? undefined
        : parsePosition(decodeCursor(this.cursorKey, query.cursor, scope));
    const rows = await this.alerts.listAlerts(db, {
      limit: query.limit + 1,
      ...(acknowledged === undefined ? {} : { acknowledged }),
      ...(after === undefined ? {} : { after }),
    });
    const page = buildPage(rows, query.limit, positionKey, this.cursorKey, scope);
    return new PageResult(page.items.map(view), page.pagination);
  }

  @Post(':alertId/acknowledge')
  @HttpCode(200)
  async acknowledge(
    @CurrentActor() current: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Param() rawParams: unknown,
  ): Promise<AlertView> {
    const { actor, db } = this.db(current);
    await this.recentAuth(actor, db, request.id);
    const { alertId } = parseWith(AlertParams, rawParams);
    const outcome = await this.alerts.acknowledge(db, alertId, actor.userId);
    if (outcome.status === 'not_found') throw new DomainError('not_found', 'Alert not found.');
    return view(outcome.alert);
  }
}
