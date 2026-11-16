// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { BADGE_VARIANTS, Badge } from './index';

afterEach(cleanup);

describe('CMP-007 Badge', () => {
  it.each(BADGE_VARIANTS)('%s variant renders its text as the label', async (variant) => {
    const { container } = render(<Badge variant={variant}>Ready</Badge>);
    expect(screen.getByText('Ready')).toHaveAttribute('data-variant', variant);
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('defaults to neutral and uses status tokens only', () => {
    render(<Badge>Draft</Badge>);
    expect(screen.getByText('Draft')).toHaveAttribute('data-variant', 'neutral');
    render(<Badge variant="success">Done</Badge>);
    expect(screen.getByText('Done').className).toContain('bg-success-subtle');
    expect(screen.getByText('Done').className).toContain('text-success');
  });

  it('renders a decorative icon next to the text', () => {
    const { container } = render(
      <Badge variant="warning" icon="triangle-alert" className="extra">
        Needs review
      </Badge>,
    );
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Needs review')).toHaveClass('extra');
  });
});
