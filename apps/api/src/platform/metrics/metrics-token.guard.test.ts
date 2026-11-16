import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MetricsTokenGuard } from './metrics-token.guard.js';

const TOKEN = 'm'.repeat(43);
const context = (authorization?: string): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }) }) }) as never;

describe('MetricsTokenGuard (TD-D41)', () => {
  const guard = new MetricsTokenGuard(TOKEN);

  it('accepts only the exact bearer token', () => {
    expect(guard.canActivate(context(`Bearer ${TOKEN}`))).toBe(true);
  });

  for (const [name, header] of [
    ['no header', undefined],
    ['empty bearer', 'Bearer '],
    ['wrong token', `Bearer ${'x'.repeat(43)}`],
    ['prefix of the token', `Bearer ${TOKEN.slice(0, 20)}`],
    ['token plus suffix', `Bearer ${TOKEN}x`],
    ['another scheme', `Basic ${TOKEN}`],
    ['no scheme', TOKEN],
    ['a session JWT', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2ln'],
  ] as const) {
    it(`answers not found for ${name}`, () => {
      expect(() => guard.canActivate(context(header))).toThrow(NotFoundException);
    });
  }

  it('answers not found for every request when no token is configured', () => {
    for (const configured of [undefined, '']) {
      const open = new MetricsTokenGuard(configured);
      expect(() => open.canActivate(context('Bearer '))).toThrow(NotFoundException);
      expect(() => open.canActivate(context('Bearer anything'))).toThrow(NotFoundException);
    }
  });
});
