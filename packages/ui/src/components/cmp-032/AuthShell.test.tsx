// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_VARIANTS, AuthShell } from './index';

afterEach(cleanup);

describe('CMP-032 AuthShell', () => {
  it.each(AUTH_VARIANTS)(
    '%s variant has a main landmark, one h1 and no axe violations',
    async (variant) => {
      const { container } = render(
        <AuthShell variant={variant} title="AI UGC Ad Director" description="Sign in.">
          <button>Continue</button>
        </AuthShell>,
      );
      expect(screen.getAllByRole('main')).toHaveLength(1);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
      expect(container.querySelector('[data-brand-panel]')).toHaveAttribute('aria-hidden', 'true');
      expect(container.firstElementChild).toHaveAttribute('data-variant', variant);
      expect((await axe.run(container)).violations).toEqual([]);
    },
  );

  it('provider loading shows a busy status and hides the children', async () => {
    const { container } = render(
      <AuthShell title="T" providerState="loading">
        <button>Hidden</button>
      </AuthShell>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading sign-in');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('provider error is an alert with its action', async () => {
    const { container } = render(
      <AuthShell title="T" providerState="error" providerAction={<button>Try again</button>} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('We could not load sign-in. Try again.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe('CMP-032 AuthShell embedding', () => {
  it('landmark={false} renders no main (gallery embedding)', () => {
    render(<AuthShell landmark={false} title="T" />);
    expect(screen.queryByRole('main')).toBeNull();
  });
});
