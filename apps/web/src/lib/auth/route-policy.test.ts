import { describe, expect, it } from 'vitest';
import { decideRoute, isAuthPage, isPublicPath } from './route-policy';

const decide = (pathname: string, session: 'active' | 'expired' | 'none', search = '') =>
  decideRoute({ pathname, search, session });

describe('route policy', () => {
  it('lets the sign-in and second-step pages and the test probes through', () => {
    for (const path of ['/sign-in', '/sign-in/factor-two', '/mfa', '/gallery', '/api-probe', '/error-probe']) {
      expect(isPublicPath(path)).toBe(true);
      expect(decide(path, 'none')).toEqual({ kind: 'next' });
    }
    expect(isAuthPage('/gallery')).toBe(false);
    expect(isPublicPath('/sign-in-other')).toBe(false);
  });
  it('sends an anonymous visitor to sign-in with the requested URL as the return path', () => {
    expect(decide('/campaigns/42/brief', 'none', '?tab=a')).toEqual({
      kind: 'redirect',
      to: '/sign-in?return=%2Fcampaigns%2F42%2Fbrief%3Ftab%3Da',
    });
    expect(decide('/access', 'none').kind).toBe('redirect');
  });
  it('adds the session-expired message for an ended session', () => {
    expect(decide('/campaigns', 'expired', '?page=2')).toEqual({
      kind: 'redirect',
      to: '/sign-in?reason=session-expired&return=%2Fcampaigns%3Fpage%3D2',
    });
  });
  it('lets a signed-in user through', () => {
    expect(decide('/campaigns', 'active')).toEqual({ kind: 'next' });
  });
  it('routes home: signed in to the campaign list, signed out to sign-in', () => {
    expect(decide('/', 'active')).toEqual({ kind: 'redirect', to: '/campaigns' });
    expect(decide('/', 'none')).toEqual({ kind: 'redirect', to: '/sign-in' });
    expect(decide('/', 'expired')).toEqual({ kind: 'redirect', to: '/sign-in?reason=session-expired&return=%2F' });
  });
  it('never builds an off-site return path', () => {
    const decision = decide('//evil.example/x', 'none');
    expect(decision).toEqual({ kind: 'redirect', to: '/sign-in?return=%2F' });
  });
});
