'use client';

import {
  adminUsageReport,
  getAdminUsageReportQueryKey,
  type ProviderUsage,
  type UsageReport,
  type UsageReportClaimChecksItem,
  type UsageReportResponse,
} from '@shroomap/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@shroomap/ui/cmp-003';
import { Input } from '@shroomap/ui/cmp-004';
import { Select } from '@shroomap/ui/cmp-005';
import { Alert } from '@shroomap/ui/cmp-011';
import { FormField } from '@shroomap/ui/cmp-010';
import { Table, type TableColumn } from '@shroomap/ui/cmp-016';
import { EmptyState } from '@shroomap/ui/cmp-019';
import { MetricGrid, MetricTile } from '@shroomap/ui/cmp-028';
import { AdminShell } from '@shroomap/ui/cmp-031';
import { useState, type ReactNode } from 'react';
import { ErrorNotice } from '../../components/errors';
import { isApiClientError } from '../../lib/api/client';
import { ROUTES } from '../../lib/errors/routes';
import { signInUrl } from '../../lib/errors/session';
import {
  CLAIM_CLASS,
  PRESETS,
  SCREEN_015_COPY as COPY,
  accountRows,
  checkWindow,
  choiceOf,
  formatAsOf,
  formatCount,
  formatLatency,
  formatUsd,
  microUsd,
  presetWindow,
  providerName,
  share,
  shortUserId,
  totalsOf,
  windowParams,
  type AccountRow,
  type ReportWindow,
  type WindowChoice,
} from './copy';

const PATH = '/admin/usage';
const EMPTY_WINDOW: ReportWindow = { from: '', to: '' };

const num = 'text-right tabular-nums';
const Num = ({ children }: { children: ReactNode }) => (
  <span className={`block ${num} max-md:inline`}>{children}</span>
);

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-body font-semibold">
          {title}
        </h2>
        <span className="text-ui text-muted-foreground">{note}</span>
      </div>
      {children}
    </section>
  );
}

function CostShare({ percent }: { percent: number }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-2 w-24 overflow-hidden rounded-full border border-border-strong bg-muted"
      >
        <span className="block h-full bg-chart-1" style={{ width: `${percent}%` }} />
      </span>
      <span className="tabular-nums">{percent}%</span>
    </span>
  );
}

const usageColumns = (cost: bigint): TableColumn<ProviderUsage>[] => [
  { id: 'provider', header: 'Provider', cell: (u) => providerName(u.provider) },
  { id: 'calls', header: 'Calls', cell: (u) => <Num>{formatCount(u.calls)}</Num> },
  { id: 'succeeded', header: 'Succeeded', cell: (u) => <Num>{formatCount(u.succeeded)}</Num> },
  { id: 'failed', header: 'Failed', cell: (u) => <Num>{formatCount(u.failed)}</Num> },
  { id: 'rejected', header: 'Rejected', cell: (u) => <Num>{formatCount(u.rejected)}</Num> },
  {
    id: 'unconfirmed',
    header: 'Unconfirmed',
    cell: (u) => <Num>{formatCount(u.unconfirmed)}</Num>,
  },
  {
    id: 'cost',
    header: 'Estimated cost',
    cell: (u) => <Num>{formatUsd(microUsd(u.estimatedCostUsd))}</Num>,
  },
  {
    id: 'share',
    header: 'Share of cost',
    cell: (u) => <CostShare percent={share(microUsd(u.estimatedCostUsd), cost)} />,
  },
  { id: 'p95', header: 'p95 latency', cell: (u) => <Num>{formatLatency(u.latencyP95Ms)}</Num> },
];

const accountColumns = (cost: bigint): TableColumn<AccountRow>[] => {
  const [, ...rest] = usageColumns(cost);
  return [
    {
      id: 'user',
      header: 'User ID',
      cell: (r) => <span className="font-mono">{shortUserId(r.userId)}</span>,
    },
    { id: 'provider', header: 'Provider', cell: (r) => providerName(r.usage.provider) },
    ...rest.map((c) => ({ ...c, cell: (r: AccountRow) => c.cell(r.usage) })),
  ];
};

