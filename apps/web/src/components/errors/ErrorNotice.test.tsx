// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../lib/api/errors';
import { setDefectSink, type DefectReport } from '../../lib/errors/defect';
import { ErrorNotice } from './ErrorNotice';
import { QcConfirmDialog } from './QcConfirmDialog';

afterEach(cleanup);
const fail = (code: string, extra: Partial<ConstructorParameters<typeof ApiClientError>[0]> = {}) =>
  new ApiClientError({ status: 500, code, ...extra });

describe('ErrorNotice', () => {
  it('500 page load: CMP-019 alert, Try again enabled at once, Reference line with Copy', async () => {
    const onAction = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    render(
      <ErrorNotice error={fail('internal_error', { requestId: 'req-123' })} onAction={onAction} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(within(alert).getByText('req-123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onAction).toHaveBeenCalledWith(
      'retry',
      expect.objectContaining({ code: 'internal_error' }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy reference' })));
    expect(write).toHaveBeenCalledWith('req-123');
    expect(screen.getByRole('button', { name: 'Copy reference' })).toHaveTextContent('Copied');
  });

  it('a 4xx never shows a Reference line', () => {
    render(
      <ErrorNotice
        error={fail('key_missing', { requestId: 'req-9', status: 422 })}
        surface="context"
      />,
    );
    expect(screen.queryByText(/Reference/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Add provider key' })).toHaveAttribute(
      'href',
      '/settings/provider-keys',
    );
  });

  describe('503 with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('in a form: CMP-011 warning above the actions, Try again disabled with the live wait', () => {
      render(
        <ErrorNotice
          error={fail('service_unavailable', {
            status: 503,
            retryAfterSeconds: 3,
            requestId: 'req-5',
          })}
          surface="context"
        />,
      );
      expect(screen.getByTestId('retry-announcement')).toHaveTextContent(
        'You can try again in 3 seconds.',
      );
      expect(screen.getByRole('button', { name: 'Try again in 3s' })).toBeDisabled();
      act(() => void vi.advanceTimersByTime(3000));
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    });
  });

  it('adds "Check the list before you repeat this" for job-creating actions only', () => {
    const e = fail('internal_error', { requestId: 'r' });
    const { rerender } = render(<ErrorNotice error={e} surface="context" call="job" />);
    expect(screen.getByText('Check the list before you repeat this.')).toBeInTheDocument();
    rerender(<ErrorNotice error={e} surface="context" call="write" />);
    expect(screen.queryByText('Check the list before you repeat this.')).toBeNull();
    rerender(<ErrorNotice error={e} surface="context" call="read" />);
    expect(screen.queryByText('Check the list before you repeat this.')).toBeNull();
  });

  it('adds the administrator hint after three consecutive failures', () => {
    const e = fail('internal_error');
    const { rerender } = render(<ErrorNotice error={e} surface="context" failures={2} />);
    expect(screen.queryByText('If this continues, contact your administrator.')).toBeNull();
    rerender(<ErrorNotice error={e} surface="context" failures={3} />);
    expect(screen.getByText('If this continues, contact your administrator.')).toBeInTheDocument();
  });

  it('logs the route and request ID of a defect row once', () => {
    const reports: DefectReport[] = [];
    const restore = setDefectSink((r) => reports.push(r));
    const e = fail('idempotency_key_reused', { status: 409, requestId: 'req-d' });
    const { rerender } = render(
      <ErrorNotice error={e} surface="context" route="/campaigns/1/final" />,
    );
    rerender(<ErrorNotice error={e} surface="context" route="/campaigns/1/final" />);
    restore();
    expect(reports).toEqual([
      { code: 'idempotency_key_reused', route: '/campaigns/1/final', requestId: 'req-d' },
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent('already sent with different details');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('session expired: redirects to sign-in with the safe return path and shows the message', () => {
    const navigate = vi.fn();
    render(
      <ErrorNotice
        error={fail('unauthenticated', { status: 401 })}
        surface="context"
        navigate={navigate}
        returnTo="/campaigns/7/brief?x=1"
      />,
    );
    expect(navigate).toHaveBeenCalledWith(
      '/sign-in?reason=session-expired&return=%2Fcampaigns%2F7%2Fbrief%3Fx%3D1',
    );
    expect(screen.getByText('Your session ended. Sign in to continue.')).toBeInTheDocument();
  });

  it('an unsafe return path is replaced by home', () => {
    const navigate = vi.fn();
    render(
      <ErrorNotice
        error={fail('unauthenticated', { status: 401 })}
        navigate={navigate}
        returnTo="//evil.example"
      />,
    );
    expect(navigate).toHaveBeenCalledWith('/sign-in?reason=session-expired&return=%2F');
  });

  it('suspended, removed, not linked and MFA navigate to their screens', () => {
    const navigate = vi.fn();
    for (const code of ['account_suspended', 'account_removed', 'not_linked', 'mfa_required']) {
      render(
        <ErrorNotice error={fail(code, { status: 403 })} surface="context" navigate={navigate} />,
      );
      cleanup();
    }
    expect(navigate.mock.calls.map((c) => c[0])).toEqual([
      '/access?state=suspended',
      '/access?state=removed',
      '/access?state=not-linked',
      '/mfa',
    ]);
  });

  it('not_found in an action shows a toast; on a page it is the unavailable state with Go Home', () => {
    render(<ErrorNotice error={fail('not_found', { status: 404 })} surface="context" />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page or item is not available.');
    cleanup();
    render(<ErrorNotice error={fail('not_found', { status: 404 })} />);
    expect(screen.getByRole('link', { name: 'Go Home' })).toHaveAttribute('href', '/');
  });

  it('validation_failed: summary with the heading, one link per field, first 5 and "and n more"', () => {
    const details = Array.from({ length: 7 }, (_, i) => ({
      field: `segments.${i}.dialogue`,
      code: 'too_long',
      message: `Too long ${i + 1}`,
    }));
    render(
      <>
        <input id="d1" />
        <ErrorNotice
          error={fail('validation_failed', { status: 400, details })}
          surface="context"
          controls={{
            'segments.*.dialogue': (n) => ({ id: 'd1', label: `Segment ${n[0]} dialogue` }),
          }}
        />
      </>,
    );
    expect(
      screen.getByRole('heading', { name: 'Check the highlighted fields and try again.' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(5);
    expect(screen.getByRole('button', { name: /and 2 more/ })).toBeInTheDocument();
    expect(screen.queryByText('too_long')).toBeNull();
  });

  it('a 422 without details shows the message as the form alert', () => {
    render(<ErrorNotice error={fail('open_claim_issues', { status: 422 })} surface="context" />);
    expect(
      screen.getByText('Fix the flagged claim issues before you continue.'),
    ).toBeInTheDocument();
  });

  it('recent_auth_required opens the step-up dialog; confirming does not submit anything itself', () => {
    const onAction = vi.fn();
    render(
      <ErrorNotice
        error={fail('recent_auth_required', { status: 403 })}
        surface="context"
        onAction={onAction}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Confirm it is you' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm sign-in' }));
    expect(onAction).toHaveBeenCalledWith(
      'confirm',
      expect.objectContaining({ code: 'recent_auth_required' }),
    );
  });

  it('unknown code renders the internal_error copy', () => {
    render(<ErrorNotice error={fail('totally_new', { requestId: 'q' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side.');
  });
});

describe('QcConfirmDialog', () => {
  const clips = [
    { label: 'Segment 2', qc: 'failed' as const },
    { label: 'Segment 3', qc: 'skipped' as const, reason: 'provider busy' },
  ];

  it('lists each clip, says the ad includes them as they are, and confirms or goes back', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <QcConfirmDialog
        open
        clips={clips}
        serverMessage="Segment 2 and 3 need confirmation."
        changed
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm clips that did not pass the check',
    });
    expect(within(dialog).getByText('Segment 2: check failed')).toBeInTheDocument();
    expect(within(dialog).getByText('Segment 3: check skipped, provider busy')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('The final ad will include these clips as they are.');
    expect(dialog).toHaveTextContent('Your confirmation is recorded.');
    expect(dialog).toHaveTextContent('Check results changed since you opened this page.');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Include these clips and assemble' }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pending: busy, nothing can be dismissed; a submit error stays inside the dialog', () => {
    const { rerender } = render(
      <QcConfirmDialog open clips={clips} pending onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Go back' })).toBeDisabled();
    rerender(
      <QcConfirmDialog
        open
        clips={clips}
        error="Something went wrong"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Something went wrong');
  });
});
