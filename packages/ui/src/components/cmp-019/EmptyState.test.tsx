// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_STATE_VARIANTS, EmptyState } from './index';

afterEach(cleanup);

describe('CMP-019 EmptyState', () => {
  it.each(EMPTY_STATE_VARIANTS)(
    '%s variant has a heading, sentence and no axe violations',
    async (variant) => {
      const { container } = render(
        <EmptyState variant={variant} title="Title" description="One sentence." />,
      );
      expect(screen.getByRole('heading', { level: 3, name: 'Title' })).toBeInTheDocument();
      expect(screen.getByText('One sentence.')).toBeInTheDocument();
      expect((await axe.run(container)).violations).toEqual([]);
    },
  );

  it('only the error variant is an alert, with Try again', async () => {
    const onRetry = vi.fn();
    render(<EmptyState variant="error" title="Failed" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('empty renders no alert and shows the action; heading level is configurable', () => {
    render(<EmptyState title="T" headingLevel={2} action={<button>Create</button>} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });
});
