import type { SelectHTMLAttributes } from 'react';
import { Icon } from '../../icons';
import { FIELD_CLASS } from '../cmp-004/field-class';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean;
}

/** CMP-005 native select, styled like CMP-004; the platform provides keyboard and the picker. */
export function Select({ invalid, className, children, ...rest }: SelectProps) {
  return (
    <span className="relative block w-full">
      <select
        {...rest}
        aria-invalid={invalid ? true : undefined}
        className={[FIELD_CLASS, 'appearance-none pr-10', className].filter(Boolean).join(' ')}
      >
        {children}
      </select>
      <Icon
        name="chevron-down"
        size={16}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
