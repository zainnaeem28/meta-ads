# AIU-235: `brief.claimCounts(window)`

Import for Reporting (API-130, `UsageReport.claimChecks`):

```ts
import { ClaimCountsService } from '../brief/index.js';
import type { ClaimCheckCounts, ClaimWindow } from '../brief/index.js';

interface ClaimWindow { readonly from: Date; readonly to: Date; readonly ownerId?: string }
interface ClaimCheckCounts {
  readonly class: 'high_risk' | 'other';
  readonly raised: number;
  readonly closedByEdit: number;
  readonly clearedWithReason: number;
}
// ClaimCountsService.claimCounts(window): Promise<readonly ClaimCheckCounts[]>
```

- Counted from `claim_events` by event time `at`, `from <= at < to`. The result always has two entries, `high_risk` then `other` (zeros when empty), matching the `claimChecks` items of API-130.
- `ownerId` narrows to one account; omit it for the all-accounts report view. No copy text is read or returned (the table holds IDs and classes only).
- `BriefModule.register` exports `ClaimCountsService` (api composition root).
- Tests: `application/claim-counts.service.test.ts` (unit: empty window, class split, window passed through); `brief.integration.test.ts` "brief.claimCounts(window)" on real PostgreSQL through `createApiApp` (empty window, lower bound inside, upper bound outside, both classes, all three outcomes, other account excluded and included without `ownerId`).
- Run: `pnpm typecheck`, `pnpm exec eslint src/modules/brief`, unit and integration suites all passed.
