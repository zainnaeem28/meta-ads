'use client';

import {
  adminSetRole,
  getAdminListErasuresQueryKey,
  getAdminListInvitationsQueryKey,
  getAdminListUsersQueryKey,
  useAdminCreateInvitation,
  useAdminListErasures,
  useAdminListUsers,
  useAdminReinstateUser,
  useAdminRemoveUser,
  useAdminSuspendUser,
  useGetMe,
  type AdminUser,
  type DeletionRun,
} from '@shroomap/contracts';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Input } from '@shroomap/ui/cmp-004';
import { FormField } from '@shroomap/ui/cmp-010';
import { Dialog } from '@shroomap/ui/cmp-013';
import { Tabs } from '@shroomap/ui/cmp-014';
import { Table, type TableColumn } from '@shroomap/ui/cmp-016';
import { FilterBar, NoMatches } from '@shroomap/ui/cmp-017';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { Menu, type MenuItem } from '@shroomap/ui/cmp-020';
import { AdminShell } from '@shroomap/ui/cmp-031';
import { Icon } from '@shroomap/ui/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { isApiClientError } from '../../lib/api/errors';
import { resolveError } from '../../lib/errors/resolve';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import { COLUMNS, COPY, ERASURE_STEPS, STATUS_FILTERS } from './copy';
import { addedLabel, shortId } from './format';

export const PATH = '/admin/accounts';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTHING: never[] = [];
const PAGE = 50;

type TabId = 'accounts' | 'erasures';
interface ToastItem {
  id: string;
  variant: 'success';
  message: string;
}
type Confirm = { kind: 'suspend' | 'remove'; user: AdminUser } | null;

function rowsOf<T>(result: { status: number; data: unknown } | undefined): T[] {
  if (!result || result.status !== 200) return NOTHING;
  return (result.data as { data: T[] }).data;
}

const readUrl = () => {
  if (typeof window === 'undefined') return { q: '', status: '' };
  const p = new URLSearchParams(window.location.search);
  const status = p.get('status') ?? '';
  return {
    q: p.get('q') ?? '',
    status: STATUS_FILTERS.some((f) => f.id === status) ? status : '',
  };
};

const STATUS_VIEW = {
  active: { label: 'Active', variant: 'success', icon: 'circle-check' },
  suspended: { label: 'Suspended', variant: 'warning', icon: 'ban' },
  removed: { label: 'Removed', variant: 'neutral', icon: 'user-x' },
} as const;

const ERASURE_VIEW = {
  running: { label: 'Running', variant: 'info', icon: 'clock' },
  completed: { label: 'Completed', variant: 'success', icon: 'circle-check' },
  stuck: { label: 'Stuck', variant: 'warning', icon: 'triangle-alert' },
} as const;

/**
 * SCREEN-011: accounts for administrators (REQ-003, REQ-026, REQ-013, FLOW-12).
 * API-100 (list), 101 (suspend), 102 (reinstate), 103 (remove), 104 (role), 105 (erasures), 111 (invite dialog).
 */
