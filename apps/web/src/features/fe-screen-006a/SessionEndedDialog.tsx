'use client';

import { Button } from '@shroomap/ui/cmp-003';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SCREEN_006_COPY as COPY } from './copy';

/** `session-expired` (UI-UX §9.1): a modal alert dialog with the one action Sign in again; there is nothing to cancel. */
export function SessionEndedDialog({ step, onSignIn }: { step: number; onSignIn: () => void }) {
  const titleId = useId();
  const bodyId = useId();
  const card = useRef<HTMLDivElement>(null);
  const focusButton = () => card.current?.querySelector('button')?.focus();
  useEffect(focusButton, []);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3"
      data-testid="session-ended"
    >
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="flex w-full max-w-120 flex-col gap-4 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault();
            focusButton();
          }
        }}
      >
        <h2 id={titleId} className="text-section font-semibold">
          {COPY.sessionTitle}
        </h2>
        <p id={bodyId} className="text-ui text-muted-foreground">
          {COPY.sessionBody(step)}
        </p>
        <div className="flex flex-col gap-2 md:flex-row md:justify-end">
          <Button onClick={onSignIn}>{COPY.signInAgain}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
