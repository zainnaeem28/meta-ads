import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HEALTH_OPTIONS, HealthService } from './health.service.js';
import type { HealthOptions } from './health.service.js';

@Module({})
export class HealthModule {
  static register(options: HealthOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_OPTIONS, useValue: options }, HealthService],
    };
  }
}
