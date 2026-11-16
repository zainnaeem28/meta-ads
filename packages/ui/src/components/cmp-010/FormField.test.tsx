// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorSummary, FormDemo, FormField, mapDetails, pathNumbers, SUMMARY_LIMIT } from './index';

afterEach(cleanup);

describe('CMP-010 FormField', () => {
  it('valid: label for, help linked by aria-describedby', async () => {
    const { container } = render(
      <FormField label="Name" mark="required" help="Shown in lists." id="n">
        {(c) => <input {...c} />}
      </FormField>,
    );
    const input = screen.getByLabelText(/Name/);
    expect(input).toHaveAttribute('aria-describedby', 'n-help');
    expect(screen.getByText('Shown in lists.')).toHaveAttribute('id', 'n-help');
    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-state', 'valid');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('invalid: error text with icon is linked after help', async () => {
    const { container } = render(
      <FormField label="Name" mark="optional" help="Help" error="Enter a name.">
        {(c) => <input {...c} aria-invalid={c.invalid} />}
      </FormField>,
    );
    const input = screen.getByLabelText(/Name/);
    const [helpId, errorId] = input.getAttribute('aria-describedby')!.split(' ');
    expect(document.getElementById(helpId!)).toHaveTextContent('Help');
    expect(document.getElementById(errorId!)).toHaveTextContent('Enter a name.');
    expect(document.getElementById(errorId!)!.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-state', 'invalid');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('disabled: control is disabled and has no description when none given', async () => {
    const { container } = render(
      <FormField label="Plan" disabled>
        {(c) => <input {...c} />}
      </FormField>,
    );
    const input = screen.getByLabelText('Plan');
    expect(input).toBeDisabled();
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(container.firstElementChild).toHaveAttribute('data-state', 'disabled');
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('generates an id when none is given', () => {
    render(<FormField label="A">{(c) => <input {...c} />}</FormField>);
    expect(screen.getByLabelText('A').id).toMatch(/^field-/);
  });
});

describe('CMP-010 details mapping (UI-UX 9.1)', () => {
  it('counts array indexes as index plus one and never shows the path', () => {
    expect(pathNumbers('segments.0.dialogue')).toEqual([1]);
    expect(pathNumbers('a.2.b.4')).toEqual([3, 5]);
    expect(pathNumbers('name')).toEqual([]);
  });

  it('maps known fields to controls, keeps unknown ones without a link, first error wins', () => {
    const { entries, fieldErrors } = mapDetails(
      [
        { field: 'name', code: 'c1', message: 'First' },
        { field: 'name', code: 'c2', message: 'Second' },
        { field: 'ghost', code: 'c3', message: 'No control' },
      ],
      (f) => (f === 'name' ? { id: 'n', label: 'Name' } : undefined),
    );
    expect(fieldErrors).toEqual({ n: 'First' });
    expect(entries.map((e) => [e.message, e.target?.id])).toEqual([
      ['First', 'n'],
      ['Second', 'n'],
      ['No control', undefined],
    ]);
  });
});

describe('CMP-010 ErrorSummary', () => {
  const entries = Array.from({ length: 7 }, (_, i) => ({
    key: String(i),
    message: `Problem ${i + 1}`,
    target: i < 6 ? { id: `f${i}`, label: `Field ${i + 1}` } : undefined,
  }));

  it('renders nothing without entries', () => {
    const { container } = render(<ErrorSummary entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the first five then "and n more", which expands', async () => {
    const { container } = render(<ErrorSummary entries={entries} />);
    expect(SUMMARY_LIMIT).toBe(5);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: 'and 2 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.queryByRole('button')).toBeNull();
    // entry without a control is listed without a link
    expect(screen.getByText('Problem 7').closest('li')!.querySelector('a')).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('keeps keyboard focus in the summary when "and n more" is activated', async () => {
    render(<ErrorSummary entries={entries} />);
    screen.getByRole('button', { name: 'and 2 more' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getAllByRole('listitem')[5]).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('takes focus on mount and again whenever focusKey changes', () => {
    const { rerender } = render(<ErrorSummary entries={entries} focusKey={1} />);
    const group = screen.getByRole('group');
    expect(group).toHaveFocus();
    group.blur();
    rerender(<ErrorSummary entries={entries} focusKey={2} />);
    expect(group).toHaveFocus();
  });

  it('a summary link moves focus to its control', async () => {
    render(
      <>
        <ErrorSummary
          entries={[{ key: 'a', message: 'Bad', target: { id: 'x', label: 'X field' } }]}
        />
        <input id="x" aria-label="x" />
      </>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'X field' }));
    expect(screen.getByLabelText('x')).toHaveFocus();
  });

  it('a link to a missing control does nothing', async () => {
    render(
      <ErrorSummary
        entries={[{ key: 'a', message: 'Bad', target: { id: 'gone', label: 'Gone' } }]}
      />,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Gone' }));
  });
});

describe('CMP-010 FormDemo through submit failure', () => {
  it('submit failure shows the summary focused, field errors linked, and first 5 plus more', async () => {
    const { container } = render(<FormDemo />);
    fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!);
    expect(await screen.findByRole('group')).toHaveFocus();
    expect(screen.getByLabelText(/Campaign name/)).toHaveAccessibleDescription(
      'Shown in your campaign list. Enter a campaign name.',
    );
    expect(screen.getByRole('button', { name: 'and 3 more' })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
