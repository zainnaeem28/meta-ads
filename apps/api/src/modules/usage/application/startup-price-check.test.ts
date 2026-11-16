import { describe, expect, it, vi } from 'vitest';
import { toUnits } from '../domain/money.js';
import type { BillableCall } from '../domain/types.js';
import { FakeUsageRepository, fakeDatabase } from './fakes.js';
import { EXIT_CONFIG, StartupPriceCheck } from './startup-price-check.js';
import { UsageService } from './usage.service.js';

const OK: BillableCall = { provider: 'openai', operation: 'text' };
const MISSING: BillableCall = { provider: 'wavespeed', operation: 'bytedance/seedance-2.0/image-to-video' };

function setup(operations: BillableCall[], fail?: Error) {
  const repository = new FakeUsageRepository();
  repository.setPrice(OK, toUnits('0.01'));
  if (fail !== undefined) vi.spyOn(repository, 'estimateUnits').mockRejectedValue(fail);
  const service = new UsageService(
    fakeDatabase().database,
    repository,
    { dailyCapUnits: 1, monthlyCapUnits: 1 },
    () => new Date(),
  );
  const exit = vi.fn();
  const stderr = vi.fn();
  return { check: new StartupPriceCheck(service, { operations, exit, stderr }), exit, stderr };
}

describe('start-up price check (TD-D39)', () => {
  it('passes quietly when every operation has a row', async () => {
    const { check, exit, stderr } = setup([OK]);
    await check.onApplicationBootstrap();
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('exits 78 naming only the provider and the operation', async () => {
    const { check, exit, stderr } = setup([OK, MISSING]);
    await check.onApplicationBootstrap();
    expect(exit).toHaveBeenCalledExactlyOnceWith(EXIT_CONFIG);
    expect(EXIT_CONFIG).toBe(78);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      'config error: price_table has no row effective now for wavespeed bytedance/seedance-2.0/image-to-video',
    );
  });

  it('exits 1, without detail, when the database cannot be read', async () => {
    const { check, exit, stderr } = setup([OK], new Error('connect ECONNREFUSED postgres://user:secret@host/db'));
    await check.onApplicationBootstrap();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('secret');
  });
});