const claimColumns: TableColumn<UsageReportClaimChecksItem>[] = [
  { id: 'class', header: 'Class', cell: (c) => CLAIM_CLASS[c.class] ?? c.class },
  { id: 'raised', header: 'Raised', cell: (c) => <Num>{formatCount(c.raised)}</Num> },
  {
    id: 'closed',
    header: 'Closed by editing',
    cell: (c) => <Num>{formatCount(c.closedByEdit)}</Num>,
  },
  {
    id: 'cleared',
    header: 'Cleared with a reason',
    cell: (c) => (
      <Num>
        {formatCount(c.clearedWithReason)}
        {c.class === 'high_risk' && c.clearedWithReason === 0 ? (
          <span className="text-muted-foreground"> {COPY.notAllowed}</span>
        ) : null}
      </Num>
    ),
  },
];

const jobColumns: TableColumn<[string, number]>[] = [
  { id: 'state', header: 'State', cell: ([state]) => state.replace(/_/g, ' ') },
  { id: 'jobs', header: 'Jobs', cell: ([, n]) => <Num>{formatCount(n)}</Num> },
];

function Metrics({ report, loading }: { report?: UsageReport; loading?: boolean }) {
  const t = report ? totalsOf(report) : null;
  return (
    <MetricGrid>
      <MetricTile
        label={COPY.metrics.calls}
        loading={loading}
        value={t ? formatCount(t.calls) : null}
      />
      <MetricTile
        label={COPY.metrics.failed}
        loading={loading}
        value={t ? formatCount(t.failed) : null}
      />
      <MetricTile
        variant="cost"
        label={COPY.metrics.cost}
        loading={loading}
        value={t ? formatUsd(t.cost) : null}
      />
      <MetricTile
        label={COPY.metrics.flags}
        loading={loading}
        value={t ? formatCount(t.flags) : null}
      />
    </MetricGrid>
  );
}

function Tables({ report }: { report: UsageReport }) {
  const t = totalsOf(report);
  const rows = accountRows(report);
  const jobs = Object.entries(report.jobStates);
  return (
    <>
      <Section id="by-account" title={COPY.accountsTitle} note={COPY.accountsNote}>
        <Table
          label={COPY.accountsTitle}
          columns={accountColumns(t.cost)}
          rows={rows}
          rowKey={(r) => r.key}
        />
      </Section>
      <Section id="by-provider" title={COPY.providersTitle} note={COPY.accountsNote}>
        <Table
          label={COPY.providersTitle}
          columns={usageColumns(t.cost)}
          rows={report.providers}
          rowKey={(u) => u.provider}
        />
      </Section>
      {jobs.length > 0 ? (
        <Section id="job-states" title={COPY.jobsTitle} note={COPY.jobsNote}>
          <Table label={COPY.jobsTitle} columns={jobColumns} rows={jobs} rowKey={([s]) => s} />
        </Section>
      ) : null}
      <Section id="claim-checks" title={COPY.claimsTitle} note={COPY.claimsNote}>
        <Table
          label={COPY.claimsTitle}
          columns={claimColumns}
          rows={report.claimChecks}
          rowKey={(c) => c.class}
        />
      </Section>
    </>
  );
}

const longDate = (instant: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(instant));

function writeUrl(window: ReportWindow | null) {
  const url = window ? `${PATH}?from=${window.from}&to=${window.to}` : PATH;
  globalThis.history.replaceState(null, '', url);
}

/**
 * SCREEN-015 at `/admin/usage` (Administrator): the window selector (default 30 days, at most 366), the "as of" time,
 * metric tiles, per-account and per-provider tables with cost labelled an estimate, job states and claim-check
 * counts (API-130). Accounts are user IDs only. The optional CSV (API-131) is not offered here: the shared api client
 * parses every body as JSON, so it cannot return the `text/csv` body (change request on the ticket).
 */
