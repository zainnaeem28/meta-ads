import { Cell } from '@shroomap/ui/cmp-014/gallery-demos';
import { ErrorDemo, TableDemo } from '@shroomap/ui/cmp-016/gallery-demos';
import { Card } from '@shroomap/ui/cmp-018';
import { EmptyState } from '@shroomap/ui/cmp-019';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-016',
  title: 'Composites: Table / list, Card, Empty and error state (CMP-018, CMP-019)',
  order: 16,
};

export default function FeCompDataSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="comp-data">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Cell id="table-content" label="CMP-016 content, sortable columns (sort buttons named)">
          <TableDemo />
        </Cell>
        <Cell id="table-selected" label="CMP-016 row selected">
          <TableDemo selected="b" />
        </Cell>
        <Cell id="table-pending" label="CMP-016 row action pending">
          <TableDemo pending="a" />
        </Cell>
        <Cell id="table-loading" label="CMP-016 loading skeleton">
          <TableDemo state="loading" />
        </Cell>
        <Cell id="table-empty" label="CMP-016 no results">
          <TableDemo state="empty" />
        </Cell>
        <Cell id="table-nomatches" label="CMP-016 no results, filters hide every row">
          <TableDemo state="empty" emptyVariant="no-matches" />
        </Cell>
        <Cell id="table-error" label="CMP-016 error">
          <TableDemo state="error" />
        </Cell>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Cell id="card-plain" label="CMP-018 plain, content">
          <Card title="Morning Focus Blend" footer="Updated 2 Nov">
            Three clips ready for review.
          </Card>
        </Cell>
        <Cell id="card-section" label="CMP-018 section, content">
          <Card variant="section" title="Billing" headingLevel={2}>
            Spend this month is within your limit.
          </Card>
        </Cell>
        <Cell id="card-link" label="CMP-018 clickable (one link, nothing nested)">
          <Card title="Evening Calm" href="#card-link">
            Open the campaign.
          </Card>
        </Cell>
        <Cell id="card-loading" label="CMP-018 loading">
          <Card title="Recent activity" state="loading" />
        </Cell>
        <Cell id="card-empty" label="CMP-018 empty">
          <Card title="Recent activity" state="empty" emptyTitle="No activity yet" emptyDescription="Runs appear here." />
        </Cell>
        <Cell id="card-unavailable" label="CMP-018 unavailable">
          <Card title="Spend" state="unavailable" />
        </Cell>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Cell id="empty-empty" label="CMP-019 empty">
          <EmptyState title="No campaigns yet" description="Create your first campaign to see it here." />
        </Cell>
        <Cell id="empty-nomatches" label="CMP-019 no matches">
          <EmptyState variant="no-matches" title="No results" description="Try a different search or clear the filters." />
        </Cell>
        <Cell id="empty-error" label="CMP-019 load error (role=alert)">
          <ErrorDemo />
        </Cell>
      </div>
    </div>
  );
}
