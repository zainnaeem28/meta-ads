import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../db/index.js';
import {
  JobsLifecycle,
  JobsModule,
  JobsNotReadyError,
  assertJobsReady,
  createRuntimeBoss,
  expectedSchemaVersion,
  startRuntimeBoss,
} from './boss.js';
import {
  RetryOnSubmitQueueError,
  UnknownQueueError,
  enqueue,
  onTransaction,
} from './enqueue.js';
import { QUEUES, QUEUE_NAMES, queueNamed, queueOptions } from './queues.js';

// Queues the design names in ARCHITECTURE §2 and §5 (flows, sweeps and ADR-003), verbatim.
const DOC_QUEUES = [
  'brief.generate',
  'brief.analyze-image',
  'media.sanitize',
  'video.copy-output',
  'platform.recovery-sweep',
  'platform.cleanup',
  'media.unattached-sweep',
  'identity.expire-invitations',
  'identity.revoke-sessions',
  'production.provider-copy-cleanup',
];
// Submit queues: a paid provider call is attempted at most once.
const SUBMIT = [
  'brief.generate',
  'brief.analyze-image',
  'production.video-submit',
  'production.thumbstopper-submit',
  'production.qc-run',
];

describe('queue catalogue', () => {
  it.each(DOC_QUEUES)('contains the design queue %s', (name) => {
    expect(QUEUE_NAMES).toContain(name);
  });

  it('has unique names, and every queue has an explicit expiry and a source', () => {
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUES.length);
    for (const queue of QUEUES) {
      expect(queue.expireInSeconds, queue.name).toBeGreaterThanOrEqual(1);
      expect(queue.source, queue.name).not.toBe('');
      expect(queue.policy).toBe('standard');
    }
  });

  it.each(SUBMIT)('%s is a submit queue with retryLimit 0', (name) => {
    expect(queueNamed(name)?.retryLimit).toBe(0);
  });

  it('retried queues back off and the design retry limits hold', () => {
    expect(queueNamed('video.copy-output')).toMatchObject({
      retryLimit: 20,
      retryBackoff: true,
      retryDelayMax: 3600,
    });
    expect(queueNamed('lifecycle.campaign-deletion')?.retryLimit).toBe(10);
    expect(queueNamed('lifecycle.account-erasure')?.retryLimit).toBe(10);
    expect(queueNamed('media.sanitize')?.retryLimit).toBe(3);
    expect(queueNamed('identity.revoke-sessions')?.retryLimit).toBe(5);
  });

  it('hands pg-boss the definition without its own bookkeeping', () => {
    const options = queueOptions(queueNamed('video.copy-output')!);
    expect(options).not.toHaveProperty('name');
    expect(options).not.toHaveProperty('source');
    expect(options).toMatchObject({ retryLimit: 20, expireInSeconds: 900 });
    expect(queueNamed('nope')).toBeUndefined();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('queue DDL (SB-D24 lint)', () => {
  it('jobs-migrate.ts is the only caller of createQueue, updateQueue and deleteQueue', () => {
    const root = join(import.meta.dirname, '..', '..');
    const offenders = sourceFiles(root)
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .filter((path) => /\b(createQueue|updateQueue|deleteQueue)\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path));
    expect(offenders).toEqual(['database/jobs-migrate.ts']);
  });
});

function fakeTx(rows: unknown[] = []) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: vi.fn((query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const { sql, params } = new PgDialect().sqlToQuery(query);
      seen.push({ sql, params });
      return Promise.resolve({ rows });
    }),
  };
  return { tx: tx as unknown as DbTx, seen };
}

