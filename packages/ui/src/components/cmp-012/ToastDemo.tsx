'use client';

import { useState } from 'react';
import { Toast, ToastRegion, type ToastProps } from './Toast';

type Sample = Omit<ToastProps, 'onDismiss'>;

const STATIC: Sample[] = [
  { id: 's-success', variant: 'success', message: 'Campaign saved.' },
  { id: 's-info', variant: 'info', message: 'Your export is being prepared.' },
  { id: 's-error', variant: 'error', message: 'Could not publish. Try again.' },
  { id: 's-appearing', variant: 'info', message: 'Appearing state.', state: 'appearing' },
  { id: 's-dismissed', variant: 'info', message: 'Dismissed state.', state: 'dismissed' },
];

/** Gallery host for CMP-012: static states in flow, plus a live region that adds real toasts. */
export function ToastDemo() {
  const [live, setLive] = useState<Sample[]>([]);
  const dismiss = (id: string) => setLive((all) => all.filter((t) => t.id !== id));
  const add = (variant: 'success' | 'error') =>
    setLive((all) => [
      ...all,
      {
        id: `live-${all.length}-${variant}`,
        variant,
        message: variant === 'error' ? 'Live error toast.' : 'Live success toast.',
      },
    ]);
  return (
    <div className="flex flex-col gap-4">
      <div data-testid="toast-static" className="flex max-w-sm flex-col gap-3">
        {STATIC.map((t) =>
          t.state === 'appearing' ? (
            <div
              key={t.id}
              data-testid="toast-appearing"
              className="rounded-md border border-dashed border-border p-1"
            >
              <p className="mb-1 text-caption text-muted-foreground">
                Appearing: start frame, opacity 0 inside the dashed outline.
              </p>
              <Toast {...t} onDismiss={() => undefined} />
            </div>
          ) : (
            <Toast key={t.id} {...t} onDismiss={() => undefined} />
          ),
        )}
        <p className="text-caption text-muted-foreground">The dismissed toast renders nothing.</p>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => add('success')}
          className="min-h-control rounded-md border border-border px-4 text-ui"
        >
          Show success toast
        </button>
        <button
          type="button"
          onClick={() => add('error')}
          className="min-h-control rounded-md border border-border px-4 text-ui"
        >
          Show error toast
        </button>
      </div>
      <ToastRegion toasts={live} onDismiss={dismiss} />
    </div>
  );
}
