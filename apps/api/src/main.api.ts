import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfigOrExit } from './platform/config/index.js';
import { createHttpLogging, secretValuesOf } from './platform/logging/index.js';
import type { HttpLogging } from './platform/logging/index.js';
import { ErrorFilter, EnvelopeInterceptor, RawResponse } from './platform/http/index.js';
import { Logger } from 'nestjs-pino';

@Controller('health')
class HealthController {
  @Get('live')
  @RawResponse()
  live(): { status: string } {
    return { status: 'ok' };
  }
}

function appModule(logging: HttpLogging): new () => object {
  @Module({ imports: [logging.module()], controllers: [HealthController] })
  class AppModule {}
  return AppModule;
}

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit('api');
  const logging = createHttpLogging({
    level: config.LOG_LEVEL,
    ...(config.RELEASE_SHA === undefined ? {} : { releaseSha: config.RELEASE_SHA }),
    secretValues: secretValuesOf(config),
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    appModule(logging),
    logging.adapter(),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new ErrorFilter(logging.logger));
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.enableShutdownHooks();
  await app.listen(config.API_PORT ?? 4000, '0.0.0.0');
}

void bootstrap();
