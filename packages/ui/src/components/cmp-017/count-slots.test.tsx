// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FilterBar, type FilterChip } from './index';

afterEach(cleanup);

const bar = (chips: FilterChip[], reserve?: 2 | 3) => (
  <FilterBar
    searchLabel="Search"
    query=""
    onQueryChange={() => undefined}
    chips={chips}
    status=""
    onStatusChange={() => undefined}
    onClearAll={() => undefined}
    {...(reserve ? { reserve } : {})}
  />
);
const slots = () => [...document.querySelectorAll<HTMLElement>('[data-count-slot]')];

describe('FilterBar count slots (UI-UX §5.1)', () => {
  it('draws hidden same-size placeholders while counts are unknown, then the numbers in the same boxes', () => {
    const { rerender } = render(
      bar([
        { id: 'a', label: 'All', count: null },
        { id: 'f', label: 'Failed', count: null },
      ]),
    );
    const loading = slots();
    expect(loading.map((s) => s.dataset.countSlot)).toEqual(['loading', 'loading']);
    for (const s of loading) expect(s).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
    rerender(
      bar([
        { id: 'a', label: 'All', count: 12 },
        { id: 'f', label: 'Failed', count: 2 },
      ]),
    );
    expect(slots().map((s) => s.textContent)).toEqual(['12', '2']);
    for (const s of slots()) expect(s.className).toContain('min-w-(--count-slot-3)');
  });

  it('reserves digits, shows 999+, and draws nothing for a chip without a count', () => {
    const { rerender } = render(bar([{ id: 'a', label: 'All', count: 3 }], 2));
    expect(slots()[0]!.className).toContain('min-w-(--count-slot-2)');
    rerender(bar([{ id: 'a', label: 'All', count: 1000 }]));
    expect(slots()[0]!.textContent).toBe('999+');
    expect(slots()[0]!.className).toContain('min-w-(--count-slot-4)');
    rerender(bar([{ id: 'a', label: 'All' }]));
    expect(slots()).toHaveLength(0);
  });

  it('is one labelled, keyboard-reachable row whose chips never wrap on a phone, and arrow keys move between chips', () => {
    render(
      bar([
        { id: 'a', label: 'All', count: 1 },
        { id: 'f', label: 'Failed', count: 2 },
      ]),
    );
    const row = screen.getByRole('group', { name: 'Filter by status' });
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row.className).toContain('max-md:flex-nowrap');
    expect(row.className).toContain('max-md:overflow-x-auto');
    const [first, second] = screen.getAllByRole('button', { pressed: false });
    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });
});
