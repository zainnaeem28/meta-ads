// Pure rules of key entry (ARCHITECTURE §5.2): trimming, format and wrong-provider checks, the displayed hint.

import type { Provider } from './key-wrap.js';

export const KEY_STATUSES = ['active', 'untested', 'disabled'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

export const KEY_EVENT_KINDS = [
  'added',
  'replaced',
  'deleted',
  'test_passed',
  'test_failed',
  'stored_untested',
  'validated_by_job',
  'auth_failed',
  'disabled',
  'disabled_by_operator',
  'attempt_rate_limited',
  'rewrapped',
] as const;
export type KeyEventKind = (typeof KEY_EVENT_KINDS)[number];

export type FormatProblem = 'format' | 'wrong_provider';

export type KeyFormats = Readonly<Record<Provider, RegExp>>;

/** Surrounding whitespace is not part of a key (a pasted trailing space or newline). */
export const normalizeKey = (raw: string): string => raw.trim();

/** An `sk-` key is an OpenAI key: entered for WaveSpeed it gets its own reason before the format rule runs. */
export function checkKeyFormat(
  provider: Provider,
  key: string,
  formats: KeyFormats,
): FormatProblem | undefined {
  if (provider === 'wavespeed' && key.startsWith('sk-')) return 'wrong_provider';
  return formats[provider].test(key) ? undefined : 'format';
}

/** The only part of a key that is ever shown or stored in the clear (REQ-014). */
export const lastFour = (key: string): string => Array.from(key).slice(-4).join('');
