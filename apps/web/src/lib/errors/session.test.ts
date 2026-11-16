import { describe, expect, it } from 'vitest';
import { isSessionExpiredVisit, returnPathFrom, safeReturnPath, signInUrl } from './session';

describe('safe return path', () => {
  it.each([
    ['/campaigns/42/brief?tab=a#x', '/campaigns/42/brief?tab=a#x'],
    ['/campaigns', '/campaigns'],
    ['//evil.example/phish', '/'],
    ['https://evil.example/', '/'],
    ['javascript:alert(1)', '/'],
    ['/\\evil.example', '/'],
    ['/a\nb', '/'],
    ['/sign-in?return=/x', '/'],
    ['/sign-in', '/'],
    ['campaigns', '/'],
    ['', '/'],
    [null, '/'],
    [undefined, '/'],
    [`/${'a'.repeat(2100)}`, '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  it('builds the sign-in URL and reads the return path back, screened', () => {
    const url = signInUrl('/campaigns/42/brief?x=1');
    expect(url).toBe('/sign-in?reason=session-expired&return=%2Fcampaigns%2F42%2Fbrief%3Fx%3D1');
    const search = url.slice(url.indexOf('?'));
    expect(isSessionExpiredVisit(search)).toBe(true);
    expect(returnPathFrom(search)).toBe('/campaigns/42/brief?x=1');
    expect(returnPathFrom('?return=https%3A%2F%2Fevil.example')).toBe('/');
    expect(isSessionExpiredVisit('')).toBe(false);
  });

  it('never builds a sign-in URL that returns to an unsafe target', () => {
    expect(signInUrl('//evil.example')).toBe('/sign-in?reason=session-expired&return=%2F');
  });
});
