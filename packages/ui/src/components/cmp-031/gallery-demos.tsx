'use client';

import { useState } from 'react';
import { AdminShell, type AdminShellProps } from './AdminShell';

/** Gallery-only: one admin shell in a fixed frame with sample page content and a dismissible toast. */
export function AdminShellDemo(props: Partial<AdminShellProps>) {
  const [toasts, setToasts] = useState(props.toasts ?? []);
  return (
    <AdminShell
      path="/admin/accounts"
      pageName="Accounts"
      userName="Sam Okafor"
      embedded
      {...props}
      toasts={toasts}
      onDismissToast={(id) => setToasts((all) => all.filter((t) => t.id !== id))}
      onNavigate={() => undefined}
    >
      <h1 className="text-h1 font-semibold">Accounts</h1>
      <p className="text-ui text-muted-foreground">Page content sits here.</p>
    </AdminShell>
  );
}
