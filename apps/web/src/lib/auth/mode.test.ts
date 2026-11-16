import { describe, expect, it } from 'vitest';
import { resolveAuthMode } from './mode';

describe('auth mode', () => {
  it('defaults to local away from a hosted environment with no key', () => {
    expect(resolveAuthMode({})).toBe('local');
    expect(resolveAuthMode({ APP_ENV: 'development', AUTH_MODE: '' })).toBe('local');
  });
  it('defaults to clerk when a publishable key is set or the environment is hosted', () => {
    expect(resolveAuthMode({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x' })).toBe('clerk');
    expect(resolveAuthMode({ APP_ENV: 'staging' })).toBe('clerk');
    expect(resolveAuthMode({ APP_ENV: 'production' })).toBe('clerk');
  });
  it('honours an explicit mode and refuses local when hosted', () => {
    expect(resolveAuthMode({ AUTH_MODE: 'clerk' })).toBe('clerk');
    expect(resolveAuthMode({ AUTH_MODE: 'local', APP_ENV: 'test' })).toBe('local');
    expect(() => resolveAuthMode({ AUTH_MODE: 'local', APP_ENV: 'production' })).toThrow(/refused/);
    expect(() => resolveAuthMode({ AUTH_MODE: 'local', APP_ENV: 'staging' })).toThrow(/refused/);
  });
  it('rejects an unknown mode', () => {
    expect(() => resolveAuthMode({ AUTH_MODE: 'basic' })).toThrow(/local or clerk/);
  });
});
