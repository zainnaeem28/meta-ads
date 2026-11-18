// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from './index';

afterEach(cleanup);

const tabs = (count: number | null | undefined) => [
  { id: 'history', label: 'History', count },
  { id: 'drafts', label: 'Drafts' },
];
const slot = () => document.querySelector('[data-count-slot]') as HTMLElement;

// UI-UX §5.1: a count is drawn in a slot sized by reserved digits, never by the number, so loading to loaded moves nothing.
describe('Tabs count slot', () => {
  it('draws a same-size, hidden placeholder while the count is unknown, and the number in the same box after', () => {
    const { rerender } = render(
      <Tabs tabs={tabs(null)} value="history" onValueChange={() => undefined} label="Stages" />,
    );
    const loading = slot();
    expect(loading.dataset.countSlot).toBe('loading');
    expect(loading).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('tab', { name: 'History' })).toBeTruthy();
    const box = loading.className
      .match(/box-content|min-w-\[\dch\]|px-2|tabular-nums|text-center/g)
      ?.sort();
    rerender(
      <Tabs tabs={tabs(7)} value="history" onValueChange={() => undefined} label="Stages" />,
    );
    const loaded = slot();
    expect(loaded.dataset.countSlot).toBe('loaded');
    expect(
      loaded.className.match(/box-content|min-w-\[\dch\]|px-2|tabular-nums|text-center/g)?.sort(),
    ).toEqual(box);
    expect(screen.getByRole('tab', { name: 'History 7' })).toBeTruthy();
  });

  it('reserves 3 digits by default, 2 on request, and shows 999+ in a 4 character box', () => {
    const { rerender } = render(
      <Tabs tabs={tabs(5)} value="history" onValueChange={() => undefined} label="Stages" />,
    );
    expect(slot().className).toContain('min-w-(--count-slot-3)');
    rerender(
      <Tabs
        tabs={tabs(5)}
        reserve={2}
        value="history"
        onValueChange={() => undefined}
        label="Stages"
      />,
    );
    expect(slot().className).toContain('min-w-(--count-slot-2)');
    rerender(
      <Tabs tabs={tabs(1500)} value="history" onValueChange={() => undefined} label="Stages" />,
    );
    expect(slot().textContent).toBe('999+');
    expect(slot().className).toContain('min-w-(--count-slot-4)');
  });

  it('draws no slot for a tab without a count', () => {
    render(
      <Tabs
        tabs={tabs(undefined)}
        value="history"
        onValueChange={() => undefined}
        label="Stages"
      />,
    );
    expect(slot()).toBeNull();
  });
});
