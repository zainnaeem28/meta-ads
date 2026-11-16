'use client';

import { useEffect, useId, useState } from 'react';
import { Icon } from '../../icons';
import { FIELD_CLASS } from '../cmp-004/field-class';

export const TARGET_MIN = 32;
export const TARGET_MAX = 42;
export const HARD_MAX = 45;
/** The polite counter message waits for typing to pause. */
export const ANNOUNCE_DELAY_MS = 800;

export type WordZone = 'short' | 'within' | 'long' | 'blocked';
export type SaveState = 'idle' | 'saving' | 'saved';

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function wordZone(words: number): WordZone {
  if (words > HARD_MAX) return 'blocked';
  if (words > TARGET_MAX) return 'long';
  if (words >= TARGET_MIN) return 'within';
  return 'short';
}

const ZONE_TEXT: Record<WordZone, string> = {
  short: 'below the 32 to 42 word target',
  within: 'within the 32 to 42 word target',
  long: 'above the 42 word target',
  blocked: 'over the 45 word limit; shorten it to continue',
};
const ZONE_CLASS: Record<WordZone, string> = {
  short: 'text-muted-foreground',
  within: 'text-success font-semibold',
  long: 'text-warning font-semibold',
  blocked: 'text-destructive font-semibold',
};

export interface SegmentEditorProps {
  /** Segment number, 1 to 4. */
  segment: number;
  value: string;
  onChange: (value: string) => void;
  saveState?: SaveState;
  /** Issues attached to this segment, e.g. claim issue summaries. */
  issues?: string[];
  className?: string;
}

/** CMP-024 segment editor: dialogue textarea with a word counter; the counter is announced politely after typing pauses.
 * Over 45 words (`wordZone` is `blocked`) is only styled and announced here: the parent must block save. */
export function SegmentEditor({
  segment,
  value,
  onChange,
  saveState = 'idle',
  issues = [],
  className,
}: SegmentEditorProps) {
  const id = useId();
  const words = countWords(value);
  const zone = wordZone(words);
  const message = `${words} ${words === 1 ? 'word' : 'words'}, ${ZONE_TEXT[zone]}`;
  const [announced, setAnnounced] = useState(message);
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(message), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [message]);
  const blocked = zone === 'blocked';
  return (
    <section
      aria-label={`Segment ${segment} editor`}
      data-zone={zone}
      data-save={saveState}
      className={['flex w-full flex-col gap-2', className].filter(Boolean).join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`${id}-text`} className="text-ui font-semibold">
          Segment {segment} dialogue
        </label>
        <span className="flex items-center gap-1 text-caption text-muted-foreground">
          {saveState === 'saving' ? (
            <>
              <Icon name="loader-circle" size={16} /> Saving
            </>
          ) : saveState === 'saved' ? (
            <>
              <Icon name="circle-check" size={16} className="text-success" /> Saved
            </>
          ) : null}
        </span>
      </div>
      <textarea
        id={`${id}-text`}
        value={value}
        rows={4}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={blocked ? true : undefined}
        aria-describedby={`${id}-count`}
        className={`${FIELD_CLASS} py-2`}
      />
      <p id={`${id}-count`} className={`text-caption ${ZONE_CLASS[zone]}`}>
        <span aria-hidden="true">{message}</span>
        <span role="status" aria-live="polite" className="sr-only">
          {announced}
        </span>
      </p>
      {issues.length ? (
        <ul className="list-disc pl-5 text-caption text-warning">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
