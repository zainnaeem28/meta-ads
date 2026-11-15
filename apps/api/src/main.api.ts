import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfigOrExit } from './platform/config/index.js';

@Controller('health')
class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
class AppModule {}

async function bootstrap(): Promise<void> {
  const config = loadConfigOrExit('api');
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableShutdownHooks();
  await app.listen(config.API_PORT ?? 4000, '0.0.0.0');
}

void bootstrap();
