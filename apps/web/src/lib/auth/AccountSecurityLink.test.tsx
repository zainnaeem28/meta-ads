// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountSecurityLink } from './AccountSecurityLink';

afterEach(cleanup);

describe('AccountSecurityLink without a provider key', () => {
  it('links to the local second-step page', () => {
    render(<AccountSecurityLink />);
    expect(screen.getByRole('link', { name: 'Account and security' })).toHaveAttribute(
      'href',
      '/mfa',
    );
  });
  it('takes a custom label', () => {
    render(<AccountSecurityLink label="Security" />);
    expect(screen.getByRole('link', { name: 'Security' })).toBeInTheDocument();
  });
});
