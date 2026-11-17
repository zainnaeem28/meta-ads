'use client';

import { useId, useRef, useState, type DragEvent } from 'react';
import { Icon } from '../../icons';
import { Button } from '../cmp-003';
import { Badge } from '../cmp-007';
import type { BadgeVariant } from '../cmp-007';
import { Progress } from '../cmp-008';
import { UPLOAD_ACCEPT, formatBytes, validateImageFile, type UploadStatus } from './rules';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** 0 to 100 while `uploading`. */
  progress?: number;
  /** Shown when `rejected`; use the server message when there is one. */
  reason?: string;
  /** Optional thumbnail (object or CDN URL). */
  previewUrl?: string;
}

export interface FileRejection {
  file: File;
  reason: string;
}

export interface FileUploadProps {
  items: UploadItem[];
  /** Files that passed the local image checks. */
  onFiles: (files: File[]) => void;
  /** Files refused locally, each with its reason. */
  onRejected?: (rejections: FileRejection[]) => void;
  onRemove: (id: string) => void;
  /** Accessible name of the drop zone button. */
  label?: string;
  disabled?: boolean;
  /** Gallery and tests can pin the drag-over look. */
  dragOver?: boolean;
  className?: string;
}

const BADGE: Record<UploadStatus, { variant: BadgeVariant; text: string }> = {
  uploading: { variant: 'info', text: 'Uploading' },
  processing: { variant: 'info', text: 'Processing' },
  ready: { variant: 'success', text: 'Ready' },
  rejected: { variant: 'destructive', text: 'Rejected' },
};

/** CMP-021: image drop zone (a labelled button that opens the picker) with one status row per file. */
export function FileUpload({
  items,
  onFiles,
  onRejected,
  onRemove,
  label = 'Upload an image',
  disabled = false,
  dragOver,
  className,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const over = dragOver ?? dragging;

  const take = (list: FileList | File[] | null) => {
    const files = list ? Array.from(list) : [];
    const accepted: File[] = [];
    const rejected: FileRejection[] = [];
    for (const file of files) {
      const reason = validateImageFile(file);
      if (reason) rejected.push({ file, reason });
      else accepted.push(file);
    }
    if (accepted.length) onFiles(accepted);
    if (rejected.length) onRejected?.(rejected);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) take(e.dataTransfer.files);
  };

  return (
    <div className={['flex w-full flex-col gap-3', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={hintId}
        data-state={over ? 'drag-over' : 'idle'}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={[
          'flex w-full flex-col items-center gap-1 rounded-md border-2 border-dashed p-6 text-center text-ui text-foreground',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          over ? 'border-primary bg-primary-subtle' : 'border-input bg-card hover:bg-accent',
        ].join(' ')}
      >
        <Icon name="upload" size={24} />
        <strong>{label}</strong>
        <span id={hintId} className="text-caption text-muted-foreground">
          {over ? 'Drop to upload. ' : 'Drop an image here or choose one. '}
          JPEG, PNG, WebP or GIF · up to 10 MB
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="file-upload-input"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
      <ul
        aria-live="polite"
        aria-label="Uploaded files"
        className="m-0 flex list-none flex-col gap-2 p-0"
      >
        {items.map((item) => {
          const badge = BADGE[item.status];
          const statusText =
            item.status === 'uploading'
              ? `Uploading, ${Math.round(item.progress ?? 0)}%`
              : item.status === 'rejected'
                ? `Rejected. ${item.reason ?? 'The file could not be used.'}`
                : badge.text;
          return (
            <li
              key={item.id}
              data-status={item.status}
              className={[
                'flex items-center gap-3 rounded-md border bg-card p-3',
                item.status === 'rejected' ? 'border-destructive' : 'border-border',
              ].join(' ')}
            >
              <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-muted-foreground">
                {item.previewUrl && item.status !== 'rejected' ? (
                  <img
                    src={item.previewUrl}
                    alt=""
                    width={56}
                    height={56}
                    className="size-full object-cover"
                  />
                ) : (
                  <Icon name={item.status === 'rejected' ? 'file-warning' : 'image'} size={24} />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-ui font-semibold">{item.name}</span>
                <span className="text-caption text-muted-foreground">{formatBytes(item.size)}</span>
                {item.status === 'uploading' ? (
                  <Progress label={`Uploading ${item.name}`} value={item.progress ?? 0} />
                ) : null}
                {item.status === 'rejected' ? (
                  <span className="text-ui text-destructive">
                    {item.reason ?? 'The file could not be used.'}
                  </span>
                ) : null}
                <span className="sr-only">{statusText}</span>
              </div>
              <Badge variant={badge.variant} aria-hidden="true">
                {badge.text}
              </Badge>
              <Button
                variant="icon-only"
                size="sm"
                aria-label={`Remove ${item.name}`}
                onClick={() => onRemove(item.id)}
              >
                <Icon name="x" size={16} />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
