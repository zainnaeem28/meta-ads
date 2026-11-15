import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  createScrubber,
  scrubDeep,
  scrubReportEvent,
  scrubSpanAttributes,
} from './redact.js';
import { CANARY_EMAIL, CANARY_KEY, CANARY_SECRET, CANARY_TOKEN } from './test-support.js';

const scrub = createScrubber([CANARY_SECRET, 'short']);
scrub.learn(CANARY_TOKEN);
scrub.learn('tiny');

describe('scrubber', () => {
  it.each([
    ['openai key', `key ${CANARY_KEY} end`],
    ['wavespeed key', ['ws', '0123456789abcdefABCDEF'].join('_')],
    ['bearer', 'Authorization: Bearer abcdef0123456789'],
    ['jwt', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.c2lnbmF0dXJl'],
    ['email', `from ${CANARY_EMAIL}`],
    ['signed url', 'https://r2.example.test/b/o?X-Amz-Signature=deadbeef0123&x=1'],
    ['clerk key', ['sk', 'live', 'abcdefgh12345678'].join('_')],
    ['literal secret', `value=${CANARY_SECRET}`],
  ])('removes a %s', (_name, input) => {
    expect(scrub(input)).toContain(REDACTED);
    expect(scrub(input)).not.toMatch(/canary|abcdef0123456789|deadbeef|0123456789abcdefABCDEF/);
  });

  it('learns runtime secrets, ignores short ones and forgets the oldest past the cap', () => {
    const own = createScrubber();
    own.learn('abcdefgh-learned');
    own.learn('abcdefgh-learned');
    own.learn('tiny');
    expect(own('x abcdefgh-learned tiny')).toBe(`x ${REDACTED} tiny`);
    for (let i = 0; i < 1000; i++) own.learn(`learned-secret-${i}`);
    expect(own('abcdefgh-learned')).toBe('abcdefgh-learned');
    expect(own('learned-secret-999')).toBe(REDACTED);
  });

  it('leaves ordinary text and too-short literals alone', () => {
    expect(scrub('request completed short')).toBe('request completed short');
  });

  it('scrubs deeply, redacts sensitive keys and caps depth', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 12; i++) cursor = (cursor['n'] = {}) as Record<string, unknown>;
    const out = scrubDeep(
      {
        authorization: 'x',
        list: [CANARY_TOKEN, `Bearer ${CANARY_TOKEN}`, 3, null],
        [CANARY_SECRET]: { a: CANARY_KEY },
        deep,
      },
      scrub,
    );
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/canary/i);
    expect(text).toContain(REDACTED);
  });

  it('scrubs error reporter events and trace attributes', () => {
    const event = { message: `boom ${CANARY_KEY}`, request: { headers: { cookie: 'a=1' } } };
    expect(JSON.stringify(scrubReportEvent(event, scrub))).not.toContain(CANARY_KEY);
    expect(event.message).toContain(CANARY_KEY);
    const attrs = scrubSpanAttributes(
      { 'http.url': `/x?k=${CANARY_KEY}`, email: CANARY_EMAIL },
      scrub,
    );
    expect(JSON.stringify(attrs)).not.toMatch(/canary/i);
  });
});
