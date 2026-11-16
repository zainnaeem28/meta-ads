import { Cell } from '@shroomap/ui/cmp-014/gallery-demos';
import { Button } from '@shroomap/ui/cmp-003';
import { AuthShell } from '@shroomap/ui/cmp-032';
import { PageHeader } from '@shroomap/ui/cmp-033';
import { StageTabsDemo } from '@shroomap/ui/cmp-033/gallery-demos';
import { GridCol, PageGrid } from '@shroomap/ui/cmp-034';
import type { ReactNode } from 'react';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-033',
  title: 'Layout: Page header, Page grid, Auth shell (CMP-032, CMP-034)',
  order: 33,
};

function Block({ children }: { children: string }) {
  return (
    <div className="rounded-md border border-border bg-muted p-3 text-ui text-muted-foreground">{children}</div>
  );
}

/** One auth shell inside a fixed-size frame (the shell is full viewport height on its own). */
function ShellFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-md border border-border [&>div]:min-h-0">{children}</div>;
}

export default function FeLayoutSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="layout">
      <div className="grid grid-cols-1 gap-4">
        <Cell id="header-default" label="CMP-033 default: title, description, action">
          <PageHeader
            title="Campaigns"
            description="Find and reopen your ads."
            actions={<Button>New brief</Button>}
          />
        </Cell>
        <Cell id="header-campaign" label="CMP-033 campaign: breadcrumb and stage tabs">
          <PageHeader
            title="Morning Focus Blend"
            breadcrumb={[{ label: 'Campaigns', href: '#header-campaign' }, { label: 'Morning Focus Blend' }]}
            tabs={<StageTabsDemo />}
          />
        </Cell>
      </div>
      <Cell id="grid" label="CMP-034 12 columns: 3 + 3 + 6, 4 + 8, 12; one column under 768 px">
        <PageGrid>
          <GridCol span={3}><Block>col-3</Block></GridCol>
          <GridCol span={3}><Block>col-3</Block></GridCol>
          <GridCol span={6}><Block>col-6</Block></GridCol>
          <GridCol span={4}><Block>col-4</Block></GridCol>
          <GridCol span={8}><Block>col-8</Block></GridCol>
          <GridCol span={12}><Block>col-12</Block></GridCol>
        </PageGrid>
      </Cell>
      <div className="grid grid-cols-1 gap-4">
        <Cell id="auth-signin" label="CMP-032 sign-in, provider slot">
          <ShellFrame>
            <AuthShell landmark={false} title="AI UGC Ad Director" description="Sign in to continue.">
              <Block>Provider sign-in component</Block>
            </AuthShell>
          </ShellFrame>
        </Cell>
        <Cell id="auth-loading" label="CMP-032 sign-in, provider loading">
          <ShellFrame>
            <AuthShell landmark={false} title="AI UGC Ad Director" providerState="loading" />
          </ShellFrame>
        </Cell>
        <Cell id="auth-error" label="CMP-032 sign-in, provider error">
          <ShellFrame>
            <AuthShell landmark={false} title="AI UGC Ad Director" providerState="error" />
          </ShellFrame>
        </Cell>
        <Cell id="auth-message" label="CMP-032 message">
          <ShellFrame>
            <AuthShell landmark={false} variant="message" title="Page not found" description="This page is not available.">
              <a href="#auth-message" className="text-ui underline">Go Home</a>
            </AuthShell>
          </ShellFrame>
        </Cell>
        <Cell id="auth-mfa" label="CMP-032 MFA">
          <ShellFrame>
            <AuthShell landmark={false} variant="mfa" title="Two-step verification" description="Enter your second factor.">
              <Block>Provider MFA component</Block>
            </AuthShell>
          </ShellFrame>
        </Cell>
      </div>
    </div>
  );
}
