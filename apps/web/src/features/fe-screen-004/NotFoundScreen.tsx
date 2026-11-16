import Link from 'next/link';
import { Button } from '@shroomap/ui/cmp-003';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { Icon } from '@shroomap/ui/icons';
import { ROUTES } from '../../lib/errors/routes';
import { GO_HOME_LABEL, SCREEN_004_COPY, type Screen004State } from './copy';

/**
 * SCREEN-004: the message page for an unknown URL (`route-404`) and for a missing, deleted or not-yours record
 * (`unavailable`). No API call is made. "Go home" opens `/`, which sends a signed-in user to the campaign list and an
 * anonymous visitor to sign-in.
 */
export function NotFoundScreen({ state }: { state: Screen004State }) {
  const { title, body } = SCREEN_004_COPY[state];
  return (
    <AuthShell variant="message" title={title} description={body}>
      <div data-state={state} className="flex flex-col items-start gap-4">
        <span aria-hidden="true" className="text-muted-foreground">
          <Icon name={state === 'unavailable' ? 'lock' : 'circle-help'} size={24} />
        </span>
        <Button asChild>
          <Link href={ROUTES.home}>
            <Icon name="house" size={16} />
            {GO_HOME_LABEL}
          </Link>
        </Button>
      </div>
    </AuthShell>
  );
}
