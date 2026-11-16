'use client';

import { useState } from 'react';
import { FinalPreview } from './FinalPreview';
import type { PreviewState } from './FinalPreview';

const POSTER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320" viewBox="0 0 180 320"><rect width="180" height="320" fill="#3b2f5c"/><circle cx="90" cy="140" r="46" fill="#e8b84a"/><rect x="30" y="220" width="120" height="14" rx="7" fill="#f4efe6"/><rect x="50" y="244" width="80" height="10" rx="5" fill="#b9aedb"/></svg>',
  );
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
        poster={POSTER}
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
