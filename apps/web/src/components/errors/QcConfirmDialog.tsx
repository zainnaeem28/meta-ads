'use client';

import { Dialog } from '@shroomap/ui/cmp-013';

export interface QcClip {
  /** Segment label the user sees, for example "Segment 2". */
  label: string;
  qc: 'failed' | 'skipped';
  /** Why the check was skipped, when known. */
  reason?: string;
}

export interface QcConfirmDialogProps {
  open: boolean;
  clips: readonly QcClip[];
  /** Server message naming the clip(s), from the 422. */
  serverMessage?: string | null;
  /** The check results changed since the page loaded (recovery path after the 422). */
  changed?: boolean;
  pending?: boolean;
  /** A 5xx or any other code from the submit, shown inside the dialog. */
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}

const line = (clip: QcClip): string =>
  clip.qc === 'failed'
    ? `${clip.label}: check failed`
    : `${clip.label}: check skipped${clip.reason ? `, ${clip.reason}` : ''}`;

/** `qc_confirmation_required` recovery dialog (SCREEN-009 `qc-confirm`): warning tone, nothing assembles until confirmed. */
export function QcConfirmDialog({
  open,
  clips,
  serverMessage,
  changed = false,
  pending = false,
  error,
  onConfirm,
  onClose,
}: QcConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Confirm clips that did not pass the check"
      description={serverMessage ?? undefined}
      confirmLabel="Include these clips and assemble"
      cancelLabel="Go back"
      pending={pending}
      error={error}
      onConfirm={onConfirm}
    >
      {changed ? (
        <p className="text-ui">Check results changed since you opened this page.</p>
      ) : null}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-ui">
        {clips.map((clip) => (
          <li key={clip.label}>{line(clip)}</li>
        ))}
      </ul>
      <p className="text-ui text-muted-foreground">
        The final ad will include these clips as they are. Your confirmation is recorded.
      </p>
    </Dialog>
  );
}
