'use client';

import { useEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { Badge } from '../cmp-007';
import type { BadgeVariant } from '../cmp-007';
import { Button } from '../cmp-003';
import { Spinner } from '../cmp-008';

export const PROVIDERS = ['openai', 'wavespeed'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const KEY_CARD_STATES = [
  'active',
  'untested',
  'disabled',
  'none',
  'testing',
  'delete-confirm',
] as const;
export type KeyCardState = (typeof KEY_CARD_STATES)[number];

export const PROVIDER_NAMES: Record<Provider, string> = {
  openai: 'OpenAI',
  wavespeed: 'WaveSpeed',
};

const BADGE: Record<KeyCardState, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Active', variant: 'success' },
  untested: { label: 'Untested', variant: 'warning' },
  disabled: { label: 'Disabled', variant: 'neutral' },
  none: { label: 'No key', variant: 'neutral' },
  testing: { label: 'Testing', variant: 'info' },
  'delete-confirm': { label: 'Active', variant: 'success' },
};

export interface ProviderKeyCardProps
  extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onReset'> {
  provider: Provider;
  state: KeyCardState;
  /** Last four characters of the stored key. The full key is never shown and cannot be revealed. */
  hint?: string;
  fingerprint?: string;
  /** Already formatted, e.g. "12 Nov 2026, 09:41". */
  lastTested?: string;
  /** Link to the key-event trail. */
  eventTrailHref?: string;
  /** Add (state none) or replace the key. */
  onReplace?: () => void;
  onDelete?: () => void;
  onConfirmDelete?: () => void;
  onCancelDelete?: () => void;
}

/** CMP-025: one provider's key. Shows state, hint and fingerprint only; there is no reveal control. */
export function ProviderKeyCard({
  provider,
  state,
  hint,
  fingerprint,
  lastTested,
  eventTrailHref,
  onReplace,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  className,
  ...rest
}: ProviderKeyCardProps) {
  const name = PROVIDER_NAMES[provider];
  const badge = BADGE[state];
  const confirming = state === 'delete-confirm';
  const testing = state === 'testing';
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  const headingId = `key-card-${provider}`;
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={testing ? true : undefined}
      data-provider={provider}
      data-state={state}
      className={[
        'flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-section font-semibold">
          {name}
        </h3>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      {state === 'none' ? (
        <p className="text-ui text-muted-foreground">No {name} key is stored.</p>
      ) : (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1 text-ui">
          <dt className="text-muted-foreground">Key</dt>
          <dd className="col-span-2">
            <span className="sr-only">Ends in </span>
            <code className="font-mono" data-testid="key-hint">
              {hint ? `…${hint}` : '…'}
            </code>
          </dd>
          {fingerprint ? (
            <>
              <dt className="text-muted-foreground">Fingerprint</dt>
              <dd className="col-span-2 min-w-0 break-all font-mono">{fingerprint}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Last tested</dt>
          <dd className="col-span-2">{lastTested ?? 'Not tested yet'}</dd>
        </dl>
      )}
      {testing ? <Spinner label={`Testing ${name} key`} /> : null}
      {confirming ? (
        <div
          role="group"
          aria-label={`Confirm deleting the ${name} key`}
          className="flex flex-col gap-3 rounded-md border border-destructive-border bg-destructive-subtle p-3"
        >
          <p className="text-ui">
            Delete the {name} key? Generation that needs it stops until you add a new key.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" onClick={onConfirmDelete}>
              Confirm delete {name} key
            </Button>
            <KeepButton innerRef={keep} label={`Keep ${name} key`} onClick={onCancelDelete} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {state === 'none' ? (
            <Button size="sm" onClick={onReplace}>
              Add {name} key
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={testing} onClick={onReplace}>
                Replace {name} key
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={testing}
                onClick={onDelete}
              >
                Delete {name} key
              </Button>
            </>
          )}
          {eventTrailHref && state !== 'none' ? (
            <a
              href={eventTrailHref}
              className="text-ui text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {name} key events
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** A plain button so focus can move to the safe choice when the confirmation opens. */
function KeepButton({
  innerRef,
  label,
  onClick,
}: {
  innerRef: React.RefObject<HTMLButtonElement | null>;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      ref={innerRef}
      type="button"
      onClick={onClick}
      className="inline-flex min-h-control-sm items-center justify-center rounded-md border border-input bg-card px-3 text-ui font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-control-touch"
    >
      {label}
    </button>
  );
}
