import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { ALERT_PORT } from '../../audit/index.js';
import type { AlertPort, PendingAlert } from '../../audit/index.js';
import { USAGE_CLOCK } from './ports.js';
import type { Clock } from './ports.js';

export const USAGE_ABUSE_CONFIG = Symbol('USAGE_ABUSE_CONFIG');

/** Abuse thresholds (OI-CAPS), from `JOB_BURST_ALERT_COUNT`, `PROVIDER_AUTH_SPIKE_COUNT` and the window settings. */
export interface AbuseConfig {
  /** An alert is raised when an account has MORE than this many provider jobs in the window. */
  readonly jobBurstCount: number;
  /** An alert is raised at this many provider 401 or 429 responses for one account in the window. */
  readonly authSpikeCount: number;
  readonly windowMinutes: number;
}

export interface AbuseCheck {
  /** True when this call raised a new `job_burst` alert (an open alert for the account suppresses a second one). */
  readonly jobBurst: boolean;
  /** True when this call raised a new `provider_auth_spike` alert. */
  readonly providerAuthSpike: boolean;
  readonly jobs: number;
  readonly authResponses: number;
}

/**
 * Abuse thresholds (REQ-019 c, ARCHITECTURE §5.9): more than `jobBurstCount` provider jobs of one account within the
 * window, or `authSpikeCount` or more provider 401/429 responses for one account within the window, raise one
 * administrator alert each through `AlertPort`. The alert carries counts only, never content or key material.
 */
@Injectable()
export class AbuseMonitor {
  /** Provider 401/429 timestamps per account, newest last; only the window is kept. */
  private readonly authResponses = new Map<string, number[]>();

  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(USAGE_ABUSE_CONFIG) private readonly config: AbuseConfig,
    @Inject(USAGE_CLOCK) private readonly clock: Clock,
    @Inject(ModuleRef) private readonly modules: ModuleRef,
  ) {}

  /** A provider answered an account's call with 401 or 429 (the worker reports each such response here). */
  noteProviderAuthResponse(ownerId: string, status: 401 | 429): void {
    if (status !== 401 && status !== 429) throw new RangeError('only 401 and 429 count');
    const now = this.clock().getTime();
    const kept = this.prune(ownerId, now);
    kept.push(now);
    this.authResponses.set(ownerId, kept);
  }

  /** Evaluates both thresholds for one account and raises the alerts that apply. Safe to call as often as wanted. */
  async checkAbuseThresholds(ownerId: string): Promise<AbuseCheck> {
    const now = this.clock();
    const since = new Date(now.getTime() - this.config.windowMinutes * 60_000);
    const authResponses = this.prune(ownerId, now.getTime()).length;
    const alerts = this.modules.get<AlertPort>(ALERT_PORT, { strict: false });
    const pending: PendingAlert[] = [];
    let jobs = 0;
    let jobBurst = false;
    let providerAuthSpike = false;
    await this.database.uow.run(async (tx) => {
      const result = await tx.execute<{ jobs: string }>(sql`
        select count(*)::text as jobs from (
          select job_type, job_id from usage_events where owner_id = ${ownerId} and at >= ${since.toISOString()}::timestamptz
          union
          select job_type, job_id from spend_reservations where owner_id = ${ownerId} and created_at >= ${since.toISOString()}::timestamptz
        ) j`);
      jobs = Number(result.rows[0]?.jobs ?? 0);
      if (jobs > this.config.jobBurstCount) {
        const alert = await alerts.raiseAlert(tx, 'job_burst', ownerId, {
          jobs,
          window_min: this.config.windowMinutes,
        });
        pending.push(alert);
        jobBurst = alert.raised;
      }
      if (authResponses >= this.config.authSpikeCount) {
        const alert = await alerts.raiseAlert(tx, 'provider_auth_spike', ownerId, {
          responses: authResponses,
          window_min: this.config.windowMinutes,
        });
        pending.push(alert);
        providerAuthSpike = alert.raised;
      }
    });
    for (const alert of pending) alert.announce();
    return { jobBurst, providerAuthSpike, jobs, authResponses };
  }

  private prune(ownerId: string, nowMs: number): number[] {
    const floor = nowMs - this.config.windowMinutes * 60_000;
    const kept = (this.authResponses.get(ownerId) ?? []).filter((at) => at >= floor);
    if (kept.length === 0) this.authResponses.delete(ownerId);
    else this.authResponses.set(ownerId, kept);
    return kept;
  }
}
