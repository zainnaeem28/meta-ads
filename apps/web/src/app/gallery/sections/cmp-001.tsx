import { Logo, LogoLink, type BrandTone } from '@shroomap/ui/brand';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = { id: 'CMP-001', title: 'Brand mark and lockup', order: 1 };

const TONES: { tone: BrandTone; surface: string }[] = [
  { tone: 'light', surface: 'bg-background text-foreground' },
  { tone: 'dark', surface: 'bg-surface-inverse text-surface-inverse-foreground' },
  { tone: 'mono-ink', surface: 'bg-background text-foreground' },
  { tone: 'mono-cream', surface: 'bg-surface-inverse text-surface-inverse-foreground' },
];
const LOCKUPS = [120, 160, 240] as const;
const MARKS = [24, 32, 48, 64, 96] as const;

export default function BrandSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="brand-gallery">
      {TONES.map(({ tone, surface }) => (
        <div key={tone} data-variant={tone}>
          <p className="pb-2 text-caption text-muted-foreground">{tone}</p>
          <div data-artwork={tone} className={`rounded-md border border-border p-4 ${surface}`}>
            <div className="flex flex-wrap items-center gap-6 py-2">
              {LOCKUPS.map((size) => (
                <Logo key={size} tone={tone} size={size} data-case={`${tone}-lockup-${size}`} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-6 py-2">
              {MARKS.map((size) => (
                <Logo
                  key={size}
                  form="mark"
                  tone={tone}
                  size={size}
                  data-case={`${tone}-mark-${size}`}
                />
              ))}
            </div>
          </div>
        </div>
      ))}
      <div>
        <p className="pb-2 text-caption text-muted-foreground">
          Header lockup on a light surface (light artwork)
        </p>
        <header
          className="flex items-center rounded-md border border-border bg-card p-4"
          data-testid="brand-surface-card"
        >
          <LogoLink data-testid="brand-header-light" />
        </header>
      </div>
      <div>
        <p className="pb-2 text-caption text-muted-foreground">
          Header lockup on the inverse surface (dark artwork)
        </p>
        <header
          className="flex items-center rounded-md bg-surface-inverse p-4"
          data-testid="brand-surface-inverse"
        >
          <LogoLink logo={{ surface: 'inverse' }} data-testid="brand-header-dark" />
        </header>
      </div>
    </div>
  );
}
