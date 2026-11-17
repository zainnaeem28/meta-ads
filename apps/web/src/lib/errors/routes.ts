/**
 * Destinations the error rows point to. Paths are the proposed routes of UI-UX §7; the screen tickets own the pages,
 * and a change of path is a one-line change here.
 */
export const ROUTES = {
  home: '/',
  signIn: '/sign-in',
  access: '/access',
  mfa: '/mfa',
  campaigns: '/campaigns',
  // SCREEN-004: a missing, deleted or not-yours record.
  unavailable: '/not-found?state=unavailable',
  providerKeys: '/settings/provider-keys',
  // The brief of the current campaign: the caller passes its own link; this is the list fallback.
  brief: '/campaigns',
} as const;
