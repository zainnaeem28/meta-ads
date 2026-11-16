// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthError from '../../app/(auth)/error';
import AuthLoading from '../../app/(auth)/loading';
import { MfaScreen } from './MfaScreen';
import { SignInScreen } from './SignInScreen';

vi.mock('../../app/(auth)/actions', () => ({ localSignIn: vi.fn(), localVerify: vi.fn() }));

afterEach(cleanup);

const h1 = () => screen.getAllByRole('heading', { level: 1 });

describe('SCREEN-001 sign-in', () => {
  it('default: one h1, the local form with password-manager fields, no session message', () => {
    render(<SignInScreen clerk={false} expired={false} returnTo="/" />);
    expect(h1()).toHaveLength(1);
    expect(h1()[0]).toHaveTextContent('AI UGC Ad Director');
    expect(screen.getByLabelText('Email address')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.queryByText(/Your session ended/)).toBeNull();
  });

  it('session-expired: the message sits above the form', () => {
    render(<SignInScreen clerk={false} expired returnTo="/campaigns" />);
    const message = screen.getByText('Your session ended. Sign in to continue.');
    const email = screen.getByLabelText('Email address');
    expect(message.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('SCREEN-003 two-step verification', () => {
  it.each([
    ['enrol', 'Set up two-step verification', /Required for every account/],
    ['challenge', 'Two-step verification', /enter the 6-digit code/],
  ] as const)('%s: one h1, code field, recovery copy', (step, title, intro) => {
    render(<MfaScreen clerk={false} returnTo="/" step={step} />);
    expect(h1()).toHaveLength(1);
    expect(h1()[0]).toHaveTextContent(title);
    expect(screen.getByText(intro)).toBeInTheDocument();
    expect(screen.getByLabelText('6-digit code')).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByTestId('mfa-recovery')).toHaveTextContent('Recovery needs another second factor');
  });
});

describe('SCREEN-003 mfa_required message and brand panel', () => {
  const required = 'Two-step verification is required. Set it up to continue.';
  it('shows the mfa_required message on enrol or when arriving via mfa_required, not on a plain challenge', () => {
    const { unmount } = render(<MfaScreen clerk={false} returnTo="/" step="challenge" />);
    expect(screen.queryByText(required)).toBeNull();
    unmount();
    const second = render(<MfaScreen clerk={false} required returnTo="/" step="challenge" />);
    expect(screen.getByText(required)).toBeInTheDocument();
    second.unmount();
    render(<MfaScreen clerk={false} returnTo="/" step="enrol" />);
    expect(screen.getByText(required)).toBeInTheDocument();
  });
  it('brand panel carries the description and footer without a second h1', () => {
    const { container } = render(<MfaScreen clerk={false} returnTo="/" step="challenge" />);
    const panel = container.querySelector('[data-brand-panel]')!;
    expect(panel).toHaveTextContent('Brief, generate and assemble brand-checked UGC video ads.');
    expect(panel).toHaveTextContent('Access is by invitation.');
    expect(h1()).toHaveLength(1);
  });
});

describe('auth group loading and error', () => {
  it('loading shows the busy status', () => {
    render(<AuthLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading sign-in');
  });
  it('error shows the alert with a retry that calls reset', () => {
    const reset = vi.fn();
    render(<AuthError error={new Error('x')} reset={reset} />);
    expect(screen.getByRole('alert')).toHaveTextContent('We could not load sign-in. Try again.');
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(reset).toHaveBeenCalled();
  });
});
