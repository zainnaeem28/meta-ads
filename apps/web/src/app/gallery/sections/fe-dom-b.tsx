import { Cell } from '@shroomap/ui/cmp-014/gallery-demos';
import { KeyCardDemo } from '@shroomap/ui/cmp-025/gallery-demos';
import { PreviewDemo } from '@shroomap/ui/cmp-026/gallery-demos';
import { RowsDemo } from '@shroomap/ui/cmp-027/gallery-demos';
import { InlineBar, MetricGrid, MetricTile } from '@shroomap/ui/cmp-028';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-025',
  title:
    'Domain B: Provider key card, Final preview, Campaign row, Metric tile (CMP-025, 026, 027, 028)',
  order: 25,
};

// Plain list: a client module's exports cannot be read as values from this server section.
const PROVIDERS = ['openai', 'wavespeed'] as const;
const KEY_STATES = ['active', 'untested', 'disabled', 'none', 'testing', 'delete-confirm'] as const;
const PREVIEW_STATES = ['assembling', 'done', 'failed', 'out-of-date'] as const;

export default function FeDomBSection() {
  return (
    <div className="flex flex-col gap-8" data-testid="dom-b">
      <div data-testid="key-cards" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {PROVIDERS.flatMap((provider) =>
          KEY_STATES.map((state) => (
            <Cell
              key={`${provider}-${state}`}
              id={`key-${provider}-${state}`}
              label={`CMP-025 ${provider} ${state}`}
            >
              <KeyCardDemo provider={provider} initial={state} />
            </Cell>
          )),
        )}
      </div>

      <div data-testid="final-previews" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {PREVIEW_STATES.map((state) => (
          <Cell key={state} id={`preview-${state}`} label={`CMP-026 ${state}`}>
            <PreviewDemo state={state} />
          </Cell>
        ))}
      </div>

      <RowsDemo />

      <MetricGrid data-testid="metric-tiles">
        <MetricTile
          label="Videos finished"
          value="18"
          delta="up 3 since last week"
          bar={{ value: 18, max: 24, tone: 1 }}
        />
        <MetricTile
          variant="cost"
          label="Cost"
          value="$12.40"
          unit="USD"
          bar={{ value: 12, max: 40, tone: 2 }}
        />
        <MetricTile label="Videos finished" loading />
        <MetricTile label="Failed runs" value={null} />
        <MetricTile variant="cost" label="Cost" loading />
        <MetricTile variant="cost" label="Cost" value={null} />
      </MetricGrid>
      <div data-testid="inline-bar" className="max-w-sm">
        <InlineBar label="Budget used" value={30} max={40} tone={3} />
      </div>
    </div>
  );
}
