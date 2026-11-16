import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { Scope } from '../http/scope-registry.js';
import { RawResponse } from '../http/response.js';
import { AppMetrics } from './app-metrics.js';
import { MetricsTokenGuard } from './metrics-token.guard.js';
import type { MetricsWindow } from './window-store.js';

/** API-902 and API-903: scope M, served at the root, outside `/api/v1`. */
@Controller('internal/metrics')
@Scope('M')
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  constructor(@Inject(AppMetrics) private readonly metrics: AppMetrics) {}

  @Get()
  @RawResponse()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  exposition(): Promise<string> {
    return this.metrics.exposition();
  }

  @Get('window')
  window(): MetricsWindow {
    return this.metrics.window.snapshot();
  }
}
