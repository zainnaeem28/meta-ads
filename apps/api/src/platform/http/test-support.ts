import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Module, Post, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';
import { DomainError, ERROR_STATUS } from './domain-error.js';
import type { ErrorCodeValue } from './domain-error.js';
import { ErrorFilter } from './error.filter.js';
import { CsvResult, EnvelopeInterceptor, PageResult, RawResponse } from './response.js';
import { ZodValidationPipe } from './validation.pipe.js';

export const LOG_MESSAGE_MAX = 300;

export interface CapturedLog {
  fields: Record<string, unknown>;
  message: string;
}

export const bodySchema = z.strictObject({
  title: z.string().min(1).max(10),
  segment_count: z.number().int().min(1).max(5),
  contact: z.email().optional(),
  items: z
    .array(z.strictObject({ dialogue: z.string().max(5) }))
    .max(60)
    .optional(),
});

@Controller('t')
export class TestController {
  @Get('ok')
  ok(): { hello: string } {
    return { hello: 'world' };
  }

  @Get('nothing')
  nothing(): undefined {
    return undefined;
  }

  @Get('raw')
  @RawResponse()
  raw(): { status: string } {
    return { status: 'up' };
  }

  @Get('list')
  list(): PageResult<{ n: number }> {
    return new PageResult([{ n: 1 }], {
      type: 'cursor',
      limit: 1,
      returnedCount: 1,
      hasNextPage: false,
      nextCursor: null,
    });
  }

  @Get('csv')
  csv(): CsvResult {
    return new CsvResult('a,b\n1,2\n', 'report.csv');
  }

  @Post('gone')
  @HttpCode(204)
  gone(): void {}

  @Post('body')
  body(@Body(new ZodValidationPipe(bodySchema)) body: z.output<typeof bodySchema>): unknown {
    return body;
  }

  @Get('query')
  query(
    @Query(new ZodValidationPipe(z.object({ limit: z.coerce.number().int().max(50) }))) q: unknown,
  ): unknown {
    return q;
  }

  @Get('code')
  code(@Query('c') c: string): never {
    throw new DomainError(c as ErrorCodeValue, 'Safe message.', [
      { field: 'x', code: 'invalid', message: 'detail' },
    ]);
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail: connection to 10.0.0.5 failed');
  }

  @Get('sqlstate')
  sqlstate(@Query('s') s: string): never {
    throw Object.assign(new Error('canceling statement'), { code: s });
  }

  @Get('wrapped')
  wrapped(): never {
    throw new Error('Failed query', { cause: Object.assign(new Error('lock'), { code: '55P03' }) });
  }
}

export const ALL_CODES = Object.keys(ERROR_STATUS) as ErrorCodeValue[];

export async function createTestApp(
  extraControllers: (new () => object)[] = [],
): Promise<{ app: NestFastifyApplication; logs: CapturedLog[] }> {
  const logs: CapturedLog[] = [];
  @Module({ controllers: [TestController, ...extraControllers] })
  class TestModule {}
  const app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(
    new ErrorFilter({ error: (fields, message) => logs.push({ fields, message }) }),
  );
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, logs };
}
