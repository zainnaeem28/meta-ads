import type { Draft, DraftWrite } from '@shroomap/contracts';
import {
  CONTROL_ID as BASE_ID,
  EMPTY_VALUES as BASE_EMPTY,
  toWrite as baseWrite,
  validateStep as baseValidate,
  valuesFromDraft as baseValues,
  type FieldProblem,
  type FormValues as BaseValues,
  type StepNumber,
} from '../fe-screen-006a/draft';
import { SCREEN_006B_COPY as COPY } from './copy';

export { clampStep, etagOf, parseInterests, type StepNumber } from '../fe-screen-006a/draft';

/** Steps 1 to 3 plus what this part adds: the product image, and the concept or the script. */
export interface FormValues extends BaseValues {
  productMediaId: string;
  concept: string;
  script: string;
}

export const EMPTY_VALUES: FormValues = {
  ...BASE_EMPTY,
  productMediaId: '',
  concept: '',
  script: '',
};

export const CONTROL_ID = {
  ...BASE_ID,
  image: 'draft-product-image',
  concept: 'draft-concept',
  script: 'draft-script',
} as const;

export const valuesFromDraft = (draft: Draft): FormValues => ({
  ...baseValues(draft),
  productMediaId: draft.productMediaId ?? '',
  concept: draft.concept ?? '',
  script: draft.script ?? '',
});

const nullable = (text: string): string | null => (text.trim() === '' ? null : text);

/** The API-021/023 body: steps 1 to 3 as before, plus the image and the concept or script. */
export const toWrite = (values: FormValues, step: number): DraftWrite => ({
  ...baseWrite(values, step),
  productMediaId: values.productMediaId === '' ? null : values.productMediaId,
  concept: nullable(values.concept),
  script: nullable(values.script),
});

/** Client checks before leaving a step; `imageBusy` is true while the image uploads or is processed. */
export function validateStep(
  step: StepNumber,
  values: FormValues,
  imageBusy = false,
): FieldProblem[] {
  const problems = baseValidate(step, values);
  if (step === 2 && imageBusy)
    problems.push({ id: CONTROL_ID.image, label: COPY.step2.image, message: COPY.step2.imageBusy });
  if (step === 4) {
    const script = values.intakeMode === 'script';
    const text = script ? values.script : values.concept;
    const id = script ? CONTROL_ID.script : CONTROL_ID.concept;
    const label = script ? COPY.step4.script : COPY.step4.concept;
    if (text.trim() === '')
      problems.push({
        id,
        label,
        message: script ? COPY.step4.scriptRequired : COPY.step4.conceptRequired,
      });
    else if (text.length > 4000) problems.push({ id, label, message: COPY.step4.long });
  }
  return problems;
}
