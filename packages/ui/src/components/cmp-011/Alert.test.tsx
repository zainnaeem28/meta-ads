// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ALERT_VARIANTS, Alert } from './index';

afterEach(cleanup);

describe('CMP-011 Alert', () => {
  it.each(ALERT_VARIANTS)('%s variant renders title, body and passes axe', async (variant) => {
    const { container } = render(
      <Alert variant={variant} title="Heads up" action={<a href="#x">Fix</a>}>
        Body text
      </Alert>,
    );
    const el = screen.getByRole(variant === 'destructive' ? 'alert' : 'status');
    expect(el).toHaveAttribute('data-variant', variant);
    expect(el).toHaveTextContent('Heads up');
    expect(el).toHaveTextContent('Body text');
    expect(screen.getByRole('link', { name: 'Fix' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('defaults to info/status and allows an explicit role', () => {
    render(<Alert>Plain</Alert>);
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'info');
    cleanup();
    render(
      <Alert variant="warning" role="alert" className="extra">
        Blocking
      </Alert>,
    );
    expect(screen.getByRole('alert')).toHaveClass('extra');
  });

  it('is inserted announced: role is present at insertion time', () => {
    const { rerender } = render(<div data-testid="host" />);
    rerender(
      <div data-testid="host">
        <Alert variant="destructive">Failed</Alert>
      </div>,
    );
    expect(screen.getByTestId('host').querySelector('[role=alert]')).not.toBeNull();
  });
});
