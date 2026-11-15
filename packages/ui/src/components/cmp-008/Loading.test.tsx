// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { Progress, Skeleton, SkeletonRegion, Spinner } from './index';

afterEach(cleanup);

describe('CMP-008 Loading', () => {
  it('determinate progress exposes role=progressbar with its value', async () => {
    const { container } = render(<Progress label="Upload" value={60} />);
    const bar = screen.getByRole('progressbar', { name: 'Upload' });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuetext', '60%');
    expect(bar.querySelector('[data-progress-fill]')).toHaveStyle({ width: '60%' });
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('clamps the value to 0..100', () => {
    render(<Progress label="Over" value={140} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    cleanup();
    render(<Progress label="Under" value={-5} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('indeterminate progress has no value and is static under reduced motion', async () => {
    const { container } = render(<Progress label="Working" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    expect(bar.querySelector('[data-progress-fill]')?.className).toContain(
      'motion-reduce:animate-none',
    );
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('spinner has a visible text status and a static reduced-motion style', async () => {
    const { container } = render(<Spinner label="Saving" />);
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    const ring = container.querySelector('[data-spinner]');
    expect(ring).toHaveAttribute('aria-hidden', 'true');
    expect(ring?.className).toContain('motion-reduce:animate-none');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('skeleton region is aria-busy with a visible status and hidden blocks', async () => {
    const { container } = render(
      <SkeletonRegion status="Loading campaigns" data-testid="region">
        <Skeleton className="w-1/2" />
        <Skeleton />
      </SkeletonRegion>,
    );
    expect(screen.getByTestId('region')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading campaigns')).toBeVisible();
    const blocks = container.querySelectorAll('[data-skeleton]');
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b).toHaveAttribute('aria-hidden', 'true');
      expect(b.className).toContain('motion-reduce:animate-none');
    }
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
