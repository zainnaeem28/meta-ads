'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Alert } from '../cmp-011';
import { Button } from '../cmp-003';
import { Input } from '../cmp-004';

export type DialogVariant = 'confirm' | 'typed-confirm' | 'form';

export interface DialogPanelProps {
  title: string;
  description?: string;
  variant?: DialogVariant;
  /** Form fields (`form` variant) or extra body content. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Confirm uses the destructive button. */
  destructive?: boolean;
  /** Typed confirm: the exact text the person must type before confirming. */
  confirmText?: string;
  /** Submitting: confirm shows the spinner and everything else is locked. */
  pending?: boolean;
  /** Blocking error from the last attempt, shown in the dialog. */
  error?: string;
  /** Unsaved changes: closing asks to discard first. */
  dirty?: boolean;
  /** Shows the discard question in place of the body. */
  discarding?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onKeepEditing?: () => void;
  onDiscard?: () => void;
  /** Id of the title element; the modal wrapper focuses and labels from it. */
  titleId?: string;
  /** Gallery display of a state on the page: a labelled group instead of a second modal dialog. */
  inline?: boolean;
}

/** The dialog card without the overlay or focus handling: used by `Dialog` and to show each state in the gallery. */
export function DialogPanel({
  title,
  description,
  variant = 'confirm',
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  confirmText,
  pending = false,
  error,
  discarding = false,
  onConfirm,
  onCancel,
  onKeepEditing,
  onDiscard,
  titleId,
  inline = false,
}: DialogPanelProps) {
  const ownId = useId();
  const tid = titleId ?? `${ownId}-title`;
  const did = `${ownId}-desc`;
  const [typed, setTyped] = useState('');
  const typedOk = variant !== 'typed-confirm' || typed === confirmText;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pending && typedOk) onConfirm();
  };

  return (
    <div
      role={inline ? 'group' : 'dialog'}
      aria-modal={inline ? undefined : 'true'}
      aria-labelledby={tid}
      aria-describedby={description ? did : undefined}
      aria-busy={pending ? true : undefined}
      data-variant={variant}
      data-state={discarding ? 'dirty-discard' : pending ? 'pending' : error ? 'error' : 'open'}
      tabIndex={-1}
      className="flex w-full max-w-120 flex-col gap-4 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-lg"
    >
      {discarding ? (
        <>
          <h2 id={tid} className="text-section font-semibold">
            Discard changes?
          </h2>
          <p id={did} className="text-ui text-muted-foreground">
            You have unsaved changes. If you leave now they are lost.
          </p>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={onKeepEditing} data-autofocus="">
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <h2 id={tid} className="text-section font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={did} className="text-ui text-muted-foreground">
              {description}
            </p>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert">
              {error}
            </Alert>
          ) : null}
          {variant === 'typed-confirm' ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${ownId}-typed`} className="text-ui font-medium">
                Type <strong className="font-mono">{confirmText}</strong> to confirm
              </label>
              <Input
                id={`${ownId}-typed`}
                value={typed}
                disabled={pending}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
                data-autofocus=""
              />
            </div>
          ) : null}
          {children}
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={onCancel} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'primary'}
              pending={pending}
              pendingLabel="Working…"
              disabled={!typedOk}
            >
              {confirmLabel}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export interface DialogProps
  extends Omit<DialogPanelProps, 'discarding' | 'onKeepEditing' | 'onDiscard' | 'titleId' | 'onCancel'> {
  open: boolean;
  /** Called when the dialog should close (cancel, Escape, overlay click, or discard confirmed). */
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** CMP-013 modal dialog: focus moves in and is trapped, Escape closes, focus returns to the opener. */
export function Dialog({ open, onClose, ...panel }: DialogProps) {
  const [discarding, setDiscarding] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const requestClose = () => {
    if (panel.pending) return;
    if (panel.dirty) setDiscarding(true);
    else onClose();
  };

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    return () => {
      setDiscarding(false);
      opener.current?.focus();
    };
  }, [open]);

  // Move focus in whenever the body changes (open, and to/from the discard question).
  useEffect(() => {
    if (!open) return;
    const root = card.current;
    const target =
      root?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
      root?.querySelector<HTMLElement>(FOCUSABLE) ??
      root?.firstElementChild;
    (target as HTMLElement | null | undefined)?.focus();
  }, [open, discarding]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (discarding) setDiscarding(false);
      else requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(card.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.hasAttribute('disabled'),
    );
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !card.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !card.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3"
      data-testid="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div ref={card} className="flex w-full justify-center">
        <DialogPanel
          {...panel}
          titleId={titleId}
          discarding={discarding}
          onCancel={requestClose}
          onKeepEditing={() => setDiscarding(false)}
          onDiscard={() => {
            setDiscarding(false);
            onClose();
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
