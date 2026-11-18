import { AuthShell } from '@shroomap/ui/cmp-032';
import { AUTH_COPY } from '../../features/fe-screen-001-003/copy';

/**
 * SCREEN-001 `loading`: the shell with the busy status while the page streams. It carries the page's intro line too, so the
 * largest text of the first paint is the one the page ends with: the page replacing it neither shifts the card nor becomes a
 * later, larger LCP candidate (a cold load measured 0.9 s or 3 s depending on which chunk the first paint caught).
 */
export default function AuthLoading() {
  return (
    <AuthShell
      title={AUTH_COPY.productName}
      description={AUTH_COPY.signInIntro}
      providerState="loading"
    />
  );
}
