/** The fields of an API-010 `ProviderKeyStatus` row the badge needs. */
export interface ProviderKeyStatus {
  configured: boolean;
  status: 'active' | 'untested' | 'disabled' | null;
}

/** `unknown`: API-010 has not answered yet; the header slot holds a placeholder of its own size, so nothing moves when it does. */
export type KeyState = 'unknown' | 'ok' | 'missing' | 'disabled';

/**
 * Header key-state badge from API-010 (`GET /me/provider-keys`): a disabled key wins, then any
 * provider without a key; an empty list shows nothing. Before the answer there is `unknown` (a same-size placeholder);
 * when the read failed (`failed`) nothing is shown, as the badge cannot be known.
 */
export function deriveKeyState(
  keys: readonly ProviderKeyStatus[] | undefined,
  failed = false,
): KeyState {
  if (!keys) return failed ? 'ok' : 'unknown';
  if (keys.length === 0) return 'ok';
  if (keys.some((k) => k.configured && k.status === 'disabled')) return 'disabled';
  if (keys.some((k) => !k.configured)) return 'missing';
  return 'ok';
}
