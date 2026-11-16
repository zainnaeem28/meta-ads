import { JobCardGallery } from '@shroomap/ui/cmp-022/gallery-demos';
import { ClaimIssueGallery } from '@shroomap/ui/cmp-023/gallery-demos';
import { SegmentEditorGallery } from '@shroomap/ui/cmp-024/gallery-demos';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-022',
  title: 'Job card, Claim issue, Segment editor (CMP-022, 023, 024)',
  order: 22,
};

export default function DomainASection() {
  return (
    <div className="flex flex-col gap-8" data-testid="dom-a">
      <div data-testid="job-cards">
        <JobCardGallery />
      </div>
      <div data-testid="claim-issues">
        <ClaimIssueGallery />
      </div>
      <div data-testid="segment-editors">
        <SegmentEditorGallery />
      </div>
    </div>
  );
}
