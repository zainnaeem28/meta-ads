/** Reads custom-property declarations out of a stylesheet so tests can check the token mapping. */
export function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}

/** Every `--color-x: var(--y)` mapping in a theme stylesheet, as [x, y]. */
export function colourMappings(theme: string): [string, string][] {
  return [...theme.matchAll(/--color-([a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/g)].map(
    (m) => [m[1]!, m[2]!] as [string, string],
  );
}
