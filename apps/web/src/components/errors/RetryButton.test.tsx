// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryButton } from './RetryButton';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tick = (seconds: number) => act(() => void vi.advanceTimersByTime(seconds * 1000));

describe('RetryButton countdown', () => {
  it('counts down live, announces only at the start and at availability, then enables', () => {
    const onRetry = vi.fn();
    render(<RetryButton waitSeconds={4} onRetry={onRetry} />);
    const button = screen.getByRole('button');
    const region = screen.getByTestId('retry-announcement');
    const spoken: string[] = [region.textContent ?? ''];
    const labels: string[] = [button.textContent ?? ''];
    for (let i = 0; i < 5; i += 1) {
      tick(1);
      spoken.push(region.textContent ?? '');
      labels.push(button.textContent ?? '');
    }
    expect(labels).toEqual([
      'Try again in 4s',
      'Try again in 3s',
      'Try again in 2s',
      'Try again in 1s',
      'Try again',
      'Try again',
    ]);
    // Two distinct announcements in the whole wait: the start and the availability.
    expect([...new Set(spoken)]).toEqual([
      'You can try again in 4 seconds.',
      'You can try again now.',
    ]);
    expect(spoken.filter((t, i) => i > 0 && t !== spoken[i - 1])).toHaveLength(1);
    expect(button).toBeEnabled();
  });

  it('is disabled until the wait ends and does not retry while disabled', () => {
    const onRetry = vi.fn();
    render(<RetryButton waitSeconds={2} onRetry={onRetry} />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    button.click();
    expect(onRetry).not.toHaveBeenCalled();
    tick(2);
    expect(button).toBeEnabled();
    act(() => button.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('counts in minutes above 120 seconds and enables at zero', () => {
    render(<RetryButton waitSeconds={300} onRetry={() => undefined} />);
    expect(screen.getByRole('button')).toHaveTextContent('Try again in 5 min');
    expect(screen.getByTestId('retry-announcement')).toHaveTextContent(
      'You can try again in 5 minutes.',
    );
    tick(180);
    expect(screen.getByRole('button')).toHaveTextContent('Try again in 120s');
    tick(119);
    expect(screen.getByRole('button')).toBeDisabled();
    tick(1);
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('is enabled at once with no wait and announces nothing', () => {
    render(<RetryButton waitSeconds={0} onRetry={() => undefined} />);
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.getByTestId('retry-announcement')).toBeEmptyDOMElement();
  });

  it('starts a new wait when restartKey changes (a new failure)', () => {
    const { rerender } = render(
      <RetryButton waitSeconds={2} restartKey="a" onRetry={() => undefined} />,
    );
    tick(2);
    expect(screen.getByRole('button')).toBeEnabled();
    rerender(<RetryButton waitSeconds={2} restartKey="b" onRetry={() => undefined} />);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('button')).toHaveTextContent('Try again in 2s');
  });
});
