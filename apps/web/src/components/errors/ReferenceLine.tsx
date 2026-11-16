'use client';

import { Button } from '@shroomap/ui/cmp-003';
import { useState } from 'react';

export interface ReferenceLineProps {
  requestId: string;
}

/** The 500/503 "Reference" line: the request ID with a Copy button, so support can find the failing request. */
export function ReferenceLine({ requestId }: ReferenceLineProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-ui text-muted-foreground">
      <span>
        Reference: <code className="font-mono text-foreground">{requestId}</code>
      </span>
      <Button variant="ghost" onClick={copy} aria-label="Copy reference">
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span role="status" className="sr-only">
        {copied ? 'Reference copied' : ''}
      </span>
    </div>
  );
}
