import type { ComponentType } from 'react';

/** What a gallery section file exports next to its default component. */
export interface SectionMeta {
  /** Component id, e.g. `CMP-002`. */
  id: string;
  title: string;
  /** Sort key; ties break on id. */
  order?: number;
}

export interface GallerySection extends SectionMeta {
  Component: ComponentType;
}

interface SectionModule {
  default: ComponentType;
  meta: SectionMeta;
}

interface SectionContext {
  keys(): string[];
  (key: string): SectionModule;
}

// Bundler-resolved glob: each component ticket adds one file under ./sections and edits nothing here.
declare const require: { context(dir: string, deep: boolean, filter: RegExp): SectionContext };

export function loadSections(
  context: SectionContext = require.context('./sections', false, /\.tsx$/),
): GallerySection[] {
  return context
    .keys()
    .filter((key) => !/\.test\.tsx$/.test(key))
    .map((key) => {
      const mod = context(key);
      return { ...mod.meta, Component: mod.default };
    })
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

/** The gallery exists only when switched on and never in a production deployment (APP_ENV). */
export function isGalleryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GALLERY_ENABLED === 'true' && env.APP_ENV !== 'production';
}
