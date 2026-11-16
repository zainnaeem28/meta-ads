import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupConfig } from './config.ts';
import { dumpEncrypted } from './dump.ts';
import { mirrorLedger, mirrorMedia } from './media.ts';
import type { LedgerCounts, MediaCounts } from './media.ts';
import { makeClient, Store } from './store.ts';
import { isoDate, ulid } from './util.ts';
import type { Logger } from './util.ts';
import { waitForMigrationWindow } from './window.ts';

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  /** `ok`, `failed`, or `skipped-migration-window`. */
  status: 'ok' | 'failed' | 'skipped-migration-window';
  dump: { key: string; bytes: number } | null;
  media: MediaCounts | null;
  mediaManifest: string | null;
  ledger: LedgerCounts | null;
  failures: string[];
  heartbeat: 'sent' | 'not-sent' | 'failed' | 'not-configured';
}

export interface RunDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** One backup run. Never throws for a data problem: it reports the failure and withholds the heartbeat. */
export async function runBackup(
  config: BackupConfig,
  log: Logger,
  deps: RunDeps = {},
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const runId = ulid(started);
  const failures: string[] = [];
  const result: RunResult = {
    runId,
    startedAt: started.toISOString(),
    finishedAt: '',
    durationMs: 0,
    ok: false,
    status: 'failed',
    dump: null,
    media: null,
    mediaManifest: null,
    ledger: null,
    failures,
    heartbeat: config.heartbeatUrl === null ? 'not-configured' : 'not-sent',
  };
  const finish = (): RunResult => {
    const end = now();
    result.finishedAt = end.toISOString();
    result.durationMs = end.getTime() - started.getTime();
    return result;
  };

  const window = await waitForMigrationWindow(config.databaseUrl, {
    waitMs: config.migrationWaitMs,
    pollMs: config.migrationPollMs,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onWait: (waited) => log.warn('release_migration_running', { waitedMs: waited }),
  });
  if (!window.clear) {
    failures.push(`a release migration was still running after ${window.waitedMs} ms`);
    result.status = 'skipped-migration-window';
    return finish();
  }

  const sourceClient = makeClient(config.endpoint, config.region, config.source);
  const sinkClient = makeClient(config.endpoint, config.region, config.sink);
  const sink = new Store(sinkClient, config.backupBucket);
  const spoolDir =
    config.spoolDir === '' ? await mkdtemp(join(tmpdir(), 'backup-')) : config.spoolDir;
  const ownSpool = config.spoolDir === '';
  try {
    // 1. The database dump, encrypted to the public recipient.
    try {
      const file = join(spoolDir, `dump-${runId}.dump.age`);
      const dump = await dumpEncrypted(config, file);
      const key = `db/${isoDate(started)}/${runId}.dump.age`;
      const put = await sink.putNew(key, file, dump.bytes);
      if (put !== 'created') throw new Error(`${key} already exists`);
      result.dump = { key, bytes: dump.bytes };
      log.info('dump_written', { key, bytes: dump.bytes });
      await rm(file, { force: true });
    } catch (error) {
      failures.push(`dump: ${(error as Error).message}`);
      log.error('dump_failed', { message: (error as Error).message });
    }

    // 2. Media (u/) with the delayed delete, then the ledger. A failed dump does not stop the copies.
    const common = { sink, concurrency: config.concurrency, spoolDir, log };
    try {
      const media = await mirrorMedia(
        {
          ...common,
          source: new Store(sourceClient, config.appBucket),
          now,
          retentionDays: config.retentionDays,
        },
        runId,
      );
      result.media = media.counts;
      result.mediaManifest = media.manifestKey;
      failures.push(...media.failures);
    } catch (error) {
      failures.push(`media: ${(error as Error).message}`);
      log.error('media_failed', { message: (error as Error).message });
    }
    try {
      const ledger = await mirrorLedger({
        ...common,
        ledger: new Store(sourceClient, config.ledgerBucket),
      });
      result.ledger = ledger.counts;
      failures.push(...ledger.failures);
    } catch (error) {
      failures.push(`ledger: ${(error as Error).message}`);
      log.error('ledger_failed', { message: (error as Error).message });
    }
  } finally {
    if (ownSpool) await rm(spoolDir, { recursive: true, force: true });
  }

  result.ok = failures.length === 0;
  result.status = result.ok ? 'ok' : 'failed';
  if (result.ok && config.heartbeatUrl !== null) {
    result.heartbeat = await ping(config.heartbeatUrl, deps.fetchImpl ?? fetch, log);
  }
  return finish();
}

/** The heartbeat is sent only after a fully successful run; a missed one raises ALR-6 at 26 h. */
async function ping(url: string, fetchImpl: typeof fetch, log: Logger): Promise<'sent' | 'failed'> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      if (response.ok) return 'sent';
      log.warn('heartbeat_rejected', { status: response.status, attempt });
    } catch (error) {
      log.warn('heartbeat_error', { message: (error as Error).message, attempt });
    }
  }
  return 'failed';
}
