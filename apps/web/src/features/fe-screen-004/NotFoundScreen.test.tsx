// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_TABLE } from '../../lib/errors/copy';
import { NotFoundScreen } from './NotFoundScreen';
import { GO_HOME_LABEL, SCREEN_004_COPY, SCREEN_004_STATES, parseScreen004State } from './copy';

afterEach(cleanup);

describe('SCREEN-004 not found and unavailable record', () => {
  for (const state of SCREEN_004_STATES) {
    it(`${state}: one h1, the message and a Go Home link to the home route`, () => {
      render(<NotFoundScreen state={state} />);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1, name: SCREEN_004_COPY[state].title })).toBeInTheDocument();
      expect(screen.getByText(SCREEN_004_COPY[state].body)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: GO_HOME_LABEL })).toHaveAttribute('href', '/');
    });
  }

  it('the unavailable state gives no hint about which of missing, deleted or not-yours applies', () => {
    expect(SCREEN_004_COPY.unavailable.body).toContain("We can't tell you which");
  });

  it('the Go Home label is the one of the §9.1 rows for not_found and forbidden_role', () => {
    for (const code of ['not_found', 'forbidden_role'] as const) {
      expect(ERROR_TABLE[code].action).toMatchObject({ kind: 'link', label: GO_HOME_LABEL, href: '/' });
    }
  });

  it('parses the state parameter, defaulting to the route 404', () => {
    expect(parseScreen004State('unavailable')).toBe('unavailable');
    expect(parseScreen004State(['unavailable', 'x'])).toBe('unavailable');
    expect(parseScreen004State(undefined)).toBe('route-404');
    expect(parseScreen004State('other')).toBe('route-404');
  });
});
