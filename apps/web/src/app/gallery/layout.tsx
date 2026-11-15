import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isGalleryEnabled } from './registry';

// Read the environment per request: the same build serves the gallery in test and 404s in production.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Component gallery',
  robots: { index: false, follow: false, nocache: true },
};

export default function GalleryLayout({ children }: { children: ReactNode }) {
  if (!isGalleryEnabled()) notFound();
  return <div data-testid="gallery">{children}</div>;
}
