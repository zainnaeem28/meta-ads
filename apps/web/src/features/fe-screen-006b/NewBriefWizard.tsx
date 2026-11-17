'use client';

import {
  createDraft,
  deleteDraft,
  getDraft,
  patchDraft,
  submitDraft,
  type Draft,
  type DraftPatch,
  type DraftResponse,
  type SubmitDraftResponse,
} from '@shroomap/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@shroomap/ui/cmp-003';
import { Input, Textarea } from '@shroomap/ui/cmp-004';
import { Select } from '@shroomap/ui/cmp-005';
import { RadioCard, SegmentedControl } from '@shroomap/ui/cmp-006';
import { ErrorSummary, FormField, FormGrid, type SummaryEntry } from '@shroomap/ui/cmp-010';
import { Alert } from '@shroomap/ui/cmp-011';
import { Dialog } from '@shroomap/ui/cmp-013';
import { Stepper } from '@shroomap/ui/cmp-015';
import { Card } from '@shroomap/ui/cmp-018';
import { OperatorShell } from '@shroomap/ui/cmp-030';
import { Icon } from '@shroomap/ui/icons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorNotice } from '../../components/errors';
import { resolveError } from '../../lib/errors';
import { mapErrorDetails, type ControlMap } from '../../lib/errors/details';
import { IdempotencyKeys, idempotencyHeaders } from '../../lib/api/idempotency';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import { SEGMENT_SECONDS } from '../fe-screen-006a/copy';
import { SessionEndedDialog } from '../fe-screen-006a/SessionEndedDialog';
import { SCREEN_006B_COPY as COPY } from './copy';
import {
  CONTROL_ID,
  EMPTY_VALUES,
  clampStep,
  etagOf,
  parseInterests,
  toWrite,
  validateStep,
  valuesFromDraft,
  type FormValues,
  type StepNumber,
} from './draft';
import { ProductImage } from './ProductImage';

export const NEW_BRIEF_PATH = '/campaigns/new';
const AUTOSAVE_MS = 800;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SubmitBlock = 'key_missing' | 'spend_cap_reached';

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'conflict' }
  | { kind: 'submitted' }
  | { kind: 'gone' };

const CONTROLS: ControlMap = {
  productName: { id: CONTROL_ID.name, label: COPY.step2.name },
  productDescription: { id: CONTROL_ID.description, label: COPY.step2.description },
  'audience.ageMin': { id: CONTROL_ID.ageMin, label: COPY.step3.ageMin },
  'audience.ageMax': { id: CONTROL_ID.ageMax, label: COPY.step3.ageMax },
  'audience.interests': { id: CONTROL_ID.interests, label: COPY.step3.interests },
  'audience.interests.*': { id: CONTROL_ID.interests, label: COPY.step3.interests },
  concept: { id: CONTROL_ID.concept, label: COPY.step4.concept },
  script: { id: CONTROL_ID.script, label: COPY.step4.script },
};

const draftIn = (res: { data: unknown }): Draft => (res.data as DraftResponse).data;

const segmentsText = (count: FormValues['segmentCount']): string =>
  count === ''
    ? `Each segment is ${String(SEGMENT_SECONDS)} s.`
    : `${count} ${count === '1' ? 'segment' : 'segments'} × ${String(SEGMENT_SECONDS)} s = ${String(Number(count) * SEGMENT_SECONDS)} s total`;

function Heading({
  id,
  children,
  step,
  headingRef,
}: {
  id: string;
  children: string;
  step: number;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="flex flex-col gap-1">
      <h2
        id={id}
        ref={headingRef}
        tabIndex={-1}
        className="text-section font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {children}
      </h2>
      <p className="text-ui text-muted-foreground">{COPY.stepOf(step)}</p>
    </header>
  );
}

