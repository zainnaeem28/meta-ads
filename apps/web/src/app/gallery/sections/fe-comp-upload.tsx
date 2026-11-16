import { UploadLiveDemo, UploadStatesDemo } from '@shroomap/ui/cmp-021/gallery-demos';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-021',
  title: 'File upload (CMP-021)',
  order: 21,
};

export default function FeCompUploadSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="comp-upload">
      <UploadStatesDemo />
      <UploadLiveDemo />
    </div>
  );
}
