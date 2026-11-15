/** Brand constants shared by the manifest, the page metadata and the tests (BRAND-BRIEF §3). */
export const BRAND = {
  name: 'ShrooMap',
  productName: 'ShrooMap AI UGC Ad Director',
  description: 'Direct AI UGC video ads for your brand, from brief to export.',
  themeColor: '#4A6F47', // token-lint-ignore manifest theme_color (--primary)
  backgroundColor: '#FBF9F4', // token-lint-ignore manifest background_color (--background)
} as const;

/** The page-title pattern "Page · ShrooMap". */
export function pageTitle(page?: string): string {
  return page ? `${page} · ${BRAND.name}` : BRAND.productName;
}
