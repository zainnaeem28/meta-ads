// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../lib/api/msw.setup';
import { ApiProvider } from '../../providers/api-provider';
import { AccountsScreen } from './AccountsScreen';
import { accountFixtures, erasureFixtures, meFixture, meta, metaPage } from './fixtures';

const API = 'http://api.test/api/v1';
const MARCUS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const click = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });
const type = (el: HTMLElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value } });
  });
afterEach(cleanup);

const failure = (status: number, code: string, message = 'x') =>
  HttpResponse.json(
    { success: false, error: { code, message }, metaData: { requestId: 'req-1' } },
    { status },
  );

const calls: string[] = [];
server.events.on('request:start', ({ request }) => {
  calls.push(`${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}`);
});

function serve(users = accountFixtures(), next: string | null = null) {
  calls.length = 0;
  server.use(
    http.get(`${API}/admin/users`, () =>
      HttpResponse.json({ success: true, data: users, metaData: metaPage(users.length, next) }),
    ),
    http.get(`${API}/admin/erasures`, () =>
      HttpResponse.json({
        success: true,
        data: erasureFixtures(),
        metaData: metaPage(erasureFixtures().length),
      }),
    ),
    http.get(`${API}/me`, () =>
      HttpResponse.json({ success: true, data: meFixture(), metaData: meta }),
    ),
  );
}

const mount = () =>
  render(
    <ApiProvider origin="http://api.test" getToken={() => Promise.resolve('t')} identity="admin-1">
      <AccountsScreen />
    </ApiProvider>,
  );

const ready = async () => {
  await screen.findByText('marcus.oyelaran@shroomap.example');
  return screen.getByRole('table', { name: 'Accounts' });
};

const openMenu = async (email: string) => {
  await click(screen.getByRole('button', { name: `More actions for ${email}` }));
  return screen.findByRole('menu');
};

