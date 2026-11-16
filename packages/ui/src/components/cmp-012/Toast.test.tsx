// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_DURATION_MS, TOAST_VARIANTS, Toast, ToastDemo, ToastRegion } from './index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CMP-012 Toast', () => {
  it.each(TOAST_VARIANTS)('%s variant has a named close button and passes axe', async (variant) => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast
        id="t"
        variant={variant}
        message="Hello"
        action={<a href="#a">Undo</a>}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText('Hello')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Undo' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close notification' }));
    expect(onDismiss).toHaveBeenCalledWith('t');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('success and info auto-dismiss after the delay', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast id="a" variant="success" message="m" onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledWith('a');
  });

  it('errors and critical toasts never auto-dismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <>
        <Toast id="e" variant="error" message="e" onDismiss={onDismiss} />
        <Toast id="c" variant="info" critical message="c" onDismiss={onDismiss} />
      </>,
    );
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 5));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a re-render with a new onDismiss does not restart the timer', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Toast id="t" message="m" onDismiss={first} />);
    act(() => void vi.advanceTimersByTime(TOAST_DURATION_MS - 1000));
    rerender(<Toast id="t" message="m" onDismiss={second} />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('t');
  });

  it('pauses while hovered or focused and resumes afterwards', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast id="t" message="m" onDismiss={onDismiss} />);
    const close = screen.getByRole('button', { name: 'Close notification' });
    const toast = close.closest('[data-state]')!;
    fireEvent.mouseEnter(toast);
    act(() => void vi.advanceTimersByTime(TOAST_DURATION_MS * 2));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    fireEvent.focus(close);
    act(() => void vi.advanceTimersByTime(TOAST_DURATION_MS * 2));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(close);
    act(() => void vi.advanceTimersByTime(TOAST_DURATION_MS));
    expect(onDismiss).toHaveBeenCalledWith('t');
  });

  it('appearing state is hidden by opacity; dismissed renders nothing', () => {
    const { rerender, container } = render(
      <Toast id="x" message="m" state="appearing" onDismiss={() => undefined} />,
    );
    expect(container.firstElementChild).toHaveAttribute('data-state', 'appearing');
    expect(container.firstElementChild).toHaveClass('opacity-0');
    rerender(<Toast id="x" message="m" state="dismissed" onDismiss={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('region routes errors to an assertive live region and the rest to a polite one', () => {
    render(
      <ToastRegion
        onDismiss={() => undefined}
        toasts={[
          { id: '1', variant: 'success', message: 'ok' },
          { id: '2', variant: 'error', message: 'bad' },
        ]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('ok');
    expect(screen.getByRole('alert')).toHaveTextContent('bad');
  });

  it('demo adds and dismisses live toasts', async () => {
    const { container } = render(<ToastDemo />);
    await userEvent.click(screen.getByRole('button', { name: 'Show error toast' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show success toast' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Live error toast.');
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Live success toast.');
    await userEvent.click(screen.getAllByRole('button', { name: 'Close notification' }).at(-1)!);
    expect(screen.queryByText('Live error toast.')).not.toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
