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
  /** Character ranges of `value` to mark, e.g. a flagged phrase; only pass them while `value` is the text they were found in. */
  highlights?: { start: number; end: number }[];
  /** Hide the visible counter when the parent shows it; it is still announced. */
  hideCount?: boolean;
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
  highlights = [],
  hideCount = false,
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
  let cursor = 0;
  const marks = [...highlights]
    .sort((a, b) => a.start - b.start)
    .filter(
      (h) =>
        h.start >= cursor && h.end > h.start && h.end <= value.length && ((cursor = h.end), true),
    )
    .map((h, i, all) => ({ ...h, from: i === 0 ? 0 : all[i - 1]!.end }));
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
      <div className="relative">
        {marks.length ? (
          <div
            aria-hidden="true"
            data-testid="segment-highlight"
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3 py-2 text-ui text-transparent"
          >
            {marks.map((m, i) => (
              <span key={i}>
                {value.slice(m.from, m.start)}
                <mark className="rounded-sm bg-destructive-subtle text-transparent underline decoration-destructive decoration-2 underline-offset-2">
                  {value.slice(m.start, m.end)}
                </mark>
              </span>
            ))}
            {value.slice(marks[marks.length - 1]!.end)}
          </div>
        ) : null}
        <textarea
          id={`${id}-text`}
          value={value}
          rows={4}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={blocked ? true : undefined}
          aria-describedby={`${id}-count`}
          className={`${FIELD_CLASS} relative py-2 ${marks.length ? 'bg-transparent' : ''}`}
        />
      </div>
      <p id={`${id}-count`} className={hideCount ? 'sr-only' : `text-caption ${ZONE_CLASS[zone]}`}>
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
