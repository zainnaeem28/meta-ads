'use client';

import { useEffect } from 'react';
import { pageTitle } from '../cmp-001';

/** Sets the document title ("Page · ShrooMap") and `<meta name="robots" content="noindex">` for the signed-in app; restores both on unmount. */
export function useShellDocument(page: string | undefined): void {
  useEffect(() => {
    const previous = document.title;
    document.title = pageTitle(page);
    return () => {
      document.title = previous;
    };
  }, [page]);

  useEffect(() => {
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = meta === null;
    const previous = meta?.content ?? '';
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'robots';
      document.head.appendChild(meta);
    }
    meta.content = 'noindex';
    return () => {
      if (created) meta.remove();
      else meta.content = previous;
    };
  }, []);
}
