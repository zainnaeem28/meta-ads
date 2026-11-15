import { notFound } from 'next/navigation';
import { ApiProbe } from './api-probe';

// Test-only page for the TASK-082 e2e; the build flag is set only by the e2e build, so a product build has no probe.
export default function ApiProbePage() {
  if (process.env.NEXT_PUBLIC_E2E_PROBE !== '1') notFound();
  return <ApiProbe />;
}
