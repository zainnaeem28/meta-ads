import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { DomainError } from '../http/domain-error.js';
import { Scope } from '../http/scope-registry.js';
import { HealthService } from './health.service.js';

export interface HealthBody {
  status: 'ok';
}

/** API-900 and API-901: public, root paths, no detail in the answer. */
@Controller('health')
@Scope('Pub')
export class HealthController {
  private readonly logger = new Logger('health');

  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Event loop only: touches no dependency. */
  @Get('live')
  live(): HealthBody {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<HealthBody> {
    const failed = await this.health.failure();
    if (failed !== null) {
      // The failed check is logged for the operator; the public answer carries no detail.
      this.logger.warn(`not ready: ${failed}`);
      throw new DomainError(
        'service_unavailable',
        'The service is temporarily unavailable. Try again shortly.',
      );
    }
    return { status: 'ok' };
  }
}
