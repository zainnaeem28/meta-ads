import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { PriceMissingError } from '../domain/types.js';
import { USAGE_STARTUP } from './ports.js';
import type { UsageStartupOptions } from './ports.js';
import { UsageService } from './usage.service.js';

/** EX_CONFIG: the same exit code as every configuration fault (ARCHITECTURE §6). */
export const EXIT_CONFIG = 78;

/**
 * The start-up price check (TD-D39). After configuration validation, api and worker look the estimate up once per
 * configured model and provider operation. A missing row effective now exits 78 naming only the provider and operation;
 * a database that cannot be reached, or a failed query, is not a configuration fault and exits 1 so the host restarts.
 */
@Injectable()
export class StartupPriceCheck implements OnApplicationBootstrap {
  constructor(
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(USAGE_STARTUP) private readonly options: UsageStartupOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.usage.assertPriced(this.options.operations);
    } catch (error) {
      if (error instanceof PriceMissingError) {
        this.options.stderr(
          `config error: price_table has no row effective now for ${error.call.provider} ${error.call.operation}`,
        );
        this.options.exit(EXIT_CONFIG);
        return;
      }
      this.options.stderr('startup price check failed: the database could not be read');
      this.options.exit(1);
    }
  }
}
