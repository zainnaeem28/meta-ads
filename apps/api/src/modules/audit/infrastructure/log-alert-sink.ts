import type { Logger } from 'pino';
import type { AlertSink } from '../application/ports.js';

/** The structured `admin_alert` line for the operator alert route (ARCHITECTURE §9.2): kind and subject, never counts. */
export class LogAlertSink implements AlertSink {
  constructor(private readonly logger: Pick<Logger, 'warn'>) {}

  emit(alert: { id: string; kind: string; subjectUserId: string | null }): void {
    this.logger.warn(
      { module: 'audit', code: alert.kind, userId: alert.subjectUserId, jobId: alert.id },
      'admin_alert',
    );
  }
}
