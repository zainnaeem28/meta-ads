import type { SignIn } from '@clerk/nextjs';
import type { ComponentProps } from 'react';

type Appearance = NonNullable<ComponentProps<typeof SignIn>['appearance']>;

/**
 * Themes the provider-hosted components with the design tokens (UI-UX §3: card, `--primary`, Inter). Only what the
 * provider's variables and element hooks reach is themed; the rest is recorded as a deviation in
 * docs/evidence/TASK-084/README.md for UI/UX.
 */
export const clerkAppearance: Appearance = {
  variables: {
    colorPrimary: 'var(--primary)',
    colorBackground: 'var(--card)',
    colorForeground: 'var(--card-foreground)',
    colorMutedForeground: 'var(--muted-foreground)',
    colorDanger: 'var(--destructive)',
    colorInput: 'var(--card)',
    colorInputForeground: 'var(--foreground)',
    fontFamily: 'var(--font-sans, Inter, system-ui, sans-serif)',
    borderRadius: 'var(--radius-md)',
  },
  elements: {
    // The shell's card already frames the form: the provider card adds no second border or shadow.
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none border-0',
    card: 'w-full shadow-none border-0 p-0 bg-transparent',
    headerTitle: 'hidden',
    headerSubtitle: 'hidden',
    footer: 'hidden',
  },
};
