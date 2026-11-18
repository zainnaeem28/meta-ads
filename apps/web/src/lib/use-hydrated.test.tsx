// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useHydrated } from './use-hydrated';

function Label() {
  return <p data-testid="l">{useHydrated() ? 'client' : 'server'}</p>;
}

describe('useHydrated', () => {
  it('is false in the server render and true once mounted in the browser', () => {
    expect(renderToString(<Label />)).toContain('server');
    render(<Label />);
    expect(screen.getByTestId('l').textContent).toBe('client');
  });
});
