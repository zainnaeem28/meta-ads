import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { isGalleryEnabled, loadSections, type SectionMeta } from './registry';

const C: ComponentType = () => null;
function fake(files: Record<string, SectionMeta>) {
  const ctx = (key: string) => ({ default: C, meta: files[key]! });
  ctx.keys = () => Object.keys(files);
  return ctx;
}

describe('gallery registry', () => {
  it('discovers section files, ordered by order then id, skipping tests', () => {
    const sections = loadSections(
      fake({
        './b.tsx': { id: 'CMP-010', title: 'B' },
        './a.tsx': { id: 'CMP-002', title: 'A', order: 2 },
        './c.tsx': { id: 'CMP-009', title: 'C' },
        './a.test.tsx': { id: 'X', title: 'X' },
      }),
    );
    expect(sections.map((s) => s.id)).toEqual(['CMP-002', 'CMP-009', 'CMP-010']);
    expect(sections[0]!.Component).toBe(C);
  });

  it('is enabled only with GALLERY_ENABLED=true outside production', () => {
    expect(isGalleryEnabled({})).toBe(false);
    expect(isGalleryEnabled({ GALLERY_ENABLED: 'false' })).toBe(false);
    expect(isGalleryEnabled({ GALLERY_ENABLED: 'true', APP_ENV: 'test' })).toBe(true);
    expect(isGalleryEnabled({ GALLERY_ENABLED: 'true', APP_ENV: 'production' })).toBe(false);
  });
});
