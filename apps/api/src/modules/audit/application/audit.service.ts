import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../../../platform/shared-kernel/index.js';
import {
  ACTOR_TYPES,
  OUTCOMES,
  assertCounts,
  dedupeKeyOf,
  isAlertKind,
  isAuditAction,
} from '../domain/catalogue.js';
import type { AlertKind } from '../domain/catalogue.js';
import { ALERT_SINK, AUDIT_REPOSITORY } from './ports.js';
import type {
  AcknowledgeOutcome,
  AlertPort,
  AlertQuery,
  AlertRecord,
  AlertSink,
  AuditEventInput,
  AuditRepository,
  Executor,
  PendingAlert,
} from './ports.js';

const MAX_PAGE = 100;

/** Append-only audit trail (REQ-027): time, actor, action, object and outcome; never values, emails or content. */
@Injectable()
export class AuditService {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository) {}

  /** Writes one event in the caller's transaction (or one statement when the caller has none); returns its ID. */
  async record(db: Executor, event: AuditEventInput): Promise<string> {
    if (!isAuditAction(event.action)) throw new TypeError('action is not in the audit catalogue');
    if (!ACTOR_TYPES.includes(event.actorType)) throw new TypeError('unknown actor type');
    if (!OUTCOMES.includes(event.outcome)) throw new TypeError('unknown outcome');
    if (event.actorId === null && (event.actorType === 'user' || event.actorType === 'admin'))
      throw new TypeError('a user or admin event needs an actor ID');
    const id = newId();
    await this.repository.insertEvent(db, id, event);
    return id;
  }
}

/** Administrator alerts (ALR-5, ALR-8): raise (AlertPort), list, acknowledge. */
@Injectable()
export class AlertService implements AlertPort {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository,
    @Inject(ALERT_SINK) private readonly sink: AlertSink,
  ) {}

  /**
   * Writes the alert in the caller's transaction, so it rolls back with it. The log line is not emitted here: the caller
   * invokes `announce()` once its transaction has committed, and a rollback simply never announces.
   */
  async raiseAlert(
    tx: Executor,
    kind: AlertKind,
    subjectUserId: string | null,
    counts: Readonly<Record<string, number>>,
  ): Promise<PendingAlert> {
    if (!isAlertKind(kind)) throw new TypeError('unknown alert kind');
    assertCounts(counts);
    const id = newId();
    const raised = await this.repository.insertAlert(tx, {
      id,
      kind,
      subjectUserId,
      counts: { ...counts },
      dedupeKey: dedupeKeyOf(kind, subjectUserId),
    });
    let announced = false;
    return {
      raised,
      alertId: raised ? id : null,
      announce: () => {
        if (!raised || announced) return;
        announced = true;
        this.sink.emit({ id, kind, subjectUserId });
      },
    };
  }

  async listAlerts(db: Executor, query: AlertQuery): Promise<AlertRecord[]> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE)
      throw new RangeError(`limit is between 1 and ${String(MAX_PAGE)}`);
    return this.repository.listAlerts(db, query);
  }

  /** First acknowledgement wins; a second one reports the first without changing it. */
  async acknowledge(db: Executor, id: string, by: string): Promise<AcknowledgeOutcome> {
    const done = await this.repository.acknowledge(db, id, by);
    if (done !== null) return { status: 'acknowledged', alert: done };
    const existing = await this.repository.findAlert(db, id);
    return existing === null
      ? { status: 'not_found' }
      : { status: 'already_acknowledged', alert: existing };
  }
}
