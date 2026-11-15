import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BRAND, pageTitle } from '@shroomap/ui/brand';
import { AppProviders } from '../providers/app-providers';
import './globals.css';

// The absolute URLs of the social tags come from the origin configured per environment, read per request.
export const dynamic = 'force-dynamic';

const SOCIAL_ALT = `${BRAND.name}: ${BRAND.productName}`;

export function generateMetadata(): Metadata {
  const origin = process.env.WEB_ORIGIN;
  const image = { url: '/social-preview.png', width: 1200, height: 630, alt: SOCIAL_ALT };
  return {
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    title: { default: pageTitle(), template: `%s · ${BRAND.name}` },
    description: BRAND.description,
    applicationName: BRAND.name,
    manifest: '/site.webmanifest',
    robots: { index: false, follow: false },
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
        { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { url: '/favicon-48.png', sizes: '48x48', type: 'image/png' },
      ],
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    openGraph: {
      type: 'website',
      siteName: BRAND.name,
      title: pageTitle(),
      description: BRAND.description,
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: pageTitle(),
      description: BRAND.description,
      images: [{ url: image.url, alt: SOCIAL_ALT }],
    },
  };
}

export const viewport: Viewport = { themeColor: BRAND.themeColor };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
