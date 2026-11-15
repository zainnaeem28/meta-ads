const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

const newKey = (): string => globalThis.crypto.randomUUID();

/**
 * One instance per user-initiated job-creating action (a button). `keyFor(payload)` returns a fresh key for a new
 * action and the same key only when retrying the same payload after an attempt that did not succeed.
 */
export class IdempotencyKeys {
  private current: { key: string; payload: string } | null = null;

  keyFor(payload: unknown): string {
    const text = canonical(payload);
    if (!this.current || this.current.payload !== text)
      this.current = { key: newKey(), payload: text };
    return this.current.key;
  }

  /** The attempt succeeded: the next call is a new action with a new key, even for an identical payload. */
  succeeded(): void {
    this.current = null;
  }
}

/** Request options carrying the `Idempotency-Key` header. */
export const idempotencyHeaders = (key: string): { headers: Record<string, string> } => ({
  headers: { 'Idempotency-Key': key },
});
