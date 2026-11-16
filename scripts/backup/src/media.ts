import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { isLocked } from './store.ts';
import type { Store } from './store.ts';
import { isoDate, pool, ulid } from './util.ts';
import type { Logger } from './util.ts';

export interface ManifestEntry {
  key: string;
  etag: string;
  size: number;
  sha256: string;
  ownerId: string;
  copiedAt: string;
  /** Date (ISO instant) the next run saw the source key gone. */
  deletedAt?: string;
  /** The `media-deleted/` key holding the confirmed copy (HEAD: same size and etag). */
  movedTo?: string;
  /** Set once the old `media/` copy is gone. The age lock refuses that delete until the copy is older than the retention. */
  oldCopyRemoved?: boolean;
  /** Date of a failed delayed delete: a retry on a later day uses a new `media-deleted/` date, so a damaged copy under lock cannot block it. */
  copyFailedOn?: string;
  /** The source key now holds other bytes (new etag). The old content stays in `media/`; nothing is overwritten. */
  supersededAt?: string;
}

export interface Manifest {
  version: 1;
  date: string;
  runId: string;
  generatedAt: string;
  entries: ManifestEntry[];
}

export const MEDIA_PREFIX = 'u/';
export const mediaKey = (key: string, etag: string): string => `media/${key}/${etag}`;
export const deletedKey = (date: string, key: string, etag: string): string =>
  `media-deleted/${date}/${key}/${etag}`;
const entryId = (key: string, etag: string): string => `${key}\u0000${etag}`;

/** `u/{ownerId}/...` (ARCHITECTURE 2.7): the owner id is the second path segment. */
export function ownerOf(key: string): string {
  return key.split('/')[1] ?? '';
}

export interface MediaCounts {
  listed: number;
  copied: number;
  alreadyPresent: number;
  vanished: number;
  superseded: number;
  deletedDetected: number;
  movedToDeleted: number;
  oldCopiesRemoved: number;
  /** Confirmed copies whose old media/ copy the bucket lock still protects; retried by later runs, not a failure. */
  removalDeferred: number;
  moveFailed: number;
  copyFailed: number;
  bytesCopied: number;
}

export interface MirrorContext {
  source: Store;
  sink: Store;
  now: () => Date;
  retentionDays: number;
  concurrency: number;
  spoolDir: string;
  log: Logger;
}

export interface MirrorResult {
  counts: MediaCounts;
  failures: string[];
  manifestKey: string;
}

/** The newest manifest by upload time, or an empty one on a first run. */
export async function loadPreviousManifest(sink: Store): Promise<Manifest | null> {
  let newest: { key: string; at: number } | null = null;
  for await (const item of sink.list('manifests/')) {
    const at = item.lastModified?.getTime() ?? 0;
    if (newest === null || at > newest.at || (at === newest.at && item.key > newest.key)) {
      newest = { key: item.key, at };
    }
  }
  if (newest === null) return null;
  const text = await sink.getText(newest.key);
  if (text === null) return null;
  const parsed = JSON.parse(text) as Manifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries))
    throw new Error(`unreadable manifest ${newest.key}`);
  return parsed;
}

/**
 * Copies `source` into a spool file while hashing it. Returns the digests and the size read. The caller verifies them
 * before anything is uploaded, so a damaged read never becomes a content-addressed object.
 */
async function spool(
  body: NodeJS.ReadableStream,
  file: string,
): Promise<{ md5: string; sha256: string; size: number }> {
  const md5 = createHash('md5');
  const sha = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      md5.update(chunk);
      sha.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(body, tap, createWriteStream(file, { mode: 0o600 }));
  return { md5: md5.digest('hex'), sha256: sha.digest('hex'), size };
}

type CopyOutcome = 'copied' | 'present' | 'vanished';

/**
 * Byte copy of one source object to `target` in the sink: no decode, no transcode. Verified by size, and by MD5 when the
 * source ETag is a plain MD5 (single-part uploads), before the conditional put.
 */
