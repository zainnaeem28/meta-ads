import type { ReactNode } from 'react';

/** The auth group: each page renders its own auth shell (CMP-032) with the `main` landmark and the one `h1`. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
