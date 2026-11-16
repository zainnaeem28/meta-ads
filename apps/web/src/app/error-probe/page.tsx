import { notFound } from 'next/navigation';
import { ErrorProbe } from './error-probe';

// Test-only page for the TASK-083 e2e; the build flag is set only by the e2e build, so a product build has no probe.
export default async function ErrorProbePage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  if (process.env.NEXT_PUBLIC_E2E_PROBE !== '1') notFound();
  const { scenario } = await searchParams;
  return <ErrorProbe scenario={scenario === 'assemble' ? 'assemble' : 'load'} />;
}
