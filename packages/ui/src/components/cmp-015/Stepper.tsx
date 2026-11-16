import { Icon } from '../../icons';

export interface StepperProps {
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
  className?: string;
}

export type StepState = 'done' | 'current' | 'upcoming';

export function stepState(index: number, current: number): StepState {
  if (index < current) return 'done';
  return index === current ? 'current' : 'upcoming';
}

const STEP_CLASS: Record<StepState, string> = {
  done: 'border-primary text-foreground',
  current: 'border-primary font-semibold text-foreground max-md:flex-3',
  upcoming: 'border-border-strong text-muted-foreground',
};

const NUMBER_CLASS: Record<StepState, string> = {
  done: 'border-primary bg-primary-subtle text-primary-active',
  current: 'border-primary bg-primary text-primary-foreground',
  upcoming: 'border-input bg-card',
};

/** CMP-015 stepper: ordered list labelled "Progress"; a phone shows only the current step's label. */
export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <ol aria-label="Progress" className={['flex gap-2', className].filter(Boolean).join(' ')}>
      {steps.map((label, index) => {
        const state = stepState(index, current);
        return (
          <li
            key={label}
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className={`flex min-w-0 flex-1 items-center gap-2 border-t-4 py-2 text-ui ${STEP_CLASS[state]}`}
          >
            <span
              aria-hidden="true"
              className={`inline-grid size-6 flex-none place-items-center rounded-full border text-caption font-semibold ${NUMBER_CLASS[state]}`}
            >
              {state === 'done' ? <Icon name="check" size={16} /> : index + 1}
            </span>
            <span className={`min-w-0 truncate ${state === 'current' ? '' : 'max-md:sr-only'}`}>
              {label}
              {state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
