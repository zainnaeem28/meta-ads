/** SCREEN-004 copy (UI-UX §8 and §9.1): one message for missing, deleted and not-yours records, no data and no hint. */
export const SCREEN_004_STATES = ['route-404', 'unavailable'] as const;
export type Screen004State = (typeof SCREEN_004_STATES)[number];

export const SCREEN_004_COPY: Record<Screen004State, { title: string; body: string }> = {
  'route-404': {
    title: 'Page not found',
    body: 'The page you are looking for does not exist or has moved.',
  },
  unavailable: {
    title: 'This campaign is unavailable',
    body: "It may have been deleted, or it may not be yours to open. We can't tell you which.",
  },
};

export const GO_HOME_LABEL = 'Go Home';

export const parseScreen004State = (value: string | string[] | undefined): Screen004State =>
  (Array.isArray(value) ? value[0] : value) === 'unavailable' ? 'unavailable' : 'route-404';