describe('SCREEN-011 accounts', () => {
  it('default: email and user ID, role, status, You marker and the shell marks Accounts', async () => {
    serve();
    mount();
    const table = await ready();
    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument();
    expect(within(table).getByText('dana.whitfield@shroomap.example')).toBeInTheDocument();
    expect(within(table).getByText('You')).toBeInTheDocument();
    expect(within(table).getByText('u_bbbb…bbbb')).toBeInTheDocument();
    expect(within(table).getByText('Administrator')).toBeInTheDocument();
    expect(within(table).getByText('Suspended')).toBeInTheDocument();
    expect(within(table).getByText('Removed')).toBeInTheDocument();
    expect(within(table).getByText('Erasing: step 3 of 5')).toBeInTheDocument();
    expect(
      within(table).getByRole('button', { name: 'Reinstate tom.lindqvist@shroomap.example' }),
    ).toBeInTheDocument();
    expect(screen.getByText('5 accounts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Accounts/, current: 'page' })).toBeInTheDocument();
  });

  it('loading: skeleton rows with aria-busy before the first answer', () => {
    server.use(
      http.get(`${API}/admin/users`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
      http.get(`${API}/admin/erasures`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );
    mount();
    expect(screen.getByRole('table', { name: 'Accounts' })).toHaveAttribute('aria-busy', 'true');
  });

  it('error: honest message and Try again reloads', async () => {
    serve();
    server.use(http.get(`${API}/admin/users`, () => failure(500, 'internal_error')));
    mount();
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Accounts could not be loaded' },
        { timeout: 8000 },
      ),
    ).toBeInTheDocument();
    server.use(
      http.get(`${API}/admin/users`, () =>
        HttpResponse.json({
          success: true,
          data: accountFixtures(),
          metaData: metaPage(5),
        }),
      ),
    );
    await click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('marcus.oyelaran@shroomap.example')).toBeInTheDocument();
  });

  it('forbidden_role: the shell shows the unavailable state', async () => {
    serve();
    server.use(http.get(`${API}/admin/users`, () => failure(403, 'forbidden_role')));
    mount();
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Accounts' })).toBeNull());
    expect(screen.queryByRole('link', { name: /Invitations/ })).toBeNull();
  });

  it('only-you: the lone administrator is invited to invite their team', async () => {
    serve([accountFixtures()[0]!]);
    mount();
    expect(await screen.findByText(/You are the only person here/)).toBeInTheDocument();
  });

  it('invite dialog: validates, sends API-111 and toasts; a domain refusal stays under the field', async () => {
    serve();
    mount();
    await ready();
    await click(screen.getAllByRole('button', { name: 'Invite person' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Invite a person' });
    await click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText('Enter an email address.')).toBeInTheDocument();
    server.use(
      http.post(`${API}/admin/invitations`, () =>
        failure(
          422,
          'invite_domain_not_allowed',
          'Invitations are limited to approved email domains.',
        ),
      ),
    );
    await type(within(dialog).getByLabelText('Email address'), 'a@elsewhere.example');
    await click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(
      await within(dialog).findByText(/limited to approved email domains/),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Invite a person' })).toBeInTheDocument();
    server.use(
      http.post(`${API}/admin/invitations`, () =>
        HttpResponse.json(
          {
            success: true,
            data: {
              email: 'sam@shroomap.example',
              message: 'If this address can be invited, an invitation is on its way.',
            },
            metaData: meta,
          },
          { status: 202 },
        ),
      ),
    );
    await type(within(dialog).getByLabelText('Email address'), 'sam@shroomap.example');
    await click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation sent.')).toBeInTheDocument();
    expect(calls).toContain('POST /admin/invitations');
  });

  it('menu-open: Suspend, Grant admin and Remove for others; every item disabled on your own row', async () => {
    serve();
    mount();
    await ready();
    const menu = await openMenu('marcus.oyelaran@shroomap.example');
    expect(within(menu).getByRole('menuitem', { name: 'Suspend' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Grant admin' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toBeEnabled();
    fireEvent.keyDown(menu, { key: 'Escape' });
    const own = await openMenu('dana.whitfield@shroomap.example');
    expect(within(own).getByRole('menuitem', { name: 'Revoke admin' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(own).getByRole('menuitem', { name: 'Remove' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('suspend-confirm: names the account, calls API-101 and toasts', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(
      http.post(`${API}/admin/users/${MARCUS}/suspend`, () =>
        HttpResponse.json({
          success: true,
          data: { ...accountFixtures()[1], status: 'suspended' },
          metaData: meta,
        }),
      ),
    );
    await click(
      within(table).getByRole('button', { name: 'Suspend marcus.oyelaran@shroomap.example' }),
    );
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(
      within(dialog).getByText(/Suspend marcus.oyelaran@shroomap.example\?/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/signed out at once/)).toBeInTheDocument();
    await click(within(dialog).getByRole('button', { name: 'Suspend account' }));
    expect(await screen.findByText('Account suspended.')).toBeInTheDocument();
    expect(calls).toContain(`POST /admin/users/${MARCUS}/suspend`);
  });

  it('last-admin: the refusal is an alert above the table with the §9.1 copy and Close', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(
      http.post(`${API}/admin/users/${accountFixtures()[0]!.id}/suspend`, () =>
        failure(422, 'last_admin'),
      ),
    );
    await click(
      within(table).getByRole('button', { name: 'Suspend dana.whitfield@shroomap.example' }),
    );
    await click(screen.getByRole('button', { name: 'Suspend account' }));
    expect(
      await screen.findByText(
        'This is the last administrator. Make another account an administrator first.',
      ),
    ).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/last administrator/)).toBeNull();
  });

  it('self_action: the refusal copy of §9.1', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(
      http.post(`${API}/admin/users/${accountFixtures()[0]!.id}/suspend`, () =>
        failure(422, 'self_action'),
      ),
    );
    await click(
      within(table).getByRole('button', { name: 'Suspend dana.whitfield@shroomap.example' }),
    );
    await click(screen.getByRole('button', { name: 'Suspend account' }));
    expect(await screen.findByText('You cannot do this to your own account.')).toBeInTheDocument();
  });

  it('remove-confirm: the button waits for the exact email; a server mismatch stays in the dialog; success starts erasure', async () => {
    serve();
    mount();
    await ready();
    const menu = await openMenu('tom.lindqvist@shroomap.example');
    await click(within(menu).getByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this account permanently?' });
    const button = within(dialog).getByRole('button', { name: 'Remove account' });
    expect(button).toBeDisabled();
    const field = within(dialog).getByLabelText(/Type/);
    await type(field, 'tom.lindqvist@shroomap');
    expect(button).toBeDisabled();
    await type(field, 'tom.lindqvist@shroomap.example');
    expect(button).toBeEnabled();

    server.use(
      http.post(`${API}/admin/users/${TOM}/remove`, () => failure(422, 'confirmation_mismatch')),
    );
    await click(button);
    expect(await within(dialog).findByText(/does not match/)).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: 'Remove this account permanently?' }),
    ).toBeInTheDocument();

    let body: unknown;
    server.use(
      http.post(`${API}/admin/users/${TOM}/remove`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          {
            success: true,
            data: { deletionRunId: '99999999-9999-4999-8999-999999999999', state: 'running' },
            metaData: meta,
          },
          { status: 202 },
        );
      }),
    );
    await click(within(dialog).getByRole('button', { name: 'Remove account' }));
    expect(await screen.findByText(/Removal started/)).toBeInTheDocument();
    expect(body).toEqual({ confirmation: 'tom.lindqvist@shroomap.example' });
  });

  it('reinstate and role: API-102 and API-104 with If-Match from the row version', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(
      http.post(`${API}/admin/users/${TOM}/reinstate`, () =>
        HttpResponse.json({
          success: true,
          data: { ...accountFixtures()[3], status: 'active' },
          metaData: meta,
        }),
      ),
    );
    await click(
      within(table).getByRole('button', { name: 'Reinstate tom.lindqvist@shroomap.example' }),
    );
    expect(await screen.findByText('Account reinstated.')).toBeInTheDocument();

    let ifMatch: string | null = null;
    let body: unknown;
    server.use(
      http.put(`${API}/admin/users/${MARCUS}/role`, async ({ request }) => {
        ifMatch = request.headers.get('if-match');
        body = await request.json();
        return HttpResponse.json({
          success: true,
          data: { ...accountFixtures()[1], role: 'admin', version: 4 },
          metaData: meta,
        });
      }),
    );
    const menu = await openMenu('marcus.oyelaran@shroomap.example');
    await click(within(menu).getByRole('menuitem', { name: 'Grant admin' }));
    expect(await screen.findByText('Administrator access granted.')).toBeInTheDocument();
    expect(ifMatch).toBe('"3"');
    expect(body).toEqual({ role: 'admin' });
  });

  it('version_conflict on role: the alert offers the latest version', async () => {
    serve();
    mount();
    await ready();
    server.use(
      http.put(`${API}/admin/users/${MARCUS}/role`, () => failure(409, 'version_conflict')),
    );
    const menu = await openMenu('marcus.oyelaran@shroomap.example');
    await click(within(menu).getByRole('menuitem', { name: 'Grant admin' }));
    expect(await screen.findByText(/changed somewhere else/)).toBeInTheDocument();
  });

  it('recent_auth_required: the step-up dialog, not a toast', async () => {
    serve();
    mount();
    const table = await ready();
    server.use(
      http.post(`${API}/admin/users/${TOM}/reinstate`, () => failure(403, 'recent_auth_required')),
    );
    await click(
      within(table).getByRole('button', { name: 'Reinstate tom.lindqvist@shroomap.example' }),
    );
    expect(await screen.findByRole('button', { name: 'Confirm sign-in' })).toBeInTheDocument();
  });

  it('erasures: IDs, step names, state and objects left; no email', async () => {
    serve();
    mount();
    await ready();
    await click(screen.getByRole('tab', { name: /^Account erasures/ }));
    const table = await screen.findByRole('table', { name: 'Account erasures' });
    expect(within(table).getByText('u_8f3a…c21d')).toBeInTheDocument();
    expect(within(table).getAllByText('3 of 5: Remove stored media')).toHaveLength(2);
    expect(within(table).getByText('5 of 5: Delete account record')).toBeInTheDocument();
    expect(within(table).getByText('Stuck')).toBeInTheDocument();
    expect(within(table).getByText('42')).toBeInTheDocument();
    expect(table.textContent).not.toMatch(/@/);
  });

  it('filter and paging: status chip calls API-100 with status, Next follows the cursor', async () => {
    serve(accountFixtures(), 'cursor-2');
    mount();
    await ready();
    const urls: string[] = [];
    server.events.on('request:start', ({ request }) => urls.push(request.url));
    await click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urls.some((u) => u.includes('cursor=cursor-2'))).toBe(true));
    await click(screen.getByRole('button', { name: /^Suspended/ }));
    await waitFor(() => expect(urls.some((u) => u.includes('status=suspended'))).toBe(true));
    expect(window.location.search).toBe('?status=suspended');
  });

  it('search narrows the loaded page by email', async () => {
    serve();
    mount();
    const table = await ready();
    await type(screen.getByRole('searchbox'), 'priya');
    expect(within(table).queryByText('marcus.oyelaran@shroomap.example')).toBeNull();
    expect(within(table).getByText('priya.raman@shroomap.example')).toBeInTheDocument();
  });
});
