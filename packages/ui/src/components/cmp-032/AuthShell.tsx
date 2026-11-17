import type { ReactNode } from 'react';
import { Skeleton, SkeletonRegion } from '../cmp-008';
import { Logo } from '../cmp-001';

export const AUTH_VARIANTS = ['sign-in', 'message', 'mfa'] as const;
export type AuthVariant = (typeof AUTH_VARIANTS)[number];
export type ProviderState = 'ready' | 'loading' | 'error';

export interface AuthShellProps {
  variant?: AuthVariant;
  /** The page's one `h1`. */
  title: string;
  description?: string;
  /** Card content: message copy and actions, or the provider-hosted component (`idp-slot`). */
  children?: ReactNode;
  /** Provider-hosted component state inside the card: `loading` shows a status and skeleton, `error` an alert. */
  providerState?: ProviderState;
  /** Shown for `providerState="error"`. */
  providerError?: string;
  /** Retry control for the error state. */
  providerAction?: ReactNode;
  /** Brand-panel content (1024 px and up): product name, description and footer; the tagline shows when omitted. */
  panel?: { name: string; description: string; footer?: string };
  /** Render the `main` landmark (default). Only the gallery turns it off, to embed several shells in one page. */
  landmark?: boolean;
  className?: string;
}

const PANEL_COPY = 'Turn a product brief into a ready-to-run UGC video ad.';

/** CMP-032: split auth layout (brand panel on `--surface-inverse` from 1024 px, lockup above the card below) with the `main` landmark. */
export function AuthShell({
  variant = 'sign-in',
  title,
  description,
  children,
  providerState = 'ready',
  providerError = 'We could not load sign-in. Try again.',
  providerAction,
  panel,
  landmark = true,
  className,
}: AuthShellProps) {
  const Main = landmark ? 'main' : 'div';
  const classes = [
    'grid min-h-screen grid-cols-1 bg-background text-foreground lg:grid-cols-2',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-variant={variant}>
      <aside
        aria-hidden="true"
        data-brand-panel=""
        className="hidden flex-col justify-between bg-surface-inverse p-12 text-surface-inverse-foreground lg:flex"
      >
        <Logo surface="inverse" size={panel ? 240 : 160} alt="" />
        {panel ? (
          <div className="flex max-w-prose flex-col gap-2" data-panel-block="">
            <p className="text-page font-semibold text-surface-inverse-foreground">{panel.name}</p>
            <p className="text-section text-surface-inverse-muted">{panel.description}</p>
          </div>
        ) : (
          <p className="max-w-prose text-section text-surface-inverse-muted">{PANEL_COPY}</p>
        )}
        {panel?.footer ? (
          <p className="text-ui text-surface-inverse-muted">{panel.footer}</p>
        ) : null}
      </aside>
      <Main
        id={landmark ? 'main' : undefined}
        className="flex flex-col items-center justify-center gap-6 px-4 py-8 lg:px-8"
      >
        <div className="lg:hidden" data-mobile-lockup="">
          <Logo surface="background" size={160} />
        </div>
        <div className="flex w-full max-w-105 flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-1">
            <h1 className="text-page font-semibold text-card-foreground">{title}</h1>
            {description ? <p className="text-ui text-muted-foreground">{description}</p> : null}
          </div>
          <div
            data-slot={variant === 'message' ? 'message' : 'idp-slot'}
            className="flex flex-col gap-3"
          >
            {providerState === 'loading' ? (
              <SkeletonRegion status="Loading sign-in">
                <Skeleton className="h-control" />
                <Skeleton className="h-control" />
              </SkeletonRegion>
            ) : providerState === 'error' ? (
              <div role="alert" className="flex flex-col gap-3 text-ui text-destructive">
                <p>{providerError}</p>
                {providerAction}
              </div>
            ) : (
              children
            )}
          </div>
        </div>
      </Main>
    </div>
  );
}
