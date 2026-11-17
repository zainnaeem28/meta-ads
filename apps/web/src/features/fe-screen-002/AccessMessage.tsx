import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@shroomap/ui/cmp-003';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { Icon } from '@shroomap/ui/icons';
import { AUTH_PANEL } from '../fe-screen-001-003/copy';
import { ROUTES } from '../../lib/errors/routes';
import { ACCESS_FORM_COPY, SCREEN_002_COPY, STATE_ICON, type Screen002State } from './copy';

/**
 * The frame has no card: CMP-032 draws one, so it is flattened here (a `bare` variant of CMP-032 is the clean fix and
 * is a design change for UI/UX). The card is the shell's last `main` child; the header is its first child.
 */
const FLAT =
  '[&>main>div:last-of-type]:border-0 [&>main>div:last-of-type]:bg-transparent [&>main>div:last-of-type]:p-0 [&>main>div:last-of-type]:shadow-none';
/** Message states: glyph, heading, body, button, centred. The slot dissolves so its children order with the header. */
const CENTRED =
  '[&>main>div:last-of-type]:items-center [&>main>div:last-of-type]:text-center [&>main>div:last-of-type]:gap-3 [&_[data-slot=message]]:contents [&>main>div:last-of-type>div:first-child]:order-2';

const BADGE: Record<'neutral' | 'error', string> = {
  neutral: 'bg-primary-subtle text-primary',
  error: 'bg-destructive-subtle text-destructive',
};

/** Message state of SCREEN-002 (frame `empty`): a tinted round glyph above the heading, then the way back. */
export function AccessMessage({ state }: { state: Exclude<Screen002State, 'not-linked'> }) {
  const { title, body } = SCREEN_002_COPY[state];
  return (
    <AuthShell
      variant="message"
      panel={AUTH_PANEL}
      title={title}
      description={body}
      className={`${FLAT} ${CENTRED}`}
    >
      <span
        aria-hidden="true"
        data-state={state}
        className={`order-1 grid size-12 place-items-center rounded-full ${BADGE[state === 'removed' ? 'error' : 'neutral']}`}
      >
        <Icon name={STATE_ICON[state]} size={24} />
      </span>
      <Button variant="outline" asChild className="order-3">
        <Link href={ROUTES.signIn}>{ACCESS_FORM_COPY.back}</Link>
      </Button>
    </AuthShell>
  );
}

/** Not-linked state: heading and intro, a form card holding only the field and button, a text link back below. */
export function AccessNotLinked({ children }: { children: ReactNode }) {
  const { title, body } = SCREEN_002_COPY['not-linked'];
  return (
    <AuthShell
      variant="message"
      panel={AUTH_PANEL}
      title={title}
      description={body}
      className={FLAT}
    >
      <div
        data-state="not-linked"
        className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
      >
        {children}
      </div>
      <Link href={ROUTES.signIn} className="text-ui text-primary underline underline-offset-2">
        {ACCESS_FORM_COPY.back}
      </Link>
    </AuthShell>
  );
}
