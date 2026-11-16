import { AuthShell } from '@shroomap/ui/cmp-032';
import { AUTH_COPY } from '../../features/fe-screen-001-003/copy';

/** SCREEN-001 `loading`: the shell with the busy status while the page streams. */
export default function AuthLoading() {
  return <AuthShell title={AUTH_COPY.productName} providerState="loading" />;
}