export function AccountsScreen() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>('accounts');
  const [filters, setFilters] = useState(readUrl);
  const [cursors, setCursors] = useState<string[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<unknown>(null);
  const [stepUp, setStepUp] = useState<unknown>(null);
  const toastSeq = useRef(0);
  const now = useRef(Date.now()).current;

  const me = useGetMe();
  const meData = me.data?.status === 200 ? me.data.data.data : undefined;
  const meId = meData?.linkState === 'linked' ? meData.id : undefined;

  const cursor = cursors[cursors.length - 1];
  const users = useAdminListUsers({
    limit: PAGE,
    ...(filters.status ? { status: filters.status as AdminUser['status'] } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const erasures = useAdminListErasures({ limit: PAGE });
  const userRows = rowsOf<AdminUser>(users.data);
  const erasureRows = rowsOf<DeletionRun>(erasures.data);
  const nextCursor =
    users.data?.status === 200 ? users.data.data.metaData.pagination.nextCursor : null;

  const visibleRows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return q ? userRows.filter((u) => u.email.toLowerCase().includes(q)) : userRows;
  }, [userRows, filters.q]);

  const syncUrl = (next: { q: string; status: string }) => {
    const params = new URLSearchParams();
    if (next.q) params.set('q', next.q);
    if (next.status) params.set('status', next.status);
    const search = params.toString();
    window.history.replaceState(null, '', `${PATH}${search ? `?${search}` : ''}`);
  };
  const setFilter = (change: Partial<{ q: string; status: string }>) => {
    const next = { ...filters, ...change };
    setFilters(next);
    if (change.status !== undefined) setCursors([]);
    syncUrl(next);
  };

  const toast = useCallback((message: string) => {
    toastSeq.current += 1;
    setToasts((all) => [...all, { id: `t${toastSeq.current}`, variant: 'success', message }]);
  }, []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getAdminListUsersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getAdminListErasuresQueryKey() });
  }, [queryClient]);

  const mark = (id: string, on: boolean) =>
    setPending((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const suspend = useAdminSuspendUser();
  const reinstate = useAdminReinstateUser();
  const remove = useAdminRemoveUser();
  const create = useAdminCreateInvitation();

  /** A failed row action: step-up opens its dialog, everything else is an alert above the table (UI-UX §9.1). */
  const fail = (error: unknown) => {
    if (resolveError(error, { surface: 'context' }).code === 'recent_auth_required')
      setStepUp(error);
    else setActionError(error);
    refresh();
  };

  /** Runs one row action; resolves true when it succeeded. */
  const run = async (id: string, call: () => Promise<unknown>, done: string) => {
    setActionError(null);
    mark(id, true);
    try {
      await call();
      toast(done);
      refresh();
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      mark(id, false);
    }
  };

  const openInvite = () => {
    setEmail('');
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
      void queryClient.invalidateQueries({ queryKey: getAdminListInvitationsQueryKey() });
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

  const setRole = (user: AdminUser) => {
    const role = user.role === 'admin' ? 'user' : 'admin';
    void run(
      user.id,
      () => adminSetRole(user.id, { role }, { headers: { 'If-Match': `"${user.version}"` } }),
      role === 'admin' ? COPY.toast.granted : COPY.toast.revoked,
    );
  };
  const doReinstate = (user: AdminUser) =>
    void run(user.id, () => reinstate.mutateAsync({ userId: user.id }), COPY.toast.reinstated);

  const confirmAction = async (typed?: string) => {
    if (!confirm) return;
    const { kind, user } = confirm;
    setConfirmError(null);
    mark(user.id, true);
    setActionError(null);
    try {
      if (kind === 'suspend') await suspend.mutateAsync({ userId: user.id });
      else
        await remove.mutateAsync({ userId: user.id, data: { confirmation: typed ?? user.email } });
      toast(kind === 'suspend' ? COPY.toast.suspended : COPY.toast.removed);
      setConfirm(null);
      refresh();
    } catch (error) {
      const view = resolveError(error, { surface: 'context' });
      if (view.code === 'confirmation_mismatch') setConfirmError(view.message);
      else {
        setConfirm(null);
        fail(error);
      }
    } finally {
      mark(user.id, false);
    }
  };

  const menuItems = (user: AdminUser): MenuItem[] => {
    const own = user.id === meId;
    return [
      user.status === 'suspended'
        ? { id: 'reinstate', label: 'Reinstate', disabled: own, onSelect: () => doReinstate(user) }
        : {
            id: 'suspend',
            label: 'Suspend',
            disabled: own,
            onSelect: () => setConfirm({ kind: 'suspend', user }),
          },
      {
        id: 'role',
        label: user.role === 'admin' ? 'Revoke admin' : 'Grant admin',
        disabled: own,
        onSelect: () => setRole(user),
      },
      {
        id: 'remove',
        label: 'Remove',
        destructive: true,
        disabled: own,
        onSelect: () => {
          setConfirmError(null);
          setConfirm({ kind: 'remove', user });
        },
      },
    ];
  };

  const userColumns: TableColumn<AdminUser>[] = [
    {
      id: 'account',
      header: COLUMNS.account,
      cell: (u) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold break-all">{u.email}</span>
            {u.id === meId ? <Badge variant="primary">{COPY.you}</Badge> : null}
          </span>
          <span className="font-mono text-caption text-muted-foreground">{shortId(u.id)}</span>
        </span>
      ),
    },
    {
      id: 'role',
      header: COLUMNS.role,
      cell: (u) =>
        u.role === 'admin' ? (
          <Badge variant="primary" icon="shield-check">
            Administrator
          </Badge>
        ) : (
          <Badge>Operator</Badge>
        ),
    },
    {
      id: 'status',
      header: COLUMNS.status,
      cell: (u) => {
        const v = STATUS_VIEW[u.status];
        return (
          <span className="flex flex-col items-start gap-1">
            <Badge variant={v.variant} icon={v.icon}>
              {v.label}
            </Badge>
            {u.status === 'removed' && u.erasure ? (
              <span className="text-caption text-muted-foreground">
                Erasing: step {u.erasure.step} of 5
              </span>
            ) : null}
          </span>
        );
      },
    },
    { id: 'added', header: COLUMNS.added, cell: (u) => addedLabel(u.createdAt, now) },
    {
      id: 'actions',
      header: COLUMNS.actions,
      cell: (u) => {
        if (u.status === 'removed') return null;
        const busy = pending.has(u.id);
        return (
          <span className="flex flex-row items-center gap-2 whitespace-nowrap">
            {u.status === 'suspended' ? (
              <Button
                variant="outline"
                size="sm"
                pending={busy}
                pendingLabel="Working…"
                disabled={u.id === meId}
                aria-label={`Reinstate ${u.email}`}
                onClick={() => doReinstate(u)}
              >
                Reinstate
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`Suspend ${u.email}`}
                onClick={() => setConfirm({ kind: 'suspend', user: u })}
              >
                Suspend
              </Button>
            )}
            <Menu
              trigger={<Icon name="ellipsis" size={16} />}
              label={`More actions for ${u.email}`}
              items={menuItems(u)}
              align="end"
            />
          </span>
        );
      },
    },
  ];

  const erasureColumns: TableColumn<DeletionRun>[] = [
    {
      id: 'user',
      header: COPY.erasures.userId,
      cell: (r) => <span className="font-mono">{shortId(r.subjectId)}</span>,
    },
    {
      id: 'step',
      header: COPY.erasures.step,
      cell: (r) => `${r.step} of 5: ${ERASURE_STEPS[r.step] ?? 'Working'}`,
    },
    {
      id: 'state',
      header: COPY.erasures.state,
      cell: (r) => {
        const v = ERASURE_VIEW[r.state];
        return (
          <Badge variant={v.variant} icon={v.icon}>
            {v.label}
          </Badge>
        );
      },
    },
    { id: 'left', header: COPY.erasures.left, cell: (r) => r.remainingObjects ?? '—' },
  ];

  const forbidden = [users.error, erasures.error].some(
    (e) => isApiClientError(e) && e.code === 'forbidden_role',
  );
  const stepUpList = [users.error, erasures.error].find(
    (e) => isApiClientError(e) && e.code === 'recent_auth_required',
  );
  const listFailed = users.isError && !stepUpList;
  const onlyYou =
    users.isSuccess &&
    !filters.status &&
    !filters.q &&
    userRows.length === 1 &&
    userRows[0]?.id === meId;
  const filtered = filters.q !== '' || filters.status !== '';

  const accountsPanel = (
    <div className="flex flex-col gap-4">
      <FilterBar
        searchLabel={COPY.searchLabel}
        query={filters.q}
        onQueryChange={(q) => setFilter({ q })}
        chips={STATUS_FILTERS.map((f) => ({ id: f.id, label: f.label }))}
        status={filters.status}
        onStatusChange={(status) => setFilter({ status })}
        onClearAll={() => setFilter({ q: '', status: '' })}
      />
      {listFailed ? (
        <div className="rounded-md border border-border bg-card">
          <EmptyState
            variant="error"
            title={COPY.error.title}
            description={COPY.error.body}
            headingLevel={2}
            onRetry={() => void users.refetch()}
          />
        </div>
      ) : users.isSuccess && visibleRows.length === 0 && filtered ? (
        <NoMatches onClearAll={() => setFilter({ q: '', status: '' })} />
      ) : (
        <>
          <Table
            label="Accounts"
            columns={userColumns}
            rows={visibleRows}
            rowKey={(u) => u.id}
            pendingKeys={pending}
            state={users.isPending ? 'loading' : visibleRows.length === 0 ? 'empty' : 'content'}
            skeletonRows={5}
            emptyTitle={COPY.empty.title}
            emptyDescription={COPY.empty.body}
          />
          {onlyYou ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-card p-4">
              <p className="text-ui text-muted-foreground">{COPY.onlyYou}</p>
              <Button onClick={openInvite}>
                <Icon name="user-plus" size={16} />
                {COPY.invite}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {users.isSuccess ? (
        <nav
          aria-label={COPY.paging.label}
          className="flex flex-wrap items-center justify-between gap-3 text-ui text-muted-foreground"
        >
          <span role="status">{COPY.paging.count(visibleRows.length)}</span>
          <div className="inline-flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 0}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              {COPY.paging.previous}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!nextCursor}
              onClick={() => nextCursor && setCursors((c) => [...c, nextCursor])}
            >
              {COPY.paging.next}
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );

  const erasuresPanel = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-section font-semibold">{COPY.erasures.title}</h2>
        <p className="text-ui text-muted-foreground">{COPY.erasures.note}</p>
      </div>
      {erasures.isError && !stepUpList ? (
        <ErrorNotice error={erasures.error} onAction={() => void erasures.refetch()} />
      ) : (
        <Table
          label="Account erasures"
          columns={erasureColumns}
          rows={erasureRows}
          rowKey={(r) => r.id}
          state={erasures.isPending ? 'loading' : erasureRows.length === 0 ? 'empty' : 'content'}
          skeletonRows={3}
          emptyTitle={COPY.erasures.empty.title}
          emptyDescription={COPY.erasures.empty.body}
        />
      )}
    </div>
  );

  const tabs = [
    { id: 'accounts', label: 'Accounts', count: users.isSuccess ? userRows.length : undefined },
    {
      id: 'erasures',
      label: 'Account erasures',
      count: erasures.isSuccess ? erasureRows.length : undefined,
    },
  ];

  const target = confirm?.user;
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
          <Button onClick={openInvite}>
            <Icon name="user-plus" size={16} />
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
          {tab === 'accounts' ? accountsPanel : erasuresPanel}
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
        open={confirm?.kind === 'suspend'}
        onClose={() => setConfirm(null)}
        title={target ? COPY.suspend.title(target.email) : ''}
        description={COPY.suspend.body}
        confirmLabel={COPY.suspend.confirm}
        destructive
        pending={target ? pending.has(target.id) : false}
        onConfirm={() => void confirmAction()}
      />

      <Dialog
        open={confirm?.kind === 'remove'}
        onClose={() => setConfirm(null)}
        variant="typed-confirm"
        title={COPY.remove.title}
        description={COPY.remove.body}
        confirmText={target?.email}
        confirmLabel={COPY.remove.confirm}
        destructive
        error={confirmError ?? undefined}
        pending={target ? pending.has(target.id) : false}
        onConfirm={() => void confirmAction(target?.email)}
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
      {stepUpList ? (
        <ErrorNotice
          error={stepUpList}
          surface="context"
          navigate={(href) => window.location.assign(href)}
          returnTo={PATH}
          onAction={(action) => {
            if (action === 'confirm') window.location.assign(signInUrl(PATH));
          }}
        />
      ) : null}
    </AdminShell>
  );
}
