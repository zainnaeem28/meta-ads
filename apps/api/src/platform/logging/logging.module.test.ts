import 'reflect-metadata';
import { Controller, Get, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpLogging, requestIdOf } from './logging.module.js';
import { secretValuesOf } from './secrets.js';
import { validEnv } from '../config/test-env.js';
import { validateConfig } from '../config/schema.js';
import {
  CANARY_KEY,
  CANARY_SECRET,
  CANARY_TOKEN,
  capture,
  expectNoCanary,
} from './test-support.js';
import type { FastifyRequest } from 'fastify';

@Controller()
class ProbeController {
  @Get('echo')
  echo(@Req() req: FastifyRequest): { requestId: string } {
    return { requestId: requestIdOf(req.raw) };
  }

  @Post('boom')
  boom(): never {
    throw new Error(`exploded with ${CANARY_KEY} for ${CANARY_SECRET}`);
  }
}

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(trust = true) {
  const sink = capture();
  const logging = createHttpLogging({
    releaseSha: 'abcdef1234567',
    secretValues: [CANARY_SECRET],
    destination: sink.stream,
    trustUpstreamRequestId: trust,
  });
  @Module({
    imports: [logging.module()],
    controllers: [ProbeController],
  })
  class TestModule {}
  app = await NestFactory.create<NestFastifyApplication>(TestModule, logging.adapter(), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  await app.init();
  return sink;
}

describe('LoggingModule over Fastify', () => {
  it('echoes a trusted upstream request ID in the header and to the handler', async () => {
    const sink = await start();
    const res = await app!.inject({
      method: 'GET',
      url: '/echo',
      headers: { 'x-request-id': 'upstream-12345' },
    });
    expect(res.headers['x-request-id']).toBe('upstream-12345');
    expect(res.json()).toEqual({ requestId: 'upstream-12345' });
    const line = sink.lines().find((l) => l['msg'] === 'request completed');
    expect(line).toMatchObject({
      requestId: 'upstream-12345',
      method: 'GET',
      status: 200,
      releaseSha: 'abcdef1234567',
    });
    expect(Object.keys(line ?? {}).sort()).toEqual([
      'durationMs',
      'level',
      'method',
      'msg',
      'releaseSha',
      'requestId',
      'route',
      'status',
      'time',
    ]);
    expect(line?.['route']).toBe('/echo');
  });

  it('generates a UUIDv7 for a missing or malformed ID and never trusts it when told not to', async () => {
    await start(false);
    const res = await app!.inject({
      method: 'GET',
      url: '/echo',
      headers: { 'x-request-id': 'upstream-12345' },
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(res.headers['x-request-id']).not.toBe('upstream-12345');
  });

  it('keeps credentials, the 500 error text and the canary out of every line', async () => {
    const sink = await start();
    const headers = {
      authorization: `Bearer ${CANARY_TOKEN}`,
      cookie: `session=${CANARY_TOKEN}; theme=dark-mode-1`,
    };
    const ok = await app!.inject({ method: 'GET', url: `/echo?token=${CANARY_TOKEN}`, headers });
    const failed = await app!.inject({
      method: 'POST',
      url: '/boom',
      headers,
      payload: { apiKey: CANARY_KEY },
    });
    const missing = await app!.inject({ method: 'GET', url: `/no/${CANARY_TOKEN}`, headers });
    expect([ok.statusCode, failed.statusCode, missing.statusCode]).toEqual([200, 500, 404]);
    expect(expectNoCanary(sink.text())).toEqual([]);
    expect(sink.lines().length).toBeGreaterThanOrEqual(3);
  });
});

describe('secretValuesOf', () => {
  it('collects the secret-class values of a validated configuration, and no public ones', () => {
    const result = validateConfig('api', validEnv('api'));
    if (!result.ok) throw new Error('fixture invalid');
    const values = secretValuesOf(result.config);
    expect(values).toContain('sk_test_fixture');
    expect(values).not.toContain('http://localhost:3000');
    expect(secretValuesOf({ ...result.config, CURSOR_SIGNING_KEY: undefined })).not.toContain(
      'c'.repeat(40),
    );
    const objectSecret = { ...result.config, KEY_FINGERPRINT_PEPPERS: { '1': 'x' } } as never;
    expect(secretValuesOf(objectSecret)).toContain('{"1":"x"}');
  });
});
