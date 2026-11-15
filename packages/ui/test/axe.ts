import axe from 'axe-core';

/** Runs axe-core on the rendered container; returns the violations (critical and serious must be none). */
export async function axeViolations(container: Element) {
  const result = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    // jsdom has no layout or paint, so colour contrast is checked in the browser (Playwright axe).
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations;
}
