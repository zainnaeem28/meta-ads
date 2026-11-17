// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../../../test/axe';
import { PreviewDemo } from './gallery-demos';
import { FinalPreview, PREVIEW_STATES, formatDuration } from './index';

afterEach(cleanup);

describe('CMP-026 Final preview', () => {
  it.each(PREVIEW_STATES)('%s state renders and passes axe', async (state) => {
    const { container } = render(
      <FinalPreview
        state={state}
        title="Summer sale"
        durationSeconds={24}
        captionsSrc="data:text/vtt,WEBVTT"
        qc={{ passed: 5, total: 5 }}
        requestDownloadUrl={async () => '#x'}
        onRetry={() => undefined}
        onReassemble={() => undefined}
      />,
    );
    expect(container.firstElementChild).toHaveAttribute('data-state', state);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('done: player has controls, a text alternative and the QC summary', () => {
    const { container } = render(
      <FinalPreview
        state="done"
        title="Summer sale"
        durationSeconds={84}
        qc={{ passed: 4, total: 5 }}
      />,
    );
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('aria-label', 'Summer sale, 1:24');
    expect(screen.getByText('Summer sale')).toBeInTheDocument();
    expect(screen.getByTestId('qc-summary')).toHaveTextContent('4 of 5 checks passed');
    expect(video.parentElement?.className).toContain('bg-surface-inverse');
    expect(screen.queryByRole('button', { name: 'Download video' })).toBeInTheDocument();
  });

  it('assembling shows status and progress and no player or download', () => {
    const { container } = render(
      <FinalPreview state="assembling" title="Summer sale" step="Joining segments" progress={40} />,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Joining segments');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('failed offers retry and uses the failure text', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<FinalPreview state="failed" title="T" failure="Audio missing." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Audio missing.');
    await user.click(screen.getByRole('button', { name: 'Try assembling again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('failed has a default message and no retry without a handler', () => {
    render(<FinalPreview state="failed" title="T" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('out of date warns, offers re-assembly and still plays', async () => {
    const user = userEvent.setup();
    const onReassemble = vi.fn();
    const { container } = render(
      <FinalPreview state="out-of-date" title="T" onReassemble={onReassemble} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('out of date');
    expect(container.querySelector('video')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Assemble a new video' }));
    expect(onReassemble).toHaveBeenCalled();
  });

  it('download asks for a fresh URL on every click', async () => {
    const user = userEvent.setup();
    const request = vi
      .fn()
      .mockResolvedValueOnce('https://x/1')
      .mockResolvedValueOnce('https://x/2');
    const received = vi.fn();
    render(
      <FinalPreview state="done" title="T" requestDownloadUrl={request} onDownloadUrl={received} />,
    );
    const button = screen.getByRole('button', { name: 'Download video' });
    await user.click(button);
    await waitFor(() => expect(received).toHaveBeenCalledWith('https://x/1'));
    await user.click(screen.getByRole('button', { name: 'Download video' }));
    await waitFor(() => expect(received).toHaveBeenCalledWith('https://x/2'));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a failed URL request shows an error and re-enables the button', async () => {
    const user = userEvent.setup();
    render(
      <FinalPreview
        state="done"
        title="T"
        requestDownloadUrl={() => Promise.reject(new Error('x'))}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Download video' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'download link could not be created',
    );
    expect(screen.getByRole('button', { name: 'Download video' })).toBeEnabled();
  });

  it('the default download starts a click on a temporary anchor', async () => {
    const user = userEvent.setup();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<FinalPreview state="done" title="T" requestDownloadUrl={async () => 'https://x/f'} />);
    await user.click(screen.getByRole('button', { name: 'Download video' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
  });

  it('download without a request handler does nothing', async () => {
    const user = userEvent.setup();
    render(<FinalPreview state="done" title="T" />);
    await user.click(screen.getByRole('button', { name: 'Download video' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('demo counts the fresh-link requests', async () => {
    const user = userEvent.setup();
    render(<PreviewDemo state="done" />);
    await user.click(screen.getByRole('button', { name: 'Download video' }));
    await waitFor(() => expect(screen.getByTestId('downloads-done')).toHaveTextContent(': 1'));
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(-3)).toBe('0:00');
    expect(formatDuration(125.4)).toBe('2:05');
  });
});
