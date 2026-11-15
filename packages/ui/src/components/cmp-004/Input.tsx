'use client';

import {
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import { FIELD_CLASS } from './field-class';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
}

/** CMP-004 text input. Pair it with a visible label; `aria-describedby` points at help or error text. */
export function Input({ invalid, className, type = 'text', ...rest }: InputProps) {
  return (
    <input
      {...rest}
      type={type}
      aria-invalid={invalid ? true : undefined}
      className={[FIELD_CLASS, className].filter(Boolean).join(' ')}
    />
  );
}

/** CMP-004 masked key input: never revealed, never autofilled, no spellcheck. */
export function KeyInput({ invalid, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      type="password"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      data-1p-ignore=""
      aria-invalid={invalid ? true : undefined}
      className={[FIELD_CLASS, 'font-mono tracking-wider', className].filter(Boolean).join(' ')}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

function counterTone(length: number, max: number) {
  if (length >= max) return 'text-destructive font-semibold';
  if (length >= max * 0.9) return 'text-warning font-semibold';
  return 'text-muted-foreground';
}

/** CMP-004 textarea; with `maxLength` it shows a counter, announced through `aria-describedby`. */
export function Textarea({
  invalid,
  className,
  maxLength,
  id,
  value,
  defaultValue,
  onChange,
  'aria-describedby': describedBy,
  ...rest
}: TextareaProps) {
  const [inner, setInner] = useState(String(defaultValue ?? ''));
  const length = String(value ?? inner).length;
  const counterId = id && maxLength !== undefined ? `${id}-counter` : undefined;
  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setInner(event.target.value);
    onChange?.(event);
  };
  return (
    <div className="flex w-full flex-col gap-1">
      <textarea
        {...rest}
        id={id}
        maxLength={maxLength}
        {...(value !== undefined ? { value } : { defaultValue })}
        onChange={handleChange}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={[describedBy, counterId].filter(Boolean).join(' ') || undefined}
        className={[FIELD_CLASS, 'min-h-24 resize-y py-2', className].filter(Boolean).join(' ')}
      />
      {maxLength !== undefined ? (
        <span
          id={counterId}
          data-counter=""
          className={`text-right text-caption tabular-nums ${counterTone(length, maxLength)}`}
        >
          {length} / {maxLength}
        </span>
      ) : null}
    </div>
  );
}
