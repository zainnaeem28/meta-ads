import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from './test-support.js';
import { fieldPath, issueDetails, parseWith } from './validation.pipe.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Detail = { field: string; code: string; message: string };

let app: NestFastifyApplication;
beforeAll(async () => {
  ({ app } = await createTestApp());
});
afterAll(async () => {
  await app.close();
});

const post = (payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/t/body',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
const json = (res: { body: string }) => JSON.parse(res.body) as Json;

describe('Zod validation pipe', () => {
  it('passes a valid body through', async () => {
    const res = await post({ title: 'ok', segment_count: 2 });
    expect(res.statusCode).toBe(201);
    expect(json(res)['data']).toEqual({ title: 'ok', segment_count: 2 });
  });

  it('answers 400 validation_failed with details: required, too_long, out_of_range, invalid_format', async () => {
    const res = await post({
      title: 'x'.repeat(11),
      segment_count: 9,
      contact: 'not-mail',
      items: [{ dialogue: 'toolong' }],
    });
    const body = json(res);
    expect(res.statusCode).toBe(400);
    expect(body['success']).toBe(false);
    expect(body['error']['code']).toBe('validation_failed');
    const byField = Object.fromEntries(
      body['error']['details'].map((d: Detail) => [d.field, d.code]),
    );
    expect(byField).toEqual({
      title: 'too_long',
      segmentCount: 'out_of_range',
      contact: 'invalid_format',
      'items.0.dialogue': 'too_long',
    });
    for (const d of body['error']['details']) expect(d.message.length).toBeLessThanOrEqual(300);
  });

  it('reports a missing field as required and an unknown key as unknown_field', async () => {
    const res = await post({ segment_count: 1, extra_key: 1 });
    const details = json(res)['error']['details'] as { field: string; code: string }[];
    expect(details).toContainEqual(expect.objectContaining({ field: 'title', code: 'required' }));
    expect(details).toContainEqual(
      expect.objectContaining({ field: 'extraKey', code: 'unknown_field' }),
    );
  });

  it('never echoes the rejected value', async () => {
    const res = await post({ title: 'x'.repeat(11), segment_count: 'SECRET-VALUE-123' });
    expect(res.body).not.toContain('SECRET-VALUE-123');
    expect(json(res)['error']['details']).toContainEqual(
      expect.objectContaining({ field: 'segmentCount', code: 'invalid_type' }),
    );
  });

  it('caps details at 50', async () => {
    const res = await post({
      title: 'ok',
      segment_count: 1,
      items: Array.from({ length: 60 }, () => ({ dialogue: 'too long' })),
    });
    expect(json(res)['error']['details']).toHaveLength(50);
  });

  it('validates query values too', async () => {
    const bad = await app.inject({ method: 'GET', url: '/t/query?limit=99' });
    expect(bad.statusCode).toBe(400);
    expect(json(bad)['error']['details'][0]).toMatchObject({
      field: 'limit',
      code: 'out_of_range',
    });
    expect(json(await app.inject({ method: 'GET', url: '/t/query?limit=5' }))['data']).toEqual({
      limit: 5,
    });
  });

  it('maps the remaining issue kinds', () => {
    const schema = z.object({
      kind: z.enum(['a', 'b']),
      list: z.array(z.string()).min(2),
      n: z.number().min(5),
      s: z.string().min(3),
      refined: z.string().refine(() => false),
    });
    const details = issueDetails(
      schema.safeParse({ kind: 'z', list: [], n: 1, s: 'x', refined: 'y' }).error?.issues ?? [],
    );
    expect(Object.fromEntries(details.map((d) => [d.field, d.code]))).toEqual({
      kind: 'invalid_value',
      list: 'too_short',
      n: 'out_of_range',
      s: 'too_short',
      refined: 'invalid',
    });
    const big = issueDetails(
      z.object({ list: z.array(z.string()).max(1) }).safeParse({ list: ['a', 'b'] }).error
        ?.issues ?? [],
    );
    expect(big[0]).toMatchObject({ code: 'too_long', message: 'Must be at most 1 items.' });
  });

  it('builds camelCase paths with numeric indexes', () => {
    expect(fieldPath(['segment_count', 0, 'first-name', Symbol('s')])).toBe(
      'segmentCount.0.firstName.Symbol(s)',
    );
    expect(parseWith(z.object({ a: z.string() }), { a: 'x' })).toEqual({ a: 'x' });
  });
});
