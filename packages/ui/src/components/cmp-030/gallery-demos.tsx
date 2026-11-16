'use client';

import { useState } from 'react';
import { OperatorShell, type OperatorShellProps } from './OperatorShell';

const SAMPLE_TOASTS = [
  { id: 't1', variant: 'success' as const, message: 'Brief saved.' },
];

/** Gallery-only: one shell in a fixed frame with sample page content and a dismissible toast. */
export function ShellDemo(props: Partial<OperatorShellProps>) {
  const [toasts, setToasts] = useState(props.toasts ?? []);
  return (
    <OperatorShell
      role="user"
      path="/campaigns"
      pageName="Campaigns"
      userName="Alex Rivera"
      embedded
      {...props}
      toasts={toasts}
      onDismissToast={(id) => setToasts((all) => all.filter((t) => t.id !== id))}
      onNavigate={() => undefined}
    >
      <h1 className="text-h1 font-semibold">Campaigns</h1>
      <p className="text-ui text-muted-foreground">Page content sits here.</p>
    </OperatorShell>
  );
}

export { SAMPLE_TOASTS };
