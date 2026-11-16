'use client';

import { Button } from '@shroomap/ui/cmp-003';
import { ErrorSummary } from '@shroomap/ui/cmp-010';
import { Alert } from '@shroomap/ui/cmp-011';
import { ToastRegion } from '@shroomap/ui/cmp-012';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ROUTES } from '../../lib/errors/routes';
import { FAILURE_HINT_AT } from '../../lib/errors/countdown';
import { reportDefect } from '../../lib/errors/defect';
import { mapErrorDetails, type ControlMap } from '../../lib/errors/details';
import { resolveError, type ErrorView, type Surface } from '../../lib/errors/resolve';
import { signInUrl } from '../../lib/errors/session';
import { ReferenceLine } from './ReferenceLine';
import { RetryButton } from './RetryButton';
import { StepUpDialog } from './StepUpDialog';

/** What the failed call was: a read, a write, or one of the job-creating writes (API-024, 060, 063, 070). */
export type CallKind = 'read' | 'write' | 'job';

export type NoticeAction = 'retry' | 'reload' | 'refresh' | 'close' | 'confirm';

export interface ErrorNoticeProps {
  error: unknown;
  surface?: Surface;
  call?: CallKind;
  /** Consecutive failures of Try again, for the three-failure hint. */
  failures?: number;
  /** Controls of the form for `details[]` mapping (field rows). */
  controls?: ControlMap;
  /** The retry is in flight. */
  retrying?: boolean;
  /** Overrides the destination of a link action (for example the brief of this campaign). */
  linkHref?: string;
  onAction?: (action: NoticeAction, view: ErrorView) => void;
  /** Navigation for redirect rows; defaults to a full page load. */
  navigate?: (href: string) => void;
  /** Path to return to after sign-in; defaults to the current location. */
  returnTo?: string;
  /** Route to log for a defect; defaults to the current path. */
  route?: string;
  className?: string;
}

const REDIRECT_STATE: Record<string, string> = {
  not_linked: 'not-linked',
  account_suspended: 'suspended',
  account_removed: 'removed',
};

const here = (): string =>
  typeof window === 'undefined'
    ? ROUTES.home
    : `${window.location.pathname}${window.location.search}`;

const go = (href: string) => window.location.assign(href);

/** Where a redirect row sends the user, or null when the row does not redirect. */
export const redirectTarget = (view: ErrorView, returnTo: string): string | null => {
  if (view.code === 'unauthenticated') return signInUrl(returnTo);
  if (view.code === 'mfa_required') return ROUTES.mfa;
  if (view.presentation === 'message-page') {
    return `${ROUTES.access}?state=${REDIRECT_STATE[view.code] ?? view.code}`;
  }
  return null;
};

/**
 * Presents one API failure as UI-UX §9.1 prescribes for its code: page-level CMP-019, CMP-011 alert, toast, step-up
 * dialog, field summary or a redirect. The `qc_confirmation_required` dialog needs the clips and is `QcConfirmDialog`.
 */
export function ErrorNotice({
  error,
  surface = 'page',
  call = 'read',
  failures = 0,
  controls = {},
  retrying = false,
  linkHref,
  onAction,
  navigate = go,
  returnTo,
  route,
  className,
}: ErrorNoticeProps) {
  const view = useMemo(() => resolveError(error, { surface }), [error, surface]);
  const [toastOpen, setToastOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(true);
  const target = redirectTarget(view, returnTo ?? here());
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (view.defect) {
      reportDefect({ code: view.code, route: route ?? here(), requestId: view.requestId });
    }
  }, [view, route]);

  useEffect(() => {
    setToastOpen(true);
    setDialogOpen(true);
  }, [error]);

  useEffect(() => {
    if ((view.presentation === 'redirect' || view.presentation === 'message-page') && target)
      navigateRef.current(target);
  }, [view.presentation, target]);

  const hints: ReactNode[] = [];
  if (view.reference && call === 'job')
    hints.push(<p key="job">Check the list before you repeat this.</p>);
  if (view.retry && failures >= FAILURE_HINT_AT)
    hints.push(<p key="persist">If this continues, contact your administrator.</p>);

  const act = (action: NoticeAction) => () => onAction?.(action, view);
  const href = linkHref ?? view.action.href;

  let button: ReactNode;
  switch (view.action.kind) {
    case 'retry':
      button = view.retry ? (
        <RetryButton
          waitSeconds={view.waitSeconds}
          restartKey={error}
          pending={retrying}
          onRetry={act('retry')}
        />
      ) : (
        <Button variant="outline" size="sm" pending={retrying} onClick={act('retry')}>
          {view.action.label}
        </Button>
      );
      break;
    case 'reload':
      button = (
        <Button
          variant="outline"
          size="sm"
          onClick={onAction ? act('reload') : () => window.location.reload()}
        >
          {view.action.label}
        </Button>
      );
      break;
    case 'refresh':
      button = (
        <Button variant="outline" size="sm" onClick={act('refresh')}>
          {view.action.label}
        </Button>
      );
      break;
    case 'close':
      button = (
        <Button variant="outline" size="sm" onClick={act('close')}>
          {view.action.label}
        </Button>
      );
      break;
    case 'link':
    case 'sign-in':
      button = (
        <Button variant="outline" size="sm" asChild>
          <a href={view.action.kind === 'sign-in' ? signInUrl(returnTo ?? here()) : href}>
            {view.action.label}
          </a>
        </Button>
      );
      break;
    default:
      button = null;
  }

  const extras = (
    <div className="flex flex-col items-start gap-2">
      {hints.length > 0 ? <div className="text-ui text-muted-foreground">{hints}</div> : null}
      {button ? <div className="flex flex-wrap items-center gap-2">{button}</div> : null}
      {view.reference ? <ReferenceLine requestId={view.reference} /> : null}
    </div>
  );
  const hasExtras = hints.length > 0 || button !== null || view.reference !== null;

  const alertVariant = view.tone === 'destructive' ? 'destructive' : 'warning';

  switch (view.presentation) {
    case 'page':
      return (
        <EmptyState
          variant="error"
          title={view.message}
          className={className}
          action={hasExtras ? extras : undefined}
        />
      );
    case 'toast':
      return (
        <ToastRegion
          toasts={
            toastOpen
              ? [
                  {
                    id: view.code,
                    variant: 'error',
                    message: view.message,
                    action: hasExtras ? extras : undefined,
                  },
                ]
              : []
          }
          onDismiss={() => setToastOpen(false)}
        />
      );
    case 'dialog':
      return view.code === 'recent_auth_required' ? (
        <StepUpDialog
          open={dialogOpen}
          onConfirm={() => onAction?.('confirm', view)}
          onClose={() => setDialogOpen(false)}
        />
      ) : null;
    case 'field': {
      const mapped = mapErrorDetails(view.details, controls, view.details.length > 0);
      if (mapped.entries.length > 0) {
        return (
          <div className={className}>
            <ErrorSummary
              entries={mapped.entries}
              focusKey={String(error)}
              heading={view.message}
            />
          </div>
        );
      }
      return (
        <Alert variant={alertVariant} className={className} action={hasExtras ? extras : undefined}>
          {view.message}
        </Alert>
      );
    }
    default:
      // alert, file-row, redirect and message-page (the message shows while the navigation happens)
      return (
        <Alert variant={alertVariant} className={className} action={hasExtras ? extras : undefined}>
          {view.message}
        </Alert>
      );
  }
}
