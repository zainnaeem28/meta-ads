'use client';

import {
  getAdminListAccessRequestsQueryKey,
  getAdminListInvitationsQueryKey,
  useAdminApproveAccessRequest,
  useAdminCreateInvitation,
  useAdminDeclineAccessRequest,
  useAdminGetSettings,
  useAdminListAccessRequests,
  useAdminListInvitations,
  useAdminResendInvitation,
  useAdminRevokeInvitation,
  useGetMe,
  type AccessRequest,
  type Invitation,
} from '@shroomap/contracts';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Input } from '@shroomap/ui/cmp-004';
import { FormField } from '@shroomap/ui/cmp-010';
import { Dialog } from '@shroomap/ui/cmp-013';
import { Tabs } from '@shroomap/ui/cmp-014';
import { Table, type TableColumn } from '@shroomap/ui/cmp-016';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { AdminShell } from '@shroomap/ui/cmp-031';
import { Icon } from '@shroomap/ui/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { isApiClientError } from '../../lib/api/errors';
import { resolveError } from '../../lib/errors/resolve';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import { COLUMNS, COPY } from './copy';
import { askedLabel, emailBreaks, invitationView, invitedByLabel, relativeDays } from './format';

export const PATH = '/admin/invitations';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTHING: never[] = [];

type TabId = 'invitations' | 'requests';
interface ToastItem {
  id: string;
  variant: 'success';
  message: string;
}

/** The rows of a successful list answer (the client throws on every other status). */
function rowsOf<T>(result: { status: number; data: unknown } | undefined): T[] {
  if (!result || result.status !== 200) return NOTHING;
  return (result.data as { data: T[] }).data;
}

/**
 * SCREEN-012: invitations and access requests for administrators (REQ-003, FLOW-12).
 * API-110..113 (invitations), API-115..117 (access requests) and API-120 (read-only: whether the request form is on,
 * the only API that tells the page it is, see the decision log).
 */
