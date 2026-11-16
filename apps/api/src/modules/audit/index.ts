export { AuditModule } from './audit.module.js';
export { AuditService, AlertService } from './application/audit.service.js';
export { ALERT_PORT } from './application/ports.js';
export type {
  AcknowledgeOutcome,
  AlertPort,
  AlertPosition,
  AlertQuery,
  AlertRecord,
  AuditEventInput,
  Executor,
  PendingAlert,
} from './application/ports.js';
export { ACTOR_TYPES, ALERT_KINDS, AUDIT_ACTIONS, OUTCOMES } from './domain/catalogue.js';
export type { ActorType, AlertKind, AuditAction, Outcome } from './domain/catalogue.js';
