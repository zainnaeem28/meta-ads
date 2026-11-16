'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { SUMMARY_LIMIT, type SummaryEntry } from './details';

export interface FormFieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  invalid: boolean;
  disabled: boolean;
}

export interface FormFieldProps {
  label: string;
  /** `required` shows "(required)"; `optional` shows "(optional)"; neither shows no mark. */
  mark?: 'required' | 'optional';
  help?: string;
  /** Error text; its presence makes the field invalid. */
  error?: string;
  disabled?: boolean;
  /** Control id; generated when omitted. */
  id?: string;
  className?: string;
  /** Render the control with the id, description and state it needs. */
  children: (control: FormFieldControlProps) => ReactNode;
}

/** CMP-010: label, mark, control, help and error. Help and error are linked by `aria-describedby`. */
export function FormField({
  label,
  mark,
  help,
  error,
  disabled = false,
  id,
  className,
  children,
}: FormFieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div
      data-state={disabled ? 'disabled' : error ? 'invalid' : 'valid'}
      className={['flex min-w-0 flex-col gap-1', className].filter(Boolean).join(' ')}
    >
      <label
        htmlFor={controlId}
        className={`text-ui font-semibold ${disabled ? 'text-disabled-foreground' : 'text-foreground'}`}
      >
        {label}
        {mark ? (
          <span className="ml-1 text-caption font-normal text-muted-foreground">
            {mark === 'required' ? '(required)' : '(optional)'}
          </span>
        ) : null}
      </label>
      {children({
        id: controlId,
        'aria-describedby': describedBy,
        invalid: Boolean(error),
        disabled,
      })}
      {help ? (
        <p id={helpId} className="text-caption text-muted-foreground">
          {help}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="flex items-start gap-1 text-caption font-semibold text-destructive"
        >
          <Icon name="circle-alert" size={16} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Stacked on a phone, two columns from 768 px. */
export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={['grid grid-cols-1 gap-4 md:grid-cols-2', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}

export interface ErrorSummaryProps {
  entries: readonly SummaryEntry[];
  /** Change this value on each failed submit: focus moves to the summary every time it changes. */
  focusKey?: number | string;
  heading?: string;
}

function focusControl(id: string) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView?.({ block: 'center' });
    el.focus();
  }
}

/** CMP-010 error summary (UI-UX §9.1 b, d, f): one link per field, first 5 then "and {n} more". */
export function ErrorSummary({
  entries,
  focusKey,
  heading = 'Check the highlighted fields and try again.',
}: ErrorSummaryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const firstRevealed = useRef<HTMLLIElement>(null);
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const hasEntries = entries.length > 0;

  useEffect(() => {
    if (hasEntries) ref.current?.focus();
  }, [focusKey, hasEntries]);

  // The "and n more" button unmounts on activation: keep keyboard focus inside the summary.
  useEffect(() => {
    if (expanded) firstRevealed.current?.focus();
  }, [expanded]);

  if (!hasEntries) return null;
  const hidden = expanded ? 0 : Math.max(0, entries.length - SUMMARY_LIMIT);
  const shown = hidden ? entries.slice(0, SUMMARY_LIMIT) : entries;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby={headingId}
      data-error-summary=""
      className="rounded-md border border-destructive-border border-l-4 border-l-destructive bg-destructive-subtle p-4 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <h2 id={headingId} className="text-ui font-semibold text-destructive">
        {heading}
      </h2>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ui">
        {shown.map((entry, index) => (
          <li
            key={entry.key}
            ref={index === SUMMARY_LIMIT ? firstRevealed : undefined}
            tabIndex={index === SUMMARY_LIMIT ? -1 : undefined}
            className="break-words focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {entry.target ? (
              <a
                href={`#${entry.target.id}`}
                className="font-semibold underline"
                onClick={(event) => {
                  event.preventDefault();
                  focusControl(entry.target!.id);
                }}
              >
                {entry.target.label}
              </a>
            ) : null}
            {entry.target ? ': ' : ''}
            {entry.message}
          </li>
        ))}
      </ul>
      {hidden ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 min-h-control-sm text-ui font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          and {hidden} more
        </button>
      ) : null}
    </div>
  );
}
