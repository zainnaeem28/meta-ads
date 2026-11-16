import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The missing-data signal in the local stack. In production the uptime vendor receives the heartbeat pings and fires
// the dead-man alert; locally this receiver plays the vendor's part with the same definitions (infra/monitoring/uptime.json),
// so a stopped heartbeat can be shown to fire its rule (ALR-4, ALR-6, ALR-9 dead-man form).

export interface HeartbeatDefinition {
  id: string;
  alert: string;
  expectEveryMinutes: number;
  graceMinutes: number;
}

export function loadHeartbeats(
  path: string = join(import.meta.dirname, '..', '..', '..', 'infra', 'monitoring', 'uptime.json'),
): HeartbeatDefinition[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { heartbeats: HeartbeatDefinition[] })
    .heartbeats;
}

export interface DeadManResult {
  id: string;
  alert: string;
  state: 'ok' | 'fired';
  silentMinutes: number | null;
}

/** A heartbeat fires when it was never seen or its last ping is older than the expected interval plus the grace. */
export function evaluateDeadMan(
  definitions: readonly HeartbeatDefinition[],
  lastPing: ReadonlyMap<string, number>,
  now: number,
): DeadManResult[] {
  return definitions.map((def) => {
    const last = lastPing.get(def.id);
    if (last === undefined)
      return { id: def.id, alert: def.alert, state: 'fired', silentMinutes: null };
    const silentMinutes = (now - last) / 60_000;
    return {
      id: def.id,
      alert: def.alert,
      state: silentMinutes > def.expectEveryMinutes + def.graceMinutes ? 'fired' : 'ok',
      silentMinutes,
    };
  });
}

export interface HeartbeatReceiver {
  url: (id: string) => string;
  lastPing: ReadonlyMap<string, number>;
  close: () => Promise<void>;
}

/** Records the time of the last GET /ping/<id>. */
export async function startReceiver(clock: () => number = Date.now): Promise<HeartbeatReceiver> {
  const lastPing = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const match = /^\/ping\/([a-z0-9-]+)$/.exec(req.url ?? '');
    if (match?.[1] !== undefined) lastPing.set(match[1], clock());
    res.statusCode = match === null ? 404 : 200;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: (id) => `http://127.0.0.1:${port}/ping/${id}`,
    lastPing,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
