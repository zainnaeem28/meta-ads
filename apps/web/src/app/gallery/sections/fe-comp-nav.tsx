import { Cell, FilterDemo, TabsDemo } from '@shroomap/ui/cmp-014/gallery-demos';
import { Stepper } from '@shroomap/ui/cmp-015';
import { parseListState } from '@shroomap/ui/cmp-017';
import type { SectionMeta } from '../registry';

const STEPS = ['Account', 'Business', 'Creative', 'Review'];

export const meta: SectionMeta = {
  id: 'CMP-014',
  title: 'Composites: Tabs, Stepper, Filter bar and pagination (CMP-015, CMP-017)',
  order: 14,
};

export default function FeCompNavSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="comp-nav">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Cell id="tabs-selected" label="CMP-014 selected, default, disabled, count badges">
          <TabsDemo initial="review" />
        </Cell>
        <Cell id="tabs-first" label="CMP-014 first tab selected (hover and focus via the pointer and Tab)">
          <TabsDemo initial="all" />
        </Cell>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1, 3].map((current) => (
          <Cell key={current} id={`stepper-${current}`} label={`CMP-015 current step ${current + 1} of 4`}>
            <Stepper steps={STEPS} current={current} />
          </Cell>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Cell id="filter-default" label="CMP-017 default, with pagination">
          <FilterDemo initial={parseListState('')} rows={24} />
        </Cell>
        <Cell id="filter-selected" label="CMP-017 chip selected, page 2 (?status&page)">
          <FilterDemo initial={parseListState('?status=failed&page=2')} rows={24} />
        </Cell>
        <Cell id="filter-nomatches" label="CMP-017 no matches (?q=zzz)">
          <FilterDemo initial={parseListState('?q=zzz')} rows={0} />
        </Cell>
      </div>
    </div>
  );
}
