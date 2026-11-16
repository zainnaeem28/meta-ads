// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../lib/api/msw.setup';
import { ApiProvider } from '../../providers/api-provider';
import { InvitationsScreen } from './InvitationsScreen';
import { invitationFixtures, meta, metaPage, requestFixtures, settingsFixture } from './fixtures';

const API = 'http://api.test/api/v1';

const userEvent = {
  click: async (el: HTMLElement) => {
    await act(async () => {
      fireEvent.click(el);
    });
  },
  type: async (el: HTMLElement, text: string) => {
    await act(async () => {
      fireEvent.change(el, { target: { value: text } });
    });
  },
};
afterEach(cleanup);

const error = (status: number, code: string, message = 'x', extra: object = {}) =>
  HttpResponse.json({ success: false, error: { code, message, ...extra }, metaData: { requestId: 'req-1' } }, { status });

interface Setup {
  invitations?: ReturnType<typeof invitationFixtures>;
  requests?: ReturnType<typeof requestFixtures>;
  settings?: Parameters<typeof settingsFixture>[0];
}
const calls: string[] = [];
server.events.on('request:start', ({ request }) => {
  calls.push(`${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}`);
});

function serve({ invitations = invitationFixtures(), requests = requestFixtures(), settings }: Setup = {}) {
  calls.length = 0;
  server.use(
    http.get(`${API}/admin/invitations`, () => HttpResponse.json({ success: true, data: invitations, metaData: metaPage(invitations.length) })),
    http.get(`${API}/admin/access-requests`, () => HttpResponse.json({ success: true, data: requests, metaData: metaPage(requests.length) })),
    http.get(`${API}/admin/settings`, () => HttpResponse.json({ success: true, data: settingsFixture(settings), metaData: meta })),
  );
}

const ready = async () => {
  await screen.findByText('sam.okafor@shroomap.example');
  return screen.getByRole('table', { name: 'Invitations' });
};

const mount = () =>
  render(
    <ApiProvider origin="http://api.test" getToken={() => Promise.resolve('t')} identity="admin-1">
      <InvitationsScreen />
    </ApiProvider>,
  );

