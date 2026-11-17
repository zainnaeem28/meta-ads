// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../lib/api/msw.setup';
import { ApiProvider } from '../../providers/api-provider';
import { SettingsScreen } from './SettingsScreen';

const ORIGIN = 'http://api.test';
const URL_SETTINGS = `${ORIGIN}/api/v1/admin/settings`;
const URL_MODE = `${ORIGIN}/api/v1/admin/settings/signup-mode`;

afterEach(cleanup);

const settings = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    signupMode: 'invited_only',
    accessRequestFormEnabled: false,
    mfaRequiredFor: 'all',
    inviteEmailDomains: [],
    openModePrerequisites: {
      emailVerificationRequired: false,
      signupRateLimitEnabled: false,
      abuseLimitsEnabled: false,
      verificationRecordId: null,
    },
    ...over,
  },
  metaData: { requestId: 'req-1' },
});

const failure = (status: number, code: string, message: string) =>
  HttpResponse.json(
    { success: false, error: { code, message, details: [] }, metaData: { requestId: 'req-9' } },
    { status },
  );

function mount() {
  return render(
    <ApiProvider origin={ORIGIN} getToken={() => Promise.resolve('tok')} identity="admin">
      <SettingsScreen />
    </ApiProvider>,
  );
}

describe('SCREEN-013 settings', () => {
  it('loading, then default: mode, prerequisites and read-only values (API-120 only)', async () => {
    const seen: string[] = [];
    server.use(
      http.get(URL_SETTINGS, ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpResponse.json(settings());
      }),
    );
    mount();
    expect(screen.getAllByRole('status').some((n) => n.textContent === 'Loading settings')).toBe(
      true,
    );
    expect(document.querySelector('[data-state="loading"]')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('heading', { level: 2, name: 'Sign-up' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Invited only/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Open/ })).not.toBeChecked();
    expect(screen.getAllByText('Not verified')).toHaveLength(2);
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText('Everyone')).toBeInTheDocument();
    expect(screen.getByText('7 days')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save sign-up mode' })).toBeDisabled();
    expect(seen).toEqual(['GET /api/v1/admin/settings']);
  });

  it('saves open mode when the prerequisites hold: PUT mode, toast Sign-up mode saved.', async () => {
    let body: unknown;
    server.use(
      http.get(URL_SETTINGS, () => HttpResponse.json(settings())),
      http.put(URL_MODE, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          settings({
            signupMode: 'open',
            openModePrerequisites: {
              emailVerificationRequired: true,
              signupRateLimitEnabled: true,
              abuseLimitsEnabled: true,
              verificationRecordId: 'VR-2026-04',
            },
          }),
        );
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Open/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-up mode' }));
    expect(await screen.findByText('Sign-up mode saved.')).toBeInTheDocument();
    expect(body).toEqual({ mode: 'open' });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Open/ })).toBeChecked());
    expect(screen.getByText('VR-2026-04')).toBeInTheDocument();
    expect(screen.getAllByText('Enabled')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save sign-up mode' })).toBeDisabled();
  });

  it('open-refused: warning alert with the server message, the choice returns to Invited only', async () => {
    server.use(
      http.get(URL_SETTINGS, () => HttpResponse.json(settings())),
      http.put(URL_MODE, () =>
        failure(422, 'signup_open_prerequisites', 'Email verification is not enabled.'),
      ),
    );
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Open/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-up mode' }));
    const alert = (await screen.findByText(/Open sign-up cannot be turned on yet/)).closest(
      '[role]',
    ) as HTMLElement;
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert).toHaveTextContent('Open sign-up cannot be turned on yet.');
    expect(alert).toHaveTextContent('Email verification is not enabled.');
    expect(screen.getByRole('radio', { name: /Invited only/ })).toBeChecked();
    expect(document.querySelector('[data-state="open-refused"]')).not.toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText(/Open sign-up cannot/)).toBeNull());
  });

  it('recent_auth_required opens the step-up dialog; Confirm sign-in goes to the provider and returns here', async () => {
    server.use(
      http.get(URL_SETTINGS, () => HttpResponse.json(settings())),
      http.put(URL_MODE, () => failure(403, 'recent_auth_required', 'Recent sign-in required.')),
    );
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign, pathname: '/admin/settings', search: '' },
      configurable: true,
    });
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Open/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-up mode' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('For your security, confirm it is you again to continue.');
    // The entered choice stays in the form.
    expect(screen.getByRole('radio', { name: /Open/, hidden: true })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm sign-in' }));
    expect(assign).toHaveBeenCalledWith(expect.stringContaining('return=%2Fadmin%2Fsettings'));
  });

  it('403 forbidden_role shows the unavailable state without navigation', async () => {
    server.use(http.get(URL_SETTINGS, () => failure(403, 'forbidden_role', 'No.')));
    mount();
    expect(await screen.findByText('Administration is not available')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('500 on load: error alert with Try again, which reloads', async () => {
    let calls = 0;
    server.use(
      http.get(URL_SETTINGS, () => {
        calls += 1;
        return calls <= 3
          ? failure(500, 'internal_error', 'x')
          : HttpResponse.json(
              settings({ mfaRequiredFor: 'admins', accessRequestFormEnabled: true }),
            );
      }),
    );
    mount();
    const retry = await screen.findByRole('button', { name: /Try again/ }, { timeout: 8000 });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(await screen.findByText('Administrators only')).toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  }, 20000);
});
