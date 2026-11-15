import type { CSSProperties, SVGProps } from 'react';
import {
  LOCKUP_VIEWBOX,
  MARK_VIEWBOX,
  PALETTE,
  PART_PATHS,
  RING,
  WORD_OFFSET,
  type BrandTone,
} from './artwork';

export type { BrandTone };
export type LogoSurface = 'background' | 'card' | 'muted' | 'inverse';
export type LogoForm = 'lockup' | 'mark';
/** Lockup widths (px, 120 minimum) or `header` (30 px high, 26 px on phone). */
export type LockupSize = 120 | 160 | 240 | 'header';
/** Mark widths (px, 24 minimum). */
export type MarkSize = 24 | 32 | 48 | 64 | 96;

const LOCKUP_RATIO = 895 / 188;
const CLEAR_SPACE = 0.25;

/** The tone the brief prescribes for a surface: light on background, card, muted; dark on the inverse surface. */
export function toneForSurface(surface: LogoSurface): BrandTone {
  return surface === 'inverse' ? 'dark' : 'light';
}

interface LogoBase extends Omit<SVGProps<SVGSVGElement>, 'children' | 'ref' | 'width' | 'height'> {
  /** Surface the logo sits on; picks the light or dark artwork. Default `background`. */
  surface?: LogoSurface;
  /** Explicit artwork (single-colour contexts); overrides `surface`. */
  tone?: BrandTone;
  /** Accessible name; default "ShrooMap". An empty string makes the logo decorative. */
  alt?: string;
  /** Reserve the 25 % clear space around the artwork. Default true. */
  clearSpace?: boolean;
}

export type LogoProps =
  | (LogoBase & { form?: 'lockup'; size?: LockupSize })
  | (LogoBase & { form: 'mark'; size?: MarkSize });

/** CMP-001: the owner-supplied ShrooMap mark and lockup as inline SVG (crisp at any density, never a raster). */
export function Logo(props: LogoProps) {
  const {
    form = 'lockup',
    size,
    surface = 'background',
    tone,
    alt = 'ShrooMap',
    clearSpace = true,
    className,
    style,
    ...rest
  } = props;
  const resolved = tone ?? toneForSurface(surface);
  const palette = PALETTE[resolved];
  const isMark = form === 'mark';
  const decorative = alt === '';

  const dimension: CSSProperties = {};
  let sizeClass = '';
  if (isMark) {
    const width = (size as MarkSize | undefined) ?? 32;
    dimension.width = width;
    dimension.height = width;
    if (clearSpace) dimension.padding = width * CLEAR_SPACE;
  } else if (size === 'header') {
    sizeClass = 'h-6.5 sm:h-7.5 w-auto';
  } else {
    const width = (size as LockupSize | undefined) ?? 160;
    const height = (width as number) / LOCKUP_RATIO;
    dimension.width = width;
    dimension.height = height;
    if (clearSpace) dimension.padding = height * CLEAR_SPACE;
  }
  if (size === 'header' && !isMark && clearSpace) sizeClass += ' p-1.5 sm:p-1.5';

  const [cap, stemShade, stemHighlight, word, accent] = palette.fills;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={isMark ? MARK_VIEWBOX : LOCKUP_VIEWBOX}
      data-logo={form}
      data-tone={resolved}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': alt })}
      className={[sizeClass, 'box-content shrink-0', className].filter(Boolean).join(' ')}
      style={{ ...dimension, ...style }}
      {...rest}
    >
      <circle
        cx={RING.cx}
        cy={RING.cy}
        r={RING.r}
        fill="none"
        stroke={palette.ring}
        strokeWidth={RING.strokeWidth}
      />
      <path fill={cap} fillRule="evenodd" d={PART_PATHS[0]} />
      <path fill={stemShade} d={PART_PATHS[1]} />
      <path fill={stemHighlight} d={PART_PATHS[2]} />
      {isMark ? null : (
        <g transform={WORD_OFFSET}>
          <path fill={word} fillRule="evenodd" d={PART_PATHS[3]} />
          <path fill={accent} fillRule="evenodd" d={PART_PATHS[4]} />
        </g>
      )}
    </svg>
  );
}
