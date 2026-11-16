'use client';

import {
  deleteMyProviderKey,
  getGetMeQueryKey,
  getListMyKeyEventsQueryKey,
  getListMyProviderKeysQueryKey,
  getMe,
  listMyKeyEvents,
  listMyProviderKeys,
  putMyProviderKey,
  type KeyEventPage,
  type MeResponse,
  type ProviderKeyListResponse,
  type ProviderKeyPutResponse,
  type ProviderKeyStatus,
} from '@shroomap/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Button } from '@shroomap/ui/cmp-003';
import { KeyInput } from '@shroomap/ui/cmp-004';
import { Alert } from '@shroomap/ui/cmp-011';
import { Dialog } from '@shroomap/ui/cmp-013';
import { Card } from '@shroomap/ui/cmp-018';
import { ProviderKeyCard } from '@shroomap/ui/cmp-025';
import { OperatorShell, deriveKeyState } from '@shroomap/ui/cmp-030';
import { Icon } from '@shroomap/ui/icons';
import { useId, useState } from 'react';
import { ErrorNotice, StepUpDialog } from '../../components/errors';
import { resolveError } from '../../lib/errors';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import {
  PROVIDERS,
  PROVIDER_COPY,
  SCREEN_010_COPY as COPY,
  cardState,
  deleteBody,
  disabledMessage,
  formatEvent,
  formatAdded,
  formatLastUsed,
  presentEvent,
  replaceWarning,
  savedMessage,
  type ProviderName,
} from './copy';

const PATH = ROUTES.providerKeys;
const KEYS = getListMyProviderKeysQueryKey();
const ME = getGetMeQueryKey();
const EVENTS = getListMyKeyEventsQueryKey({ limit: 20 });
const EVENTS_ROOT = [EVENTS[0]] as const;
const FIELD_CODES = new Set(['key_invalid', 'validation_failed']);

type Pages = InfiniteData<KeyEventPage, string | undefined>;
type Flow =
  | { kind: 'put'; provider: ProviderName }
  | { kind: 'delete'; provider: ProviderName }
  | null;
type Saved = { provider: ProviderName; last4: string | null; probe: 'valid' | 'unknown' };

async function loadEvents(cursor: string | undefined, signal?: AbortSignal): Promise<KeyEventPage> {
  const res = await listMyKeyEvents({ limit: 20, ...(cursor ? { cursor } : {}) }, { signal });
  return res.data as KeyEventPage;
}

interface KeyDialogProps {
  provider: ProviderName;
  current: ProviderKeyStatus | undefined;
  pending: boolean;
  error: unknown;
  onSubmit: (apiKey: string) => void;
  onClose: () => void;
}

