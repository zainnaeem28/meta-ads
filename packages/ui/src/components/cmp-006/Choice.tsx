'use client';

import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { NOT_IN_RELEASE } from './constants';
import { useControllable } from './useControllable';

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(' ');

interface ChoiceBase {
  label: ReactNode;
  description?: ReactNode;
  /** A feature that is not shipped: the control is disabled and says "Not in this release". */
  unavailable?: boolean;
}

export interface CheckboxProps
  extends ChoiceBase, Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {}

/** CMP-006 checkbox: native `input`, 44 px hit region (the whole label row). */
export function Checkbox({
  label,
  description,
  unavailable,
  disabled,
  className,
  id,
  ...rest
}: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const off = disabled || unavailable;
  return (
    <label
      htmlFor={inputId}
      className={cx(
        'flex min-h-control-touch items-start gap-3 py-2 text-ui',
        off ? 'cursor-not-allowed text-disabled-foreground' : 'cursor-pointer',
        className,
      )}
    >
      <input
        {...rest}
        id={inputId}
        type="checkbox"
        disabled={off}
        className={
          'mt-0.5 size-5 flex-none accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed'
        }
      />
      <span className="flex flex-col">
        <span>{label}</span>
        {description ? <span className="text-muted-foreground">{description}</span> : null}
        {unavailable ? <span className="text-caption">{NOT_IN_RELEASE}</span> : null}
      </span>
    </label>
  );
}

export interface RadioCardProps
  extends ChoiceBase, Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {}

/** CMP-006 radio card: native radio (visually hidden) inside a bordered card; group by `name`. */
export function RadioCard({
  label,
  description,
  unavailable,
  disabled,
  className,
  ...rest
}: RadioCardProps) {
  const off = disabled || unavailable;
  return (
    <label
      className={cx('relative block', off ? 'cursor-not-allowed' : 'cursor-pointer', className)}
    >
      <input {...rest} type="radio" disabled={off} className="peer sr-only" />
      <span
        className={cx(
          'flex min-h-control-touch items-start gap-3 rounded-lg border border-input bg-card px-4 py-3',
          'hover:border-foreground',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
          'peer-checked:border-primary peer-checked:bg-primary-subtle peer-checked:ring-1 peer-checked:ring-primary',
          'peer-checked:[&_.dot]:border-primary peer-checked:[&_.dot-fill]:opacity-100 peer-disabled:border-border peer-disabled:bg-disabled peer-disabled:text-disabled-foreground peer-disabled:hover:border-border',
        )}
      >
        <span
          aria-hidden="true"
          className="dot mt-0.5 grid size-5 flex-none place-items-center rounded-full border-2 border-input bg-card"
        >
          <span className="dot-fill size-2.5 rounded-full bg-primary opacity-0" />
        </span>
        <span className="flex flex-col">
          <span className="text-ui font-semibold">{label}</span>
          {description ? <span className="text-ui">{description}</span> : null}
          {unavailable ? <span className="text-caption">{NOT_IN_RELEASE}</span> : null}
        </span>
      </span>
    </label>
  );
}

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  /** Accessible name of the radio group. */
  'aria-label': string;
  options: SegmentedOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  className?: string;
}

/** CMP-006 segmented control: a native radio group, so arrow keys move and select. */
export function SegmentedControl({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps) {
  const auto = useId();
  const [current, setCurrent] = useControllable(
    value,
    defaultValue ?? options[0]?.value ?? '',
    onValueChange,
  );
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx('inline-flex gap-0.5 rounded-md border border-input bg-card p-0.5', className)}
    >
      {options.map((option) => (
        <label key={option.value} className="relative">
          <input
            type="radio"
            name={name ?? auto}
            value={option.value}
            checked={current === option.value}
            disabled={option.disabled}
            onChange={() => setCurrent(option.value)}
            className="peer sr-only"
          />
          <span
            className={cx(
              'flex min-h-control-touch cursor-pointer items-center rounded-sm px-3 text-ui font-medium',
              'hover:bg-accent peer-checked:bg-primary peer-checked:text-primary-foreground',
              'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
              'peer-disabled:cursor-not-allowed peer-disabled:bg-disabled peer-disabled:text-disabled-foreground',
            )}
          >
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'role' | 'children'
> {
  label: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  unavailable?: boolean;
}

/** CMP-006 switch: `button role="switch"`; Space and Enter toggle it. */
export function Switch({
  label,
  checked,
  defaultChecked = false,
  onCheckedChange,
  unavailable,
  disabled,
  className,
  onClick,
  ...rest
}: SwitchProps) {
  const [on, setOn] = useControllable(checked, defaultChecked, onCheckedChange);
  const off = disabled || unavailable;
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={off}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOn(!on);
      }}
      className={cx(
        'group inline-flex min-h-control-touch items-center gap-3 text-ui',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:text-disabled-foreground',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'relative h-6 w-10 flex-none rounded-full',
          on ? 'bg-primary' : 'bg-input',
          'group-disabled:opacity-60',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 size-5 rounded-full bg-card shadow-sm',
            on ? 'left-5' : 'left-0.5',
          )}
        />
      </span>
      <span className="flex flex-col text-left">
        <span>{label}</span>
        {unavailable ? <span className="text-caption">{NOT_IN_RELEASE}</span> : null}
      </span>
    </button>
  );
}