export function InvitationsScreen() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>('invitations');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<unknown>(null);
  const [stepUp, setStepUp] = useState<unknown>(null);
  const toastSeq = useRef(0);
  const now = useRef(Date.now()).current;

  const settings = useAdminGetSettings();
  const settingsData = settings.data?.status === 200 ? settings.data.data.data : undefined;
  const requestsOff = settingsData
    ? settingsData.signupMode === 'open' || !settingsData.accessRequestFormEnabled
    : false;

  const me = useGetMe();
  const meData = me.data?.status === 200 ? me.data.data.data : undefined;
  const meId = meData?.linkState === 'linked' ? meData.id : undefined;

  const invitations = useAdminListInvitations({ limit: 50 });
  // Waits for the settings: with requests off the list is never fetched.
  const requests = useAdminListAccessRequests(
    { state: 'pending', limit: 50 },
    { query: { enabled: !settings.isPending && !requestsOff } },
  );
  const invitationRows = rowsOf<Invitation>(invitations.data);
  const requestRows = rowsOf<AccessRequest>(requests.data);

  const toast = useCallback((message: string) => {
    toastSeq.current += 1;
    setToasts((all) => [...all, { id: `t${toastSeq.current}`, variant: 'success', message }]);
  }, []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getAdminListInvitationsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getAdminListAccessRequestsQueryKey() });
  }, [queryClient]);

  const mark = (id: string, on: boolean) =>
    setPending((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** A failed row action: step-up opens its dialog, everything else is an alert above the tabs (UI-UX §9.1). */
  const fail = (error: unknown) => {
    if (resolveError(error, { surface: 'context' }).code === 'recent_auth_required')
      setStepUp(error);
    else setActionError(error);
    refresh();
  };

  const create = useAdminCreateInvitation();
  const resend = useAdminResendInvitation();
  const revoke = useAdminRevokeInvitation();
  const approve = useAdminApproveAccessRequest();
  const decline = useAdminDeclineAccessRequest();

  const run = async (id: string, call: () => Promise<unknown>, done: string) => {
    setActionError(null);
    mark(id, true);
    try {
      await call();
      toast(done);
      refresh();
    } catch (error) {
      fail(error);
    } finally {
      mark(id, false);
    }
  };

  const openInvite = (prefill = '') => {
    setEmail(prefill);
    setFieldError(null);
    setDialogError(null);
    setInviteOpen(true);
  };

  const sendInvite = async () => {
    const address = email.trim();
    if (!address) return setFieldError(COPY.dialog.required);
    if (!EMAIL.test(address)) return setFieldError(COPY.dialog.malformed);
    setFieldError(null);
    setDialogError(null);
    mark('invite', true);
    try {
      await create.mutateAsync({ data: { email: address } });
      setInviteOpen(false);
      toast(COPY.toast.invited);
      refresh();
    } catch (error) {
      const view = resolveError(error, { surface: 'context' });
      if (view.code === 'invite_domain_not_allowed' || view.code === 'validation_failed')
        setFieldError(view.message);
      else if (view.code === 'recent_auth_required') {
        setInviteOpen(false);
        setStepUp(error);
      } else setDialogError(view.message);
    } finally {
      mark('invite', false);
    }
  };

  const invitationColumns: TableColumn<Invitation>[] = [
    {
      id: 'email',
      header: COLUMNS.invitations.email,
      cell: (r) => <span className="font-semibold">{emailBreaks(r.email)}</span>,
    },
    {
      id: 'state',
      header: COLUMNS.invitations.state,
      cell: (r) => {
        const v = invitationView(r);
        return (
          <Badge variant={v.variant} icon={v.icon}>
            {v.label}
          </Badge>
        );
      },
    },
    { id: 'by', header: COLUMNS.invitations.by, cell: (r) => invitedByLabel(r.invitedBy, meId) },
    {
      id: 'expires',
      header: COLUMNS.invitations.expires,
      cell: (r) =>
        r.state === 'invited' || r.state === 'expired' ? relativeDays(r.expiresAt, now) : '—',
    },
    {
      id: 'actions',
      header: COLUMNS.invitations.actions,
      cell: (r) => {
        const busy = pending.has(r.id);
        if (r.state === 'invited')
          return (
            <span className="flex flex-row items-start gap-2 whitespace-nowrap md:flex-col lg:flex-row">
              <Button
                variant="outline"
                size="sm"
                pending={busy}
                pendingLabel="Working…"
                aria-label={`Resend to ${r.email}`}
                onClick={() =>
                  void run(
                    r.id,
                    () => resend.mutateAsync({ invitationId: r.id }),
                    COPY.toast.resent,
                  )
                }
              >
                Resend
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Revoke ${r.email}`}
                onClick={() => setRevoking(r)}
              >
                Revoke
              </Button>
            </span>
          );
        if (r.state === 'expired')
          return (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Invite ${r.email} again`}
              onClick={() => openInvite(r.email)}
            >
              Invite again
            </Button>
          );
        return null;
      },
    },
  ];

  const requestColumns: TableColumn<AccessRequest>[] = [
    {
      id: 'email',
      header: COLUMNS.requests.email,
      cell: (r) => <span className="font-semibold">{emailBreaks(r.email)}</span>,
    },
    { id: 'note', header: COLUMNS.requests.note, cell: (r) => r.note || 'No note' },
    { id: 'asked', header: COLUMNS.requests.asked, cell: (r) => askedLabel(r.createdAt, now) },
    {
      id: 'actions',
      header: COLUMNS.requests.actions,
      cell: (r) => {
        const busy = pending.has(r.id);
        return (
          <span className="flex flex-row items-start gap-2 whitespace-nowrap md:flex-col lg:flex-row">
            <Button
              size="sm"
              pending={busy}
              pendingLabel="Working…"
              aria-label={`Approve ${r.email}`}
              onClick={() =>
                void run(
                  r.id,
                  () => approve.mutateAsync({ accessRequestId: r.id }),
                  COPY.toast.approved,
                )
              }
            >
              <Icon name="check" size={16} />
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`Decline ${r.email}`}
              onClick={() =>
                void run(
                  r.id,
                  () => decline.mutateAsync({ accessRequestId: r.id }),
                  COPY.toast.declined,
                )
              }
            >
              Decline
            </Button>
          </span>
        );
      },
    },
  ];

  const forbidden = [invitations.error, requests.error, settings.error].some(
    (e) => isApiClientError(e) && e.code === 'forbidden_role',
  );

  const invitationsPanel = invitations.isError ? (
    <ErrorNotice error={invitations.error} onAction={() => void invitations.refetch()} />
  ) : (
    <Table
      label="Invitations"
      columns={invitationColumns}
      rows={invitationRows}
      rowKey={(r) => r.id}
      state={invitations.isPending ? 'loading' : invitationRows.length === 0 ? 'empty' : 'content'}
      skeletonRows={3}
      emptyTitle={COPY.empty.title}
      emptyDescription={COPY.empty.body}
      emptyAction={
        <Button onClick={() => openInvite()}>
          <Icon name="mail-plus" size={16} />
          {COPY.invite}
        </Button>
      }
    />
  );

  const requestsPanel = requestsOff ? (
    <div className="rounded-md border border-border bg-card">
      <EmptyState
        title={COPY.requestsOff.title}
        description={COPY.requestsOff.body}
        headingLevel={2}
      />
    </div>
  ) : requests.isError ? (
    <ErrorNotice error={requests.error} onAction={() => void requests.refetch()} />
  ) : (
    <Table
      label="Access requests"
      columns={requestColumns}
      rows={requestRows}
      rowKey={(r) => r.id}
      state={requests.isPending ? 'loading' : requestRows.length === 0 ? 'empty' : 'content'}
      skeletonRows={2}
      emptyTitle={COPY.requestsEmpty.title}
      emptyDescription={COPY.requestsEmpty.body}
    />
  );

  const tabs = useMemo(
    () => [
      {
        id: 'invitations',
        label: 'Invitations',
        count: invitations.isSuccess ? invitationRows.length : undefined,
      },
      {
        id: 'requests',
        label: 'Access requests',
        count: !requestsOff && requests.isSuccess ? requestRows.length : undefined,
      },
    ],
    [
      invitations.isSuccess,
      invitationRows.length,
      requestsOff,
      requests.isSuccess,
      requestRows.length,
    ],
  );

  return (
    <AdminShell
      path={PATH}
      pageName={COPY.title}
      unavailable={forbidden}
      toasts={toasts}
      onDismissToast={(id) => setToasts((all) => all.filter((t) => t.id !== id))}
      onSignOut={() => window.location.assign(ROUTES.signIn)}
    >
      <div className="mx-auto flex w-full max-w-wide flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-h1 font-semibold">{COPY.title}</h1>
            <p className="text-ui text-muted-foreground">{COPY.description}</p>
          </div>
          <Button onClick={() => openInvite()}>
            <Icon name="mail-plus" size={16} />
            {COPY.invite}
          </Button>
        </div>
        {actionError ? (
          <ErrorNotice
            error={actionError}
            surface="context"
            onAction={(action) => {
              setActionError(null);
              if (action === 'refresh') refresh();
            }}
          />
        ) : null}
        <Tabs
          tabs={tabs}
          value={tab}
          onValueChange={(id) => setTab(id as TabId)}
          label={COPY.tabsLabel}
        >
          {tab === 'invitations' ? invitationsPanel : requestsPanel}
        </Tabs>
      </div>

      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        variant="form"
        title={COPY.dialog.title}
        description={COPY.dialog.description}
        confirmLabel={COPY.dialog.send}
        pending={pending.has('invite')}
        error={dialogError ?? undefined}
        onConfirm={() => void sendInvite()}
      >
        <FormField label={COPY.dialog.email} error={fieldError ?? undefined}>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="off"
              value={email}
              data-autofocus=""
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>
      </Dialog>

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={COPY.revoke.title}
        description={revoking ? COPY.revoke.body(revoking.email) : undefined}
        confirmLabel={COPY.revoke.confirm}
        destructive
        pending={revoking ? pending.has(revoking.id) : false}
        onConfirm={() => {
          const target = revoking;
          if (!target) return;
          void run(
            target.id,
            () => revoke.mutateAsync({ invitationId: target.id }),
            COPY.toast.revoked,
          ).then(() => setRevoking(null));
        }}
      />

      {stepUp ? (
        <ErrorNotice
          error={stepUp}
          surface="context"
          navigate={(href) => window.location.assign(href)}
          returnTo={PATH}
          onAction={(action) => {
            if (action === 'confirm') window.location.assign(signInUrl(PATH));
            else setStepUp(null);
          }}
        />
      ) : null}
    </AdminShell>
  );
}
