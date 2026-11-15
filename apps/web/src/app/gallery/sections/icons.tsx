import { ICON_NAMES, Icon, type IconSize } from '@shroomap/ui/icons';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = { id: 'CMP-002', title: 'Icon set', order: 2 };

const SIZES: IconSize[] = [16, 20, 24];

export default function IconsSection() {
  return (
    <ul data-testid="icon-grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {ICON_NAMES.map((name) => (
        <li
          key={name}
          data-icon-cell={name}
          className="flex items-center gap-4 rounded-md border border-border bg-card p-4 text-foreground"
        >
          <span className="flex items-center gap-2">
            {SIZES.map((size) => (
              <Icon key={size} name={name} size={size} />
            ))}
          </span>
          <span className="text-caption text-muted-foreground">{name}</span>
        </li>
      ))}
    </ul>
  );
}
