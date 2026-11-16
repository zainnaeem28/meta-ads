// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { InlineBar, MetricGrid, MetricTile, TILE_VARIANTS } from './index';

afterEach(cleanup);

describe('CMP-028 Metric tile and inline bar', () => {
  it.each(TILE_VARIANTS)('%s variant passes axe with a value and a bar', async (variant) => {
    const { container } = render(
      <MetricGrid>
        <MetricTile
          variant={variant}
          label="Videos"
          value="18"
          unit="videos"
          delta="up 3"
          bar={{ value: 18, max: 24, tone: 2 }}
        />
      </MetricGrid>,
    );
    expect(screen.getByRole('group')).toHaveAttribute('data-variant', variant);
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('up 3')).toBeInTheDocument();
    expect(screen.getByTestId('bar-label')).toHaveTextContent('18 of 24');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('cost tiles are labelled estimated', () => {
    render(<MetricTile variant="cost" label="Cost" value="$1.20" />);
    expect(screen.getByRole('group', { name: 'Cost (estimated)' })).toBeInTheDocument();
  });

  it('loading shows a status and hides the value', async () => {
    const { container } = render(<MetricTile label="Videos" loading value="9" />);
    expect(screen.getByRole('group')).toHaveAttribute('data-state', 'loading');
    expect(screen.getByRole('group')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading Videos');
    expect(screen.queryByText('9')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('no data says so, and omits delta and bar', async () => {
    const { container } = render(
      <MetricTile label="Failed runs" value={null} delta="x" bar={{ value: 1, max: 2 }} />,
    );
    expect(screen.getByRole('group')).toHaveAttribute('data-state', 'no-data');
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('bar exposes a meter with a numeric label and clamps', () => {
    const { rerender } = render(<InlineBar label="Budget" value={30} max={40} />);
    const meter = screen.getByRole('meter', { name: 'Budget' });
    expect(meter).toHaveAttribute('aria-valuenow', '30');
    expect(meter).toHaveAttribute('aria-valuetext', '30 of 40');
    expect(meter.firstElementChild).toHaveStyle({ width: '75%' });
    rerender(<InlineBar label="Budget" value={90} max={40} tone={5} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '40');
    rerender(<InlineBar label="Budget" value={-4} max={0} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
  });

  it('grid is 1 up, 2 up from tablet and 4 up on desktop', () => {
    const { container } = render(<MetricGrid />);
    expect(container.firstElementChild).toHaveClass('grid-cols-1', 'md:grid-cols-2', 'lg:grid-cols-4');
  });

  it('bar uses its own label when given', () => {
    render(<MetricTile label="Videos" value="1" bar={{ value: 1, max: 2, label: 'Share of target' }} />);
    expect(screen.getByRole('meter', { name: 'Share of target' })).toBeInTheDocument();
  });
});
