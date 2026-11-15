import { describe, expect, it } from 'vitest';
import { TestServerRefusedError, adminUrl, allowedHosts } from './test-database.js';

describe('test database helper guard', () => {
  it('accepts only the test server by default', () => {
    expect(allowedHosts({})).toEqual(['test-db']);
    expect(adminUrl({})).toBe('postgres://postgres@test-db:5432/postgres');
    expect(
      adminUrl({ TEST_DATABASE_ADMIN_URL: 'postgres://postgres@test-db:5433/postgres' }),
    ).toContain(':5433');
  });

  it.each([
    'postgres://app@db:5432/paperclip',
    'postgres://postgres@localhost:5432/postgres',
    'postgres://u@prod.example.com:5432/app',
  ])('refuses %s', (url) => {
    expect(() => adminUrl({ TEST_DATABASE_ADMIN_URL: url })).toThrow(TestServerRefusedError);
  });

  it('allows another host only when it is listed explicitly', () => {
    const env = {
      TEST_DATABASE_ADMIN_URL: 'postgres://postgres@localhost/postgres',
      TEST_DATABASE_HOSTS: 'test-db, localhost',
    };
    expect(allowedHosts(env)).toEqual(['test-db', 'localhost']);
    expect(adminUrl(env)).toContain('localhost');
  });
});
