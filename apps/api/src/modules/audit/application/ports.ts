import type { DbTx } from '../../../platform/db/index.js';
import type { ActorType, AlertKind, AuditAction, Outcome } from '../domain/catalogue.js';

/** A transaction handle, or the pool-backed database for a single statement (a denied call has no transaction). */
export type Executor = Pick<DbTx, 'select' | 'insert' | 'update'>;

export interface AuditEventInput {
  readonly actorId: string | null;
  readonly actorType: ActorType;
  readonly action: AuditAction;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly outcome: Outcome;
  readonly requestId?: string | null;
}

export interface AlertRecord {
  readonly id: string;
  readonly kind: AlertKind;
  readonly subjectUserId: string | null;
  readonly counts: Readonly<Record<string, number>>;
  /** PostgreSQL timestamptz text with microseconds, e.g. `2026-11-15 23:53:22.123456+00`. */
  readonly raisedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
}

/** Position after the last row of a page, in the queue order of `admin_alerts_queue_idx`. */
export interface AlertPosition {
  readonly acknowledgedAt: string | null;
  readonly raisedAt: string;
  readonly id: string;
}

export interface AlertQuery {
  /** `false` lists open alerts, `true` acknowledged ones, absent both (open first). */
  readonly acknowledged?: boolean;
  readonly limit: number;
  readonly after?: AlertPosition;
}

export type AcknowledgeOutcome =
  | { readonly status: 'acknowledged'; readonly alert: AlertRecord }
  | { readonly status: 'already_acknowledged'; readonly alert: AlertRecord }
  | { readonly status: 'not_found' };

/** Module-private persistence; other modules never see it. */
export interface AuditRepository {
  insertEvent(db: Executor, id: string, event: AuditEventInput): Promise<void>;
  insertAlert(
    db: Executor,
    alert: {
      id: string;
      kind: AlertKind;
      subjectUserId: string | null;
      counts: Record<string, number>;
      dedupeKey: string;
    },
  ): Promise<boolean>;
  listAlerts(db: Executor, query: AlertQuery): Promise<AlertRecord[]>;
  acknowledge(db: Executor, id: string, by: string): Promise<AlertRecord | null>;
  findAlert(db: Executor, id: string): Promise<AlertRecord | null>;
}

/** What the alert service reports each raised alert to once it has committed (the `admin_alert` log line). */
export interface AlertSink {
  emit(alert: { id: string; kind: AlertKind; subjectUserId: string | null }): void;
}

/** An alert written in the caller's transaction; `announce` is called by the caller after that transaction commits. */
export interface PendingAlert {
  /** False when an open alert for the same kind and subject already existed: nothing is written or announced. */
  readonly raised: boolean;
  readonly alertId: string | null;
  announce(): void;
}

/** ARCHITECTURE §1.3: the port other modules use to raise an administrator alert. */
export interface AlertPort {
  raiseAlert(
    tx: Executor,
    kind: AlertKind,
    subjectUserId: string | null,
    counts: Readonly<Record<string, number>>,
  ): Promise<PendingAlert>;
}

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
export const ALERT_SINK = Symbol('ALERT_SINK');
export const ALERT_PORT = Symbol('ALERT_PORT');
