'use client';

import { useGetMe, type MeLinked, type MeNotLinked } from '@shroomap/contracts';
import { useEffect, useState } from 'react';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { Alert } from '@shroomap/ui/cmp-011';
import { Button } from '@shroomap/ui/cmp-003';
import { AUTH_COPY, AUTH_PANEL } from '../fe-screen-001-003/copy';
import { isApiClientError } from '../../lib/api/errors';
import { resolveError } from '../../lib/errors/resolve';
import { ROUTES } from '../../lib/errors/routes';
import { AccessMessage } from './AccessMessage';
import { AccessRequestForm, type AccessFormOutcome } from './AccessRequestForm';
import { ACCESS_FORM_COPY, type NamedState, type Screen002State } from './copy';

const go = (href: string) => window.location.assign(href);

/** The account view of an answered API-001 call (the typed union also covers error bodies, which the client throws). */
const accountOf = (me: ReturnType<typeof useGetMe>): MeLinked | MeNotLinked | undefined =>
  (me.data as { data?: { data?: MeLinked | MeNotLinked } } | undefined)?.data?.data;

/** The state API-001 gives, or null while it is unknown. A suspended or removed account is answered by its error code. */
function stateFromMe(me: ReturnType<typeof useGetMe>): Screen002State | 'linked' | 'error' | null {
  if (me.isPending) return null;
  if (me.error) {
    const code = isApiClientError(me.error) ? me.error.code : null;
    if (code === 'account_suspended') return 'suspended';
    if (code === 'account_removed') return 'removed';
    return 'error';
  }
  const body = accountOf(me);
  if (!body || body.linkState === 'linked') return 'linked';
  return body.accessRequest.state === 'pending' ? 'request-pending' : 'not-linked';
}

/**
 * SCREEN-002 at `/access`. `named` is the state the visitor was sent to by name; a suspended, removed or invalid-invite
 * state needs no api call. Otherwise API-001 decides, and a linked account is sent on to the campaigns. A not-linked
 * token reaches only API-001 and API-002.
 */
export function AccessScreen({ named, navigate = go }: { named: NamedState | null; navigate?: (href: string) => void }) {
  const lookup = named === null || named === 'not-linked';
  const me = useGetMe({ query: { enabled: lookup, retry: false } });
  const [submitted, setSubmitted] = useState<AccessFormOutcome | null>(null);
  const resolved = lookup ? stateFromMe(me) : null;

  useEffect(() => {
    if (resolved === 'linked') navigate(ROUTES.campaigns);
  }, [resolved, navigate]);

  if (!lookup && named) return <AccessMessage state={named} />;
  if (resolved === 'suspended' || resolved === 'removed') return <AccessMessage state={resolved} />;
  if (resolved === null || resolved === 'linked') {
    return (
      <AuthShell variant="message" panel={AUTH_PANEL} title={AUTH_COPY.productName} providerState="loading" />
    );
  }
  if (resolved === 'error') {
    const view = resolveError(me.error);
    return (
      <AuthShell variant="message" panel={AUTH_PANEL} title={ACCESS_FORM_COPY.checkFailedTitle}>
        <Alert variant={view.tone === 'destructive' ? 'destructive' : 'warning'}>{view.message}</Alert>
        <Button variant="outline" onClick={() => void me.refetch()}>
          {ACCESS_FORM_COPY.tryAgain}
        </Button>
      </AuthShell>
    );
  }
  if (resolved === 'request-pending' || submitted === 'received') return <AccessMessage state="request-pending" />;
  const account = accountOf(me);
  const formEnabled = account?.linkState === 'not_linked' && account.accessRequest.formEnabled;
  return (
    <AccessMessage state="not-linked">
      {submitted === 'form-off' || !formEnabled ? (
        <p className="text-ui text-muted-foreground">{ACCESS_FORM_COPY.formOff}</p>
      ) : (
        <AccessRequestForm onDone={setSubmitted} />
      )}
    </AccessMessage>
  );
}
