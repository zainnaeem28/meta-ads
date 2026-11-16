'use client';

import { CampaignRow } from './CampaignRow';

const noop = () => undefined;

/** Gallery-only: a history row, a draft row and a row being deleted (handlers cannot cross from a server section). */
export function RowsDemo() {
  return (
    <ul data-testid="campaign-rows" className="m-0 flex list-none flex-col gap-3 p-0">
      <CampaignRow
        variant="history"
        name="Summer sale"
        href="#campaign-summer"
        segments={4}
        duration="0:24"
        date="12 Nov 2026"
        status={{ label: 'Ready', variant: 'success' }}
        actions={[
          { id: 'open', label: 'Open Summer sale', onClick: noop },
          { id: 'delete', label: 'Delete Summer sale', onClick: noop, destructive: true },
        ]}
      />
      <CampaignRow
        variant="draft"
        name="Autumn launch"
        href="#campaign-autumn"
        segments={2}
        date="14 Nov 2026"
        status={{ label: 'Draft' }}
        actions={[
          { id: 'continue', label: 'Continue Autumn launch', onClick: noop },
          { id: 'delete', label: 'Delete Autumn launch', onClick: noop, destructive: true },
        ]}
      />
      <CampaignRow
        variant="history"
        name="Winter promo"
        href="#campaign-winter"
        segments={1}
        duration="0:08"
        date="2 Nov 2026"
        status={{ label: 'Ready', variant: 'success' }}
        deleting
        actions={[{ id: 'delete', label: 'Delete Winter promo', onClick: noop }]}
      />
    </ul>
  );
}
