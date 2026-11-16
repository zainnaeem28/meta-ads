import { parseMetricsWindow } from './window.ts';
import type { MetricsWindow } from './window.ts';
import type { ReadFailure } from './rules.ts';

export type ReadResult =
  { ok: true; window: MetricsWindow } | { ok: false; reason: ReadFailure; status?: number };

/** One GET of API-903 with the metrics token. Never throws; the token never leaves this function except in the header. */
export async function readWindow(
  apiUrl: string,
  token: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadResult> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/internal/metrics/window', apiUrl), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    return {
      ok: false,
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'status', status: response.status };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    return {
      ok: false,
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'invalid_body',
    };
  }
  const window = parseMetricsWindow(body);
  return window === null ? { ok: false, reason: 'invalid_body' } : { ok: true, window };
}