describe('enqueue', () => {
  it('runs pg-boss statements on the caller transaction with their parameters', async () => {
    const { tx, seen } = fakeTx([{ id: 'x' }]);
    const result = await onTransaction(tx).executeSql('select $1, $2, $1', ['a', 7]);
    expect(result.rows).toEqual([{ id: 'x' }]);
    expect(seen[0]).toEqual({ sql: 'select $1, $2, $3', params: ['a', 7, 'a'] });
    await onTransaction(tx).executeSql('select 1');
    expect(seen[1]).toEqual({ sql: 'select 1', params: [] });
  });

  it('sends through the transaction handle and returns the job id', async () => {
    const { tx } = fakeTx();
    const send = vi.fn(() => Promise.resolve('job-1'));
    const id = await enqueue({ send } as unknown as PgBoss, tx, 'platform.cleanup', { a: 1 }, {
      singletonKey: 'k',
    });
    expect(id).toBe('job-1');
    const call = send.mock.calls[0] as unknown as [string, object, { db: object; singletonKey: string }];
    expect(call[0]).toBe('platform.cleanup');
    expect(call[2].singletonKey).toBe('k');
    expect(typeof call[2].db).toBe('object');
  });

  it('refuses a queue outside the catalogue and a retry on a submit queue', async () => {
    const { tx } = fakeTx();
    const send = vi.fn();
    const boss = { send } as unknown as PgBoss;
    await expect(enqueue(boss, tx, 'ghost', {})).rejects.toBeInstanceOf(UnknownQueueError);
    await expect(
      enqueue(boss, tx, 'brief.generate', {}, { retryLimit: 2 }),
    ).rejects.toBeInstanceOf(RetryOnSubmitQueueError);
    await enqueue(boss, tx, 'brief.generate', {}, { retryLimit: 0 });
    await enqueue(boss, tx, 'video.copy-output', {}, { retryLimit: 5 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

function fakeBoss(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isInstalled: vi.fn(() => Promise.resolve(true)),
    schemaVersion: vi.fn(() => Promise.resolve(expectedSchemaVersion())),
    getQueues: vi.fn((names: string[]) => Promise.resolve(names.map((name) => ({ name })))),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('start-up check (probe 11)', () => {
  it('reads the schema version this build of pg-boss expects', () => {
    expect(expectedSchemaVersion()).toBeGreaterThan(0);
  });

  it('passes when the schema is current and every queue exists', async () => {
    await expect(assertJobsReady(fakeBoss() as unknown as PgBoss)).resolves.toBeUndefined();
  });

  it('fails when the schema is missing, behind, or a queue is missing', async () => {
    const notInstalled = fakeBoss({ isInstalled: () => Promise.resolve(false) });
    await expect(assertJobsReady(notInstalled as unknown as PgBoss)).rejects.toThrow(
      /not installed/,
    );
    const behind = fakeBoss({ schemaVersion: () => Promise.resolve(expectedSchemaVersion() - 1) });
    await expect(assertJobsReady(behind as unknown as PgBoss)).rejects.toThrow(/needs/);
    const unknown = fakeBoss({ schemaVersion: () => Promise.resolve(null) });
    await expect(assertJobsReady(unknown as unknown as PgBoss)).rejects.toBeInstanceOf(
      JobsNotReadyError,
    );
    const missing = fakeBoss({
      getQueues: () => Promise.resolve(QUEUES.slice(1).map(({ name }) => ({ name }))),
    });
    await expect(assertJobsReady(missing as unknown as PgBoss)).rejects.toThrow(
      new RegExp(`missing: ${QUEUES[0]!.name.replace('.', '\\.')}`),
    );
  });

  it('stops the instance when the start or the check fails', async () => {
    const failing = fakeBoss({ start: () => Promise.reject(new Error('down')) });
    await expect(startRuntimeBoss(failing as unknown as PgBoss)).rejects.toThrow('down');
    expect(failing.stop).toHaveBeenCalledOnce();
    const incomplete = fakeBoss({ getQueues: () => Promise.resolve([]) });
    await expect(startRuntimeBoss(incomplete as unknown as PgBoss)).rejects.toThrow(/missing/);
    expect(incomplete.stop).toHaveBeenCalledOnce();
    const ok = fakeBoss();
    await startRuntimeBoss(ok as unknown as PgBoss);
    expect(ok.stop).not.toHaveBeenCalled();
  });
});

describe('runtime wiring', () => {
  it('builds the instance without connecting, for either role', () => {
    const url = 'postgres://app_api@localhost:1/app';
    expect(createRuntimeBoss({ DATABASE_URL: url, role: 'api' })).toBeDefined();
    expect(createRuntimeBoss({ DATABASE_URL: url, role: 'worker', poolMax: 6 })).toBeDefined();
  });

  it('the lifecycle starts on init and stops gracefully on shutdown', async () => {
    const boss = fakeBoss();
    const lifecycle = new JobsLifecycle(boss as unknown as PgBoss, QUEUES);
    await lifecycle.onModuleInit();
    expect(boss.start).toHaveBeenCalledOnce();
    await lifecycle.onApplicationShutdown();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 10_000 });
  });

  it('the module provides the instance and its lifecycle', () => {
    const module = JobsModule.forRoot({ DATABASE_URL: 'postgres://x@localhost:1/app', role: 'api' });
    expect(module.global).toBe(true);
    expect(module.exports).toHaveLength(1);
    expect(module.providers).toHaveLength(3);
  });
});