function SubmitBlockAlert({ block }: { block: SubmitBlock }) {
  if (block === 'key_missing') {
    return (
      <Alert
        variant="warning"
        role="alert"
        title={COPY.keyMissing.title}
        action={
          <Button size="sm" asChild>
            <a href={ROUTES.providerKeys}>{COPY.keyMissing.action}</a>
          </Button>
        }
      >
        {COPY.keyMissing.body}
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" role="alert" title={COPY.capReached.title}>
      {COPY.capReached.body}
    </Alert>
  );
}

export interface NewBriefWizardProps {
  /** `?draft=<id>`: resume this draft; absent starts a new one. */
  draftId?: string;
  /** Test builds only: preview the step-4 submit blocks; the real ones come from the API-024 answer. */
  initialBlock?: SubmitBlock;
}

/**
 * SCREEN-006 at `/campaigns/new`: autosaves the draft through API-021 and API-023 with the version in If-Match,
 * resumes it with API-022, "Start over" deletes it with API-025, uploads and analyses the product image (API-030,
 * 031, 035, 036) and "Generate brief" submits the draft (API-024).
 */
export function NewBriefWizard({ draftId: initialId, initialBlock }: NewBriefWizardProps) {
  const resumeId = initialId && UUID.test(initialId) ? initialId : undefined;
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [step, setStep] = useState<StepNumber>(1);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [hasDraft, setHasDraft] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [entries, setEntries] = useState<SummaryEntry[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [focusKey, setFocusKey] = useState(0);
  const [failures, setFailures] = useState(0);
  const [startOver, setStartOver] = useState<{ open: boolean; pending: boolean; error: unknown }>({
    open: false,
    pending: false,
    error: null,
  });
  const [rev, setRev] = useState(0);
  const [imageBusy, setImageBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [block, setBlock] = useState<SubmitBlock | undefined>(initialBlock);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const idRef = useRef<string | undefined>(resumeId);
  const keys = useRef(new IdempotencyKeys());
  const etagRef = useRef<string | undefined>(undefined);
  const valuesRef = useRef(values);
  const stepRef = useRef(step);
  const imageBusyRef = useRef(false);
  const revRef = useRef(0);
  const savedRev = useRef(0);
  const inflight = useRef<Promise<unknown> | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  valuesRef.current = values;
  stepRef.current = step;
  imageBusyRef.current = imageBusy;

  const loaded = useQuery({
    queryKey: ['draft', resumeId],
    enabled: resumeId !== undefined,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const res = await getDraft(resumeId!, { signal });
      return { draft: draftIn(res), etag: res.headers.get('ETag') };
    },
  });
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (applied || !loaded.data) return;
    const { draft, etag } = loaded.data;
    setApplied(true);
    if (draft.campaignId) {
      setStatus({ kind: 'submitted' });
      return;
    }
    etagRef.current = etagOf(etag, draft.version);
    setValues(valuesFromDraft(draft));
    setStep(clampStep(draft.step));
    setHasDraft(true);
  }, [loaded.data, applied]);

  const fail = useCallback((error: unknown) => {
    const view = resolveError(error, { surface: 'context' });
    if (view.code === 'unauthenticated') return setSessionEnded(true);
    if (view.code === 'version_conflict') return setStatus({ kind: 'conflict' });
    if (view.code === 'state_conflict') return setStatus({ kind: 'submitted' });
    if (view.code === 'not_found') return setStatus({ kind: 'gone' });
    if (view.code === 'validation_failed') {
      const mapped = mapErrorDetails(view.details, CONTROLS);
      setEntries(mapped.entries);
      setFieldErrors(mapped.fieldErrors);
      setFocusKey((k) => k + 1);
    }
    setFailures((n) => n + 1);
    setStatus({ kind: 'failed', error });
  }, []);

  /** Writes the form to the draft (creating it on the first save). Calls run one after another. */
  const save = useCallback(
    async (targetStep: StepNumber): Promise<boolean> => {
      while (inflight.current) await inflight.current.catch(() => undefined);
      const startedAt = revRef.current;
      const body = toWrite(valuesRef.current, targetStep);
      setStatus({ kind: 'saving' });
      const run = (async () => {
        const res = idRef.current
          ? await patchDraft(
              idRef.current,
              body as DraftPatch,
              etagRef.current ? { headers: { 'If-Match': etagRef.current } } : {},
            )
          : await createDraft(body);
        const draft = draftIn(res);
        if (!idRef.current) {
          idRef.current = draft.id;
          window.history.replaceState(null, '', `${NEW_BRIEF_PATH}?draft=${draft.id}`);
        }
        etagRef.current = etagOf(res.headers.get('ETag'), draft.version);
        savedRev.current = startedAt;
        setHasDraft(true);
        setStatus({ kind: 'saved' });
        setFailures(0);
      })();
      inflight.current = run;
      try {
        await run;
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        inflight.current = null;
      }
    },
    [fail],
  );

  const blocked =
    status.kind === 'conflict' ||
    status.kind === 'submitted' ||
    status.kind === 'gone' ||
    sessionEnded;
  useEffect(() => {
    if (rev === 0 || rev === savedRev.current || blocked || advancing) return;
    if (validateStep(stepRef.current, valuesRef.current, imageBusyRef.current).length > 0) return;
    const timer = setTimeout(() => void save(stepRef.current), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [rev, blocked, advancing, imageBusy, save]);

  /** Edits still inside the debounce window are written when the user leaves (route change, tab hidden or closed). */
  const flushRef = useRef<() => void>(() => undefined);
  flushRef.current = () => {
    if (revRef.current === savedRev.current || blocked || advancing) return;
    if (validateStep(stepRef.current, valuesRef.current, imageBusyRef.current).length > 0) return;
    void save(stepRef.current);
  };
  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      onHide();
    };
  }, []);

  useEffect(() => {
    if (focusHeading.current) {
      focusHeading.current = false;
      headingRef.current?.focus();
    }
  }, [step]);

  const touch = () => {
    revRef.current += 1;
    setRev(revRef.current);
  };
  const edit = (patch: Partial<FormValues>, controlId?: string) => {
    setValues((v) => ({ ...v, ...patch }));
    if (controlId && fieldErrors[controlId]) {
      setFieldErrors((all) =>
        Object.fromEntries(Object.entries(all).filter(([id]) => id !== controlId)),
      );
      setEntries((list) => list.filter((e) => e.target?.id !== controlId));
    }
    if (status.kind === 'failed' || status.kind === 'saved') setStatus({ kind: 'idle' });
    touch();
  };

  const clearProblems = () => {
    setEntries([]);
    setFieldErrors({});
  };
  const move = (to: StepNumber) => {
    clearProblems();
    focusHeading.current = true;
    setStep(to);
  };
  const back = () => {
    move(clampStep(step - 1));
    touch();
  };
  const next = async () => {
    const problems = validateStep(step, values, imageBusy);
    if (problems.length > 0) {
      setEntries(
        problems.map((p, i) => ({
          key: `${String(i)}:${p.id}`,
          message: p.message,
          target: { id: p.id, label: p.label },
        })),
      );
      setFieldErrors(Object.fromEntries(problems.map((p) => [p.id, p.message])));
      setFocusKey((k) => k + 1);
      return;
    }
    clearProblems();
    setAdvancing(true);
    const to = clampStep(step + 1);
    const ok = await save(to);
    setAdvancing(false);
    if (ok) move(to);
  };

  const generate = async () => {
    const problems = validateStep(4, values);
    if (problems.length > 0) {
      setEntries(
        problems.map((p, i) => ({
          key: `${String(i)}:${p.id}`,
          message: p.message,
          target: { id: p.id, label: p.label },
        })),
      );
      setFieldErrors(Object.fromEntries(problems.map((p) => [p.id, p.message])));
      setFocusKey((k) => k + 1);
      return;
    }
    clearProblems();
    setSubmitError(null);
    setGenerating(true);
    if (!(await save(4)) || !idRef.current) return setGenerating(false);
    try {
      const res = await submitDraft(
        idRef.current,
        idempotencyHeaders(keys.current.keyFor({ draftId: idRef.current })),
      );
      keys.current.succeeded();
      const { campaignId } = (res.data as SubmitDraftResponse).data;
      // Stays in the pending state while the brief screen loads.
      window.location.assign(`/campaigns/${campaignId}/brief`);
    } catch (error) {
      setGenerating(false);
      const code = resolveError(error, { surface: 'context' }).code;
      if (code === 'key_missing' || code === 'spend_cap_reached') return setBlock(code);
      if (
        code === 'unauthenticated' ||
        code === 'state_conflict' ||
        code === 'not_found' ||
        code === 'version_conflict'
      )
        return fail(error);
      setSubmitError(error);
    }
  };

  const reload = async () => {
    const id = idRef.current;
    if (!id) return;
    setStatus({ kind: 'saving' });
    try {
      const res = await getDraft(id);
      const draft = draftIn(res);
      etagRef.current = etagOf(res.headers.get('ETag'), draft.version);
      clearProblems();
      setValues(valuesFromDraft(draft));
      savedRev.current = revRef.current;
      setStatus({ kind: 'saved' });
    } catch (error) {
      fail(error);
    }
  };

  const confirmStartOver = async () => {
    setStartOver((s) => ({ ...s, pending: true, error: null }));
    try {
      if (idRef.current) {
        try {
          await deleteDraft(idRef.current);
        } catch (error) {
          if (resolveError(error).code !== 'not_found') throw error;
        }
      }
    } catch (error) {
      if (resolveError(error).code === 'unauthenticated') {
        setStartOver({ open: false, pending: false, error: null });
        return setSessionEnded(true);
      }
      return setStartOver({ open: true, pending: false, error });
    }
    idRef.current = undefined;
    etagRef.current = undefined;
    window.history.replaceState(null, '', NEW_BRIEF_PATH);
    clearProblems();
    revRef.current += 1;
    savedRev.current = revRef.current;
    setRev(revRef.current);
    setValues(EMPTY_VALUES);
    setHasDraft(false);
    setBlock(initialBlock);
    setSubmitError(null);
    setStatus({ kind: 'idle' });
    setStartOver({ open: false, pending: false, error: null });
    focusHeading.current = true;
    setStep(1);
  };

  const returnTo = `${NEW_BRIEF_PATH}${idRef.current ? `?draft=${idRef.current}` : ''}`;
  const loading = resumeId !== undefined && !applied && loaded.isPending;
  const err = (id: string) => fieldErrors[id];
  const saving = status.kind === 'saving';

  const savedLabel = saving ? (
    <span className="flex items-center gap-2" role="status">
      <Icon name="loader-circle" size={16} className="animate-spin motion-reduce:animate-none" />
      {COPY.saving}
    </span>
  ) : status.kind === 'saved' ? (
    <span className="flex items-center gap-2" role="status">
      <Icon name="circle-check" size={16} />
      {COPY.savedNow}
    </span>
  ) : hasDraft && status.kind === 'idle' ? (
    <span className="flex items-center gap-2" role="status">
      <Icon name="circle-check" size={16} />
      {COPY.saved}
    </span>
  ) : null;

  const footer = (primary: ReactNode, onBack?: () => void) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {onBack ? (
        <Button variant="outline" onClick={onBack} disabled={advancing || generating}>
          <Icon name="arrow-left" size={16} />
          {COPY.back}
        </Button>
      ) : (
        <Button
          variant="ghost"
          onClick={() => setStartOver({ open: true, pending: false, error: null })}
          disabled={advancing || generating}
        >
          {COPY.startOver}
        </Button>
      )}
      {primary}
    </div>
  );
  const nextButton = (
    <Button
      onClick={() => void next()}
      pending={advancing}
      pendingLabel={COPY.savingButton}
      disabled={blocked}
    >
      {COPY.next[step - 1]}
      <Icon name="arrow-right" size={16} />
    </Button>
  );

  let body: ReactNode;
  if (loading) {
    body = <Card variant="section" state="loading" title={COPY.loading} headingLevel={2} />;
  } else if (loaded.isError && !applied) {
    const code = resolveError(loaded.error, { surface: 'page' }).code;
    if (code === 'unauthenticated') {
      body = null;
    } else if (code === 'not_found') {
      body = (
        <Alert
          variant="warning"
          role="alert"
          title={COPY.notFoundTitle}
          action={
            <Button size="sm" asChild>
              <a href={NEW_BRIEF_PATH}>{COPY.notFoundAction}</a>
            </Button>
          }
        >
          {COPY.notFoundBody}
        </Alert>
      );
    } else {
      body = (
        <ErrorNotice
          error={loaded.error}
          returnTo={returnTo}
          retrying={loaded.isRefetching}
          onAction={() => void loaded.refetch()}
        />
      );
    }
  } else if (status.kind === 'submitted') {
    body = (
      <Alert
        variant="info"
        role="status"
        title={COPY.submittedTitle}
        action={
          <Button size="sm" asChild>
            <a href={ROUTES.campaigns}>{COPY.submittedAction}</a>
          </Button>
        }
      >
        {COPY.submittedBody}
      </Alert>
    );
  } else if (status.kind === 'gone') {
    body = (
      <Alert
        variant="warning"
        role="alert"
        title={COPY.notFoundTitle}
        action={
          <Button size="sm" asChild>
            <a href={NEW_BRIEF_PATH}>{COPY.notFoundAction}</a>
          </Button>
        }
      >
        {COPY.notFoundBody}
      </Alert>
    );
  } else {
    const tones = COPY.step3.tones as readonly string[];
    const toneOptions =
      values.tone && !tones.includes(values.tone) ? [...tones, values.tone] : tones;
    body = (
      <div className="flex flex-col gap-4">
        {status.kind === 'conflict' ? (
          <Alert
            variant="warning"
            role="alert"
            title={COPY.conflictTitle}
            action={
              <Button variant="outline" size="sm" onClick={() => void reload()}>
                <Icon name="refresh-cw" size={16} />
                {COPY.conflictAction}
              </Button>
            }
          >
            {COPY.conflictBody}
          </Alert>
        ) : null}
        {status.kind === 'failed' && entries.length === 0 ? (
          <div>
            <ErrorNotice
              error={status.error}
              surface="context"
              call="write"
              failures={failures}
              returnTo={returnTo}
              retrying={saving}
              onAction={() => void save(stepRef.current)}
            />
          </div>
        ) : null}
        <Card
          variant="section"
          headingLevel={2}
          footer={
            step === 4
              ? footer(
                  <Button
                    onClick={() => void generate()}
                    pending={generating}
                    pendingLabel={COPY.step4.generating}
                    disabled={blocked || block !== undefined}
                  >
                    <Icon name="arrow-right" size={16} />
                    {COPY.step4.generate}
                  </Button>,
                  back,
                )
              : footer(nextButton, step === 1 ? undefined : back)
          }
        >
          {entries.length > 0 ? (
            <ErrorSummary
              entries={entries}
              focusKey={focusKey}
              heading={COPY.summaryHeading(entries.length)}
            />
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-6">
              <Heading id="step-title" step={1} headingRef={headingRef}>
                {COPY.step1.title}
              </Heading>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-ui font-semibold">{COPY.step1.style}</legend>
                <RadioCard
                  name="ad-style"
                  value="ugc"
                  checked
                  readOnly
                  label={COPY.step1.ugc}
                  description={COPY.step1.ugcHelp}
                />
                <RadioCard
                  name="ad-style"
                  value="animated"
                  unavailable
                  label={COPY.step1.animated}
                  description={COPY.step1.animatedHelp}
                />
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-ui font-semibold">{COPY.step1.intake}</legend>
                <RadioCard
                  name="intake-mode"
                  value="description"
                  checked={values.intakeMode === 'description'}
                  onChange={() => edit({ intakeMode: 'description' })}
                  label={COPY.step1.describe}
                  description={COPY.step1.describeHelp}
                />
                <RadioCard
                  name="intake-mode"
                  value="script"
                  checked={values.intakeMode === 'script'}
                  onChange={() => edit({ intakeMode: 'script' })}
                  label={COPY.step1.script}
                  description={COPY.step1.scriptHelp}
                />
              </fieldset>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-6">
              <Heading id="step-title" step={2} headingRef={headingRef}>
                {COPY.step2.title}
              </Heading>
              <FormField
                id={CONTROL_ID.name}
                label={COPY.step2.name}
                mark="required"
                help={COPY.step2.nameHelp}
                error={err(CONTROL_ID.name)}
              >
                {(c) => (
                  <Input
                    {...c}
                    value={values.productName}
                    onChange={(e) => edit({ productName: e.target.value }, CONTROL_ID.name)}
                    autoComplete="off"
                  />
                )}
              </FormField>
              <FormField
                id={CONTROL_ID.description}
                label={COPY.step2.description}
                mark="required"
                error={err(CONTROL_ID.description)}
              >
                {(c) => (
                  <Textarea
                    {...c}
                    maxLength={2000}
                    value={values.productDescription}
                    onChange={(e) =>
                      edit({ productDescription: e.target.value }, CONTROL_ID.description)
                    }
                  />
                )}
              </FormField>
              <div
                id={CONTROL_ID.image}
                tabIndex={-1}
                className="flex flex-col gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <h3 className="text-ui font-semibold">{COPY.step2.image}</h3>
                <ProductImage
                  mediaId={values.productMediaId}
                  onMediaChange={(id) => edit({ productMediaId: id })}
                  onBusyChange={setImageBusy}
                  onUseDescription={(text) =>
                    edit({ productDescription: text.slice(0, 2000) }, CONTROL_ID.description)
                  }
                  onUnauthenticated={() => setSessionEnded(true)}
                  disabled={blocked}
                />
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-6">
              <Heading id="step-title" step={3} headingRef={headingRef}>
                {COPY.step3.title}
              </Heading>
              <FormGrid>
                <FormField
                  id={CONTROL_ID.ageMin}
                  label={COPY.step3.ageMin}
                  error={err(CONTROL_ID.ageMin)}
                >
                  {(c) => (
                    <Input
                      {...c}
                      type="number"
                      inputMode="numeric"
                      min={21}
                      max={99}
                      className="tabular-nums"
                      value={values.ageMin}
                      onChange={(e) => edit({ ageMin: e.target.value }, CONTROL_ID.ageMin)}
                    />
                  )}
                </FormField>
                <FormField
                  id={CONTROL_ID.ageMax}
                  label={COPY.step3.ageMax}
                  error={err(CONTROL_ID.ageMax)}
                >
                  {(c) => (
                    <Input
                      {...c}
                      type="number"
                      inputMode="numeric"
                      min={21}
                      max={99}
                      className="tabular-nums"
                      value={values.ageMax}
                      onChange={(e) => edit({ ageMax: e.target.value }, CONTROL_ID.ageMax)}
                    />
                  )}
                </FormField>
                <FormField label={COPY.step3.gender}>
                  {(c) => (
                    <Select
                      {...c}
                      value={values.gender || 'all'}
                      onChange={(e) => edit({ gender: e.target.value as FormValues['gender'] })}
                    >
                      {(Object.keys(COPY.step3.genders) as (keyof typeof COPY.step3.genders)[]).map(
                        (g) => (
                          <option key={g} value={g}>
                            {COPY.step3.genders[g]}
                          </option>
                        ),
                      )}
                    </Select>
                  )}
                </FormField>
                <FormField
                  id={CONTROL_ID.interests}
                  label={COPY.step3.interests}
                  help={COPY.step3.interestsHelp}
                  error={err(CONTROL_ID.interests)}
                >
                  {(c) => (
                    <Input
                      {...c}
                      value={values.interests}
                      onChange={(e) => edit({ interests: e.target.value }, CONTROL_ID.interests)}
                      autoComplete="off"
                    />
                  )}
                </FormField>
              </FormGrid>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-ui font-semibold">{COPY.step3.goal}</legend>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  {(Object.keys(COPY.step3.goals) as (keyof typeof COPY.step3.goals)[]).map(
                    (goal) => (
                      <RadioCard
                        key={goal}
                        name="goal"
                        value={goal}
                        checked={values.goal === goal}
                        onChange={() => edit({ goal })}
                        label={COPY.step3.goals[goal]}
                      />
                    ),
                  )}
                </div>
              </fieldset>
              <FormGrid>
                <FormField label={COPY.step3.tone} help={COPY.step3.toneHelp}>
                  {(c) => (
                    <Select
                      {...c}
                      value={values.tone}
                      onChange={(e) => edit({ tone: e.target.value })}
                    >
                      <option value="">Choose a tone</option>
                      {toneOptions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
                <div className="flex flex-col gap-1">
                  <span id="segments-label" className="text-ui font-semibold">
                    {COPY.step3.segments}
                  </span>
                  <SegmentedControl
                    aria-label={COPY.step3.segments}
                    name="segments"
                    value={values.segmentCount}
                    options={['1', '2', '3', '4'].map((n) => ({ value: n, label: n }))}
                    onValueChange={(n) => edit({ segmentCount: n as FormValues['segmentCount'] })}
                  />
                  <p
                    className="text-caption tabular-nums text-muted-foreground"
                    data-testid="segments-total"
                  >
                    {segmentsText(values.segmentCount)}
                  </p>
                </div>
              </FormGrid>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="flex flex-col gap-6">
              <Heading id="step-title" step={4} headingRef={headingRef}>
                {COPY.step4.title}
              </Heading>
              {block ? <SubmitBlockAlert block={block} /> : null}
              {submitError ? (
                <ErrorNotice
                  error={submitError}
                  surface="context"
                  call="job"
                  failures={failures}
                  returnTo={returnTo}
                  retrying={generating}
                  onAction={() => void generate()}
                />
              ) : null}
              {values.intakeMode === 'script' ? (
                <FormField
                  id={CONTROL_ID.script}
                  label={COPY.step4.script}
                  mark="required"
                  help={COPY.step4.scriptHelp}
                  error={err(CONTROL_ID.script)}
                >
                  {(c) => (
                    <Textarea
                      {...c}
                      maxLength={4000}
                      rows={8}
                      value={values.script}
                      disabled={generating}
                      onChange={(e) => edit({ script: e.target.value }, CONTROL_ID.script)}
                    />
                  )}
                </FormField>
              ) : (
                <FormField
                  id={CONTROL_ID.concept}
                  label={COPY.step4.concept}
                  mark="required"
                  help={COPY.step4.conceptHelp}
                  error={err(CONTROL_ID.concept)}
                >
                  {(c) => (
                    <Textarea
                      {...c}
                      maxLength={4000}
                      rows={6}
                      value={values.concept}
                      disabled={generating}
                      onChange={(e) => edit({ concept: e.target.value }, CONTROL_ID.concept)}
                    />
                  )}
                </FormField>
              )}
              <dl
                aria-label={COPY.step4.summary}
                className="grid grid-cols-1 gap-x-4 gap-y-1 text-ui md:grid-cols-4"
              >
                <dt className="mt-2 text-muted-foreground md:mt-0">{COPY.step4.product}</dt>
                <dd className="md:col-span-3">{values.productName || COPY.step4.notSet}</dd>
                <dt className="mt-2 text-muted-foreground md:mt-0">{COPY.step4.image}</dt>
                <dd className="md:col-span-3">
                  {values.productMediaId ? COPY.step4.imageAdded : COPY.step4.imageNone}
                </dd>
                <dt className="mt-2 text-muted-foreground md:mt-0">{COPY.step4.audience}</dt>
                <dd className="md:col-span-3">{audienceSummary(values)}</dd>
                <dt className="mt-2 text-muted-foreground md:mt-0">{COPY.step4.direction}</dt>
                <dd className="md:col-span-3">{directionSummary(values)}</dd>
              </dl>
              <p className="text-caption text-muted-foreground">{COPY.step4.reuseNote}</p>
              {generating ? (
                <p
                  role="status"
                  className="flex items-center gap-2 text-ui"
                  data-testid="generating-status"
                >
                  <Icon
                    name="loader-circle"
                    size={16}
                    className="animate-spin motion-reduce:animate-none"
                  />
                  {COPY.step4.inProgress}
                </p>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
    );
  }

  return (
    <OperatorShell
      role="user"
      path={NEW_BRIEF_PATH}
      pageName={COPY.title}
      onSignOut={() => window.location.assign(ROUTES.signIn)}
    >
      <div
        className="mx-auto flex max-w-content flex-col gap-6"
        data-screen="SCREEN-006"
        aria-busy={loading || undefined}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <header className="flex flex-col gap-1">
            <h1 className="text-page font-semibold">{COPY.title}</h1>
            <p className="text-ui text-muted-foreground">{COPY.description}</p>
          </header>
          <div className="text-ui text-muted-foreground" data-testid="save-status">
            {savedLabel}
          </div>
        </div>
        <Stepper steps={[...COPY.steps]} current={step - 1} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-8">{body}</div>
          <aside aria-label="Summary" className="hidden lg:col-span-4 lg:block">
            <Card variant="section" headingLevel={2}>
              <h2 className="text-body font-semibold">{COPY.next4Title}</h2>
              <ol className="flex flex-col gap-2 text-ui">
                {COPY.next4.map((line, i) => (
                  <li key={line} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-grid size-6 place-items-center rounded-full bg-primary-subtle text-caption font-semibold text-primary-active"
                    >
                      {i + 1}
                    </span>
                    {line}
                  </li>
                ))}
              </ol>
              <p className="text-ui text-muted-foreground">{COPY.next4Note}</p>
            </Card>
          </aside>
        </div>
      </div>

      <Dialog
        open={startOver.open}
        onClose={() =>
          !startOver.pending && setStartOver({ open: false, pending: false, error: null })
        }
        title={COPY.startOverTitle}
        description={COPY.startOverBody}
        confirmLabel={COPY.startOverConfirm}
        destructive
        pending={startOver.pending}
        error={
          startOver.error
            ? resolveError(startOver.error, { surface: 'context' }).message
            : undefined
        }
        onConfirm={() => void confirmStartOver()}
      />
      {sessionEnded ||
      (loaded.isError && !applied && resolveError(loaded.error).code === 'unauthenticated') ? (
        <SessionEndedDialog
          step={step}
          onSignIn={() => window.location.assign(signInUrl(returnTo))}
        />
      ) : null}
    </OperatorShell>
  );
}

function audienceSummary(v: FormValues): string {
  const parts = [
    v.gender === '' || v.gender === 'all' ? 'Any gender' : COPY.step3.genders[v.gender],
    v.ageMin || v.ageMax ? `${v.ageMin || '21'} to ${v.ageMax || '99'}` : null,
    parseInterests(v.interests).join(', ') || null,
  ];
  return parts.filter(Boolean).join(', ');
}

function directionSummary(v: FormValues): string {
  const parts = [
    v.goal ? COPY.step3.goals[v.goal] : null,
    v.tone ? v.tone.toLowerCase() : null,
    v.segmentCount
      ? `${v.segmentCount} ${v.segmentCount === '1' ? 'segment' : 'segments'} (${String(Number(v.segmentCount) * SEGMENT_SECONDS)} s)`
      : null,
  ];
  return parts.filter(Boolean).join(', ') || COPY.step4.notSet;
}
