// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './index';

afterEach(cleanup);

describe('CMP-033 PageHeader', () => {
  it('renders exactly one h1 with description and actions, no axe violations', async () => {
    const { container } = render(
      <main>
        <PageHeader
          title="Campaigns"
          description="Your ads."
          actions={<button>New brief</button>}
        />
      </main>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getByText('Your ads.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New brief' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('campaign variant has a breadcrumb with the current page marked and a tabs slot', async () => {
    const { container } = render(
      <main>
        <PageHeader
          title="Morning Focus"
          breadcrumb={[{ label: 'Campaigns', href: '/campaigns' }, { label: 'Morning Focus' }]}
          tabs={<div role="tablist" aria-label="Stages" />}
        />
      </main>,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(screen.getByRole('link', { name: 'Campaigns' })).toHaveAttribute('href', '/campaigns');
    expect(screen.getByRole('link', { name: 'Campaigns' })).toHaveClass('min-h-11', 'min-w-11');
    expect(nav.querySelector('[aria-current="page"]')).toHaveTextContent('Morning Focus');
    expect(screen.getByRole('tablist', { name: 'Stages' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('an empty breadcrumb renders no navigation', () => {
    render(<PageHeader title="T" breadcrumb={[]} />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
