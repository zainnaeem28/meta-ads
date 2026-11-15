// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({
    children,
    publishableKey,
  }: {
    children: React.ReactNode;
    publishableKey: string;
  }) => (
    <div data-testid="clerk" data-key={publishableKey}>
      {children}
    </div>
  ),
  useAuth: () => ({ getToken: () => Promise.resolve('clerk-token'), userId: 'user_1' }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('AppProviders', () => {
  it('runs anonymous without a Clerk key', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    const { AppProviders } = await import('./app-providers');
    render(
      <AppProviders>
        <span data-testid="child">x</span>
      </AppProviders>,
    );
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(screen.queryByTestId('clerk')).toBeNull();
  });

  it('wraps the app in Clerk and feeds the bearer and identity from it', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture');
    const { AppProviders } = await import('./app-providers');
    render(
      <AppProviders>
        <span data-testid="child">x</span>
      </AppProviders>,
    );
    expect(screen.getByTestId('clerk').dataset.key).toBe('pk_test_fixture');
    expect(screen.getByTestId('child')).toBeTruthy();
  });
});
