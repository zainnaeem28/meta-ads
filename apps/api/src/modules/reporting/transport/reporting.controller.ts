import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { CsvResult, DomainError, parseWith } from '../../../platform/http/index.js';
import type { ActorContext } from '../../../platform/http/index.js';
import { CurrentActor, requireRecentAuth } from '../../../platform/http/auth.guard.js';
import { Scope } from '../../../platform/http/scope-registry.js';
import { RateLimiter } from '../../../platform/rate-limit/index.js';
import { AuditService } from '../../audit/index.js';
import { CSV_HEADER, csvRow } from '../domain/csv.js';
import { UsageReportService } from '../application/usage-report.service.js';
import type { UsageReportView } from '../application/usage-report.service.js';

/** API-130: 10 per minute per administrator; API-131: 5 per minute. */
export const REPORT_LIMIT = { limit: 10, windowSeconds: 60 } as const;
export const CSV_LIMIT = { limit: 5, windowSeconds: 60 } as const;

const Instant = z.iso.datetime({ offset: true }).transform((text) => new Date(text));
const WindowQuery = z.object({ from: Instant.optional(), to: Instant.optional() }).strict();

/** API-130 and API-131: the usage report and its CSV; administrator with recent authentication. */
@Controller('admin')
@Scope('A')
export class ReportingController {
  constructor(
    @Inject(UsageReportService) private readonly report: UsageReportService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DATABASE) private readonly database: Pick<Database, 'db'>,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /** The guard has checked token, status, MFA and role; this adds recent authentication and audits its denial. */
  private async admit(
    actor: ActorContext | undefined,
    request: FastifyRequest,
    scope: string,
    rule: { limit: number; windowSeconds: number },
  ): Promise<ActorContext> {
    if (actor === undefined) throw new DomainError('unauthenticated', 'Sign in to continue.');
    try {
      requireRecentAuth(actor);
    } catch (error) {
      try {
        await this.audit.record(this.database.db, {
          actorId: actor.userId,
          actorType: 'admin',
          action: 'auth.denied',
          objectType: 'route',
          objectId: null,
          outcome: 'denied',
          requestId: request.id,
        });
      } catch {
        // The refusal is what the caller must see.
      }
      throw error;
    }
    await this.limiter.enforce(scope, actor.userId, rule);
    return actor;
  }

  @Get('usage-report')
  async usageReport(
    @CurrentActor() current: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Query() rawQuery: unknown,
  ): Promise<UsageReportView> {
    await this.admit(current, request, 'usage-report', REPORT_LIMIT);
    const window = this.report.window(parseWith(WindowQuery, rawQuery));
    return this.report.usageReport(window);
  }

  @Get('usage-report.csv')
  async usageReportCsv(
    @CurrentActor() current: ActorContext | undefined,
    @Req() request: FastifyRequest,
    @Query() rawQuery: unknown,
  ): Promise<CsvResult> {
    const actor = await this.admit(current, request, 'usage-report-csv', CSV_LIMIT);
    const window = this.report.window(parseWith(WindowQuery, rawQuery));
    const view = await this.report.usageReport(window);
    const lines = [CSV_HEADER];
    for (const account of view.accounts) {
      for (const p of account.providers) {
        lines.push(
          csvRow([account.userId, p.provider, p.calls, p.succeeded, p.failed, p.rejected, p.unconfirmed, p.estimatedCostUsd, p.latencyP50Ms, p.latencyP95Ms]),
        );
      }
    }
    // The export is the audited act: only a produced report is recorded, with who asked, never what was in it.
    await this.audit.record(this.database.db, {
      actorId: actor.userId,
      actorType: 'admin',
      action: 'usage_report.exported',
      objectType: 'usage_report',
      objectId: null,
      outcome: 'allowed',
      requestId: request.id,
    });
    const day = (iso: string): string => iso.slice(0, 10);
    return new CsvResult(`${lines.join('\r\n')}\r\n`, `usage-${day(view.from)}-${day(view.to)}.csv`);
  }
}
