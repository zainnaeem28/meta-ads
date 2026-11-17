import { describe, expect, it } from 'vitest';
import { assemblyConfigFrom } from '../production.module.js';
import { assemblyReuseHash } from './assembly.service.js';

describe('assembly settings and reuse hash', () => {
  it('defaults to 20 renders a day and checks a setting that is present', () => {
    expect(assemblyConfigFrom({}).rendersPerDay).toBe(20);
    expect(assemblyConfigFrom({ ASSEMBLY_RENDERS_PER_USER_PER_DAY: '30' }).rendersPerDay).toBe(30);
    for (const bad of ['0', '201', 'x', '1.5']) {
      expect(() => assemblyConfigFrom({ ASSEMBLY_RENDERS_PER_USER_PER_DAY: bad })).toThrow('ASSEMBLY_RENDERS_PER_USER_PER_DAY');
    }
  });

  it('makes the same hash for the same clips in the same order and another for any difference', () => {
    const [a, b] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const base = assemblyReuseHash([a!, b!], null);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(assemblyReuseHash([a!, b!], null)).toBe(base);
    expect(assemblyReuseHash([b!, a!], null)).not.toBe(base);
    expect(assemblyReuseHash([a!], null)).not.toBe(base);
    expect(assemblyReuseHash([a!, b!], a!)).not.toBe(base);
  });
});
