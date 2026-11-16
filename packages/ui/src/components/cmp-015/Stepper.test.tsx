// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { Stepper, stepState } from './index';

afterEach(cleanup);

const STEPS = ['Format', 'Product', 'Audience and direction', 'Concept and script'];

describe('CMP-015 Stepper', () => {
  it('is an ordered list labelled Progress with the current step marked', async () => {
    const { container } = render(<Stepper steps={STEPS} current={2} />);
    const list = screen.getByRole('list', { name: 'Progress' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
    ]);
    expect(items.filter((i) => i.getAttribute('aria-current') === 'step')).toHaveLength(1);
    expect(items[2]).toHaveAttribute('aria-current', 'step');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('tells assistive tech which steps are done and keeps every label readable', () => {
    render(<Stepper steps={STEPS} current={1} />);
    expect(screen.getByText('(done)')).toBeInTheDocument();
    for (const label of STEPS) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('hides non-current labels visually on phones only', () => {
    render(<Stepper steps={STEPS} current={0} />);
    expect(screen.getByText('Product').className).toContain('max-md:sr-only');
    expect(screen.getByText('Format').className).not.toContain('sr-only');
  });

  it('derives states from the index', () => {
    expect([0, 1, 2].map((i) => stepState(i, 1))).toEqual(['done', 'current', 'upcoming']);
  });
});
