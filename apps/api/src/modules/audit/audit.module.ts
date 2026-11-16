import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Logger } from 'pino';
import { AlertService, AuditService } from './application/audit.service.js';
import { ALERT_PORT, ALERT_SINK, AUDIT_REPOSITORY } from './application/ports.js';
import { DrizzleAuditRepository } from './infrastructure/audit.repository.js';
import { LogAlertSink } from './infrastructure/log-alert-sink.js';

@Module({})
export class AuditModule {
  /** `logger` is the process's pino instance (the one the allow-list and redaction are configured on). */
  static register(logger: Pick<Logger, 'warn'>): DynamicModule {
    return {
      module: AuditModule,
      providers: [
        AuditService,
        AlertService,
        { provide: AUDIT_REPOSITORY, useClass: DrizzleAuditRepository },
        { provide: ALERT_SINK, useValue: new LogAlertSink(logger) },
        { provide: ALERT_PORT, useExisting: AlertService },
      ],
      exports: [AuditService, AlertService, ALERT_PORT],
    };
  }
}