/** Add or replace dialog: masked, never autofilled, never revealed; the field is emptied after every outcome. */
function KeyDialog({ provider, current, pending, error, onSubmit, onClose }: KeyDialogProps) {
  const { name, advice } = PROVIDER_COPY[provider];
  const replacing = current?.configured === true;
  const inFlight = current?.inFlightJobCount ?? 0;
  const [value, setValue] = useState('');
  const [empty, setEmpty] = useState(false);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const helpId = `${fieldId}-help`;

  const view = error ? resolveError(error, { surface: 'context' }) : null;
  const fieldError = empty ? COPY.fieldEmpty : view && FIELD_CODES.has(view.code) ? view.message : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={replacing ? `Replace ${name} key?` : `Add ${name} key`}
      confirmLabel={replacing ? COPY.testAndReplace : COPY.testAndSave}
      pending={pending}
      error={view && !fieldError ? view.message : undefined}
      onConfirm={() => {
        const key = value.trim();
        setValue('');
        if (key === '') {
          setEmpty(true);
          return;
        }
        setEmpty(false);
        onSubmit(key);
      }}
    >
      {replacing && inFlight > 0 ? (
        <Alert variant="warning" role="status">
          {replaceWarning(inFlight)}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <label htmlFor={fieldId} className="text-ui font-medium">
          {replacing ? `New ${name} API key` : `${name} API key`}
        </label>
        <KeyInput
          id={fieldId}
          value={value}
          placeholder={replacing ? COPY.fieldNew : COPY.fieldPaste}
          disabled={pending}
          invalid={fieldError !== null}
          aria-describedby={fieldError ? `${errorId} ${helpId}` : helpId}
          aria-busy={pending || undefined}
          data-autofocus=""
          onChange={(e) => {
            setValue(e.target.value);
            setEmpty(false);
          }}
        />
        {fieldError ? (
          <p id={errorId} className="flex items-start gap-1 text-ui text-destructive">
            <Icon name="circle-alert" size={16} />
            <span>{fieldError}</span>
          </p>
        ) : null}
        <p id={helpId} className="text-caption text-muted-foreground">
          {COPY.fieldHelp} {replacing ? `${COPY.replaceHelp} Afterwards, revoke the old key at ${name}. ` : ''}
          {advice} {COPY.reminder}
        </p>
        {pending ? (
          <p role="status" className="text-ui text-muted-foreground">
            {COPY.testing}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * SCREEN-010 at `/settings/provider-keys` (Operator and admin): each provider's key by hint and fingerprint only,
 * add or replace with a non-billing test, delete, and the key-event trail (API-010 to API-013, API-001).
 */
export function ProviderKeysScreen() {
  const client = useQueryClient();
  const [flow, setFlow] = useState<Flow>(null);
  const [stepUp, setStepUp] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [toasts, setToasts] = useState<{ id: string; variant: 'success'; message: string }[]>([]);

  const me = useQuery({
    queryKey: ME,
    queryFn: async ({ signal }) => (await getMe({ signal })).data as MeResponse,
    retry: false,
  });
  const keys = useQuery({
    queryKey: KEYS,
    queryFn: async ({ signal }) => (await listMyProviderKeys({ signal })).data as ProviderKeyListResponse,
  });
  const events = useInfiniteQuery<KeyEventPage, Error, Pages, readonly unknown[], string | undefined>({
    queryKey: EVENTS,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) => loadEvents(pageParam, signal),
    getNextPageParam: (last) => last.metaData.pagination.nextCursor ?? undefined,
  });

  const refreshed = () => {
    void client.invalidateQueries({ queryKey: KEYS });
    void client.invalidateQueries({ queryKey: EVENTS_ROOT });
  };
  const reauthenticate = () => window.location.assign(signInUrl(PATH));
  const needsStepUp = (error: unknown) => resolveError(error, { surface: 'context' }).code === 'recent_auth_required';

  const put = useMutation({
    mutationFn: async (vars: { provider: ProviderName; apiKey: string }) =>
      (await putMyProviderKey(vars.provider, { apiKey: vars.apiKey })).data as ProviderKeyPutResponse,
    onSuccess: (body) => {
      const { probe, ...status } = body.data;
      client.setQueryData<ProviderKeyListResponse>(KEYS, (old) =>
        old && { ...old, data: old.data.map((k) => (k.provider === status.provider ? status : k)) },
      );
      setSaved({ provider: status.provider, last4: status.last4, probe });
      setToasts([{ id: `saved-${status.provider}`, variant: 'success', message: `${PROVIDER_COPY[status.provider].name} key saved.` }]);
      setFlow(null);
      refreshed();
    },
    onError: (error) => {
      if (needsStepUp(error)) {
        setFlow(null);
        setStepUp(true);
      }
    },
  });

  const remove = useMutation({
    mutationFn: async (provider: ProviderName) => {
      await deleteMyProviderKey(provider);
      return provider;
    },
    onSuccess: (provider) => {
      setSaved(null);
      setToasts([{ id: `deleted-${provider}`, variant: 'success', message: COPY.deletedToast(PROVIDER_COPY[provider].name) }]);
      setFlow(null);
      refreshed();
    },
    onError: (error) => {
      if (needsStepUp(error)) {
        setFlow(null);
        setStepUp(true);
      }
    },
  });

  const list = keys.data?.data ?? [];
  const byProvider = (provider: ProviderName) => list.find((k) => k.provider === provider);
  const entries = events.data?.pages.flatMap((p) => p.data) ?? [];
  const role = me.data && me.data.data.linkState === 'linked' ? me.data.data.role : 'user';
  const missing = keys.isSuccess && PROVIDERS.some((p) => !byProvider(p)?.configured);
  const disabled = PROVIDERS.filter((p) => byProvider(p)?.configured && byProvider(p)?.status === 'disabled');

  const open = (kind: 'put' | 'delete', provider: ProviderName) => {
    put.reset();
    remove.reset();
    setFlow({ kind, provider });
  };
  const close = () => {
    if (put.isPending || remove.isPending) return;
    put.reset();
    remove.reset();
    setFlow(null);
  };

  let body;
  if (keys.isPending) {
    body = <Card state="loading" title={COPY.loading} headingLevel={2} />;
  } else if (keys.isError) {
    body = (
      <ErrorNotice
        error={keys.error}
        returnTo={PATH}
        retrying={keys.isRefetching}
        onAction={(action) => (action === 'confirm' ? reauthenticate() : void keys.refetch())}
      />
    );
  } else {
    body = (
      <div role="group" aria-label={COPY.cardsLabel} className="flex flex-col gap-4">
        {PROVIDERS.map((provider) => {
          const key = byProvider(provider);
          const { purpose } = PROVIDER_COPY[provider];
          const testing = put.isPending && put.variables?.provider === provider;
          const state = testing ? 'testing' : cardState(key);
          return (
            <div key={provider} className="flex flex-col gap-2">
              <ProviderKeyCard
                provider={provider}
                state={state}
                hint={key?.last4 ?? undefined}
                fingerprint={key?.fingerprint ?? undefined}
                description={purpose}
                added={formatAdded(key?.createdAt ?? null)}
                lastUsed={formatLastUsed(key?.lastValidatedAt ?? null)}
                jobsRunning={key?.inFlightJobCount}
                onReplace={() => open('put', provider)}
                onDelete={() => open('delete', provider)}
              />
              {key?.configured && key.status === 'untested' ? (
                <p className="px-1 text-ui text-muted-foreground" data-testid={`untested-${provider}`}>
                  {COPY.untestedNote}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  const dialogProvider = flow?.provider;
  const current = dialogProvider ? byProvider(dialogProvider) : undefined;

  return (
    <OperatorShell
      role={role}
      path={PATH}
      pageName={COPY.title}
      keyState={deriveKeyState(keys.data?.data)}
      toasts={toasts}
      onDismissToast={() => setToasts([])}
      onSignOut={() => window.location.assign(ROUTES.signIn)}
    >
      <div className="mx-auto flex max-w-narrow flex-col gap-4" data-screen="SCREEN-010" aria-busy={keys.isPending || undefined}>
        <header className="flex flex-col gap-1">
          <h1 className="text-section font-semibold">{COPY.title}</h1>
          <p className="text-ui text-muted-foreground">{COPY.description}</p>
        </header>

        {saved ? (
          <Alert variant="success" role="status" title={savedMessage(PROVIDER_COPY[saved.provider].name, saved.last4, saved.probe).title}>
            {savedMessage(PROVIDER_COPY[saved.provider].name, saved.last4, saved.probe).body}
          </Alert>
        ) : null}
        {disabled.map((provider) => (
          <Alert key={provider} variant="destructive" role="alert" title={disabledMessage(PROVIDER_COPY[provider].name).title}>
            {disabledMessage(PROVIDER_COPY[provider].name).body}
          </Alert>
        ))}
        {missing ? (
          <Alert variant="warning" role="status" title={COPY.emptyTitle}>
            {COPY.emptyBody}
          </Alert>
        ) : null}

        {body}

        {keys.isSuccess ? (
          <section id="key-activity" aria-labelledby="key-activity-title" className="flex scroll-mt-20 flex-col gap-2">
            <Card
              variant="plain"
              state={events.isPending ? 'loading' : events.isError ? 'content' : entries.length === 0 ? 'empty' : 'content'}
              emptyTitle={COPY.eventsEmpty}
              title={events.isPending ? COPY.eventsLoading : undefined}
              headingLevel={2}
              footer={
                events.hasNextPage ? (
                  <Button variant="outline" size="sm" pending={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
                    {COPY.showMore}
                  </Button>
                ) : undefined
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="key-activity-title" className="text-body font-semibold">
                  {COPY.eventsTitle}
                </h2>
                <span className="text-ui text-muted-foreground">{COPY.eventsNote}</span>
              </div>
              {events.isError ? (
                <ErrorNotice error={events.error} surface="context" returnTo={PATH} retrying={events.isRefetching} onAction={(a) => (a === 'confirm' ? reauthenticate() : void events.refetch())} />
              ) : (
                <ul aria-label={COPY.eventsTitle} className="divide-y divide-border">
                  {entries.map((event) => {
                    const view = presentEvent(event);
                    return (
                      <li key={event.id} className="flex items-center gap-3 py-2">
                        <span aria-hidden="true" className={view.tone}>
                          <Icon name={view.icon} size={16} />
                        </span>
                        <span className="min-w-0 grow">{view.label}</span>
                        <time dateTime={event.at} className="shrink-0 text-caption text-muted-foreground">
                          {formatEvent(event.at)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>
        ) : null}

        <Alert variant="info" role="status" title={COPY.protectedTitle}>
          {COPY.protectedBody}
        </Alert>
      </div>

      {flow?.kind === 'put' && dialogProvider ? (
        <KeyDialog
          key={dialogProvider}
          provider={dialogProvider}
          current={current}
          pending={put.isPending}
          error={put.error}
          onSubmit={(apiKey) => put.mutate({ provider: dialogProvider, apiKey })}
          onClose={close}
        />
      ) : null}
      {flow?.kind === 'delete' && dialogProvider ? (
        <Dialog
          open
          onClose={close}
          title={`Delete ${PROVIDER_COPY[dialogProvider].name} key?`}
          confirmLabel={COPY.deleteConfirm}
          destructive
          pending={remove.isPending}
          error={remove.error ? resolveError(remove.error, { surface: 'context' }).message : undefined}
          onConfirm={() => remove.mutate(dialogProvider)}
        >
          {deleteBody(PROVIDER_COPY[dialogProvider].name, current?.inFlightJobCount ?? 0, PROVIDER_COPY[dialogProvider].uses).map((line) => (
            <p key={line} className="text-ui">
              {line}
            </p>
          ))}
        </Dialog>
      ) : null}
      <StepUpDialog open={stepUp} onConfirm={reauthenticate} onClose={() => setStepUp(false)} />
    </OperatorShell>
  );
}
