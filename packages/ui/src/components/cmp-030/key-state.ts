/** The fields of an API-010 `ProviderKeyStatus` row the badge needs. */
export interface ProviderKeyStatus {
  configured: boolean;
  status: 'active' | 'untested' | 'disabled' | null;
}

export type KeyState = 'ok' | 'missing' | 'disabled';

/**
 * Header key-state badge from API-010 (`GET /me/provider-keys`): a disabled key wins, then any
 * provider without a key; an empty list (API-001 not yet answered) shows nothing.
 */
export function deriveKeyState(keys: readonly ProviderKeyStatus[] | undefined): KeyState {
  if (!keys || keys.length === 0) return 'ok';
  if (keys.some((k) => k.configured && k.status === 'disabled')) return 'disabled';
  if (keys.some((k) => !k.configured)) return 'missing';
  return 'ok';
}
