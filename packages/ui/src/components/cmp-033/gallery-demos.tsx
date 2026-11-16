'use client';

import { useState } from 'react';
import { Tabs } from '../cmp-014';

const STAGES = [
  { id: 'brief', label: 'Brief' },
  { id: 'clips', label: 'Clips', disabled: true },
  { id: 'final', label: 'Final', disabled: true },
];

/** Gallery-only: the campaign stage tabs (CMP-014) shown under the breadcrumb. */
export function StageTabsDemo() {
  const [value, setValue] = useState('brief');
  return (
    <Tabs label="Campaign stages" tabs={STAGES} value={value} onValueChange={setValue}>
      <p className="text-ui text-muted-foreground">Brief stage content.</p>
    </Tabs>
  );
}
