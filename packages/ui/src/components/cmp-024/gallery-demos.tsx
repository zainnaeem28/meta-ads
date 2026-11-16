'use client';

import { useState } from 'react';
import { SegmentEditor } from './SegmentEditor';
import type { SaveState } from './SegmentEditor';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');

const CASES: { key: string; text: string; save: SaveState; segment: number }[] = [
  { key: 'short', text: words(10), save: 'idle', segment: 1 },
  { key: 'within', text: words(36), save: 'idle', segment: 2 },
  { key: 'over', text: words(48), save: 'idle', segment: 3 },
  { key: 'saving', text: words(36), save: 'saving', segment: 4 },
  { key: 'saved', text: words(36), save: 'saved', segment: 1 },
];
const noop = () => {};

function LiveEditor() {
  const [text, setText] = useState(words(36));
  return <SegmentEditor segment={2} value={text} onChange={setText} />;
}

/** Gallery host: segments 1..4, every counter zone, saving and saved, plus one editable editor. */
export function SegmentEditorGallery() {
  return (
    <div className="grid max-w-4xl gap-4 md:grid-cols-2">
      {CASES.map((c) => (
        <div key={c.key} data-case={c.key}>
          <SegmentEditor segment={c.segment} value={c.text} onChange={noop} saveState={c.save} />
        </div>
      ))}
      <div data-testid="live-editor">
        <LiveEditor />
      </div>
    </div>
  );
}
