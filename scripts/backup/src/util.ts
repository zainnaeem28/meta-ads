import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (48-bit time, 80 random bits) for dump object names and run ids. */
export function ulid(at: Date): string {
  let time = at.getTime();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  let tail = '';
  for (const byte of randomBytes(16)) tail += CROCKFORD[byte % 32];
  return head + tail.slice(0, 16);
}

export const isoDate = (at: Date): string => at.toISOString().slice(0, 10);

/** Run `work` over `items` with at most `limit` in flight. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** JSON lines on stdout. Callers pass names, counts and keys; never a credential or a database URL. */
export function jsonLogger(
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const emit =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      write(JSON.stringify({ level, event, at: new Date().toISOString(), ...fields }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
