import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

/** A fresh, unguessable canary per test process: no key-shaped literal ever sits in the repository. */
const mint = (prefix: string): string => `${prefix}canary-${randomBytes(10).toString('hex')}`;

export const CANARY_KEY = mint('sk-');
export const CANARY_TOKEN = mint('');
export const CANARY_EMAIL = 'canary.person@example.test';
export const CANARY_SECRET = mint('');

export const CANARIES = [CANARY_KEY, CANARY_TOKEN, CANARY_EMAIL, CANARY_SECRET];

/** A pino destination that keeps every written line. */
export function capture(): {
  stream: Writable;
  text: () => string;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  const text = (): string => chunks.join('');
  return {
    stream,
    text,
    lines: () =>
      text()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export function expectNoCanary(output: string, canaries: readonly string[] = CANARIES): string[] {
  return canaries.filter((canary) => output.includes(canary));
}
