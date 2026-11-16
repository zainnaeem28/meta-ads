import { BADGE_VARIANTS, Badge } from '@shroomap/ui/cmp-007';
import { Progress, Skeleton, SkeletonRegion, Spinner } from '@shroomap/ui/cmp-008';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = { id: 'CMP-007', title: 'Badge and loading (CMP-008)', order: 7 };

export default function PrimBSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="prim-b">
      <div data-testid="badge-variants" className="flex flex-wrap items-center gap-3">
        {BADGE_VARIANTS.map((v) => (
          <Badge key={v} variant={v}>
            {v}
          </Badge>
        ))}
      </div>
      <div data-testid="badge-icons" className="flex flex-wrap items-center gap-3">
        <Badge variant="success" icon="circle-check">
          Approved
        </Badge>
        <Badge variant="info" icon="info">
          In review
        </Badge>
        <Badge variant="warning" icon="triangle-alert">
          Needs attention
        </Badge>
        <Badge variant="destructive" icon="circle-x">
          Failed
        </Badge>
      </div>
      <div data-testid="spinner" className="flex items-center gap-3">
        <Spinner label="Saving" />
      </div>
      <div data-testid="progress" className="flex max-w-sm flex-col gap-3">
        <Progress label="Upload 35 percent" value={35} />
        <Progress label="Upload 60 percent" value={60} />
        <Progress label="Upload complete" value={100} />
        <Progress label="Working, duration unknown" />
      </div>
      <div data-testid="skeleton" className="max-w-sm">
        <SkeletonRegion status="Loading campaigns">
          <Skeleton className="h-6 w-1/4" />
          <Skeleton className="w-1/2" />
          <Skeleton className="w-3/4" />
          <Skeleton className="h-32 w-full" />
        </SkeletonRegion>
      </div>
    </div>
  );
}
