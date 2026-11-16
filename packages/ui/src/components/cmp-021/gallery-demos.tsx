'use client';

import { useEffect, useRef, useState } from 'react';
import { Cell } from '../cmp-014/gallery-demos';
import { FileUpload, type UploadItem } from './FileUpload';

export { Cell };

const SAMPLE: UploadItem[] = [
  { id: 'u', name: 'bottle.jpg', size: 2_400_000, status: 'uploading', progress: 60 },
  { id: 'p', name: 'tin.png', size: 1_100_000, status: 'processing' },
  { id: 'r', name: 'jar.webp', size: 640_000, status: 'ready' },
  { id: 'x', name: 'huge.gif', size: 12_000_000, status: 'rejected', reason: 'Too large. Images can be up to 10 MB.' },
];

const noop = () => undefined;

/** Every state at once, pinned, for the gallery baseline. */
export function UploadStatesDemo() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Cell id="upload-idle" label="CMP-021 idle">
        <FileUpload items={[]} onFiles={noop} onRemove={noop} />
      </Cell>
      <Cell id="upload-drag-over" label="CMP-021 drag-over">
        <FileUpload items={[]} onFiles={noop} onRemove={noop} dragOver />
      </Cell>
      <Cell id="upload-rows" label="CMP-021 uploading, processing, ready, rejected with server reason">
        <FileUpload items={SAMPLE} onFiles={noop} onRemove={noop} />
      </Cell>
    </div>
  );
}

/** Working demo: picks files, simulates upload and processing, rejects non-images with the reason. */
export function UploadLiveDemo() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const patch = (id: string, change: Partial<UploadItem>) =>
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...change } : i)));
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  return (
    <Cell id="upload-live" label="CMP-021 interactive (simulated upload)">
      <FileUpload
        items={items}
        onFiles={(files) =>
          files.forEach((file, n) => {
            const id = `${Date.now()}-${n}-${file.name}`;
            setItems((list) => [...list, { id, name: file.name, size: file.size, status: 'uploading', progress: 0 }]);
            later(() => patch(id, { progress: 50 }), 100);
            later(() => patch(id, { status: 'processing', progress: 100 }), 250);
            later(() => patch(id, { status: 'ready' }), 450);
          })
        }
        onRejected={(rejections) =>
          setItems((list) => [
            ...list,
            ...rejections.map(({ file, reason }, n) => ({
              id: `${Date.now()}-r${n}-${file.name}`,
              name: file.name,
              size: file.size,
              status: 'rejected' as const,
              reason,
            })),
          ])
        }
        onRemove={(id) => setItems((list) => list.filter((i) => i.id !== id))}
      />
    </Cell>
  );
}
