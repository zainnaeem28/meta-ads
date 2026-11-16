'use client';

import { createAssembly, useGetMe } from '@shroomap/contracts';
import { useRef, useState } from 'react';
import { Button } from '@shroomap/ui/cmp-003';
import { ErrorNotice, QcConfirmDialog } from '../../components/errors';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/client';
import { useRetryFailures } from '../../lib/errors/countdown';

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const CLIPS = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];

function LoadScenario() {
  const me = useGetMe({ query: { retry: false } });
  if (me.error) return <ErrorNotice error={me.error} onAction={() => void me.refetch()} />;
  return <p>{me.isPending ? 'Loading' : 'Loaded'}</p>;
}

// A job-creating write (API-070): every retry of the same payload reuses its idempotency key.
function AssembleScenario() {
  const keys = useRef(new IdempotencyKeys());
  const { failures, recordFailure, recordSuccess } = useRetryFailures();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [qcOpen, setQcOpen] = useState(false);
  const [qc, setQc] = useState(false);

  const submit = async (override: boolean, isRetry = false) => {
    const data = {
      clips: CLIPS,
      ...(override ? { confirmations: { qcOverride: [CLIPS[0]!] } } : {}),
    };
    setPending(true);
    try {
      await createAssembly(CAMPAIGN, data, idempotencyHeaders(keys.current.keyFor(data)));
      keys.current.succeeded();
      recordSuccess();
      setError(null);
      setQcOpen(false);
      setDone(true);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'qc_confirmation_required') {
        setQc(true);
        setQcOpen(true);
        setError(null);
      } else {
        setError(err);
        if (isRetry) recordFailure();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={() => void submit(qc)} pending={pending} pendingLabel="Assembling…">
        Assemble
      </Button>
      {done ? <p>Assembled</p> : null}
      {error ? (
        <ErrorNotice
          error={error}
          surface="context"
          call="job"
          failures={failures}
          retrying={pending}
          onAction={(action) => {
            if (action === 'retry') void submit(qc, true);
          }}
        />
      ) : null}
      <QcConfirmDialog
        open={qcOpen}
        clips={[{ label: 'Segment 2', qc: 'failed' }]}
        serverMessage="Segment 2 did not pass the check."
        changed
        pending={pending}
        onConfirm={() => void submit(true)}
        onClose={() => setQcOpen(false)}
      />
    </div>
  );
}

export function ErrorProbe({ scenario }: { scenario: 'load' | 'assemble' }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4 font-sans text-foreground">
      <h1 className="text-section font-semibold">Error probe</h1>
      {scenario === 'load' ? <LoadScenario /> : <AssembleScenario />}
    </main>
  );
}
