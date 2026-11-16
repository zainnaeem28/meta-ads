'use client';

import type { Settings } from '@shroomap/contracts';
import { Button } from '@shroomap/ui/cmp-003';
import { RadioCard } from '@shroomap/ui/cmp-006';
import { Badge } from '@shroomap/ui/cmp-007';
import { Card } from '@shroomap/ui/cmp-018';
import { PageHeader } from '@shroomap/ui/cmp-033';
import type { ReactNode } from 'react';
import { ErrorNotice, type NoticeAction } from '../../components/errors/ErrorNotice';
import { INVITE_LIFETIME_DAYS, SETTINGS_COPY as C } from './copy';

export type SignupMode = Settings['signupMode'];

export interface SettingsViewProps {
  /** Absent while the first load runs. */
  settings?: Settings;
  selected: SignupMode;
  onSelect: (mode: SignupMode) => void;
  onSave: () => void;
  saving?: boolean;
  /** Failure of the save (API-121): the refusal alert or the step-up dialog. */
  saveError?: unknown;
  onSaveErrorAction?: (action: NoticeAction) => void;
  /** Failure of the first load (API-120). */
  loadError?: unknown;
  onRetryLoad?: () => void;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:justify-between md:gap-6">
      <dt className="text-ui text-muted-foreground">{term}</dt>
      <dd className="text-ui font-medium">{children}</dd>
    </div>
  );
}

function Prerequisites({ settings }: { settings: Settings }) {
  const { emailVerificationRequired, signupRateLimitEnabled, abuseLimitsEnabled, verificationRecordId } =
    settings.openModePrerequisites;
  const limits = signupRateLimitEnabled && abuseLimitsEnabled;
  const status = (ok: boolean) =>
    ok ? (
      <Badge variant="success" icon="circle-check">
        Enabled
      </Badge>
    ) : (
      <Badge variant="warning" icon="triangle-alert">
        Not verified
      </Badge>
    );
  return (
    <dl className="divide-y divide-border">
      <Row term={C.prerequisites.email}>{status(emailVerificationRequired)}</Row>
      <Row term={C.prerequisites.limits}>{status(limits)}</Row>
      <Row term={C.prerequisites.record}>
        {verificationRecordId ? <Badge variant="info">{verificationRecordId}</Badge> : <Badge>None</Badge>}
      </Row>
    </dl>
  );
}

/** SCREEN-013 body: sign-up mode (API-121) and the read-only security configuration (API-120). */
export function SettingsView({
  settings,
  selected,
  onSelect,
  onSave,
  saving = false,
  saveError,
  onSaveErrorAction,
  loadError,
  onRetryLoad,
}: SettingsViewProps) {
  const header = <PageHeader title={C.title} description={C.description} />;

  if (loadError) {
    return (
      <div className="mx-auto flex w-full max-w-prose flex-col gap-6" data-state="error">
        {header}
        <ErrorNotice error={loadError} surface="page" onAction={(a) => a === 'retry' && onRetryLoad?.()} />
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="mx-auto flex w-full max-w-prose flex-col gap-6" data-state="loading" aria-busy="true">
        {header}
        <p role="status" className="text-ui text-muted-foreground">
          {C.loading}
        </p>
        <Card variant="section" state="loading" />
        <Card variant="section" state="loading" />
      </div>
    );
  }

  const unchanged = selected === settings.signupMode;
  return (
    <div
      className="mx-auto flex w-full max-w-prose flex-col gap-6"
      data-state={saveError ? 'open-refused' : 'default'}
    >
      {header}
      <Card
        variant="section"
        title={C.signup.title}
        headingLevel={2}
        footer={
          <Button onClick={onSave} pending={saving} pendingLabel={C.saving} disabled={unchanged}>
            {C.save}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-ui text-muted-foreground">{C.signup.sub}</p>
          {saveError ? (
            <ErrorNotice
              error={saveError}
              surface="context"
              call="write"
              onAction={(a) => onSaveErrorAction?.(a)}
            />
          ) : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-ui font-semibold">{C.modeLegend}</legend>
            <RadioCard
              name="signup-mode"
              value="invited_only"
              label={C.invitedOnly.label}
              description={C.invitedOnly.description}
              checked={selected === 'invited_only'}
              onChange={() => onSelect('invited_only')}
            />
            <RadioCard
              name="signup-mode"
              value="open"
              label={C.open.label}
              description={C.open.description}
              checked={selected === 'open'}
              onChange={() => onSelect('open')}
            />
          </fieldset>
          <Prerequisites settings={settings} />
        </div>
      </Card>
      <Card
        variant="section"
        title={C.security.title}
        headingLevel={2}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-ui text-muted-foreground">{C.security.sub}</p>
            <Badge icon="lock">{C.security.badge}</Badge>
          </div>
          <dl className="divide-y divide-border">
            <Row term={C.mfa.label}>{settings.mfaRequiredFor === 'all' ? C.mfa.all : C.mfa.admins}</Row>
            <Row term={C.accessForm}>
              <Badge variant={settings.accessRequestFormEnabled ? 'success' : 'neutral'}>
                {settings.accessRequestFormEnabled ? 'On' : 'Off'}
              </Badge>
            </Row>
            <Row term={C.inviteLifetime}>{INVITE_LIFETIME_DAYS} days</Row>
          </dl>
        </div>
      </Card>
    </div>
  );
}
