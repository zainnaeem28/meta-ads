'use client';

import { useState } from 'react';
import { ProviderKeyCard } from './ProviderKeyCard';
import type { KeyCardState, Provider } from './ProviderKeyCard';

const DESCRIPTION: Record<Provider, string> = {
  openai: 'Used for briefs, script suggestions, image analysis and audio checks.',
  wavespeed: 'Used to generate the video clips.',
};

/** Gallery-only: the delete flow, active to delete-confirm to none. */
export function KeyCardDemo({ provider, initial }: { provider: Provider; initial: KeyCardState }) {
  const [state, setState] = useState<KeyCardState>(initial);
  return (
    <ProviderKeyCard
      provider={provider}
      state={state}
      hint="7Q2d"
      fingerprint="4f9a1c07b21e"
      description={DESCRIPTION[provider]}
      added="3 Nov 2026"
      lastUsed="12 min ago"
      jobsRunning={1}
      onReplace={() => setState('untested')}
      onDelete={() => setState('delete-confirm')}
      onCancelDelete={() => setState('active')}
      onConfirmDelete={() => setState('none')}
    />
  );
}
