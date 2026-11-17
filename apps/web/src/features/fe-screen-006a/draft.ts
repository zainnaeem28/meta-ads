import type { Draft, DraftWrite } from '@shroomap/contracts';
import { SCREEN_006_COPY as COPY } from './copy';

export type StepNumber = 1 | 2 | 3 | 4;
export type Gender = '' | 'all' | 'female' | 'male';
export type Goal = '' | 'awareness' | 'conversion' | 'retention';

/** What the person has typed, as strings; the draft's other fields (concept, script, image) are carried untouched. */
export interface FormValues {
  intakeMode: 'description' | 'script';
  productName: string;
  productDescription: string;
  ageMin: string;
  ageMax: string;
  gender: Gender;
  interests: string;
  goal: Goal;
  tone: string;
  segmentCount: '' | '1' | '2' | '3' | '4';
}

export const EMPTY_VALUES: FormValues = {
  intakeMode: 'description',
  productName: '',
  productDescription: '',
  ageMin: '',
  ageMax: '',
  gender: '',
  interests: '',
  goal: '',
  tone: '',
  segmentCount: '',
};

export const CONTROL_ID = {
  name: 'draft-product-name',
  description: 'draft-product-description',
  ageMin: 'draft-age-min',
  ageMax: 'draft-age-max',
  interests: 'draft-interests',
} as const;

export const clampStep = (step: number): StepNumber =>
  step >= 4 ? 4 : step <= 1 ? 1 : (step as StepNumber);

export function valuesFromDraft(draft: Draft): FormValues {
  return {
    intakeMode: draft.intakeMode,
    productName: draft.productName ?? '',
    productDescription: draft.productDescription ?? '',
    ageMin: draft.audience?.ageMin === undefined ? '' : String(draft.audience.ageMin),
    ageMax: draft.audience?.ageMax === undefined ? '' : String(draft.audience.ageMax),
    gender: draft.audience?.gender ?? '',
    interests: draft.audience?.interests?.join(', ') ?? '',
    goal: draft.direction?.goal ?? '',
    tone: draft.direction?.tone ?? '',
    segmentCount:
      draft.direction?.segmentCount === undefined
        ? ''
        : (String(draft.direction.segmentCount) as FormValues['segmentCount']),
  };
}

export const parseInterests = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

const toAge = (text: string): number | undefined =>
  /^\d+$/.test(text.trim()) ? Number(text) : undefined;

/** The fields of steps 1 to 3 as an API-021/023 body. Empty means null (clears); the image, concept and script are not sent. */
export function toWrite(values: FormValues, step: number): DraftWrite {
  const ageMin = toAge(values.ageMin);
  const ageMax = toAge(values.ageMax);
  const interests = parseInterests(values.interests);
  const audience = {
    ...(ageMin === undefined ? {} : { ageMin }),
    ...(ageMax === undefined ? {} : { ageMax }),
    ...(values.gender === '' ? {} : { gender: values.gender }),
    ...(interests.length > 0 ? { interests } : {}),
  };
  const direction = {
    ...(values.goal === '' ? {} : { goal: values.goal }),
    ...(values.tone === '' ? {} : { tone: values.tone }),
    ...(values.segmentCount === '' ? {} : { segmentCount: Number(values.segmentCount) }),
  };
  return {
    step,
    adStyle: 'ugc',
    intakeMode: values.intakeMode,
    productName: values.productName.trim() === '' ? null : values.productName,
    productDescription: values.productDescription.trim() === '' ? null : values.productDescription,
    audience: Object.keys(audience).length > 0 ? audience : null,
    direction: Object.keys(direction).length > 0 ? direction : null,
  };
}

export interface FieldProblem {
  id: string;
  label: string;
  message: string;
}

/** Client checks before leaving a step; the server stays authoritative. Order is page order. */
export function validateStep(step: StepNumber, values: FormValues): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (step === 2) {
    if (values.productName.trim() === '') {
      problems.push({
        id: CONTROL_ID.name,
        label: COPY.step2.name,
        message: COPY.step2.nameRequired,
      });
    } else if (values.productName.length > 120) {
      problems.push({ id: CONTROL_ID.name, label: COPY.step2.name, message: COPY.step2.nameLong });
    }
    if (values.productDescription.trim() === '') {
      problems.push({
        id: CONTROL_ID.description,
        label: COPY.step2.description,
        message: COPY.step2.descriptionRequired,
      });
    } else if (values.productDescription.length > 2000) {
      problems.push({
        id: CONTROL_ID.description,
        label: COPY.step2.description,
        message: COPY.step2.descriptionLong,
      });
    }
  }
  if (step === 3) {
    const min = toAge(values.ageMin);
    const max = toAge(values.ageMax);
    const bad = (text: string, n: number | undefined) =>
      text.trim() !== '' && (n === undefined || n < 21 || n > 99);
    const minBad = bad(values.ageMin, min);
    const maxBad = bad(values.ageMax, max);
    if (minBad)
      problems.push({
        id: CONTROL_ID.ageMin,
        label: COPY.step3.ageMin,
        message: COPY.step3.ageRange,
      });
    if (maxBad)
      problems.push({
        id: CONTROL_ID.ageMax,
        label: COPY.step3.ageMax,
        message: COPY.step3.ageRange,
      });
    if (!minBad && !maxBad && min !== undefined && max !== undefined && max < min) {
      problems.push({
        id: CONTROL_ID.ageMax,
        label: COPY.step3.ageMax,
        message: COPY.step3.ageOrder,
      });
    }
    const interests = parseInterests(values.interests);
    if (interests.length > 10) {
      problems.push({
        id: CONTROL_ID.interests,
        label: COPY.step3.interests,
        message: COPY.step3.interestsMany,
      });
    } else if (interests.some((item) => item.length > 40)) {
      problems.push({
        id: CONTROL_ID.interests,
        label: COPY.step3.interests,
        message: COPY.step3.interestsLong,
      });
    }
  }
  return problems;
}

/** Draft ETag is the quoted version (ADR-010). */
export const etagOf = (header: string | null, version: number): string =>
  header ?? `"${String(version)}"`;
