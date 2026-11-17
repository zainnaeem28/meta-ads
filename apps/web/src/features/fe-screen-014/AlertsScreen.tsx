'use client';

import {
  adminAcknowledgeAlert,
  adminListAlerts,
  getAdminListAlertsQueryKey,
  type Alert,
  type AlertPage,
} from '@shroomap/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { Badge } from '@shroomap/ui/cmp-007';
import { Button } from '@shroomap/ui/cmp-003';
import { Card } from '@shroomap/ui/cmp-018';
import { AdminShell } from '@shroomap/ui/cmp-031';
import { Icon } from '@shroomap/ui/icons';
import { useState } from 'react';
import { ErrorNotice } from '../../components/errors';
import { isApiClientError } from '../../lib/api/client';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import { SCREEN_014_COPY as COPY, formatRaised, presentAlert } from './copy';

const PAGE_SIZE = 50;
const KEY = getAdminListAlertsQueryKey({ limit: PAGE_SIZE });
const PATH = '/admin/alerts';

type Pages = InfiniteData<AlertPage, string | undefined>;

async function loadPage(cursor: string | undefined, signal?: AbortSignal): Promise<AlertPage> {
  const res = await adminListAlerts(
    { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    { signal },
  );
  return res.data as AlertPage;
}

function AlertRow({
  alert,
  pending,
  onAcknowledge,
}: {
  alert: Alert;
  pending: boolean;
  onAcknowledge: (id: string) => void;
}) {
  const view = presentAlert(alert);
  const done = alert.acknowledgedAt !== null;
  return (
    <li
      data-alert-id={alert.id}
      data-acknowledged={done}
      className="flex items-start gap-3 py-3 max-md:flex-wrap"
    >
      <span aria-hidden="true" className={`mt-0.5 ${view.tone}`}>
        <Icon name={view.icon} size={20} />
      </span>
      <div className="flex min-w-0 grow flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="font-semibold">{view.title}</strong>
          <Badge variant={view.badge.variant}>{view.badge.label}</Badge>
        </div>
        <p className="text-ui text-muted-foreground">{view.body}</p>
        <p className="text-caption text-muted-foreground">
          <time dateTime={alert.raisedAt}>{formatRaised(alert.raisedAt)}</time>
        </p>
      </div>
      {done ? (
        <Badge variant="success" icon="check">
          {COPY.acknowledged}
        </Badge>
      ) : (
        <Button
          variant="outline"
          size="sm"
          pending={pending}
          aria-label={`${COPY.acknowledge}: ${view.title}`}
          onClick={() => onAcknowledge(alert.id)}
        >
          {COPY.acknowledge}
        </Button>
      )}
    </li>
  );
}

/**
 * SCREEN-014 at `/admin/alerts` (Administrator): unacknowledged and acknowledged alerts with Acknowledge, and the
 * unacknowledged count the shell shows (API-125, API-126). Alerts carry user IDs and counts, never an email.
 */
export function AlertsScreen() {
  const client = useQueryClient();
  const [toasts, setToasts] = useState<{ id: string; variant: 'success'; message: string }[]>([]);
  const [failed, setFailed] = useState<{ error: unknown; alertId: string } | null>(null);

  const list = useInfiniteQuery<AlertPage, Error, Pages, readonly unknown[], string | undefined>({
    queryKey: KEY,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => loadPage(pageParam, signal),
    getNextPageParam: (last) => last.metaData.pagination.nextCursor ?? undefined,
  });

  const ack = useMutation({
    mutationFn: async (alertId: string) =>
      (await adminAcknowledgeAlert(alertId)).data as { data: Alert },
    onSuccess: (body) => {
      setFailed(null);
      client.setQueryData<Pages>(
        KEY,
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              data: page.data.map((a) => (a.id === body.data.id ? body.data : a)),
            })),
          },
      );
      setToasts([{ id: body.data.id, variant: 'success', message: COPY.acknowledgedToast }]);
    },
    onError: (error, alertId) => setFailed({ error, alertId }),
  });

  const alerts = list.data?.pages.flatMap((p) => p.data) ?? [];
  const unacknowledged = alerts.filter((a) => a.acknowledgedAt === null).length;
  const forbidden = isApiClientError(list.error) && list.error.code === 'forbidden_role';
  const reauthenticate = () => window.location.assign(signInUrl(PATH));

  let body;
  if (list.isPending) {
    body = <Card state="loading" title={COPY.loading} headingLevel={2} />;
  } else if (list.isError) {
    body = (
      <div className="flex flex-col gap-3">
        <ErrorNotice
          error={list.error}
          returnTo={PATH}
          retrying={list.isRefetching}
          onAction={(action) => (action === 'confirm' ? reauthenticate() : void list.refetch())}
        />
      </div>
    );
  } else if (alerts.length === 0) {
    body = (
      <Card
        state="empty"
        emptyTitle={COPY.emptyTitle}
        emptyDescription={COPY.emptyBody}
        headingLevel={2}
      />
    );
  } else {
    body = (
      <Card
        variant="plain"
        className="py-1"
        footer={
          list.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              pending={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {COPY.showMore}
            </Button>
          ) : undefined
        }
      >
        <ul aria-label={COPY.listLabel} className="divide-y divide-border">
          {alerts.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              pending={ack.isPending && ack.variables === alert.id}
              onAcknowledge={(id) => ack.mutate(id)}
            />
          ))}
        </ul>
      </Card>
    );
  }

  return (
    <AdminShell
      path={PATH}
      pageName={COPY.title}
      alertCount={unacknowledged}
      unavailable={forbidden}
      toasts={toasts}
      onDismissToast={() => setToasts([])}
      workspaceHref={ROUTES.campaigns}
    >
      <div
        className="mx-auto flex max-w-5xl flex-col gap-4"
        data-screen="SCREEN-014"
        aria-busy={list.isPending || undefined}
      >
        {forbidden ? null : (
          <header className="flex flex-col gap-1">
            <h1 className="text-section font-semibold">{COPY.title}</h1>
            <p className="text-ui text-muted-foreground">{COPY.description}</p>
          </header>
        )}
        {failed ? (
          <ErrorNotice
            error={failed.error}
            surface="context"
            returnTo={PATH}
            retrying={ack.isPending}
            onAction={(action) => {
              if (action === 'confirm') reauthenticate();
              else if (action === 'retry') ack.mutate(failed.alertId);
              else setFailed(null);
            }}
          />
        ) : null}
        {body}
      </div>
    </AdminShell>
  );
}