export async function copyObject(
  ctx: Pick<MirrorContext, 'source' | 'sink' | 'spoolDir'>,
  sourceKey: string,
  targetKeyFor: (etag: string) => string,
  record?: (info: { etag: string; size: number; sha256: string }) => void,
): Promise<{ outcome: CopyOutcome; bytes: number }> {
  const got = await ctx.source.get(sourceKey);
  if (got === null) return { outcome: 'vanished', bytes: 0 };
  const target = targetKeyFor(got.etag);
  const existing = await ctx.sink.head(target);
  if (existing !== null) {
    got.body.destroy();
    return { outcome: 'present', bytes: 0 };
  }
  const file = join(ctx.spoolDir, `spool-${ulid(new Date())}`);
  try {
    const digest = await spool(got.body, file);
    const onDisk = (await stat(file)).size;
    if (onDisk !== got.size || digest.size !== got.size) {
      throw new Error(
        `short read of ${sourceKey}: expected ${got.size} bytes, read ${digest.size}`,
      );
    }
    if (!got.etag.includes('-') && /^[0-9a-f]{32}$/.test(got.etag) && digest.md5 !== got.etag) {
      throw new Error(`checksum mismatch reading ${sourceKey}`);
    }
    const put = await ctx.sink.putNew(target, file, got.size);
    record?.({ etag: got.etag, size: got.size, sha256: digest.sha256 });
    return {
      outcome: put === 'created' ? 'copied' : 'present',
      bytes: put === 'created' ? got.size : 0,
    };
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * The delayed delete (SB v6 7.1 C), first half: server-side copy of `media/<key>/<etag>` to `media-deleted/<date>/...`
 * and a HEAD that confirms the same size and etag. Returns the new key, or throws; the old copy is not touched.
 */
export async function copyToDeleted(
  sink: Store,
  entry: ManifestEntry,
  today: string,
): Promise<string> {
  const from = mediaKey(entry.key, entry.etag);
  const date =
    entry.copyFailedOn !== undefined && entry.copyFailedOn !== today
      ? today
      : (entry.deletedAt ?? '').slice(0, 10);
  const to = deletedKey(date, entry.key, entry.etag);
  const original = await sink.head(from);
  if (original === null) throw new Error(`media copy ${from} is missing; nothing to copy to ${to}`);
  const already = await sink.head(to);
  if (already === null || already.size !== original.size || already.etag !== original.etag) {
    await sink.copyWithin(from, to);
  }
  const confirmed = await sink.head(to);
  if (confirmed === null)
    throw new Error(`HEAD of ${to} found nothing after the copy; ${from} kept`);
  if (confirmed.size !== original.size || confirmed.etag !== original.etag) {
    throw new Error(
      `HEAD of ${to} differs from ${from} (size ${confirmed.size} vs ${original.size}, etag ${confirmed.etag} vs ${original.etag}); ${from} kept`,
    );
  }
  return to;
}

/**
 * Second half, the service's only delete: remove the old `media/` copy once the `media-deleted/` copy is confirmed (and
 * confirmed again here). `locked` means the bucket's age lock still protects the old copy; it ages out and a later run
 * removes it. The deleted data is safe in both places meanwhile.
 */
export async function removeOldCopy(
  sink: Store,
  entry: ManifestEntry,
): Promise<'removed' | 'locked'> {
  const from = mediaKey(entry.key, entry.etag);
  const original = await sink.head(from);
  if (original === null) return 'removed';
  const to = entry.movedTo ?? '';
  const confirmed = to === '' ? null : await sink.head(to);
  if (confirmed === null || confirmed.size !== original.size || confirmed.etag !== original.etag) {
    throw new Error(`HEAD of ${to} no longer matches ${from}; ${from} kept`);
  }
  try {
    await sink.deleteMediaCopy(from);
    return 'removed';
  } catch (error) {
    if (isLocked(error)) return 'locked';
    throw error;
  }
}

export async function mirrorMedia(ctx: MirrorContext, runId: string): Promise<MirrorResult> {
  const now = ctx.now();
  const today = isoDate(now);
  const counts: MediaCounts = {
    listed: 0,
    copied: 0,
    alreadyPresent: 0,
    vanished: 0,
    superseded: 0,
    deletedDetected: 0,
    movedToDeleted: 0,
    oldCopiesRemoved: 0,
    removalDeferred: 0,
    moveFailed: 0,
    copyFailed: 0,
    bytesCopied: 0,
  };
  const failures: string[] = [];
  const previous = await loadPreviousManifest(ctx.sink);
  const entries = new Map<string, ManifestEntry>();
  for (const e of previous?.entries ?? []) entries.set(entryId(e.key, e.etag), e);

  const sourceKeys = new Map<string, { etag: string; size: number }>();
  for await (const item of ctx.source.list(MEDIA_PREFIX)) sourceKeys.set(item.key, item);
  counts.listed = sourceKeys.size;

  // Copy new and changed objects. The key in the sink carries the etag, so changed content is a new key.
  await pool([...sourceKeys.keys()], ctx.concurrency, async (key) => {
    try {
      const result = await copyObject(
        ctx,
        key,
        (etag) => mediaKey(key, etag),
        (info) => {
          const id = entryId(key, info.etag);
          const old = entries.get(id);
          entries.set(id, {
            key,
            etag: info.etag,
            size: info.size,
            sha256: info.sha256,
            ownerId: ownerOf(key),
            copiedAt: old?.copiedAt ?? now.toISOString(),
          });
        },
      );
      if (result.outcome === 'copied') {
        counts.copied++;
        counts.bytesCopied += result.bytes;
      } else if (result.outcome === 'present') {
        counts.alreadyPresent++;
        // The sink already holds this content; make sure the manifest knows it (first run after a lost manifest).
        const head = sourceKeys.get(key);
        if (head !== undefined && !entries.has(entryId(key, head.etag))) {
          entries.set(entryId(key, head.etag), {
            key,
            etag: head.etag,
            size: head.size,
            sha256: '',
            ownerId: ownerOf(key),
            copiedAt: now.toISOString(),
          });
        }
      } else {
        counts.vanished++;
      }
    } catch (error) {
      counts.copyFailed++;
      failures.push(`copy ${key}: ${(error as Error).message}`);
      ctx.log.error('media_copy_failed', { key, message: (error as Error).message });
    }
  });

  // A key that is back (or still there) with the manifest's etag is live again; with another etag, the old one is superseded.
  const currentEtag = new Map([...sourceKeys].map(([k, v]) => [k, v.etag] as const));
  for (const entry of entries.values()) {
    const live = currentEtag.get(entry.key);
    if (live === undefined) continue;
    if (live === entry.etag) {
      delete entry.deletedAt;
    } else if (entry.supersededAt === undefined && entry.deletedAt === undefined) {
      entry.supersededAt = now.toISOString();
      counts.superseded++;
    }
  }

  // Deleted sources: mark on detection, then run the delayed delete for every entry still waiting for it.
  const waiting: ManifestEntry[] = [];
  for (const entry of entries.values()) {
    if (currentEtag.has(entry.key) || entry.movedTo !== undefined) continue;
    if (entry.supersededAt !== undefined) continue;
    if (entry.deletedAt === undefined) {
      entry.deletedAt = now.toISOString();
      counts.deletedDetected++;
    }
    waiting.push(entry);
  }
  const pending = [...entries.values()].filter(
    (e) => e.movedTo !== undefined && e.oldCopyRemoved !== true,
  );
  await pool(
    [...waiting, ...pending.filter((e) => !waiting.includes(e))],
    ctx.concurrency,
    async (entry) => {
      try {
        if (entry.movedTo === undefined) {
          entry.movedTo = await copyToDeleted(ctx.sink, entry, today);
          delete entry.copyFailedOn;
          counts.movedToDeleted++;
        }
        if ((await removeOldCopy(ctx.sink, entry)) === 'removed') {
          entry.oldCopyRemoved = true;
          counts.oldCopiesRemoved++;
        } else {
          counts.removalDeferred++;
        }
      } catch (error) {
        counts.moveFailed++;
        if (entry.movedTo === undefined) entry.copyFailedOn = today;
        failures.push(`move ${entry.key}: ${(error as Error).message}`);
        ctx.log.error('media_move_failed', { key: entry.key, message: (error as Error).message });
      }
    },
  );

  // Tombstones only need to outlive the retention window.
  const horizon = now.getTime() - (ctx.retentionDays + 2) * 86_400_000;
  const kept = [...entries.values()].filter(
    (e) =>
      e.oldCopyRemoved !== true || e.deletedAt === undefined || Date.parse(e.deletedAt) > horizon,
  );
  kept.sort((a, b) => (a.key + a.etag).localeCompare(b.key + b.etag));
  const manifest: Manifest = {
    version: 1,
    date: today,
    runId,
    generatedAt: now.toISOString(),
    entries: kept,
  };
  const body = Buffer.from(JSON.stringify(manifest), 'utf8');
  let manifestKey = `manifests/${today}.json`;
  if ((await ctx.sink.putNewBuffer(manifestKey, body, 'application/json')) === 'exists') {
    manifestKey = `manifests/${today}-${runId}.json`;
    await ctx.sink.putNewBuffer(manifestKey, body, 'application/json');
  }
  return { counts, failures, manifestKey };
}

export interface LedgerCounts {
  listed: number;
  copied: number;
  alreadyPresent: number;
  vanished: number;
  copyFailed: number;
}

/** Mirror of the erasure ledger to `ledger/<source key>`: write-once, no delayed delete, never a delete. */
export async function mirrorLedger(
  ctx: Pick<MirrorContext, 'sink' | 'concurrency' | 'spoolDir' | 'log'> & { ledger: Store },
): Promise<{ counts: LedgerCounts; failures: string[] }> {
  const counts: LedgerCounts = {
    listed: 0,
    copied: 0,
    alreadyPresent: 0,
    vanished: 0,
    copyFailed: 0,
  };
  const failures: string[] = [];
  const keys: string[] = [];
  for await (const item of ctx.ledger.list('')) keys.push(item.key);
  counts.listed = keys.length;
  await pool(keys, ctx.concurrency, async (key) => {
    try {
      const r = await copyObject(
        { source: ctx.ledger, sink: ctx.sink, spoolDir: ctx.spoolDir },
        key,
        () => `ledger/${key}`,
      );
      if (r.outcome === 'copied') counts.copied++;
      else if (r.outcome === 'present') counts.alreadyPresent++;
      else counts.vanished++;
    } catch (error) {
      counts.copyFailed++;
      failures.push(`ledger ${key}: ${(error as Error).message}`);
      ctx.log.error('ledger_copy_failed', { key, message: (error as Error).message });
    }
  });
  return { counts, failures };
}
