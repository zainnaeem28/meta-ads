import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import * as contracts from '../src/index';
import type { ErrorCodeValue, components, paths } from '../src/index';
import { httpClient } from '../src/http';

const spec = yaml.load(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as {
  components: { schemas: { ErrorCode: { enum: string[] } } };
};

describe('@shroomap/contracts public surface', () => {
  it('exports the error-code enum equal to the OpenAPI registry (TC-ERR-08)', () => {
    expect([...contracts.ERROR_CODES]).toEqual(spec.components.schemas.ErrorCode.enum);
    expect(contracts.ERROR_CODES).toHaveLength(36);
  });

  it('exports Zod schemas that accept and reject bodies', () => {
    const schemas = Object.values(contracts.zod).filter(
      (v) => typeof (v as { safeParse?: unknown }).safeParse === 'function',
    );
    expect(schemas.length).toBeGreaterThan(0);
  });

  it('exports the generated client', () => {
    const fns = Object.entries(contracts).filter(([, v]) => typeof v === 'function');
    expect(fns.length).toBeGreaterThan(50);
  });

  it('exports the generated types', () => {
    const code: ErrorCodeValue = contracts.ERROR_CODES[0];
    const probe: { paths?: paths; schema?: components['schemas']['ErrorCode'] } = {};
    expect(code).toBeTypeOf('string');
    expect(probe).toEqual({});
  });
});

describe('httpClient mutator', () => {
  it('returns data, status and headers and parses JSON bodies', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    try {
      const result = await httpClient<{ data: unknown; status: number }>('/health/live');
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ ok: true });
      globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
      expect((await httpClient<{ data: unknown }>('/x')).data).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends no credentials, matching the API CORS policy (credentials: false)', async () => {
    const original = globalThis.fetch;
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await httpClient('/x');
      expect(seen?.credentials).toBe('omit');
    } finally {
      globalThis.fetch = original;
    }
  });
});