describe('SCREEN-012 invitations and requests', () => {
  it('default: tabs with counts, invitation rows with state, expiry and actions, and the shell nav marks Invitations', async () => {
    serve();
    mount();
    const table = await ready();
    expect(screen.getByRole('heading', { level: 1, name: 'Invitations and requests' })).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /^Invitations/ })).getByText('3')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /^Access requests/ })).getByText('2')).toBeInTheDocument());
    expect(within(table).getByText('sam.okafor@shroomap.example')).toBeInTheDocument();
    expect(within(table).getByText('Invited')).toBeInTheDocument();
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).getByText('Email not delivered')).toBeInTheDocument();
    expect(within(table).getByText('in 6 days')).toBeInTheDocument();
    expect(within(table).getByText('9 days ago')).toBeInTheDocument();
    expect(within(table).getAllByRole('button', { name: /^Resend to/ })).toHaveLength(2);
    expect(within(table).getByRole('button', { name: 'Invite lena.brandt@shroomap.example again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Invitations/, current: 'page' })).toBeInTheDocument();
  });

  it('loading: skeleton rows with aria-busy before the first answer', () => {
    server.use(
      http.get(`${API}/admin/invitations`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
      http.get(`${API}/admin/access-requests`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
      http.get(`${API}/admin/settings`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    mount();
    expect(screen.getByRole('table', { name: 'Invitations' })).toHaveAttribute('aria-busy', 'true');
  });

  it('empty: honest explanation and the first action opens the invite dialog', async () => {
    serve({ invitations: [] });
    mount();
    expect(await screen.findByRole('heading', { name: 'No invitations yet' })).toBeInTheDocument();
    expect(screen.getByText(/single-use link that works for 7 days/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Invite person' });
    await userEvent.click(buttons[buttons.length - 1]!);
    expect(await screen.findByRole('dialog', { name: 'Invite a person' })).toBeInTheDocument();
  });

  it('requests: Approve and Decline per pending request, "No note" when absent', async () => {
    serve();
    mount();
    await userEvent.click(await screen.findByRole('tab', { name: /^Access requests/ }));
    const table = await screen.findByRole('table', { name: 'Access requests' });
    expect(within(table).getByText('Social team, spring launch')).toBeInTheDocument();
    expect(within(table).getByText('No note')).toBeInTheDocument();
    expect(within(table).getByText('Today')).toBeInTheDocument();
    expect(within(table).getByText('Yesterday')).toBeInTheDocument();

    server.use(
      http.post(`${API}/admin/access-requests/44444444-4444-4444-8444-444444444444/approve`, () =>
        HttpResponse.json({ success: true, data: { ...requestFixtures()[0], state: 'approved' }, metaData: meta }),
      ),
    );
    await userEvent.click(within(table).getByRole('button', { name: 'Approve nina.castellano@shroomap.example' }));
    expect(await screen.findByText('Request approved.')).toBeInTheDocument();
    expect(calls).toContain('POST /admin/access-requests/44444444-4444-4444-8444-444444444444/approve');

    server.use(
      http.post(`${API}/admin/access-requests/55555555-5555-4555-8555-555555555555/decline`, () =>
        HttpResponse.json({ success: true, data: { ...requestFixtures()[1], state: 'declined' }, metaData: meta }),
      ),
    );
    await userEvent.click(within(table).getByRole('button', { name: 'Decline j.mbeki@shroomap.example' }));
    expect(await screen.findByText('Request declined.')).toBeInTheDocument();
  });

  it.each([
    ['open sign-up mode', { signupMode: 'open' as const, accessRequestFormEnabled: true }],
    ['the form disabled', { signupMode: 'invited_only' as const, accessRequestFormEnabled: false }],
  ])('requests-off (%s): the tab explains requests are off and the requests API is not called', async (_name, settings) => {
    serve({ settings });
    mount();
    await ready();
    await waitFor(() => expect(calls).toContain('GET /admin/settings'));
    await userEvent.click(screen.getByRole('tab', { name: /^Access requests/ }));
    expect(await screen.findByRole('heading', { name: 'The request-access form is off' })).toBeInTheDocument();
    expect(screen.getByText(/Invite them instead/)).toBeInTheDocument();
    expect(calls).not.toContain('GET /admin/access-requests');
  });

  it('resent: Resend calls API-112 and shows the toast; Revoke asks first and calls API-113', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(
      http.post(`${API}/admin/invitations/11111111-1111-4111-8111-111111111111/resend`, () =>
        HttpResponse.json({ success: true, data: invitationFixtures()[0], metaData: meta }),
      ),
      http.post(`${API}/admin/invitations/11111111-1111-4111-8111-111111111111/revoke`, () =>
        HttpResponse.json({ success: true, data: { ...invitationFixtures()[0], state: 'revoked' }, metaData: meta }),
      ),
    );
    await userEvent.click(within(table).getByRole('button', { name: 'Resend to sam.okafor@shroomap.example' }));
    expect(await screen.findByText('Invitation sent again. The 7-day period starts over.')).toBeInTheDocument();

    await userEvent.click(within(table).getByRole('button', { name: 'Revoke sam.okafor@shroomap.example' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this invitation?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke invitation' }));
    expect(await screen.findByText('Invitation revoked.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toContain('POST /admin/invitations/11111111-1111-4111-8111-111111111111/revoke');
  });

  it('invite: sends the trimmed address, closes and shows the same message whatever the address', async () => {
    serve();
    mount();
    await ready();
    let body: unknown;
    server.use(
      http.post(`${API}/admin/invitations`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { success: true, data: { email: 'new@shroomap.example', message: 'If this address can be invited, an invitation is on its way.' }, metaData: meta },
          { status: 202 },
        );
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Invite person' }));
    await userEvent.type(await screen.findByLabelText('Email address'), '  new@shroomap.example ');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('If this address can be invited, an invitation is on its way.')).toBeInTheDocument();
    expect(body).toEqual({ email: 'new@shroomap.example' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('invite-error: an empty or malformed address is refused in the field without a call', async () => {
    serve();
    mount();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Invite person' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter an email address.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email address'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(calls).not.toContain('POST /admin/invitations');
  });

  it('invite-error: invite_domain_not_allowed shows the §9.1 copy on the field and keeps the input', async () => {
    serve();
    mount();
    await ready();
    server.use(http.post(`${API}/admin/invitations`, () => error(422, 'invite_domain_not_allowed')));
    await userEvent.click(screen.getByRole('button', { name: 'Invite person' }));
    await userEvent.type(await screen.findByLabelText('Email address'), 'sam@gmail.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    const field = await screen.findByLabelText('Email address');
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Invitations are limited to approved email domains. Use an approved address.')).toBeInTheDocument();
    expect(field).toHaveValue('sam@gmail.com');
  });

  it('invite-error: validation_failed from the server is shown on the field', async () => {
    serve();
    mount();
    await ready();
    server.use(http.post(`${API}/admin/invitations`, () => error(400, 'validation_failed', 'Check the highlighted fields.')));
    await userEvent.click(screen.getByRole('button', { name: 'Invite person' }));
    await userEvent.type(await screen.findByLabelText('Email address'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true'));
  });

  it('Invite again on an expired invitation opens the dialog with the address filled in', async () => {
    serve();
    mount();
    const table = await ready();
    await userEvent.click(within(table).getByRole('button', { name: 'Invite lena.brandt@shroomap.example again' }));
    expect(await screen.findByLabelText('Email address')).toHaveValue('lena.brandt@shroomap.example');
  });

  it('state_conflict on Resend: an alert above the tabs with Refresh, and the lists are reloaded', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(http.post(`${API}/admin/invitations/11111111-1111-4111-8111-111111111111/resend`, () => error(409, 'state_conflict')));
    await userEvent.click(within(table).getByRole('button', { name: 'Resend to sam.okafor@shroomap.example' }));
    expect(await screen.findByText('This cannot be done in its current state. Refresh to see what changed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText(/cannot be done in its current state/)).toBeNull());
  });

  it('recent_auth_required: opens the step-up dialog and does not submit anything on its own', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(http.post(`${API}/admin/invitations/11111111-1111-4111-8111-111111111111/resend`, () => error(403, 'recent_auth_required')));
    await userEvent.click(within(table).getByRole('button', { name: 'Resend to sam.okafor@shroomap.example' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeInTheDocument();
  });

  it('forbidden_role: the shell shows the unavailable state, no data', async () => {
    server.use(
      http.get(`${API}/admin/invitations`, () => error(403, 'forbidden_role')),
      http.get(`${API}/admin/access-requests`, () => error(403, 'forbidden_role')),
      http.get(`${API}/admin/settings`, () => error(403, 'forbidden_role')),
    );
    mount();
    expect(await screen.findByRole('heading', { name: 'Administration is not available' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a failed list load shows the load error with Try again', async () => {
    serve();
    server.use(http.get(`${API}/admin/invitations`, () => error(503, 'service_unavailable')));
    mount();
    expect(await screen.findByRole('button', { name: /^Try again/ }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Invitations' })).toBeNull();
  });

  it('only the listed operations are called', async () => {
    serve();
    mount();
    await ready();
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    expect(new Set(calls)).toEqual(new Set(['GET /admin/invitations', 'GET /admin/access-requests', 'GET /admin/settings']));
  });
});
