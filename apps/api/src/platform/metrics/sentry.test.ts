import { describe, expect, it } from 'vitest';
import { createScrubber } from '../logging/redact.js';
import { createScrubHook, createSentryAdapter } from './sentry.js';
import type { SentrySdk } from './sentry.js';

// TC-LOG: the error reporter never receives a canary key, e-mail or token.

const CANARY_KEY = ['canary', 'key', 'value'].join('_') + '_0123456789';
const CANARY_EMAIL = 'canary.person@example.com';
const CANARY_TOKEN = 'Bearer eyJcanary.payload.signature';

function fakeSdk(): { sdk: SentrySdk; options: () => Record<string, unknown> | undefined; after: () => ((e: unknown, r: unknown) => void) | undefined } {
  let options: Record<string, unknown> | undefined;
  let after: ((e: unknown, r: unknown) => void) | undefined;
  return {
    sdk: {
      init: (o) => void (options = o),
      getClient: () => ({ on: (_hook, cb) => void (after = cb as never) }),
      captureException: () => undefined,
    },
    options: () => options,
    after: () => after,
  };
}

describe('Sentry adapter', () => {
  it('stays off without a DSN: nothing is initialised', () => {
    const fake = fakeSdk();
    expect(createSentryAdapter({}, { sdk: fake.sdk, onDropped: () => undefined })).toBeNull();
    expect(createSentryAdapter({ SENTRY_DSN: '' }, { sdk: fake.sdk, onDropped: () => undefined })).toBeNull();
    expect(fake.options()).toBeUndefined();
  });

  it('initialises with the configured DSN, environment and sample rates, without default PII', () => {
    const fake = fakeSdk();
    const adapter = createSentryAdapter(
      { SENTRY_DSN: 'https://k@o.example.test/1', SENTRY_ENVIRONMENT: 'staging', SENTRY_ERRORS_SAMPLE_RATE: 0.5 },
      { sdk: fake.sdk, onDropped: () => undefined },
    );
    expect(adapter).not.toBeNull();
    expect(fake.options()).toMatchObject({ environment: 'staging', sampleRate: 0.5, tracesSampleRate: 0, sendDefaultPii: false });
  });

  it('never sends a canary key, e-mail or token through beforeSend', () => {
    const fake = fakeSdk();
    createSentryAdapter({ SENTRY_DSN: 'https://k@o.example.test/1' }, { sdk: fake.sdk, scrub: createScrubber([CANARY_KEY]), onDropped: () => undefined });
    const beforeSend = fake.options()?.['beforeSend'] as (event: object) => object | null;
    const sent = beforeSend({
      message: `failed for ${CANARY_EMAIL} with ${CANARY_KEY}`,
      exception: { values: [{ value: `provider said ${CANARY_KEY}` }] },
      request: { url: `/x?apiKey=${CANARY_KEY}`, headers: { authorization: CANARY_TOKEN }, data: { email: CANARY_EMAIL }, cookies: { s: CANARY_TOKEN } },
      user: { email: CANARY_EMAIL },
      extra: { token: CANARY_TOKEN, email: CANARY_EMAIL, note: `mail ${CANARY_EMAIL}` },
    });
    const text = JSON.stringify(sent);
    expect(text).not.toContain(CANARY_KEY);
    expect(text).not.toContain(CANARY_TOKEN);
    expect(text).not.toContain('eyJcanary');
    expect(text).not.toContain('canary.person');
  });

  it('drops (and counts) an event whose scrub fails rather than sending it raw', () => {
    let dropped = 0;
    const throwing = Object.assign(() => {
      throw new Error('boom');
    }, { learn: () => undefined });
    const hook = createScrubHook(throwing as never, () => dropped++);
    expect(hook({ message: 'x' })).toBeNull();
    expect(dropped).toBe(1);
  });

  it('counts a refused or failed delivery as a dropped event', () => {
    const fake = fakeSdk();
    let dropped = 0;
    createSentryAdapter({ SENTRY_DSN: 'https://k@o.example.test/1' }, { sdk: fake.sdk, onDropped: () => dropped++ });
    fake.after()?.({}, { statusCode: 200 });
    expect(dropped).toBe(0);
    fake.after()?.({}, { statusCode: 429 });
    fake.after()?.({}, undefined);
    expect(dropped).toBe(2);
  });

  it('counts a capture that throws', () => {
    let dropped = 0;
    const sdk = fakeSdk().sdk;
    sdk.captureException = () => {
      throw new Error('x');
    };
    const adapter = createSentryAdapter({ SENTRY_DSN: 'https://k@o.example.test/1' }, { sdk, onDropped: () => dropped++ });
    adapter?.captureException(new Error('e'));
    expect(dropped).toBe(1);
  });
});
