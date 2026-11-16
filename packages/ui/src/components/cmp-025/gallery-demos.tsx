'use client';

import { useState } from 'react';
import { ProviderKeyCard } from './ProviderKeyCard';
import type { KeyCardState, Provider } from './ProviderKeyCard';

/** Gallery-only: the delete flow, active to delete-confirm to none. */
export function KeyCardDemo({ provider, initial }: { provider: Provider; initial: KeyCardState }) {
  const [state, setState] = useState<KeyCardState>(initial);
  return (
    <ProviderKeyCard
      provider={provider}
      state={state}
      hint="a3f9"
      fingerprint="sha256:9c1e…74b2"
      lastTested="12 Nov 2026, 09:41"
      eventTrailHref="#key-events"
      onReplace={() => setState('untested')}
      onDelete={() => setState('delete-confirm')}
      onCancelDelete={() => setState('active')}
      onConfirmDelete={() => setState('none')}
    />
  );
}
