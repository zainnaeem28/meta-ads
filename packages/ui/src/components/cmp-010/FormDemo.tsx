'use client';

import { useState } from 'react';
import { Input } from '../cmp-004';
import { mapDetails, type ErrorDetail } from './details';
import { ErrorSummary, FormField, FormGrid } from './FormField';

const FIELDS: Record<string, { id: string; label: string }> = {
  name: { id: 'demo-name', label: 'Campaign name' },
  'segments.0.dialogue': { id: 'demo-seg-1', label: 'Segment 1 dialogue' },
  'segments.1.dialogue': { id: 'demo-seg-2', label: 'Segment 2 dialogue' },
};

const DETAILS: ErrorDetail[] = [
  { field: 'name', code: 'required', message: 'Enter a campaign name.' },
  {
    field: 'segments.0.dialogue',
    code: 'too_long',
    message: 'Keep the dialogue under 200 characters.',
  },
  { field: 'segments.1.dialogue', code: 'required', message: 'Enter the dialogue.' },
  { field: 'segments.2.dialogue', code: 'required', message: 'Segment 3 has no visible field.' },
  { field: 'a.0', code: 'x', message: 'Fourth problem.' },
  { field: 'a.1', code: 'x', message: 'Fifth problem.' },
  { field: 'a.2', code: 'x', message: 'Sixth problem.' },
  { field: 'a.3', code: 'x', message: 'Seventh problem.' },
];

/** Gallery and test host for CMP-010: a form whose submit fails with `details[]`. */
export function FormDemo() {
  const [submits, setSubmits] = useState(0);
  const [details, setDetails] = useState<ErrorDetail[]>([]);
  const { entries, fieldErrors } = mapDetails(details, (field) => FIELDS[field]);
  return (
    <form
      noValidate
      className="flex max-w-narrow flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setDetails(DETAILS);
        setSubmits((n) => n + 1);
      }}
    >
      <ErrorSummary entries={entries} focusKey={submits} />
      <FormGrid>
        <FormField
          label="Campaign name"
          mark="required"
          help="Shown in your campaign list."
          id="demo-name"
          error={fieldErrors['demo-name']}
        >
          {(c) => <Input {...c} />}
        </FormField>
        <FormField label="Segment 1 dialogue" id="demo-seg-1" error={fieldErrors['demo-seg-1']}>
          {(c) => <Input {...c} />}
        </FormField>
        <FormField
          label="Segment 2 dialogue"
          mark="optional"
          id="demo-seg-2"
          error={fieldErrors['demo-seg-2']}
        >
          {(c) => <Input {...c} />}
        </FormField>
        <FormField label="Notes" mark="optional" help="Valid state: no error.">
          {(c) => <Input {...c} defaultValue="Looks good" />}
        </FormField>
        <FormField label="Locked field" help="Set by your plan." disabled>
          {(c) => <Input {...c} defaultValue="Standard" />}
        </FormField>
      </FormGrid>
      <button
        type="submit"
        className="min-h-control self-start rounded-md bg-primary px-4 text-ui font-semibold text-primary-foreground"
      >
        Submit
      </button>
    </form>
  );
}