export function UsageScreen({ initialWindow = null }: { initialWindow?: ReportWindow | null }) {
  const [applied, setApplied] = useState<ReportWindow | null>(initialWindow);
  const [choice, setChoice] = useState<WindowChoice>(() => choiceOf(initialWindow));
  const [draft, setDraft] = useState<ReportWindow>(initialWindow ?? EMPTY_WINDOW);
  const [draftError, setDraftError] = useState<string | null>(null);

  const params = applied ? windowParams(applied) : null;
  const query = useQuery<UsageReportResponse>({
    queryKey: getAdminUsageReportQueryKey(params ?? undefined),
    queryFn: async ({ signal }) =>
      (await adminUsageReport(params ?? undefined, { signal })).data as UsageReportResponse,
  });

  const error = query.error;
  const code = isApiClientError(error) ? error.code : null;
  const forbidden = code === 'forbidden_role';
  const tooLarge = code === 'report_window_too_large';
  const unreachable = code === 'service_unavailable';
  const report = query.data?.data;
  const retry = () => void query.refetch();

  const choose = (next: WindowChoice) => {
    setChoice(next);
    setDraftError(null);
    if (next === 'custom') {
      setDraft((d) => (d.from ? d : (applied ?? presetWindow(30))));
      return;
    }
    const window = next === '30' ? null : presetWindow(Number(next));
    setApplied(window);
    writeUrl(window);
  };

  const apply = () => {
    const problem = checkWindow(draft);
    setDraftError(problem);
    if (problem) return;
    setApplied(draft);
    writeUrl(draft);
  };

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-4">
        <Metrics loading />
        <Section id="loading" title={COPY.accountsTitle} note={COPY.loading}>
          <Table
            label={COPY.accountsTitle}
            columns={accountColumns(0n)}
            rows={[]}
            rowKey={(r) => r.key}
            state="loading"
          />
        </Section>
      </div>
    );
  } else if (tooLarge) {
    body = null;
  } else if (query.isError && !forbidden) {
    body = unreachable ? (
      <EmptyState
        variant="error"
        title={COPY.errorTitle}
        description={COPY.errorBody}
        headingLevel={2}
        onRetry={retry}
      />
    ) : (
      <ErrorNotice
        error={error}
        returnTo={PATH}
        retrying={query.isRefetching}
        onAction={(action) =>
          action === 'confirm' ? window.location.assign(signInUrl(PATH)) : retry()
        }
      />
    );
  } else if (report?.empty) {
    body = (
      <EmptyState
        title={COPY.emptyTitle}
        description={`No provider calls were made between ${longDate(report.from)} and ${longDate(new Date(Date.parse(report.to) - 1).toISOString())}. This is not an error.`}
        headingLevel={2}
      />
    );
  } else if (report) {
    body = (
      <>
        <Metrics report={report} />
        <Tables report={report} />
      </>
    );
  }

  const windowError = draftError ?? (tooLarge ? COPY.windowFieldError : undefined);

  return (
    <AdminShell
      path={PATH}
      pageName={COPY.title}
      unavailable={forbidden}
      workspaceHref={ROUTES.campaigns}
    >
      <div
        className="mx-auto flex max-w-6xl flex-col gap-4"
        data-screen="SCREEN-015"
        aria-busy={query.isPending || undefined}
      >
        {forbidden ? null : (
          <>
            <header className="flex flex-col gap-1">
              <h1 className="text-section font-semibold">{COPY.title}</h1>
              <p className="text-ui text-muted-foreground">{COPY.description}</p>
            </header>
            <div className="flex flex-wrap items-end gap-4">
              <FormField
                label={COPY.windowLabel}
                className="w-56 max-md:w-full"
                error={choice === 'custom' ? undefined : windowError}
              >
                {(control) => (
                  <Select
                    id={control.id}
                    aria-describedby={control['aria-describedby']}
                    invalid={control.invalid}
                    value={choice}
                    onChange={(e) => choose(e.target.value as WindowChoice)}
                  >
                    {PRESETS.map((n) => (
                      <option key={n} value={String(n)}>
                        Last {n} days
                      </option>
                    ))}
                    <option value="custom">Custom dates</option>
                  </Select>
                )}
              </FormField>
              {choice === 'custom' ? (
                <>
                  <FormField label={COPY.customFrom} className="w-44 max-md:w-full">
                    {(control) => (
                      <Input
                        id={control.id}
                        type="date"
                        value={draft.from}
                        invalid={control.invalid}
                        onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                      />
                    )}
                  </FormField>
                  <FormField
                    label={COPY.customTo}
                    className="w-44 max-md:w-full"
                    error={windowError}
                  >
                    {(control) => (
                      <Input
                        id={control.id}
                        type="date"
                        value={draft.to}
                        aria-describedby={control['aria-describedby']}
                        invalid={control.invalid}
                        onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                      />
                    )}
                  </FormField>
                  <Button variant="outline" onClick={apply}>
                    {COPY.apply}
                  </Button>
                </>
              ) : null}
              {report ? (
                <span className="text-ui text-muted-foreground">
                  {COPY.asOf} <time dateTime={report.asOf}>{formatAsOf(report.asOf)}</time>
                </span>
              ) : null}
            </div>
            {tooLarge ? <Alert variant="destructive">{COPY.windowTooLarge}</Alert> : null}
          </>
        )}
        {forbidden ? null : body}
      </div>
    </AdminShell>
  );
}
