import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@shroomap/ui/cmp-003';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { Icon } from '@shroomap/ui/icons';
import { AUTH_PANEL } from '../fe-screen-001-003/copy';
import { ROUTES } from '../../lib/errors/routes';
import { ACCESS_FORM_COPY, SCREEN_002_COPY, STATE_ICON, type Screen002State } from './copy';

/** The auth shell's message card for one state of SCREEN-002; children sit between the copy and the way back. */
export function AccessMessage({ state, children }: { state: Screen002State; children?: ReactNode }) {
  const { title, body } = SCREEN_002_COPY[state];
  return (
    <AuthShell variant="message" panel={AUTH_PANEL} title={title} description={body}>
      <div data-state={state} className="flex flex-col items-start gap-4">
        <span aria-hidden="true" className="text-muted-foreground">
          <Icon name={STATE_ICON[state]} size={24} />
        </span>
        {children}
        <Button variant="outline" asChild>
          <Link href={ROUTES.signIn}>{ACCESS_FORM_COPY.back}</Link>
        </Button>
      </div>
    </AuthShell>
  );
}
