import { Cell } from '@shroomap/ui/cmp-014/gallery-demos';
import { ShellDemo } from '@shroomap/ui/cmp-030/gallery-demos';
import type { SectionMeta } from '../registry';

export const meta: SectionMeta = {
  id: 'CMP-030',
  title: 'Operator shell (CMP-030)',
  order: 30,
};

const TOAST = [{ id: 'saved', variant: 'success' as const, message: 'Brief saved.', critical: true }];

export default function FeShellOperatorSection() {
  return (
    <div className="flex flex-col gap-6" data-testid="shell-operator">
      <Cell id="shell-user-sidebar" label="CMP-030 role user, sidebar 240 px (1024 px and up)">
        <ShellDemo layout="sidebar" />
      </Cell>
      <Cell id="shell-nav-states" label="CMP-030 nav item states: current, hover (preview), default; focus with Tab">
        <ShellDemo layout="sidebar" path="/campaigns/new" previewHover="provider-keys" />
      </Cell>
      <Cell id="shell-rail" label="CMP-030 collapsed rail 64 px (768 to 1023 px), labels kept as accessible names">
        <ShellDemo layout="rail" />
      </Cell>
      <Cell id="shell-tabbar" label="CMP-030 bottom tab bar 64 px (under 768 px)">
        <ShellDemo layout="tabbar" path="/settings/provider-keys" />
      </Cell>
      <Cell id="shell-menu-user" label="CMP-030 role user, avatar menu open">
        <ShellDemo menuOpen />
      </Cell>
      <Cell id="shell-admin" label="CMP-030 role admin, avatar menu open shows Switch to administration">
        <ShellDemo role="admin" menuOpen userName="Sam Okafor" />
      </Cell>
      <Cell id="shell-key-missing" label="CMP-030 key badge: Add provider keys (warning)">
        <ShellDemo keyState="missing" />
      </Cell>
      <Cell id="shell-key-disabled" label="CMP-030 key badge: Key disabled (destructive), with a toast">
        <ShellDemo keyState="disabled" toasts={TOAST} />
      </Cell>
      <Cell id="shell-auto" label="CMP-030 responsive (follows the viewport: tab bar, rail, sidebar)">
        <ShellDemo layout="auto" path="/campaigns/new" />
      </Cell>
    </div>
  );
}
