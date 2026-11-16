import { DialogLive, DialogStates, MenuStates } from '@shroomap/ui/cmp-013/gallery-demos';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-013',
  title: 'Composites: Dialog and Menu (CMP-020)',
  order: 13,
};

export default function FeCompOverlaySection() {
  return (
    <div className="flex flex-col gap-6" data-testid="comp-overlay">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-cell="dialog-states">
        <DialogStates />
      </div>
      <div data-cell="dialog-live" className="rounded-md border border-border bg-card p-4">
        <DialogLive />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <MenuStates />
      </div>
    </div>
  );
}
