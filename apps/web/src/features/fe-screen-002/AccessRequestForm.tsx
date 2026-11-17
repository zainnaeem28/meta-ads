'use client';

import { useCreateAccessRequest } from '@shroomap/contracts';
import { useState, type FormEvent } from 'react';
import { Button } from '@shroomap/ui/cmp-003';
import { Textarea } from '@shroomap/ui/cmp-004';
import { FormField } from '@shroomap/ui/cmp-010';
import { Alert } from '@shroomap/ui/cmp-011';
import { isApiClientError } from '../../lib/api/errors';
import { resolveError } from '../../lib/errors/resolve';
import { ACCESS_FORM_COPY, NOTE_MAX } from './copy';

/** What the form reports to the screen: the request was taken (any address, same answer) or the form is switched off. */
export type AccessFormOutcome = 'received' | 'form-off';

/**
 * The request-access form (API-002). The requester's email comes from the token on the server, never from this form;
 * the only field is the optional note. The answer is the same whether or not a request or an account exists.
 */
export function AccessRequestForm({ onDone }: { onDone: (outcome: AccessFormOutcome) => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const mutation = useCreateAccessRequest();

  const fieldError =
    isApiClientError(error) && error.code === 'validation_failed'
      ? ACCESS_FORM_COPY.noteTooLong
      : undefined;
  const alert = error && !fieldError ? resolveError(error, { surface: 'context' }) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmed = note.trim();
    mutation.mutate(
      { data: trimmed ? { note: trimmed } : {} },
      {
        onSuccess: () => onDone('received'),
        onError: (err) => {
          if (isApiClientError(err) && err.code === 'not_found') onDone('form-off');
          else setError(err);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3" noValidate>
      {alert ? (
        <Alert
          role="alert"
          variant={alert.tone === 'destructive' ? 'destructive' : 'warning'}
          data-code={alert.code}
        >
          {alert.message}
        </Alert>
      ) : null}
      <FormField
        label={ACCESS_FORM_COPY.label}
        mark="optional"
        help={ACCESS_FORM_COPY.help}
        error={fieldError}
      >
        {(control) => (
          <Textarea
            {...control}
            name="note"
            rows={4}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </FormField>
      <Button type="submit" pending={mutation.isPending} pendingLabel={ACCESS_FORM_COPY.pending}>
        {ACCESS_FORM_COPY.submit}
      </Button>
    </form>
  );
}
