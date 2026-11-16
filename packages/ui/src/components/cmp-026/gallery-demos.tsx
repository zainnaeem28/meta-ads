'use client';

import { useState } from 'react';
import { FinalPreview } from './FinalPreview';
import type { PreviewState } from './FinalPreview';

const CAPTIONS = 'data:text/vtt;charset=utf-8,WEBVTT';

/** Gallery-only: a preview whose download request counts how often a fresh URL was asked for. */
export function PreviewDemo({ state }: { state: PreviewState }) {
  const [requests, setRequests] = useState(0);
  return (
    <div className="flex flex-col gap-2">
      <FinalPreview
        state={state}
        title="Summer sale, 9:16"
        durationSeconds={24}
        captionsSrc={CAPTIONS}
        qc={{ passed: 5, total: 5 }}
        step="Joining segments (3 of 4)"
        progress={60}
        requestDownloadUrl={async () => {
          setRequests((n) => n + 1);
          return '#fresh-link';
        }}
        onDownloadUrl={() => undefined}
        onRetry={() => undefined}
        onReassemble={() => undefined}
      />
      <p className="text-caption text-muted-foreground" data-testid={`downloads-${state}`}>
        Fresh links requested: {requests}
      </p>
    </div>
  );
}
