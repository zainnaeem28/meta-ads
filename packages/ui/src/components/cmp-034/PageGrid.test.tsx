// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { GRID_SPANS, GridCol, PageGrid } from './index';

afterEach(cleanup);

describe('CMP-034 PageGrid', () => {
  it('is one column under 768 px and 12 columns above', () => {
    render(<PageGrid data-testid="g" />);
    const cls = screen.getByTestId('g').className;
    expect(cls).toContain('grid-cols-1');
    expect(cls).toContain('md:grid-cols-12');
  });

  it.each(GRID_SPANS)('col-%s spans %s columns from 768 px', (span) => {
    render(<GridCol span={span} data-testid="c" />);
    expect(screen.getByTestId('c').className).toContain(`md:col-span-${span}`);
  });

  it('defaults to full width, supports list semantics and has no axe violations', async () => {
    const { container } = render(
      <PageGrid as="ul">
        <GridCol as="li" data-testid="d">A</GridCol>
        <GridCol as="li" span={6}>B</GridCol>
      </PageGrid>,
    );
    expect(screen.getByTestId('d').className).toContain('md:col-span-12');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
