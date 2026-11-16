// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CAUSES, JOB_STATES, JobCard } from './index';

afterEach(cleanup);

describe('CMP-022 JobCard', () => {
  it.each(JOB_STATES)('%s state shows its status in text and passes axe', async (state) => {
    const { container } = render(<JobCard segment={2} state={state} />);
    const card = screen.getByRole('article', { name: 'Segment 2 clip' });
    expect(card).toHaveAttribute('data-state', state);
    expect(card.textContent?.toLowerCase()).toContain(state);
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('pending offers a named Generate action', async () => {
    const onGenerate = vi.fn();
    render(<JobCard segment={3} state="pending" onGenerate={onGenerate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate segment 3' }));
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it.each(FAILURE_CAUSES)(
    'failed (%s) explains the cause; unknown never offers retry',
    async (cause) => {
      const onRetry = vi.fn();
      const { container } = render(
        <JobCard segment={2} state="failed" cause={cause} onRetry={onRetry} />,
      );
      expect(screen.getByRole('status')).toBeInTheDocument();
      const retry = screen.queryByRole('button', { name: 'Retry segment 2' });
      if (cause === 'unknown') {
        expect(retry).toBeNull();
        expect(screen.getByText(/check your provider account/i)).toBeInTheDocument();
      } else {
        await userEvent.click(retry!);
        expect(onRetry).toHaveBeenCalledOnce();
      }
      expect((await axe.run(container)).violations).toEqual([]);
    },
  );

  it('completed with a clip shows the player, QC states and Re-run check', async () => {
    const onRerun = vi.fn();
    const { container, rerender } = render(
      <JobCard segment={1} state="completed" src="/clip.mp4" qc="passed" onRerunCheck={onRerun} />,
    );
    expect(container.querySelector('video')).toHaveAttribute('aria-label', 'Clip for segment 1');
    expect(screen.getByText('Check passed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-run check segment 1' }));
    expect(onRerun).toHaveBeenCalledOnce();
    rerender(<JobCard segment={1} state="completed" qc="skipped" qcReason="No audio" />);
    expect(screen.getByText('Check skipped')).toBeInTheDocument();
    expect(screen.getByText('No audio')).toBeInTheDocument();
    expect(screen.getByText('Clip not available')).toBeInTheDocument();
    rerender(<JobCard segment={1} state="completed" qc="failed" />);
    expect(screen.getByText('Check failed')).toBeInTheDocument();
  });

  it('disables actions while busy or without a handler', () => {
    render(<JobCard segment={1} state="pending" busy onGenerate={() => {}} />);
    expect(screen.getByRole('button', { name: 'Generate segment 1' })).toBeDisabled();
  });
});
