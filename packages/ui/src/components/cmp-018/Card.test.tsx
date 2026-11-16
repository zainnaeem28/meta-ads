// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CARD_VARIANTS, Card } from './index';

afterEach(cleanup);

describe('CMP-018 Card', () => {
  it.each(CARD_VARIANTS)('%s content has heading, body, footer and no axe violations', async (variant) => {
    const { container } = render(
      <Card variant={variant} title="Billing" footer="Updated today">
        Body text
      </Card>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    expect(screen.getByText('Updated today')).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('heading level is configurable', () => {
    render(<Card title="T" headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('loading is busy and announced, without content', async () => {
    const { container } = render(
      <Card title="T" state="loading">
        Body
      </Card>,
    );
    expect(container.querySelector('[aria-busy=true]')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByText('Body')).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('empty uses the empty state one level below; unavailable says so', async () => {
    const { container, rerender } = render(<Card title="T" state="empty" emptyTitle="No activity" />);
    expect(screen.getByRole('heading', { level: 4, name: 'No activity' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
    rerender(<Card title="T" state="unavailable" />);
    expect(screen.getByRole('status')).toHaveTextContent('not available');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('a clickable card is exactly one link on the heading', async () => {
    const { container } = render(
      <Card title="Open me" href="/x">
        Body
      </Card>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Open me' })).toContainElement(screen.getByRole('link'));
    expect(container.querySelectorAll('button, a')).toHaveLength(1);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
