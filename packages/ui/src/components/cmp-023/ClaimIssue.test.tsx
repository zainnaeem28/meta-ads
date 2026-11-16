// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaimIssue } from './index';

afterEach(cleanup);

const base = { segment: 2, quote: 'Cures all.', instruction: 'Remove it.' };

describe('CMP-023 ClaimIssue', () => {
  it('high risk has no clear action and passes axe', async () => {
    const { container } = render(<ClaimIssue {...base} claimClass="high-risk" />);
    expect(screen.getByText('High risk')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Reason for clearing')).toBeNull();
    expect(screen.getByText(/cannot be cleared/)).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('other clears with a reason; the button is disabled until one exists', async () => {
    const onClear = vi.fn();
    const { container } = render(<ClaimIssue {...base} claimClass="other" onClear={onClear} />);
    const button = screen.getByRole('button', { name: 'Clear issue for segment 2' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason for clearing'), '   ');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason for clearing'), ' Supported by study ');
    expect(button).toBeEnabled();
    expect((await axe.run(container)).violations).toEqual([]);
    await userEvent.click(button);
    expect(onClear).toHaveBeenCalledWith('Supported by study');
  });

  it('submits with Enter and not while busy or empty', async () => {
    const onClear = vi.fn();
    const { rerender } = render(<ClaimIssue {...base} claimClass="other" onClear={onClear} />);
    await userEvent.type(screen.getByLabelText('Reason for clearing'), 'ok{Enter}');
    expect(onClear).toHaveBeenCalledWith('ok');
    onClear.mockClear();
    rerender(<ClaimIssue {...base} claimClass="other" onClear={onClear} busy />);
    expect(screen.getByRole('button', { name: /Clear issue/ })).toBeDisabled();
  });

  it('closed shows no actions', async () => {
    const { container } = render(<ClaimIssue {...base} claimClass="other" closed />);
    expect(screen.getByRole('article')).toHaveAttribute('data-state', 'closed');
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
