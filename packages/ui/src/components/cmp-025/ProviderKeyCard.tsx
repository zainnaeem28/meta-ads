'use client';

import { useEffect, useId, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { Badge } from '../cmp-007';
import type { BadgeVariant } from '../cmp-007';
import type { IconName } from '../../icons';
import { Button } from '../cmp-003';
import { Icon } from '../../icons';
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

const BADGE: Record<KeyCardState, { label: string; variant: BadgeVariant; icon?: IconName }> = {
  active: { label: 'Active', variant: 'success', icon: 'circle-check' },
  untested: { label: 'Untested', variant: 'warning', icon: 'clock' },
  disabled: { label: 'Disabled', variant: 'destructive', icon: 'circle-x' },
  none: { label: 'Not added', variant: 'neutral' },
  testing: { label: 'Testing', variant: 'info' },
  'delete-confirm': { label: 'Active', variant: 'success', icon: 'circle-check' },
};

/** "4f9a1c07b21e" becomes "4f9a·1c07" (two groups of four of the 12-hex fingerprint). */
export function formatFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 4)}·${fingerprint.slice(4, 8)}`;
}

export interface ProviderKeyCardProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'onReset'
> {
  provider: Provider;
  state: KeyCardState;
  /** Last four characters of the stored key. The full key is never shown and cannot be revealed. */
  hint?: string;
  /** The 12-hex key fingerprint; shown as two groups of four. */
  fingerprint?: string;
  /** One line on what the provider is used for. */
  description?: string;
  /** `createdAt`, already formatted, e.g. "3 Nov 2026". */
  added?: string;
  /** `ProviderKeyStatus.lastValidatedAt`, already formatted ("12 min ago"); null or omitted reads "Not yet". */
  lastUsed?: string | null;
  /** `inFlightJobCount`. */
  jobsRunning?: number;
  /** Extra line under the rows, e.g. why the key was disabled. */
  note?: string;
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
  description,
  added,
  lastUsed,
  jobsRunning,
  note,
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
  const keep = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirming) keep.current?.querySelector<HTMLButtonElement>('[data-keep]')?.focus();
  }, [confirming]);
  const headingId = useId();
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
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="text-section font-semibold">
            {name}
          </h3>
          <Badge variant={badge.variant} icon={badge.icon}>
            {badge.label}
          </Badge>
          {state !== 'none' && !confirming ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={testing} onClick={onReplace}>
                <Icon name="refresh-cw" size={16} />
                Replace key
              </Button>
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={testing}
                onClick={onDelete}
                aria-label={`Delete ${name} key`}
              >
                <Icon name="trash-2" size={16} />
                Delete
              </Button>
            </div>
          ) : null}
        </div>
        {description ? <p className="text-ui text-muted-foreground">{description}</p> : null}
      </div>
      {state !== 'none' ? (
        <dl className="grid grid-cols-4 gap-x-4 gap-y-1 text-ui">
          <dt className="text-muted-foreground">Key</dt>
          <dd className="col-span-3 min-w-0">
            <span className="sr-only">Ends in </span>
            <code className="font-mono" data-testid="key-hint">
              {hint ? `…${hint}` : '…'}
            </code>
            {fingerprint ? (
              <span className="ml-2 text-muted-foreground">
                fingerprint <span className="font-mono">{formatFingerprint(fingerprint)}</span>
              </span>
            ) : null}
          </dd>
          {added ? (
            <>
              <dt className="text-muted-foreground">Added</dt>
              <dd className="col-span-3">{added}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Last used</dt>
          <dd className="col-span-3">{lastUsed ?? 'Not yet'}</dd>
          {jobsRunning !== undefined ? (
            <>
              <dt className="text-muted-foreground">Jobs running</dt>
              <dd className="col-span-3">{jobsRunning}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {note ? <p className="text-ui text-muted-foreground">{note}</p> : null}
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
          <div ref={keep} className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" onClick={onConfirmDelete}>
              Confirm delete {name} key
            </Button>
            <Button variant="outline" size="sm" data-keep="" onClick={onCancelDelete}>
              Keep {name} key
            </Button>
          </div>
        </div>
      ) : state === 'none' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onReplace}>
            <Icon name="plus" size={16} />
            Add {name} key
          </Button>
        </div>
      ) : null}
    </section>
  );
}
