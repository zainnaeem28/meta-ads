'use client';

import { Dialog } from '@shroomap/ui/cmp-013';

export interface StepUpDialogProps {
  open: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** `recent_auth_required` step-up (CMP-013): re-authenticate, then the user repeats the action; nothing is auto-submitted. */
export function StepUpDialog({ open, onConfirm, onClose }: StepUpDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Confirm it is you"
      description="For your security, confirm it is you again to continue."
      confirmLabel="Confirm sign-in"
      onConfirm={onConfirm}
    />
  );
}
