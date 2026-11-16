import type { Metadata } from 'next';
import { NotFoundScreen } from '../features/fe-screen-004/NotFoundScreen';
import { SCREEN_004_COPY } from '../features/fe-screen-004/copy';

// The framework reads this file for every unknown URL (and adds its own noindex to the 404 response); the screen itself lives in features/fe-screen-004.
export const metadata: Metadata = { title: SCREEN_004_COPY['route-404'].title };

export default function NotFound() {
  return <NotFoundScreen state="route-404" />;
}
