import type { SVGProps } from 'react';
import { ICONS, type IconName } from './registry';

export type IconSize = 16 | 20 | 24;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref' | 'children'> {
  name: IconName;
  size?: IconSize;
  /** Accessible name. Omit for a decorative icon (rendered `aria-hidden`). */
  label?: string;
}

/** CMP-002: Lucide icon, 2 px stroke, `currentColor`; decorative unless `label` is given. */
export function Icon({ name, size = 20, label, ...rest }: IconProps) {
  const Glyph = ICONS[name];
  const labelled = label !== undefined && label !== '';
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={2}
      color="currentColor"
      data-icon={name}
      {...(labelled ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
    />
  );
}
