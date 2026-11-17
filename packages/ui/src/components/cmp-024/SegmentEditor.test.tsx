// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_DELAY_MS, SegmentEditor, countWords, wordZone } from './index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('CMP-024 helpers', () => {
  it('counts words and classifies zones at the boundaries', () => {
    expect(countWords('  ')).toBe(0);
    expect(countWords(' a  b\nc ')).toBe(3);
    expect([31, 32, 42, 43, 45, 46].map(wordZone)).toEqual([
      'short',
      'within',
      'within',
      'long',
      'long',
      'blocked',
    ]);
  });
});

describe('CMP-024 SegmentEditor', () => {
  it.each([
    ['within', 36],
    ['short', 5],
    ['long', 44],
    ['blocked', 48],
  ])('%s zone shows its counter text and passes axe', async (zone, n) => {
    const { container } = render(
      <SegmentEditor segment={3} value={words(n)} onChange={() => {}} />,
    );
    expect(screen.getByRole('region', { name: 'Segment 3 editor' })).toHaveAttribute(
      'data-zone',
      zone,
    );
    const box = screen.getByLabelText('Segment 3 dialogue');
    expect(box).toHaveAccessibleDescription(new RegExp(`^${n} words`));
    expect(box.getAttribute('aria-invalid') === 'true').toBe(zone === 'blocked');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('shows saving and saved states and issues', () => {
    const { rerender } = render(
      <SegmentEditor
        segment={1}
        value="one"
        onChange={() => {}}
        saveState="saving"
        issues={['Check this']}
      />,
    );
    expect(screen.getByText('Saving')).toBeInTheDocument();
    expect(screen.getByText('Check this')).toBeInTheDocument();
    expect(
      screen.getByText('1 word, below the 32 to 42 word target', { selector: '[aria-hidden]' }),
    ).toBeInTheDocument();
    rerender(<SegmentEditor segment={1} value="one" onChange={() => {}} saveState="saved" />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('reports typing and announces politely only after typing pauses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function Host() {
      const [v, setV] = useState(words(31));
      return <SegmentEditor segment={1} value={v} onChange={setV} />;
    }
    render(<Host />);
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('31 words, below');
    await userEvent.type(screen.getByLabelText('Segment 1 dialogue'), ' extra', { delay: null });
    expect(live).toHaveTextContent('31 words, below');
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_DELAY_MS + 10);
    });
    expect(live).toHaveTextContent('32 words, within');
  });
});
